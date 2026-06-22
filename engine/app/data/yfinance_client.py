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


def fetch_stock_ohlcv(code: str, start: str, end: str) -> pd.DataFrame:
    """個股**還原**日 OHLCV（auto_adjust=True：含除權息＋分割還原）→ 回測價源。

    FinMind 免費級只給未還原 TaiwanStockPrice（除權/分割有斷點，回測會失真），故回測/benchmark/
    regime 趨勢改用 yfinance 還原價。代號先試上市 `.TW`，無則試上櫃 `.TWO`。
    回傳乾淨欄位：date(str), open, high, low, close, volume —— 與 finmind fetch_ohlcv 對齊。
    """
    cols = ["date", "open", "high", "low", "close", "volume"]
    end_excl = (pd.Timestamp(end) + pd.Timedelta(days=1)).date().isoformat()  # yfinance end 為開區間
    for suffix in (".TW", ".TWO"):
        try:
            hist = yf.Ticker(code + suffix).history(start=start, end=end_excl, auto_adjust=True)
        except Exception:
            hist = pd.DataFrame()
        if hist is None or hist.empty:
            continue
        out = pd.DataFrame({
            "date": hist.index.strftime("%Y-%m-%d"),
            "open": hist["Open"].astype(float),
            "high": hist["High"].astype(float),
            "low": hist["Low"].astype(float),
            "close": hist["Close"].astype(float),
            "volume": hist["Volume"].astype("int64"),
        })
        return out.sort_values("date").reset_index(drop=True)[cols]
    return pd.DataFrame(columns=cols)


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


def fetch_intraday_sparkline(symbol: str) -> list[dict]:
    """獲取 yfinance 單日 5 分鐘 K 線，用於分時 sparkline (1d)。"""
    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period="1d", interval="5m", auto_adjust=True)
        if df is None or df.empty:
            return []
        
        # 轉成台北時間
        try:
            df.index = df.index.tz_convert("Asia/Taipei")
        except Exception:
            pass
            
        out = []
        for t, row in df.iterrows():
            close_val = row["Close"]
            if pd.isna(close_val):
                continue
            out.append({
                "t": t.strftime("%H:%M"),
                "v": round(float(close_val), 2)
            })
        return out
    except Exception:
        return []


def fetch_history_sparkline(symbol: str, range_str: str) -> list[dict]:
    """獲取歷史收盤價，用於 5d 或 1m sparkline。"""
    try:
        period = "5d" if range_str == "5d" else "1mo"
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval="1d", auto_adjust=True)
        if df is None or df.empty:
            return []
            
        out = []
        for t, row in df.iterrows():
            close_val = row["Close"]
            if pd.isna(close_val):
                continue
            out.append({
                "date": t.strftime("%Y-%m-%d"),
                "close": round(float(close_val), 2)
            })
        return out
    except Exception:
        return []

