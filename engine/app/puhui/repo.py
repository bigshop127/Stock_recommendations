"""老王報告 repo 層（檔案 I/O、索引、快取、name↔code 反查、缺日 fallback）。

職責（與純函式 `parser` 分離）：
1. 掃 `reports/**/*.md` 建日期索引。
2. `get_daily(date)`：讀檔 → parser 解析 → 反查代號 → **落地快取** `data/puhui_analysis/{date}.json`
   （決策1(b)，仍 gitignored；快取只為加速，報告才是真相）。
3. **name→code 反查**（決策；finmind TaiwanStockInfo），查不到標 `code=null` 不硬猜。
4. **缺當日報告 → 沿用最近前一篇（≤fallback_max_days，決策5）**，標 `stale` 並降信心。

對 Node 產物唯讀：只讀 `reports/`，只寫自家 `data/puhui_analysis/`（gitignored）。
"""
from __future__ import annotations

import json
import re
from datetime import date as _date, datetime, timezone, timedelta
from pathlib import Path

from app.data import finmind_client
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.puhui.parser import parse_report

_TPE = timezone(timedelta(hours=8))

_ROOT = Path(__file__).resolve().parents[3]      # 專案根 C:\CC AI Agent
REPORTS_DIR = _ROOT / "reports"
CACHE_DIR = _ROOT / "data" / "puhui_analysis"    # gitignored（決策1b 落地快取）

_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")

_index_cache: dict[str, Path] | None = None


def _scan_index(force: bool = False) -> dict[str, Path]:
    """{date: path}，掃 reports/**/*.md（檔名含日期）。記憶體快取。"""
    global _index_cache
    if _index_cache is not None and not force:
        return _index_cache
    idx: dict[str, Path] = {}
    if REPORTS_DIR.exists():
        for p in REPORTS_DIR.rglob("*.md"):
            m = _DATE_RE.search(p.name)
            if m:
                idx[f"{m.group(1)}-{m.group(2)}-{m.group(3)}"] = p
    _index_cache = idx
    return idx


def list_dates() -> list[str]:
    return sorted(_scan_index().keys())


def _resolve_codes(daily: dict) -> dict:
    """對 code=None 但疑似台股的個股做 name→code 反查；查不到保持 None + note。"""
    unresolved = []
    for s in daily.get("stocks", []):
        if s.get("code"):
            continue
        code = finmind_client.get_code_by_name(s.get("name", ""))
        if code:
            s["code"] = code
            s["is_tw"] = True
            s["note"] = (s.get("note", "") + "；name→code 反查補代號").strip("；")
        else:
            s["is_tw"] = False
            unresolved.append(s.get("name"))
    if unresolved:
        daily.setdefault("notes", []).append(
            f"name→code 查無 {len(unresolved)} 檔（美股/非上市櫃）：{unresolved} → code=null 不硬猜"
        )
    daily["tw_count"] = sum(1 for s in daily["stocks"] if s.get("code"))
    return daily


def _cache_path(date: str) -> Path:
    return CACHE_DIR / f"{date}.json"


def _load_cache(date: str, report_path: Path) -> dict | None:
    cp = _cache_path(date)
    if not cp.exists():
        return None
    try:
        # 報告比快取新 → 失效重解
        if report_path.exists() and report_path.stat().st_mtime > cp.stat().st_mtime:
            return None
        return json.loads(cp.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_cache(date: str, daily: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(date).write_text(
            json.dumps(daily, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass   # 快取寫失敗不致命（純加速）


def _parse_one(date: str, *, use_cache: bool, resolve: bool) -> dict:
    """解析單一存在的報告（不含 fallback）。"""
    path = _scan_index()[date]
    if use_cache:
        cached = _load_cache(date, path)
        if cached is not None:
            return cached
    daily = parse_report(path.read_text(encoding="utf-8"),
                         date=date, source_file=str(path.relative_to(_ROOT)))
    if resolve:
        daily = _resolve_codes(daily)
    if use_cache:
        _write_cache(date, daily)
    return daily


def get_daily(date: str | None = None, *, use_cache: bool = True, resolve: bool = True,
              cfg: FactorConfig = DEFAULT_CONFIG) -> dict | None:
    """取某日老王情報（PuhuiDaily），含缺日 fallback（決策5）。

    回傳新增欄位：
    - `requested_date` / `as_of_date`：要求日 vs 實際採用報告日。
    - `stale`：是否沿用較早報告；`fallback_days`：相差天數。
    - `confidence_factor`：建議信心折扣（stale/legacy 各打折）→ 供 sentiment/blend 用。
    None：fallback 視窗內也無任何報告。
    """
    idx = _scan_index()
    if not idx:
        return None
    req = date or max(idx)

    # 找 ≤ req 的最近報告日
    candidates = sorted(d for d in idx if d <= req)
    if not candidates:
        return None
    as_of = candidates[-1]

    fallback_days = (_date.fromisoformat(req) - _date.fromisoformat(as_of)).days
    stale = fallback_days > 0
    pc = cfg.puhui
    if stale and fallback_days > pc.fallback_max_days:
        return None   # 太舊（超過 ≈5 交易日）→ 老王層退出，由上層重正規化

    daily = _parse_one(as_of, use_cache=use_cache, resolve=resolve)
    daily = dict(daily)   # 不污染快取物件

    conf_factor = 1.0
    if daily.get("template") == "legacy":
        conf_factor *= pc.legacy_conf_factor
    if stale:
        conf_factor *= pc.stale_conf_factor
        daily.setdefault("notes", []).append(
            f"當日（{req}）無老王報告 → 沿用 {as_of}（{fallback_days} 天前），已降信心"
        )

    daily["requested_date"] = req
    daily["as_of_date"] = as_of
    daily["stale"] = stale
    daily["fallback_days"] = fallback_days
    daily["confidence_factor"] = round(conf_factor, 3)
    return daily


def get_stock(code: str, date: str | None = None,
              cfg: FactorConfig = DEFAULT_CONFIG) -> dict | None:
    """取某日某代號的老王個股觀點（含 daily meta：stale/confidence_factor）。查無回 None。"""
    daily = get_daily(date, cfg=cfg)
    if not daily:
        return None
    for s in daily.get("stocks", []):
        if str(s.get("code")) == str(code):
            return {**s,
                    "as_of_date": daily["as_of_date"],
                    "requested_date": daily["requested_date"],
                    "stale": daily["stale"],
                    "confidence_factor": daily["confidence_factor"]}
    return None


def get_stock_score(code: str, date: str | None = None,
                    cfg: FactorConfig = DEFAULT_CONFIG) -> float | None:
    """老王個股分數（0~100）給階段3 `sentiment.puhui` 子訊號；查無回 None（觸發降級）。"""
    s = get_stock(code, date, cfg=cfg)
    return float(s["score"]) if s and s.get("score") is not None else None
