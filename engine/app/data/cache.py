"""本地 parquet 時序快取（階段 2）。

設計目標（對應 docs/data-layer.md 驗收「重跑命中快取、不重打 API」）：
- 以 `(dataset, key)` 為單位存一個 parquet 檔：`data_cache/{dataset}/{key}.parquet`。
- 時序資料（OHLCV、法人、融資券）以日期欄為主鍵，支援：
    1) 抓歷史區間：`get_timeseries(..., start, end)`。
    2) 更新到最新：`end=今天`，只補快取尾端缺口。
- **gap-based 補抓**：只對「快取沒涵蓋到的日期區間」打 API；要求區間已被快取完整涵蓋時 → 0 次 API 呼叫（純命中）。
- **未結算窗**：來源 EOD 有延遲（實例：FinMind 的 TAIEX 指數當日深夜仍未出），此時補抓會回傳空。
  空回傳在「已結算」的日期＝假日，可安心把浮水印往前推；但在未結算窗（今天往前
  `_SETTLE_GRACE_DAYS` 天）內若照推，該交易日會被永久標記為已涵蓋、之後永遠命中快取而
  不再回補 → 資料停在舊日期。故未結算窗內的浮水印上限＝實際抓到的最後資料日。

不快取的資料：富果即時五檔 / 當日盤中（live-only，每次都要最新）→ 不走本模組。
"""
from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path
from typing import Callable

import pandas as pd

from app.core.config import settings

# fetch_fn 簽章：(code, start: str 'YYYY-MM-DD', end: str) -> DataFrame（含 date_col）
FetchFn = Callable[[str, str, str], pd.DataFrame]

_SAFE = re.compile(r"[^0-9A-Za-z_.\-]")

# 未結算窗長度：今天往前這麼多天內，來源的空回傳一律不當成「假日」（可能只是還沒出 EOD）
_SETTLE_GRACE_DAYS = 3


def _safe(name: str) -> str:
    """把 dataset/code 清成安全檔名片段（台股代號可能含 '.'、'^' 等）。"""
    return _SAFE.sub("_", str(name))


def _path(dataset: str, key: str) -> Path:
    return settings.cache_path / _safe(dataset) / f"{_safe(key)}.parquet"


def _meta_path(dataset: str, key: str) -> Path:
    return settings.cache_path / _safe(dataset) / f"{_safe(key)}.meta.json"


def _read_covered(dataset: str, key: str) -> tuple[str, str] | None:
    """讀「已抓取涵蓋區間」浮水印（與資料 min/max 無關，能正確處理週末/假日/今日未收盤）。"""
    p = _meta_path(dataset, key)
    if not p.exists():
        return None
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
        return m["covered_start"], m["covered_end"]
    except Exception:
        return None


def _write_covered(dataset: str, key: str, start: str, end: str) -> None:
    p = _meta_path(dataset, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"covered_start": start, "covered_end": end}), encoding="utf-8")


def _today() -> pd.Timestamp:
    """抽成函式，測試可注入固定日期。"""
    return pd.Timestamp.today().normalize()


def _now() -> pd.Timestamp:
    """抽成函式，測試可注入固定時間（get_periodic 的 TTL 用）。"""
    return pd.Timestamp.now()


def _settled_end(desired_end: str, last_data: str | None) -> str:
    """算浮水印終點：未結算窗內不可宣稱涵蓋到「沒真的抓到資料」的日期。

    desired_end 整段都已結算 → 直接採用（空回傳＝假日，往前推才不會每次重打 API）。
    否則上限收斂到「已結算邊界」與「實際資料最後一日」的較大者，讓來源延遲 publish 的
    交易日下次仍被視為缺口而回補。
    """
    settle_floor = (_today() - timedelta(days=_SETTLE_GRACE_DAYS)).strftime("%Y-%m-%d")
    if desired_end <= settle_floor:
        return desired_end
    floor = settle_floor
    if last_data and last_data > floor:
        floor = last_data
    return min(floor, desired_end)


def read_cache(dataset: str, key: str) -> pd.DataFrame | None:
    """讀快取；不存在回 None。"""
    p = _path(dataset, key)
    if not p.exists():
        return None
    try:
        return pd.read_parquet(p)
    except Exception:
        # 快取毀損 → 視為 miss，下次重抓覆蓋
        return None


def write_cache(dataset: str, key: str, df: pd.DataFrame) -> Path:
    """寫快取（覆蓋）。呼叫端負責已 dedupe / sort。"""
    p = _path(dataset, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(p, index=False)
    return p


def _merge(
    old: pd.DataFrame | None,
    new_parts: list[pd.DataFrame],
    date_col: str,
    key_cols: list[str] | None = None,
) -> pd.DataFrame:
    frames = [f for f in ([old] if old is not None else []) + new_parts if f is not None and not f.empty]
    if not frames:
        return pd.DataFrame()
    merged = pd.concat(frames, ignore_index=True)
    # 同日重複（補抓邊界重疊）→ 留最後一筆；以日期排序
    merged = merged.drop_duplicates(subset=key_cols or [date_col], keep="last")
    merged = merged.sort_values(date_col).reset_index(drop=True)
    return merged


def get_timeseries(
    dataset: str,
    code: str,
    start: str,
    end: str,
    fetch_fn: FetchFn,
    date_col: str = "date",
) -> tuple[pd.DataFrame, dict]:
    """取 [start, end] 的時序資料；快取未涵蓋處才打 API。

    回傳 `(df, meta)`：
      df   — 已切到 [start, end]、依日期排序的乾淨 DataFrame。
      meta — `{cache_hit: bool, fetched_ranges: [[s,e], ...], rows: int, source: str}`。
    """
    s_ts, e_ts = pd.Timestamp(start), pd.Timestamp(end)
    cached = read_cache(dataset, code)
    covered = _read_covered(dataset, code)

    ranges_to_fetch: list[tuple[str, str]] = []
    if cached is None or covered is None or date_col not in getattr(cached, "columns", []):
        # 無快取或無浮水印 → 整段抓
        cached = cached if (cached is not None and date_col in getattr(cached, "columns", [])) else None
        ranges_to_fetch.append((start, end))
    else:
        cov_start, cov_end = pd.Timestamp(covered[0]), pd.Timestamp(covered[1])
        # 前缺口（請求起點早於已涵蓋）
        if s_ts < cov_start:
            gap_end = (cov_start - timedelta(days=1)).strftime("%Y-%m-%d")
            ranges_to_fetch.append((start, gap_end))
        # 後缺口（更新到最新；用浮水印而非資料 max，週末/假日不會重打）
        if e_ts > cov_end:
            gap_start = (cov_end + timedelta(days=1)).strftime("%Y-%m-%d")
            ranges_to_fetch.append((gap_start, end))

    # 過濾掉反向區間
    ranges_to_fetch = [(s, e) for (s, e) in ranges_to_fetch if pd.Timestamp(s) <= pd.Timestamp(e)]
    cache_hit = len(ranges_to_fetch) == 0

    fetched_parts: list[pd.DataFrame] = []
    for s, e in ranges_to_fetch:
        part = fetch_fn(code, s, e)
        if part is not None and not part.empty:
            fetched_parts.append(part)

    if fetched_parts:
        merged = _merge(cached, fetched_parts, date_col)
        write_cache(dataset, code, merged)
    elif cached is not None:
        merged = cached
    else:
        merged = pd.DataFrame()

    # 更新涵蓋浮水印 = 舊涵蓋 ∪ 本次請求（已結算的缺口即使無資料/假日，也標記已抓過，下次命中）；
    # 未結算窗內則收斂到實際資料日，避免來源延遲出的交易日被永久跳過（見模組 docstring）
    if ranges_to_fetch:
        new_start = min(start, covered[0]) if covered else start
        desired_end = max(end, covered[1]) if covered else end
        last_data = str(merged[date_col].max())[:10] if not merged.empty else None
        _write_covered(dataset, code, new_start, _settled_end(desired_end, last_data))

    # 切到請求區間
    if not merged.empty:
        mask = (pd.to_datetime(merged[date_col]) >= s_ts) & (pd.to_datetime(merged[date_col]) <= e_ts)
        out = merged.loc[mask].reset_index(drop=True)
    else:
        out = merged

    meta = {
        "cache_hit": bool(cache_hit),
        "fetched_ranges": [list(r) for r in ranges_to_fetch],  # 本次實際打 API 的區間
        "rows": int(len(out)),
        "source": "cache" if cache_hit else "api+cache",
    }
    return out, meta


# ── 晚公布的期別資料（季報、月營收、股利）──────────────────────────────────────
#
# 這類資料的「日期」是期別日（季末、次月 1 日、除權息基準日），實際公布晚上幾週到幾個月。
# get_timeseries 的浮水印只往後補「還沒涵蓋的日期」，會在那一期還沒公布時先把日期標成已涵蓋，
# 公布後就永遠補不回來（2026-09 實例：2330 財報快取浮水印到 9/24，資料卻停在 2026-03-31，
# 第二季財報永遠缺；月營收也有整個月漏掉的）。
# 改成：快取超過 ttl 就重抓最近 refresh_days 天（晚公布的期別一定落在這段），其餘沿用快取。

PERIODIC_TTL_HOURS = 6


def _read_meta(dataset: str, key: str) -> dict:
    p = _meta_path(dataset, key)
    if not p.exists():
        return {}
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
        return m if isinstance(m, dict) else {}
    except Exception:
        return {}


def get_periodic(
    dataset: str,
    code: str,
    start: str,
    end: str,
    fetch_fn: FetchFn,
    *,
    refresh_days: int,
    ttl_hours: float = PERIODIC_TTL_HOURS,
    date_col: str = "date",
    key_cols: list[str] | None = None,
) -> tuple[pd.DataFrame, dict]:
    """取 [start, end] 的期別資料；快取過期才重抓最近 refresh_days 天。

    - 從沒用這支抓過（沒有 fetched_at，含舊 get_timeseries 留下的浮水印）→ 整段重抓一次，順便補回漏掉的期別。
    - 有快取但重抓失敗 → 回舊快取（不更新 fetched_at，下次再試）；完全沒快取時才把錯誤往外丟。
    - 抓回來是空的（ETF 沒有財報）也記 fetched_at，ttl 內不會每次重打。
    """
    cached = read_cache(dataset, code)
    if cached is not None and date_col not in cached.columns:
        cached = None
    meta = _read_meta(dataset, code)
    cov_start = meta.get("covered_start")
    fetched_at = meta.get("fetched_at")
    now = _now()

    head_gap: tuple[str, str] | None = None
    tail: tuple[str, str] | None = None
    if cov_start is None or fetched_at is None:
        tail = (start, end)
    else:
        if start < cov_start:
            head_gap = (start, (pd.Timestamp(cov_start) - timedelta(days=1)).strftime("%Y-%m-%d"))
        try:
            expired = now - pd.Timestamp(fetched_at) > pd.Timedelta(hours=ttl_hours)
        except Exception:
            expired = True
        if expired:
            recent = (_today() - timedelta(days=refresh_days)).strftime("%Y-%m-%d")
            tail = (max(start, recent), end)

    ranges = [r for r in (head_gap, tail) if r is not None and r[0] <= r[1]]
    parts: list[pd.DataFrame] = []
    ok: set[tuple[str, str]] = set()
    for s, e in ranges:
        try:
            part = fetch_fn(code, s, e)
        except Exception:
            if cached is None and not meta:
                raise
            continue  # 有舊資料可用：這次先回舊的
        ok.add((s, e))
        if part is not None and not part.empty:
            parts.append(part)

    merged = _merge(cached, parts, date_col, key_cols) if parts else (cached if cached is not None else pd.DataFrame())
    if parts:
        write_cache(dataset, code, merged)

    if ok:
        new_meta = dict(meta)
        if tail in ok:
            new_meta["fetched_at"] = now.isoformat()
            if cov_start is None or fetched_at is None:
                new_meta["covered_start"] = start  # 整段重抓過
        if head_gap in ok:
            new_meta["covered_start"] = start
        p = _meta_path(dataset, code)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(new_meta), encoding="utf-8")

    if not merged.empty:
        dates = pd.to_datetime(merged[date_col])
        out = merged.loc[(dates >= pd.Timestamp(start)) & (dates <= pd.Timestamp(end))].reset_index(drop=True)
    else:
        out = merged

    return out, {
        "cache_hit": not ranges,
        "fetched_ranges": [list(r) for r in ranges],
        "rows": int(len(out)),
        "source": "cache" if not ranges else "api+cache",
    }
