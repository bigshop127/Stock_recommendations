"""老王情報 API（階段4）。

- `GET /watchlist?date=`：自動觀察清單（波段/當沖分開排序、含標籤）。
- `GET /puhui/view?code=&date=`：純老王觀點查詢（解析結果原樣回，供前端/除錯）。

融合訊號 `GET /signal/blended` 在 `api/signal.py`（與既有 /signal 同 router）。
沿用階段2/3 慣例：DataSourceError → 502。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.data.http import DataSourceError
from app.puhui import repo
from app.puhui.watchlist import build_watchlist

router = APIRouter(tags=["puhui"])


@router.get("/watchlist", summary="自動觀察清單（波段潛力 / 當沖候選各自排序）")
def watchlist(
    date: str | None = Query(None, description="日期 YYYY-MM-DD（省略=最近一篇老王報告日）"),
):
    try:
        return build_watchlist(date)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"觀察清單建立失敗：{exc}") from exc


@router.get("/puhui/view", summary="純老王觀點（解析結果原樣回）")
def puhui_view(
    code: str | None = Query(None, description="台股代號；省略=回當日全部個股"),
    date: str | None = Query(None, description="日期 YYYY-MM-DD（省略=最近一篇）"),
):
    daily = repo.get_daily(date)
    if not daily:
        raise HTTPException(status_code=404, detail="fallback 視窗內無任何老王報告")
    if code is None:
        return daily
    stock = repo.get_stock(code, date)
    if stock is None:
        raise HTTPException(
            status_code=404,
            detail=f"老王 {daily['as_of_date']} 報告未提及 {code}（或代號未解析）",
        )
    return {
        "date": daily["requested_date"],
        "as_of_date": daily["as_of_date"],
        "stale": daily["stale"],
        "water_level": daily["water_level"],
        "market_sentiment": daily["market_sentiment"],
        "stock": stock,
    }
