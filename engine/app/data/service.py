"""數據層編排（接快取 + 各 client），供 app/api/data.py 呼叫。

可回測（FinMind，走 parquet 快取）：ohlcv、chips。
live-only（富果，不快取或僅快取歷史日）：book、intraday。
大盤環境（yfinance）：market。
"""
from __future__ import annotations

import datetime
import logging
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
    tdcc_client,
    twse_mis_client,
    twse_openapi_client,
    yfinance_client,
)
from app.data.http import DataSourceError

log = logging.getLogger(__name__)


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


def get_fundamentals(code: str) -> dict:
    """個股基本面聚合：估值（日）、月營收（月）、獲利 (季)、股利 (年) 與最新 summary。"""
    today = datetime.date.today()
    
    # 1. Valuation: 近一年
    val_start = (today - datetime.timedelta(days=365)).isoformat()
    val_end = today.isoformat()
    val_df, _ = cache.get_timeseries("fundamentals_valuation", code, val_start, val_end, finmind_client.fetch_valuation)
    
    # 2. Revenue: 近 ~25 月
    # 為了計算 YoY，往前多拿 13 個月（即共 38 個月）
    rev_start_query = (today - datetime.timedelta(days=38 * 30.5)).isoformat()
    rev_df, _ = cache.get_timeseries(
        "fundamentals_revenue", code, rev_start_query, val_end,
        finmind_client.fetch_month_revenue
    )
    if not rev_df.empty:
        rev_df = rev_df.copy()
        rev_df["date_dt"] = pd.to_datetime(rev_df["date"])
        rev_df = rev_df.sort_values("date_dt").reset_index(drop=True)
        
        rev_df["month_period"] = rev_df["date_dt"].dt.to_period("M")
        rev_map = rev_df.set_index("month_period")["revenue"].to_dict()
        
        mom_list = []
        yoy_list = []
        for _, row in rev_df.iterrows():
            m = row["month_period"]
            rev = row["revenue"]
            
            # MoM
            prev_m = m - 1
            prev_rev = rev_map.get(prev_m)
            if prev_rev is not None and not pd.isna(prev_rev) and prev_rev > 0:
                mom_list.append(round(((rev - prev_rev) / prev_rev) * 100, 4))
            else:
                mom_list.append(None)
                
            # YoY
            prev_y = m - 12
            prev_rev_y = rev_map.get(prev_y)
            if prev_rev_y is not None and not pd.isna(prev_rev_y) and prev_rev_y > 0:
                yoy_list.append(round(((rev - prev_rev_y) / prev_rev_y) * 100, 4))
            else:
                yoy_list.append(None)
                
        rev_df["mom"] = mom_list
        rev_df["yoy"] = yoy_list
        rev_df["month"] = rev_df["month_period"].astype(str)
        rev_df = rev_df[["month", "revenue", "yoy", "mom"]]
        rev_df = rev_df.tail(25).reset_index(drop=True)
        
    # 3. Financials: 近 ~10 季
    # 拿過去 12 季以確保有 10 季數據可用
    fin_start = (today - datetime.timedelta(days=12 * 92)).isoformat()
    fin_df, _ = cache.get_timeseries("fundamentals_financials", code, fin_start, val_end, finmind_client.fetch_financials)
    if not fin_df.empty:
        fin_df = fin_df.tail(10).reset_index(drop=True)
        
    # 4. Dividend: 近 ~6 年
    div_start = (today - datetime.timedelta(days=6 * 365)).isoformat()
    div_df, _ = cache.get_timeseries(
        "fundamentals_dividend", code, div_start, val_end,
        finmind_client.fetch_dividend
    )
    if not div_df.empty:
        div_df = div_df.copy()
        div_df["year"] = pd.to_datetime(div_df["date"]).dt.year.astype(str)
        div_df = div_df.groupby("year").agg({
            "cash_dividend": "sum",
            "stock_dividend": "sum"
        }).reset_index()
        div_df["cash_dividend"] = div_df["cash_dividend"].round(4)
        div_df["stock_dividend"] = div_df["stock_dividend"].round(4)
        div_df = div_df.sort_values("year").tail(6).reset_index(drop=True)
        
    # 5. Summary / market cap / as_of
    pe_ratio = None
    pb_ratio = None
    dividend_yield = None
    as_of = today.isoformat()
    
    if not val_df.empty:
        latest_val = val_df.iloc[-1]
        as_of = str(latest_val["date"])
        
        val_pe = latest_val["pe_ratio"]
        val_pb = latest_val["pb_ratio"]
        val_dy = latest_val["dividend_yield"]
        
        if not pd.isna(val_pe): pe_ratio = round(float(val_pe), 2)
        if not pd.isna(val_pb): pb_ratio = round(float(val_pb), 2)
        if not pd.isna(val_dy): dividend_yield = round(float(val_dy), 2)
        
    market_cap = None
    try:
        shares_start = (today - datetime.timedelta(days=30)).isoformat()
        shares_df, _ = cache.get_timeseries("shares_issued", code, shares_start, val_end, finmind_client.fetch_shares_issued)
        if not shares_df.empty:
            latest_shares = float(shares_df.iloc[-1]["shares"])
            if latest_shares > 0:
                ohlcv_start = (today - datetime.timedelta(days=15)).isoformat()
                ohlcv_df, _ = cache.get_timeseries("ohlcv", code, ohlcv_start, val_end, finmind_client.fetch_ohlcv)
                if not ohlcv_df.empty:
                    latest_close = float(ohlcv_df.iloc[-1]["close"])
                    market_cap = int(latest_shares * latest_close)
    except Exception:
        pass
        
    eps_ttm = None
    if not fin_df.empty:
        last_4_fin = fin_df.tail(4)
        eps_list = last_4_fin["eps"].dropna().tolist()
        if len(eps_list) == 4:
            eps_ttm = round(sum(eps_list), 2)
            
    def _clean_records(df, map_fn=None):
        if df is None or df.empty:
            return []
        records = df.to_dict(orient="records")
        cleaned = []
        for r in records:
            cleaned_r = {}
            for k, v in r.items():
                if pd.isna(v):
                    cleaned_r[k] = None
                else:
                    if isinstance(v, (int, float)):
                        cleaned_r[k] = round(v, 4) if isinstance(v, float) else v
                    else:
                        cleaned_r[k] = str(v)
            if map_fn:
                cleaned_r = map_fn(cleaned_r)
            cleaned.append(cleaned_r)
        return cleaned

    def format_financials_record(r):
        date_str = r.pop("date", None)
        if date_str:
            dt = pd.to_datetime(date_str)
            r["quarter"] = f"{dt.year}-Q{(dt.month - 1) // 3 + 1}"
        else:
            r["quarter"] = None
        return r

    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "as_of": as_of,
        "summary": {
            "pe_ratio": pe_ratio,
            "pb_ratio": pb_ratio,
            "dividend_yield": dividend_yield,
            "market_cap": market_cap,
            "eps_ttm": eps_ttm
        },
        "valuation": _clean_records(val_df),
        "revenue": _clean_records(rev_df),
        "financials": _clean_records(fin_df, format_financials_record),
        "dividend": _clean_records(div_df),
        "unit": {
            "revenue": "元",
            "market_cap": "元",
            "dividend": "元/股",
            "ratio": "%"
        },
        "source": "FinMind"
    }


def get_chips(code: str, start: str, end: str) -> dict:
    """三大法人 + 融資券，合併同一日期軸（因子原料用，勿改命名與單位）。"""
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

    records = merged.to_dict(orient="records")
    for r in records:
        for k, v in r.items():
            if pd.isna(v):
                r[k] = None

    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "start": start,
        "end": end,
        "source": "FinMind 三大法人買賣超 + 融資融券",
        "live_only": False,
        "cache": {"institutional": m_inst, "margin": m_margin},
        "rows": int(len(merged)),
        "data": records,
    }


def get_chips_series(
    code: str,
    start: str | None = None,
    end: str | None = None,
    days: int | None = None,
) -> dict:
    """三大法人 + 融資券 + 外資持股比率，合併同一日期軸，供前端圖表展示（做單位換算、特定欄位）。"""
    # If start is None and days is None, default to days = 20
    if start is None and days is None:
        days = 20

    if not end:
        end_date = datetime.date.today()
    else:
        end_date = datetime.date.fromisoformat(end)

    if not start:
        n_days = days if days is not None else 20
        # Fetch extra days to cover weekends and holidays
        start_date = end_date - datetime.timedelta(days=n_days * 2 + 10)
    else:
        start_date = datetime.date.fromisoformat(start)

    start_str = start_date.isoformat()
    end_str = end_date.isoformat()

    inst, m_inst = cache.get_timeseries("chips_inst", code, start_str, end_str, finmind_client.fetch_institutional)
    margin, m_margin = cache.get_timeseries("chips_margin", code, start_str, end_str, finmind_client.fetch_margin)
    shareholding, m_shareholding = cache.get_timeseries("chips_shareholding", code, start_str, end_str, finmind_client.fetch_shareholding)

    if not inst.empty:
        inst = inst.copy()
        inst["foreign_net_buy_qty"] = inst["foreign_net"] / 1000.0
        inst["investment_trust_net_buy_qty"] = inst["trust_net"] / 1000.0
        inst["dealer_net_buy_qty"] = inst["dealer_net"] / 1000.0
        inst["total_net_buy_qty"] = inst["foreign_net_buy_qty"] + inst["investment_trust_net_buy_qty"] + inst["dealer_net_buy_qty"]
        inst = inst.drop(columns=["foreign_net", "trust_net", "dealer_net"])
    else:
        inst = pd.DataFrame(columns=["date", "foreign_net_buy_qty", "investment_trust_net_buy_qty", "dealer_net_buy_qty", "total_net_buy_qty"])

    if margin.empty:
        margin = pd.DataFrame(columns=["date", "margin_balance", "margin_change", "short_balance", "short_change"])

    if shareholding.empty:
        shareholding = pd.DataFrame(columns=["date", "foreign_holding_ratio"])

    # Outer merge
    merged = inst.merge(margin, on="date", how="outer").merge(shareholding, on="date", how="outer")

    if not merged.empty:
        merged = merged.sort_values("date").reset_index(drop=True)

    # Fill NaNs for specific columns
    expected_cols = {
        "foreign_net_buy_qty": 0.0,
        "investment_trust_net_buy_qty": 0.0,
        "dealer_net_buy_qty": 0.0,
        "total_net_buy_qty": 0.0,
        "margin_balance": 0.0,
        "margin_change": 0.0,
        "short_balance": 0.0,
        "short_change": 0.0,
    }
    for col, default in expected_cols.items():
        if col not in merged.columns:
            merged[col] = default
        else:
            merged[col] = merged[col].fillna(default)

    if "foreign_holding_ratio" not in merged.columns:
        merged["foreign_holding_ratio"] = None

    # Slice to last days if days is specified
    if days is not None and days > 0:
        merged = merged.tail(days).reset_index(drop=True)

    as_of = None
    if not merged.empty:
        as_of = str(merged.iloc[-1]["date"])

    records = merged.to_dict(orient="records")
    for r in records:
        for k, v in r.items():
            if pd.isna(v):
                r[k] = None

    return {
        "code": code,
        "name": finmind_client.get_stock_name(code),
        "as_of": as_of,
        "unit": {
            "net_buy_qty": "張",
            "balance": "張",
            "holding_ratio": "%",
        },
        "data": records,
        "source": "FinMind",
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
    """即時最佳五檔（live snapshot，不可回測）。預設 TWSE MIS（免金鑰、官方）。

    book_source=auto 時富果失敗（常見為 429 頻率限制）自動退回 MIS，
    避免單一數據源被限流就整頁 502（book_source 明確指定 mis/fugle 則不退回，尊重明確指定）。
    """
    src = _book_source()
    if src == "mis":
        quote = twse_mis_client.get_quote(code)
        source = "TWSE MIS getStockInfo（官方、免金鑰）"
    elif (settings.book_source or "auto").lower() == "auto":
        try:
            quote = fugle_client.get_quote(code)
            source = "富果 Fugle intraday/quote"
        except DataSourceError as exc:
            log.warning("Fugle book 失敗（%s），退回 TWSE MIS：%s", code, exc)
            quote = twse_mis_client.get_quote(code)
            source = "TWSE MIS getStockInfo（官方、免金鑰；富果限流退回）"
    else:
        quote = fugle_client.get_quote(code)
        source = "富果 Fugle intraday/quote"
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


# ── 個股新聞輿情與情緒聚合（供階段6） ───────────────────────────────────────
def get_stock_news(code: str, limit: int = 30) -> dict:
    from app.factors.sentiment import classify_polarity
    import email.utils
    from datetime import timezone

    name = finmind_client.get_stock_name(code)
    keyword = name if name else code

    # 2. Query news
    raw_items = news_client.get_news(keyword=keyword, limit=limit)

    processed_items = []
    for it in raw_items:
        title = it.get("title") or ""
        summary = it.get("summary") or ""

        # Polarity tagging
        res = classify_polarity(f"{title} {summary}")

        # Source extraction
        source_feed = it.get("source_feed") or ""
        if source_feed == "cnyes":
            source = "鉅亨網"
        elif source_feed.startswith("google_news:"):
            source = source_feed.split(":", 1)[1]
            # Strip source suffix from Google News title if present
            suffix = f" - {source}"
            if title.endswith(suffix):
                title = title[:-len(suffix)].strip()
        else:
            source = "Google News"
            if " - " in title:
                parts = title.rsplit(" - ", 1)
                if len(parts) > 1 and len(parts[1]) < 20:
                    source = parts[1].strip()
                    title = parts[0].strip()

        # Published normalization
        pub_str = it.get("published")
        normalized_pub = pub_str
        if pub_str:
            try:
                # check if already ISO
                datetime.datetime.fromisoformat(pub_str)
                normalized_pub = pub_str
            except Exception:
                try:
                    dt = email.utils.parsedate_to_datetime(pub_str)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    normalized_pub = dt.isoformat()
                except Exception:
                    try:
                        sec = int(pub_str)
                        normalized_pub = datetime.datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()
                    except Exception:
                        normalized_pub = pub_str

        processed_items.append({
            "title": title,
            "summary": it.get("summary"),
            "url": it.get("url"),
            "source": source,
            "published": normalized_pub,
            "sentiment": {
                "label": res["label"],
                "score": res["score"],
                "hits": res["hits"]
            }
        })

    # 5. Overall summary
    positive_cnt = sum(1 for it in processed_items if it["sentiment"]["label"] == "positive")
    negative_cnt = sum(1 for it in processed_items if it["sentiment"]["label"] == "negative")
    neutral_cnt = sum(1 for it in processed_items if it["sentiment"]["label"] == "neutral")
    total_cnt = len(processed_items)

    polar_scores = [it["sentiment"]["score"] for it in processed_items if it["sentiment"]["hits"]]
    if polar_scores:
        overall_score = round(sum(polar_scores) / len(polar_scores), 1)
    else:
        overall_score = 50.0

    if overall_score > 50.0:
        overall_label = "positive"
    elif overall_score < 50.0:
        overall_label = "negative"
    else:
        overall_label = "neutral"

    as_of = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()

    return {
        "code": code,
        "name": name or code,
        "as_of": as_of,
        "summary": {
            "overall_label": overall_label,
            "overall_score": overall_score,
            "positive": positive_cnt,
            "negative": negative_cnt,
            "neutral": neutral_cnt,
            "total": total_cnt
        },
        "items": processed_items
    }


def search_symbols(q: str, limit: int = 20) -> list[dict[str, str]]:
    """搜尋台股代號或股名。
    比對規則：q 對 代號前綴 (stock_id.startswith(q)) 或 股名子字串 (q in stock_name) 皆命中；
    去重、依「代號前綴完全相符優先，其餘代號數字小→大」排序；截斷 limit（上限 50）。
    """
    if limit > 50:
        limit = 50
    q = (q or "").strip()
    if not q:
        return []

    all_symbols = finmind_client.list_symbols()

    # 比對
    matched = []
    for s in all_symbols:
        sid = s["stock_id"]
        sname = s["stock_name"]

        is_id_match = sid.startswith(q)
        is_name_match = q in sname

        if is_id_match or is_name_match:
            matched.append((sid, sname, is_id_match and sid == q))

    # 排序：
    # 1. 完全符合代號 (priority 0)
    # 2. 代號前綴符合 (priority 1)
    # 3. 股名子字串符合 (priority 2)
    # 相同優先度時依代號數值大小或字典序排序
    def sort_key(item):
        sid, sname, is_exact = item
        if is_exact:
            priority = 0
        elif sid.startswith(q):
            priority = 1
        else:
            priority = 2

        try:
            val = int(sid.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
        except ValueError:
            val = 999999
        return (priority, val, sid)

    matched.sort(key=sort_key)

    results = []
    for sid, sname, _ in matched[:limit]:
        results.append({
            "code": sid,
            "name": sname
        })
    return results


def get_company_profile(code: str) -> dict:
    return twse_openapi_client.fetch_company_profile(code)


DEFAULT_THRESHOLDS = {
    "retail": "≤50 張",
    "mid": "50–400 張",
    "large": ">400 張"
}


def _classify_dispersion_level(level_raw: Any) -> str | None:
    """歸併級距至 retail (1-8: ≤50張), mid (9-11: 50–400張), large (12-15: >400張)。
    Level 16 (差異數調整) / Level 17 (合計) 排除 (回傳 None)。
    """
    try:
        lvl_int = int(level_raw)
        if lvl_int <= 8:
            return "retail"
        elif lvl_int <= 11:
            return "mid"
        elif lvl_int <= 15:
            return "large"
        else:
            return None
    except (ValueError, TypeError):
        pass

    s = str(level_raw).replace(",", "").strip()
    if "差異" in s or "合計" in s or "總計" in s:
        return None

    if "-" in s:
        parts = s.split("-")
        try:
            high = int(parts[1].rstrip("股張"))
            if high <= 50000:
                return "retail"
            elif high <= 400000:
                return "mid"
            else:
                return "large"
        except (ValueError, IndexError):
            pass
    elif ">" in s or "以上" in s or "超過" in s:
        return "large"

    return None


def aggregate_dispersion(rows: list[dict[str, Any]], thresholds: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """將每週級距聚合為 retail / mid / large 三組，排除 level 16/17，並計算人數與 delta。"""
    if not rows:
        return []

    by_date: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = str(r.get("date") or "").strip()
        if not d:
            continue

        cat = _classify_dispersion_level(r.get("HoldingSharesLevel") or r.get("holding_shares_level") or r.get("level"))
        if cat is None:
            continue

        if d not in by_date:
            by_date[d] = {
                "retail": {"people": 0, "shares_pct": 0.0},
                "mid": {"people": 0, "shares_pct": 0.0},
                "large": {"people": 0, "shares_pct": 0.0},
            }

        p_val = r.get("people") or r.get("People") or r.get("number_of_people") or 0
        try:
            people_cnt = int(p_val)
        except (ValueError, TypeError):
            people_cnt = 0
        by_date[d][cat]["people"] += people_cnt

        pct_val = r.get("percent") or r.get("Percent") or r.get("shares_pct") or 0.0
        try:
            pct_float = float(pct_val)
        except (ValueError, TypeError):
            pct_float = 0.0
        by_date[d][cat]["shares_pct"] += pct_float

    sorted_dates = sorted(by_date.keys())
    weekly: list[dict[str, Any]] = []

    prev_counts: dict[str, int] | None = None

    for d in sorted_dates:
        day_data = by_date[d]
        item: dict[str, Any] = {"date": d}

        for cat in ("retail", "mid", "large"):
            cnt = day_data[cat]["people"]
            pct = round(day_data[cat]["shares_pct"], 2)

            delta: int | None = None
            if prev_counts is not None and cat in prev_counts:
                delta = cnt - prev_counts[cat]

            item[cat] = {
                "people": cnt,
                "people_delta": delta,
                "shares_pct": pct
            }

        prev_counts = {cat: day_data[cat]["people"] for cat in ("retail", "mid", "large")}
        weekly.append(item)

    return weekly


def get_shareholding_dispersion(code: str, weeks: int = 16) -> dict:
    today_str = _date.today().isoformat()
    try:
        tdcc_client.save_snapshot()
        rows = tdcc_client.load_history(code, weeks)
        weekly = aggregate_dispersion(rows, DEFAULT_THRESHOLDS)
        if len(weekly) > weeks:
            weekly = weekly[-weeks:]

        stock_name = finmind_client.get_stock_name(code)
        return {
            "code": code,
            "name": stock_name if stock_name != code else "個股",
            "levels": DEFAULT_THRESHOLDS,
            "weekly": weekly,
            "source": "TDCC 集保戶股權分散表 (id=1-5)",
            "as_of": weekly[-1]["date"] if weekly else today_str
        }
    except Exception as exc:
        print(f"[service] get_shareholding_dispersion error: {exc}")

    stock_name = finmind_client.get_stock_name(code)
    return {
        "code": code,
        "name": stock_name if stock_name != code else "個股",
        "levels": DEFAULT_THRESHOLDS,
        "weekly": [],
        "source": "TDCC 集保戶股權分散表 (id=1-5)",
        "as_of": today_str
    }


