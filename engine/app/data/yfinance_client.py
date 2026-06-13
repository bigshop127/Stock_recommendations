"""yfinance 數據源 client（大盤環境因子 → regime gate 的隔夜美股輸入）。

對應 scoring-model.md §1.2：美股四大指數 + 費半 + VIX + 台股加權，給環境閘門判定。
yfinance 免費、無金鑰。回傳乾淨快照供 /data/market。
"""
from __future__ import annotations

from datetime import date as _date

import pandas as pd
import yfinance as yf

# label → Yahoo 代號
INDICES: dict[str, str] = {
    "twii": "^TWII",   # 台股加權指數
    "sp500": "^GSPC",  # 標普 500
    "nasdaq": "^IXIC", # 那斯達克
    "dow": "^DJI",     # 道瓊
    "sox": "^SOX",     # 費城半導體
    "vix": "^VIX",     # 波動率（恐懼貪婪 proxy 輸入）
}


def _last_two_closes(symbol: str, on_or_before: str | None) -> tuple[float, float] | None:
    """取 <= 指定日的最後兩個收盤（用來算當日漲跌幅）。"""
    end = pd.Timestamp(on_or_before) + pd.Timedelta(days=1) if on_or_before else None
    hist = yf.Ticker(symbol).history(period="1mo", end=end, auto_adjust=False)
    closes = hist["Close"].dropna()
    if closes.empty:
        return None
    last = float(closes.iloc[-1])
    prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
    return last, prev


def get_market_snapshot(on_date: str | None = None) -> dict:
    """大盤/美股快照：每個指數 {close, prev_close, change_pct}。

    on_date 省略 → 取各指數最新交易日。回傳含 date 與 indices map。
    """
    indices: dict[str, dict] = {}
    for label, symbol in INDICES.items():
        try:
            res = _last_two_closes(symbol, on_date)
        except Exception as exc:  # 單一指數失敗不拖垮整包，標 error
            indices[label] = {"symbol": symbol, "error": str(exc)[:120]}
            continue
        if res is None:
            indices[label] = {"symbol": symbol, "close": None, "prev_close": None, "change_pct": None}
            continue
        last, prev = res
        change = (last - prev) / prev * 100 if prev else None
        indices[label] = {
            "symbol": symbol,
            "close": round(last, 2),
            "prev_close": round(prev, 2),
            "change_pct": round(change, 2) if change is not None else None,
        }
    return {
        "date": on_date or _date.today().isoformat(),
        "indices": indices,
        # 階段 3 regime gate 才實際運算；A/D 漲跌家數待補（FinMind 無乾淨單一集）
        "notes": "regime gate 於階段 3 計算；漲跌家數 A/D proxy 待補。",
    }
