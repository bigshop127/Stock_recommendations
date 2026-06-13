"""數據層編排（接快取 + 各 client），供 app/api/data.py 呼叫。

可回測（FinMind，走 parquet 快取）：ohlcv、chips。
live-only（富果，不快取或僅快取歷史日）：book、intraday。
大盤環境（yfinance）：market。
"""
from __future__ import annotations

from datetime import date as _date

import pandas as pd

from app.core.config import settings
from app.data import (
    cache,
    finmind_client,
    fred_client,
    fugle_client,
    news_client,
    taifex_client,
    twse_mis_client,
    yfinance_client,
)


def _records(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    return df.to_dict(orient="records")


# ── 可回測：FinMind ──────────────────────────────────────────────────────────
def get_ohlcv(code: str, start: str, end: str) -> dict:
    df, meta = cache.get_timeseries("ohlcv", code, start, end, finmind_client.fetch_ohlcv)
    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "start": start,
        "end": end,
        "source": "FinMind TaiwanStockPrice",
        "live_only": False,
        "cache": meta,
        "rows": meta["rows"],
        "data": _records(df),
    }


def get_ohlcv_adj(code: str, start: str, end: str) -> dict:
    """**還原**日 OHLCV（yfinance auto_adjust：含除權息＋分割）→ 回測/benchmark/regime 趨勢用。

    FinMind 免費級 TaiwanStockPrice 未還原，遇分割/除權有斷點會讓回測失真；本端點以 yfinance 還原價
    取代。schema 與 get_ohlcv 對齊（少 turnover）。走 parquet 快取。
    """
    df, meta = cache.get_timeseries("ohlcv_adj", code, start, end, yfinance_client.fetch_stock_ohlcv)
    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "start": start,
        "end": end,
        "source": "yfinance 還原日線（auto_adjust，含除權息/分割）",
        "live_only": False,
        "cache": meta,
        "rows": meta["rows"],
        "data": _records(df),
    }


def get_chips(code: str, start: str, end: str) -> dict:
    """三大法人 + 融資券，合併同一日期軸。"""
    inst, m_inst = cache.get_timeseries("chips_inst", code, start, end, finmind_client.fetch_institutional)
    margin, m_margin = cache.get_timeseries("chips_margin", code, start, end, finmind_client.fetch_margin)

    if inst.empty and margin.empty:
        merged = pd.DataFrame()
    elif inst.empty:
        merged = margin
    elif margin.empty:
        merged = inst
    else:
        merged = inst.merge(margin, on="date", how="outer").sort_values("date").reset_index(drop=True)

    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "start": start,
        "end": end,
        "source": "FinMind 三大法人買賣超 + 融資融券",
        "live_only": False,
        "cache": {"institutional": m_inst, "margin": m_margin},
        "rows": int(len(merged)),
        "data": _records(merged),
    }


# ── live-only：即時五檔（預設 TWSE MIS 免費；有富果 key 才用富果）─────────────
def _book_source() -> str:
    """決定 /data/book 來源：auto=有富果 key 才用富果，否則 MIS。"""
    mode = (settings.book_source or "auto").lower()
    if mode == "fugle":
        return "fugle"
    if mode == "mis":
        return "mis"
    return "fugle" if settings.fugle_api_key else "mis"  # auto


def get_book(code: str) -> dict:
    """即時最佳五檔（live snapshot，不可回測）。預設 TWSE MIS（免金鑰、官方）。"""
    src = _book_source()
    if src == "fugle":
        quote = fugle_client.get_quote(code)
        source = "富果 Fugle intraday/quote"
    else:
        quote = twse_mis_client.get_quote(code)
        source = "TWSE MIS getStockInfo（官方、免金鑰）"
    return {
        "code": code,
        "source": source,
        "live_only": True,
        "note": "盤口為 live-only，無歷史、不可回測（scoring-model §2.1）。"
                "MIS 為近即時（延遲約數秒），用於訊號評分非下單執行。",
        "book": quote,
    }


def get_intraday(code: str, on_date: str | None = None, timeframe: str = "1") -> dict:
    """盤中分K。今日/未指定 → live 當日；過去日期 → 歷史分K（快取，受富果回溯範圍限制）。"""
    today = _date.today().isoformat()
    is_live = on_date is None or on_date >= today

    if is_live:
        df = fugle_client.get_intraday_candles(code, timeframe=timeframe)
        cache_meta = {"cache_hit": False, "source": "live", "rows": int(len(df))}
        used_date = today
    else:
        used_date = on_date
        key = f"{code}_{on_date}_{timeframe}"

        def _fetch(_code: str, _s: str, _e: str) -> pd.DataFrame:
            return fugle_client.get_historical_candles(_code, on_date, on_date, timeframe=timeframe)

        # 歷史某日不可變 → 命中快取就不重打
        cached = cache.read_cache("fugle_intraday", key)
        if cached is not None and not cached.empty:
            df, cache_meta = cached, {"cache_hit": True, "source": "cache", "rows": int(len(cached))}
        else:
            df = fugle_client.get_historical_candles(code, on_date, on_date, timeframe=timeframe)
            if not df.empty:
                cache.write_cache("fugle_intraday", key, df)
            cache_meta = {"cache_hit": False, "source": "api+cache", "rows": int(len(df))}

    return {
        "code": code,
        "date": used_date,
        "timeframe": f"{timeframe}min",
        "source": "富果 Fugle " + ("intraday/candles" if is_live else "historical/candles"),
        "live_only": is_live,
        "note": "盤中分K；歷史分鐘級回溯範圍受富果限制（見 docs/data-layer.md）。",
        "cache": cache_meta,
        "rows": int(len(df)),
        "data": _records(df),
    }


# ── 大盤環境：yfinance ──────────────────────────────────────────────────────
def get_market(on_date: str | None = None) -> dict:
    snap = yfinance_client.get_market_snapshot(on_date)
    return {
        "source": "yfinance（^TWII/^GSPC/^IXIC/^DJI/^SOX/^VIX）",
        "live_only": False,
        **snap,
    }


# ── 期貨/選擇權：TAIFEX（官方，可回測；供階段3 regime gate）─────────────────
def get_futures(start: str, end: str, product: str = "TXF") -> dict:
    """三大法人期貨未平倉淨額 + Put/Call Ratio，合併同一日期軸。"""
    inst, m_inst = cache.get_timeseries(
        f"taifex_inst_{product}", product, start, end,
        lambda c, s, e: taifex_client.fetch_institutional_futures(c, s, e, product=product),
    )
    pc, m_pc = cache.get_timeseries("taifex_pcratio", "OPT", start, end, taifex_client.fetch_pc_ratio)

    if inst.empty and pc.empty:
        merged = pd.DataFrame()
    elif inst.empty:
        merged = pc
    elif pc.empty:
        merged = inst
    else:
        merged = inst.merge(pc, on="date", how="outer").sort_values("date").reset_index(drop=True)

    return {
        "product": product,
        "start": start,
        "end": end,
        "source": "TAIFEX 三大法人期貨未平倉 + Put/Call Ratio（官方）",
        "live_only": False,
        "cache": {"institutional": m_inst, "pc_ratio": m_pc},
        "rows": int(len(merged)),
        "data": _records(merged),
    }


# ── 新聞情緒源：鉅亨 / Google News（供階段4 F_sentiment）─────────────────────
def get_news(keyword: str | None = None, limit: int = 30) -> dict:
    items = news_client.get_news(keyword=keyword, limit=limit)
    return {
        "keyword": keyword,
        "source": "Google News RSS" if keyword else "鉅亨 Anue newslist",
        "live_only": True,  # 新聞為時效資料，本層不長期快取
        "note": "僅取標題/摘要供情緒分析；情緒歷史回測需另建語料庫（階段4）。",
        "count": len(items),
        "items": items,
    }


# ── 美國總經：FRED（官方，可回測；供階段5/環境）─────────────────────────────
def get_macro(series: str, start: str, end: str) -> dict:
    df, meta = cache.get_timeseries(
        f"fred_{fred_client.resolve_series(series)}", series, start, end, fred_client.fetch_series,
    )
    return {
        "series": series,
        "series_id": fred_client.resolve_series(series),
        "start": start,
        "end": end,
        "source": "FRED（聖路易聯準會）",
        "live_only": False,
        "cache": meta,
        "rows": meta["rows"],
        "data": _records(df),
    }
