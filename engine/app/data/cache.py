"""本地 parquet 時序快取（階段 2）。

設計目標（對應 docs/data-layer.md 驗收「重跑命中快取、不重打 API」）：
- 以 `(dataset, key)` 為單位存一個 parquet 檔：`data_cache/{dataset}/{key}.parquet`。
- 時序資料（OHLCV、法人、融資券）以日期欄為主鍵，支援：
    1) 抓歷史區間：`get_timeseries(..., start, end)`。
    2) 更新到最新：`end=今天`，只補快取尾端缺口。
- **gap-based 補抓**：只對「快取沒涵蓋到的日期區間」打 API；要求區間已被快取完整涵蓋時 → 0 次 API 呼叫（純命中）。

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


def _merge(old: pd.DataFrame | None, new_parts: list[pd.DataFrame], date_col: str) -> pd.DataFrame:
    frames = [f for f in ([old] if old is not None else []) + new_parts if f is not None and not f.empty]
    if not frames:
        return pd.DataFrame()
    merged = pd.concat(frames, ignore_index=True)
    # 同日重複（補抓邊界重疊）→ 留最後一筆；以日期排序
    merged = merged.drop_duplicates(subset=[date_col], keep="last")
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

    # 更新涵蓋浮水印 = 舊涵蓋 ∪ 本次請求（即使某缺口無資料/假日，也標記已抓過，下次命中）
    if ranges_to_fetch:
        new_start = min(start, covered[0]) if covered else start
        new_end = max(end, covered[1]) if covered else end
        _write_covered(dataset, code, new_start, new_end)

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
