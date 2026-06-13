"""/signal 端點（階段 3）— 個股訊號。

GET /signal?code=2330&date=&mode=swing|daytrade → 一筆 StockSignal。
- swing：technical+chips+sentiment × regime gate（可回測因子 + live 情緒）。
- daytrade：live-only 盤口/分K（階段3 後段 checkpoint 後實作）。

沿用階段 2 慣例：取數走 service、DataSourceError→502。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.data.http import DataSourceError
from app.factors.daytrade import build_daytrade_signal
from app.factors.swing import build_swing_signal

router = APIRouter(prefix="/signal", tags=["signal"])


@router.get("", summary="個股訊號（swing 可回測；daytrade live-only）")
def signal(
    code: str = Query(..., description="台股代號，例 2330"),
    date: str | None = Query(None, description="訊號日 YYYY-MM-DD（省略=最近交易日）"),
    mode: str = Query("swing", description="swing | daytrade"),
):
    if mode == "swing":
        try:
            return build_swing_signal(code, date)
        except DataSourceError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"訊號計算失敗：{exc}") from exc
    if mode == "daytrade":
        try:
            return build_daytrade_signal(code)
        except DataSourceError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"當沖訊號計算失敗：{exc}") from exc
    raise HTTPException(status_code=400, detail=f"未知 mode：{mode}（swing|daytrade）")
