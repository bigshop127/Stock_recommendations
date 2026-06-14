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
from app.puhui.blend import build_blended_signal

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


@router.get("/blended", summary="量化 × 老王 融合訊號（含 conflict 標記與雙方理由）")
def signal_blended(
    code: str = Query(..., description="台股代號，例 2330"),
    date: str | None = Query(None, description="訊號日 YYYY-MM-DD（省略=最近交易日）"),
):
    """階段4：swing 量化訊號 + 老王觀點融合。

    - 同向 → 提升信心；背離 → `conflict=true`、降信心，**不蓋掉量化分**。
    - 老王持股水位 `water_level` × 階段3 regime gate **取較嚴 min**。
    """
    try:
        return build_blended_signal(code, date)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"融合訊號計算失敗：{exc}") from exc
