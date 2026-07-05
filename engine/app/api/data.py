"""/data/* 端點（階段 2：台股數據層）。

可回測：/data/ohlcv、/data/chips（FinMind）、/data/futures（TAIFEX）、/data/macro（FRED）。
live-only：/data/book（TWSE MIS 預設，富果可選）、/data/intraday、/data/news。
大盤環境：/data/market（yfinance）。

金鑰缺失或數據源錯誤 → 502 + 明確訊息（不靜默回空）。
"""
from __future__ import annotations

from datetime import date as _date, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.data import service
from app.data.http import DataSourceError

router = APIRouter(prefix="/data", tags=["data"])


def _default_range() -> tuple[str, str]:
    end = _date.today()
    start = end - timedelta(days=365)
    return start.isoformat(), end.isoformat()


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # 對外數據源未知錯誤
        raise HTTPException(status_code=502, detail=f"數據源錯誤：{exc}") from exc


@router.get("/ohlcv", summary="日K OHLCV（FinMind，可回測）")
def ohlcv(
    code: str = Query(..., description="台股代號，例 2330"),
    start: str | None = Query(None, description="起日 YYYY-MM-DD（預設近一年）"),
    end: str | None = Query(None, description="迄日 YYYY-MM-DD（預設今日）"),
):
    d_start, d_end = _default_range()
    return _guard(service.get_ohlcv, code, start or d_start, end or d_end)


@router.get("/ohlcv_adj", summary="還原日K OHLCV（yfinance auto_adjust：含除權息/分割，可回測）")
def ohlcv_adj(
    code: str = Query(..., description="台股代號，例 2330"),
    start: str | None = Query(None, description="起日 YYYY-MM-DD（預設近一年）"),
    end: str | None = Query(None, description="迄日 YYYY-MM-DD（預設今日）"),
):
    """FinMind 免費級未還原（0050 等分割股會失真）→ 本端點以 yfinance 還原價取代，供前端正確畫 K 線。"""
    d_start, d_end = _default_range()
    return _guard(service.get_ohlcv_adj, code, start or d_start, end or d_end)


@router.get("/chips", summary="籌碼：三大法人 + 融資券 + 外資持股比率（FinMind，可回測）")
def chips(
    code: str = Query(..., description="台股代號，例 2330"),
    days: int | None = Query(None, description="天數，預設 20"),
    start: str | None = Query(None, description="起日 YYYY-MM-DD"),
    end: str | None = Query(None, description="迄日 YYYY-MM-DD"),
):
    return _guard(service.get_chips_series, code, start, end, days)


@router.get("/fundamentals", summary="基本面：估值 + 月營收 + 獲利能力 + 股利政策（FinMind，可回測）")
def fundamentals(
    code: str = Query(..., description="台股代號，例 2330"),
):
    return _guard(service.get_fundamentals, code)


@router.get("/profile", summary="個股公司基本檔（TWSE OpenAPI + 降級）")
def profile(
    code: str = Query(..., description="台股代號，例 2330"),
):
    return _guard(service.get_company_profile, code)



@router.get("/book", summary="即時最佳五檔（預設 TWSE MIS 免費；富果可選；live-only）")
def book(code: str = Query(..., description="台股代號，例 2330")):
    return _guard(service.get_book, code)


@router.get("/intraday", summary="盤中分K（富果；今日 live、過去日歷史受回溯限制）")
def intraday(
    code: str = Query(..., description="台股代號，例 2330"),
    date: str | None = Query(None, description="YYYY-MM-DD；省略=今日 live"),
    timeframe: str = Query("1", description="分鐘級：1/5/10/15/30/60"),
):
    return _guard(service.get_intraday, code, date, timeframe)


@router.get("/market", summary="大盤/美股指數快照（yfinance）")
def market(date: str | None = Query(None, description="YYYY-MM-DD；省略=最新交易日")):
    return _guard(service.get_market, date)


@router.get("/futures", summary="期貨/選擇權：三大法人未平倉 + P/C Ratio（TAIFEX，可回測）")
def futures(
    start: str | None = Query(None, description="起日 YYYY-MM-DD（預設近一年）"),
    end: str | None = Query(None, description="迄日 YYYY-MM-DD（預設今日）"),
    product: str = Query("TXF", description="期貨契約代號，預設臺股期貨 TXF（TX/TAIEX 亦可）"),
):
    d_start, d_end = _default_range()
    return _guard(service.get_futures, start or d_start, end or d_end, product)


@router.get("/news", summary="財經新聞（帶 keyword→Google News；否則鉅亨最新台股）")
def news(
    keyword: str | None = Query(None, description="關鍵字（股名/代號）；省略=鉅亨最新台股新聞"),
    limit: int = Query(30, ge=1, le=100, description="回傳則數上限"),
):
    return _guard(service.get_news, keyword, limit)


@router.get("/stock_news", summary="個股新聞輿情及情緒標記")
def stock_news(
    code: str = Query(..., description="台股代號，例 2330"),
    limit: int = Query(30, ge=1, le=100, description="回傳則數上限"),
):
    return _guard(service.get_stock_news, code, limit)



@router.get("/macro", summary="美國總經單一序列（FRED，可回測）")
def macro(
    series: str = Query(..., description="別名 us10y/yield_curve/cpi/unemployment/fed_funds/vix 或 FRED series_id"),
    start: str | None = Query(None, description="起日 YYYY-MM-DD（預設近一年）"),
    end: str | None = Query(None, description="迄日 YYYY-MM-DD（預設今日）"),
):
    d_start, d_end = _default_range()
    return _guard(service.get_macro, series, start or d_start, end or d_end)


@router.get("/symbols/search", summary="搜尋股票代號 or 股名")
def search_symbols(
    q: str = Query("", description="搜尋關鍵字（代號或股名）"),
    limit: int = Query(20, ge=1, le=50, description="回傳上限"),
):
    try:
        results = service.search_symbols(q, limit)
        return {
            "query": q,
            "count": len(results),
            "results": results,
            "source": "FinMind TaiwanStockInfo"
        }
    except DataSourceError as exc:
        return {
            "query": q,
            "count": 0,
            "results": [],
            "source": "FinMind TaiwanStockInfo",
            "degraded": True,
            "detail": str(exc)
        }
    except Exception as exc:
        return {
            "query": q,
            "count": 0,
            "results": [],
            "source": "FinMind TaiwanStockInfo",
            "degraded": True,
            "detail": f"未知錯誤：{exc}"
        }

