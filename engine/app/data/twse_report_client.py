"""TWSE 盤後統計報表 Client（MI_INDEX, BFI82U, BFIAMU，官方、免費、免金鑰）。

提供盤後資料抓取與 Parquet 快取機制。
"""
from __future__ import annotations

import datetime
import re
from typing import Any
import pandas as pd

from app.data import cache
from app.data.http import DataSourceError, get_json

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) financeapp-engine/2",
    "Referer": "https://www.twse.com.tw/zh/page/trading/exchange/MI_INDEX.html",
}


def _clean_num(val: str) -> float:
    if not val:
        return 0.0
    val_clean = val.replace(",", "").strip()
    if val_clean in ("", "-", "--", "None", "null"):
        return 0.0
    try:
        return float(val_clean)
    except ValueError:
        return 0.0



def _to_yyyymmdd(date_str: str) -> str:
    """'YYYY-MM-DD' -> 'YYYYMMDD'"""
    return date_str.replace("-", "")


# ── 1. 三大法人買賣超統計 BFI82U ──────────────────────────────────────────────
def fetch_bfi82u_raw(date_str: str) -> dict | None:
    """從 TWSE 獲取特定日期之三大法人現貨買賣金額統計。"""
    date_formatted = _to_yyyymmdd(date_str)
    url = f"https://www.twse.com.tw/fund/BFI82U?response=json&dayDate={date_formatted}&type=day"
    
    try:
        res = get_json(url, headers=_HEADERS)
    except Exception as exc:
        raise DataSourceError(f"TWSE BFI82U 請求失敗：{exc}") from exc

    if not isinstance(res, dict) or res.get("stat") != "OK":
        return None

    data_rows = res.get("data", [])
    if not data_rows:
        return None

    dealer_net = 0.0
    investment_trust_net = 0.0
    foreign_net = 0.0
    total_net = 0.0

    for row in data_rows:
        if len(row) < 4:
            continue
        name = row[0].strip()
        diff = _clean_num(row[3])
        if "自營商(自行買賣)" in name or "自營商(避險)" in name:
            dealer_net += diff
        elif "投信" in name:
            investment_trust_net = diff
        elif "外資及陸資(不含外資自營商)" in name:
            foreign_net = diff
        elif "合計" in name:
            total_net = diff

    return {
        "foreign": foreign_net,
        "investment_trust": investment_trust_net,
        "dealer": dealer_net,
        "total": total_net,
    }


def get_bfi82u(date_str: str) -> dict | None:
    """獲取三大法人統計（優先讀取快取）。"""
    cached = cache.read_cache("twse_bfi82u", date_str)
    if cached is not None and not cached.empty:
        row = cached.iloc[0]
        return {
            "foreign": float(row["foreign"]),
            "investment_trust": float(row["investment_trust"]),
            "dealer": float(row["dealer"]),
            "total": float(row["total"]),
        }

    raw = fetch_bfi82u_raw(date_str)
    if raw:
        df = pd.DataFrame([raw])
        cache.write_cache("twse_bfi82u", date_str, df)
        return raw
    return None


# ── 2. 類股成交金額統計 BFIAMU ──────────────────────────────────────────────
def fetch_bfiamu_raw(date_str: str) -> list[dict] | None:
    """從 TWSE 獲取特定日期之各類股成交統計。"""
    date_formatted = _to_yyyymmdd(date_str)
    url = f"https://www.twse.com.tw/exchangeReport/BFIAMU?response=json&date={date_formatted}"
    
    try:
        res = get_json(url, headers=_HEADERS)
    except Exception as exc:
        raise DataSourceError(f"TWSE BFIAMU 請求失敗：{exc}") from exc

    if not isinstance(res, dict) or res.get("stat") != "OK":
        return None

    data_rows = res.get("data", [])
    if not data_rows:
        return None

    sectors = []
    for row in data_rows:
        if len(row) < 3:
            continue
        raw_name = row[0].strip()
        # 移除 "類指數"、"業指數"、"指數" 與空格
        clean_name = raw_name.replace("類指數", "").replace("業指數", "").replace("指數", "").strip()
        # 航運業類指數 正常化為 航運
        if clean_name == "航運業":
            clean_name = "航運"
        elif clean_name == "電腦及週邊設備":
            clean_name = "電腦及週邊"
            
        turnover = _clean_num(row[2])
        sectors.append({
            "name": clean_name,
            "turnover": turnover,
        })
    return sectors


def get_bfiamu(date_str: str) -> list[dict] | None:
    """獲取各類股成交統計（優先讀取快取）。"""
    cached = cache.read_cache("twse_bfiamu", date_str)
    if cached is not None and not cached.empty:
        return cached.to_dict(orient="records")

    raw = fetch_bfiamu_raw(date_str)
    if raw:
        df = pd.DataFrame(raw)
        cache.write_cache("twse_bfiamu", date_str, df)
        return raw
    return None


# ── 3. 大盤統計與市場多空寬度 MI_INDEX ────────────────────────────────────────
def fetch_mi_index_ms_raw(date_str: str) -> dict | None:
    """從 TWSE 獲取特定日期之 MI_INDEX (type=MS)。"""
    date_formatted = _to_yyyymmdd(date_str)
    url = f"https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={date_formatted}&type=MS"
    
    try:
        res = get_json(url, headers=_HEADERS)
    except Exception as exc:
        raise DataSourceError(f"TWSE MI_INDEX 請求失敗：{exc}") from exc

    if not isinstance(res, dict) or res.get("stat") != "OK":
        return None

    tables = res.get("tables", [])
    
    # 尋找 "漲跌證券數合計" 表
    breadth_table = None
    stats_table = None
    for t in tables:
        title = t.get("title", "")
        if "漲跌證券數合計" in title:
            breadth_table = t
        elif "大盤統計資訊" in title:
            stats_table = t

    if not breadth_table:
        return None

    # 解析漲跌家數 (股票欄位一般在 index 2)
    advancing = 0
    declining = 0
    unchanged = 0
    limit_up = 0
    limit_down = 0

    data_rows = breadth_table.get("data", [])
    for row in data_rows:
        if len(row) < 3:
            continue
        row_type = row[0].strip()
        val = row[2].replace(",", "").strip()
        
        # 格式 "574(58)"
        match = re.match(r"(\d+)(?:\((\d+)\))?", val)
        count = 0
        limit_count = 0
        if match:
            count = int(match.group(1))
            if match.group(2):
                limit_count = int(match.group(2))
                
        if "上漲" in row_type:
            advancing = count
            limit_up = limit_count
        elif "下跌" in row_type:
            declining = count
            limit_down = limit_count
        elif "持平" in row_type:
            unchanged = count

    # 解析大盤總成交金額 (從 stats_table 獲取)
    volume = 0.0
    if stats_table:
        stats_rows = stats_table.get("data", [])
        for row in stats_rows:
            if len(row) >= 2 and ("總計" in row[0] or "證券合計" in row[0]):
                volume = _clean_num(row[1])
                break

    total = advancing + declining + unchanged
    advancing_pct = round(advancing / total, 4) if total > 0 else 0.0

    return {
        "advancing": advancing,
        "declining": declining,
        "unchanged": unchanged,
        "limit_up": limit_up,
        "limit_down": limit_down,
        "total": total,
        "advancing_pct": advancing_pct,
        "volume": volume,
    }


def get_mi_index_ms(date_str: str) -> dict | None:
    """獲取 MI_INDEX 大盤與寬度統計（優先讀取快取）。"""
    cached = cache.read_cache("twse_mi_index", date_str)
    if cached is not None and not cached.empty:
        row = cached.iloc[0]
        return {
            "advancing": int(row["advancing"]),
            "declining": int(row["declining"]),
            "unchanged": int(row["unchanged"]),
            "limit_up": int(row["limit_up"]),
            "limit_down": int(row["limit_down"]),
            "total": int(row["total"]),
            "advancing_pct": float(row["advancing_pct"]),
            "volume": float(row["volume"]),
        }

    raw = fetch_mi_index_ms_raw(date_str)
    if raw:
        df = pd.DataFrame([raw])
        cache.write_cache("twse_mi_index", date_str, df)
        return raw
    return None


# ── 4. 盤後資料回溯輔助 ────────────────────────────────────────────────────────
def get_with_rollback(fetch_fn: callable, date_str: str | None = None, max_days: int = 15) -> tuple[Any, str]:
    """若指定日期無資料，則向前回溯至最近一個有資料的交易日。"""
    if not date_str:
        dt = datetime.date.today()
    else:
        dt = datetime.date.fromisoformat(date_str)

    for _ in range(max_days):
        current_str = dt.isoformat()
        try:
            res = fetch_fn(current_str)
            if res is not None:
                return res, current_str
        except Exception:
            pass
        dt -= datetime.timedelta(days=1)

    raise DataSourceError("無法取得任何有效的交易日資料（已往前搜尋 15 天）")


# ── 5. 全市場個股收盤行情 MI_INDEX (ALLBUT0999) ─────────────────────────────────
def fetch_mi_index_allbut0999_raw(date_str: str) -> list[dict] | None:
    """從 TWSE 獲取特定日期之全市場上市個股每日收盤行情。"""
    date_formatted = _to_yyyymmdd(date_str)
    url = f"https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={date_formatted}&type=ALLBUT0999"

    try:
        res = get_json(url, headers=_HEADERS)
    except Exception as exc:
        raise DataSourceError(f"TWSE MI_INDEX ALLBUT0999 請求失敗：{exc}") from exc

    if not isinstance(res, dict) or res.get("stat") != "OK":
        return None

    tables = res.get("tables", [])
    target_table = None
    for t in tables:
        title = t.get("title", "")
        if "每日收盤行情" in title:
            target_table = t
            break

    if not target_table:
        # 備用：若找不到符合標題之 table，看 res 是否有 data
        if "data" in res:
            target_table = res
        else:
            return None

    fields = target_table.get("fields", [])
    data_rows = target_table.get("data", [])
    if not data_rows:
        return None

    code_idx = fields.index("證券代號") if "證券代號" in fields else 0
    name_idx = fields.index("證券名稱") if "證券名稱" in fields else 1
    turnover_idx = fields.index("成交金額") if "成交金額" in fields else 4
    close_idx = fields.index("收盤價") if "收盤價" in fields else 8
    dir_idx = fields.index("漲跌(+/-)") if "漲跌(+/-)" in fields else 9
    diff_idx = fields.index("漲跌價差") if "漲跌價差" in fields else 10

    stocks = []
    for row in data_rows:
        try:
            max_idx = max(code_idx, name_idx, turnover_idx, close_idx, dir_idx, diff_idx)
            if len(row) <= max_idx:
                continue

            code = str(row[code_idx]).strip()
            if len(code) != 4 or not code.isdigit() or code.startswith("00"):
                continue

            name = str(row[name_idx]).strip()
            turnover = _clean_num(str(row[turnover_idx]))

            close_str = str(row[close_idx]).strip()
            if close_str in ("", "--", "-", "None", "null"):
                close = None
            else:
                close_val = _clean_num(close_str)
                close = close_val if close_val > 0 else None

            dir_raw = str(row[dir_idx])
            dir_clean = re.sub(r'<[^>]+>', '', dir_raw).strip()
            diff_val = _clean_num(str(row[diff_idx]))

            if "X" in dir_clean:
                change_val = None
            elif "+" in dir_clean or "▲" in dir_clean:
                change_val = diff_val
            elif "-" in dir_clean or "▼" in dir_clean:
                change_val = -diff_val
            else:
                change_val = 0.0

            stocks.append({
                "code": code,
                "name": name,
                "close": close,
                "change_val": change_val,
                "turnover": turnover,
            })
        except Exception:
            continue

    return stocks


def get_mi_index_allbut0999(date_str: str) -> list[dict] | None:
    """獲取全市場個股每日收盤行情（優先讀取日檔快取）。"""
    import json
    from app.core.config import settings
    cache_file = settings.cache_path / "stock_heatmap" / f"{date_str}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    raw = fetch_mi_index_allbut0999_raw(date_str)
    if raw is not None:
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        return raw
    return None

