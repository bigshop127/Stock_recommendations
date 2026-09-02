"""富果 Fugle 數據源 client（live / 當沖；玉山）。

REST v1.0：https://api.fugle.tw/marketdata/v1.0/stock，header `X-API-KEY`。
金鑰走 settings.fugle_api_key（engine/.env）。

對應 scoring-model.md §2（當沖引擎，全部 live_only）：
- quote（最佳五檔 + 內外盤）→ F_orderbook → /data/book
- intraday candles（當日分K）→ F_intraday_tech → /data/intraday

⚠️ 重要限制（寫進 docs/data-layer.md）：
- 富果**歷史盤口/委買賣明細拿不到** → /data/book 永遠是 live snapshot，不可回測。
- 歷史「分K」僅 historical/candles 提供，分鐘級可回溯範圍有限（smoke 腳本實測後記錄）。
"""
from __future__ import annotations

import pandas as pd

from app.core.config import settings
from app.data.http import DataSourceError, get_json

BASE = "https://api.fugle.tw/marketdata/v1.0/stock"


def _headers() -> dict:
    if not settings.fugle_api_key:
        raise DataSourceError(
            "缺少 FUGLE_API_KEY。請在 engine/.env 填入富果 Marketdata API Key（見 engine/.env.example）。"
        )
    return {"X-API-KEY": settings.fugle_api_key}


def _levels(rows: list | None) -> list[dict]:
    """把富果 bids/asks 統一成 [{price, size}]，缺值容錯。"""
    out: list[dict] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        out.append({"price": r.get("price"), "size": r.get("size") or r.get("volume")})
    return out


def get_quote(code: str) -> dict:
    """即時報價 + 最佳五檔（live-only，不可回測）。

    回傳乾淨結構：code, time, last_price, bids[], asks[],
    total(成交量值), inner_outer(內外盤量，若富果有提供), live_only=True, raw。
    """
    payload = get_json(f"{BASE}/intraday/quote/{code}", headers=_headers())
    if not isinstance(payload, dict):
        raise DataSourceError(f"富果 quote 非預期回應：{str(payload)[:200]}")

    total = payload.get("total") or {}
    bids = _levels(payload.get("bids"))
    asks = _levels(payload.get("asks"))
    # 內外盤量（不同版本欄位名可能在 total 或頂層；容錯抓取）
    inner = total.get("tradeVolumeAtBid") or payload.get("tradeVolumeAtBid")
    outer = total.get("tradeVolumeAtAsk") or payload.get("tradeVolumeAtAsk")

    return {
        "code": str(payload.get("symbol", code)),
        "name": payload.get("name"),
        "time": payload.get("lastUpdated") or payload.get("date"),
        "last_price": payload.get("lastPrice") or payload.get("closePrice"),
        "bids": bids,
        "asks": asks,
        "total": {
            "trade_volume": total.get("tradeVolume"),
            "trade_value": total.get("tradeValue"),
        },
        "inner_outer": {"at_bid": inner, "at_ask": outer},
        "day": {
            "open": payload.get("openPrice"),
            "high": payload.get("highPrice"),
            "low": payload.get("lowPrice"),
            "prev_close": payload.get("previousClose"),
        },
        "is_intraday": payload.get("isIntraday"),
        "live_only": True,
        "raw": payload,
    }


def _candles_to_df(payload: dict) -> pd.DataFrame:
    cols = ["date", "open", "high", "low", "close", "volume"]
    data = payload.get("data") or []
    if not data:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(data)
    rename = {"timestamp": "date"}
    df = df.rename(columns=rename)
    keep = [c for c in cols if c in df.columns]
    return df[keep].reset_index(drop=True)


def get_intraday_candles(code: str, timeframe: str = "1") -> pd.DataFrame:
    """當日盤中分K（live-only）。timeframe 分鐘：1/5/10/15/30/60。"""
    payload = get_json(
        f"{BASE}/intraday/candles/{code}",
        params={"timeframe": timeframe},
        headers=_headers(),
    )
    if not isinstance(payload, dict):
        raise DataSourceError(f"富果 intraday candles 非預期回應：{str(payload)[:200]}")
    return _candles_to_df(payload)


def get_historical_candles(code: str, start: str, end: str, timeframe: str = "1") -> pd.DataFrame:
    """歷史分K（給當沖回測；分鐘級可回溯範圍有限，由 smoke 實測）。"""
    payload = get_json(
        f"{BASE}/historical/candles/{code}",
        params={"from": start, "to": end, "timeframe": timeframe, "fields": "open,high,low,close,volume"},
        headers=_headers(),
    )
    if not isinstance(payload, dict):
        raise DataSourceError(f"富果 historical candles 非預期回應：{str(payload)[:200]}")
    return _candles_to_df(payload)
