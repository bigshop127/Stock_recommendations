"""TWSE MIS（基本市況報導）即時報價 + 最佳五檔 client（免費、官方、免金鑰）。

公開 JSON：GET https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0
這是富果/永豐 之外的免費替代源——官方台股即時源頭，含最佳五檔。

對應 scoring-model.md §2（當沖引擎，live_only）：
- 最佳五檔 b/g（委買價/量）、a/f（委賣價/量）→ F_orderbook → /data/book

⚠️ 限制（寫進 docs/data-layer.md）：
- 報價為近即時（延遲約 5–20s），非 tick 級；用於訊號評分足夠，非下單執行用。
- 無歷史盤口 → 與富果相同，盤口因子 live_only、不可回測。
- 非交易時段五檔多為空或上一盤快照。
- 需帶 Referer / User-Agent；首次呼叫先取站台 cookie。
"""
from __future__ import annotations

import time

from app.data.http import DataSourceError, _session, get_json

API = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
_INDEX = "https://mis.twse.com.tw/stock/index.jsp"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) financeapp-engine/2",
    "Referer": "https://mis.twse.com.tw/stock/fibest.jsp",
    "Accept": "application/json, text/plain, */*",
}

# 解析後的 channel 前綴（tse_ / otc_）以代號快取，避免每次都試兩種市場
_channel_cache: dict[str, str] = {}
_cookie_ready = False


def _ensure_cookie() -> None:
    """MIS 需要站台 session cookie，首次呼叫先 GET 首頁取得。"""
    global _cookie_ready
    if _cookie_ready:
        return
    try:
        _session.get(_INDEX, headers=_HEADERS, timeout=10)
    except Exception:
        pass  # 取不到 cookie 不致命，直接打 API 多半仍可
    _cookie_ready = True


def _nums(s: str | None) -> list[str]:
    """MIS 以 '_' 分隔五檔；'-' 或空字串代表無值。回傳對齊用的原始字串清單。"""
    if not s:
        return []
    return s.split("_")


def _levels(prices: str | None, sizes: str | None) -> list[dict]:
    """把對齊的價/量字串轉成 [{price, size}]（跳過無效檔位，保持索引對齊）。"""
    ps, vs = _nums(prices), _nums(sizes)
    out: list[dict] = []
    for i, p in enumerate(ps):
        if p in ("", "-"):
            continue
        v = vs[i] if i < len(vs) else None
        try:
            price = float(p)
        except ValueError:
            continue
        size = None
        if v not in (None, "", "-"):
            try:
                size = int(float(v))
            except ValueError:
                size = None
        out.append({"price": price, "size": size})
    return out


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _query(channel: str) -> dict | None:
    """打一次 MIS，回 msgArray[0]；查無回 None。"""
    _ensure_cookie()
    params = {"ex_ch": channel, "json": "1", "delay": "0", "_": str(int(time.time() * 1000))}
    payload = get_json(API, params=params, headers=_HEADERS)
    if not isinstance(payload, dict):
        raise DataSourceError(f"TWSE MIS 非預期回應：{str(payload)[:200]}")
    arr = payload.get("msgArray") or []
    return arr[0] if arr else None


def get_quote(code: str) -> dict:
    """即時報價 + 最佳五檔（live-only）。輸出結構與 fugle_client.get_quote 對齊，供 /data/book 共用。"""
    # 市場判別：先用快取，否則 tse_ → otc_ 依序試
    tried = [_channel_cache[code]] if code in _channel_cache else [f"tse_{code}.tw", f"otc_{code}.tw"]
    row = None
    used = None
    for ch in tried:
        row = _query(ch)
        if row:
            used = ch
            _channel_cache[code] = ch
            break
    if not row:
        raise DataSourceError(
            f"TWSE MIS 查無 {code}（非交易時段或代號錯誤）。盤中重試可得即時五檔。"
        )

    last = _f(row.get("z"))
    if last is None:  # 尚無成交（如開盤前）→ 退而用昨收/開盤
        last = _f(row.get("o")) or _f(row.get("y"))

    return {
        "code": str(row.get("c", code)),
        "name": row.get("n"),
        "time": row.get("t"),
        "last_price": last,
        "bids": _levels(row.get("b"), row.get("g")),  # 委買價 / 委買量
        "asks": _levels(row.get("a"), row.get("f")),  # 委賣價 / 委賣量
        "total": {
            "trade_volume": _f(row.get("v")),   # 累計成交量（張）
            "trade_value": None,                # MIS 不直接提供成交值
        },
        "inner_outer": {"at_bid": None, "at_ask": None},  # MIS 無內外盤分量
        "day": {"open": _f(row.get("o")), "high": _f(row.get("h")),
                "low": _f(row.get("l")), "prev_close": _f(row.get("y"))},
        "channel": used,
        "live_only": True,
        "raw": row,
    }
