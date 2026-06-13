"""/backtest 端點（階段 3）— 波段策略向量化回測。

POST /backtest  body: { codes[], start, end, weights?, entry_score?, exit_score?, cost? }
→ BacktestResult（metrics + equity_curve + 0050 benchmark）。

只回測 swing；live_only 因子不進輸入（契約強制）。DataSourceError→502。
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date as _date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.backtest.engine import run_backtest
from app.backtest.grid import grid_search
from app.data.http import DataSourceError
from app.factors.config import DEFAULT_CONFIG

router = APIRouter(prefix="/backtest", tags=["backtest"])


class CostBody(BaseModel):
    fee_rate: float | None = None
    fee_discount: float | None = None
    tax_rate: float | None = None


class BacktestBody(BaseModel):
    codes: list[str] = Field(..., min_length=1, description="台股代號清單")
    start: str | None = Field(None, description="起日 YYYY-MM-DD（預設近 2 年）")
    end: str | None = Field(None, description="迄日 YYYY-MM-DD（預設今日）")
    weights: dict[str, float] | None = Field(None, description="覆寫 technical/chips 權重")
    entry_score: float | None = None
    exit_score: float | None = None
    cost: CostBody | None = None


def _default_period() -> tuple[str, str]:
    end = _date.today()
    return (end - timedelta(days=730)).isoformat(), end.isoformat()


def _build_cfg(body: BacktestBody):
    cfg = DEFAULT_CONFIG
    if body.weights:
        cfg = replace(cfg, swing=replace(cfg.swing, **{k: v for k, v in body.weights.items()
                                                       if k in ("technical", "chips", "sentiment")}))
    if body.cost:
        ck = {k: v for k, v in body.cost.model_dump().items() if v is not None}
        if ck:
            cfg = replace(cfg, cost=replace(cfg.cost, **ck))
    return cfg


@router.post("", summary="波段策略回測（含成本 + 0050 benchmark）")
def backtest(body: BacktestBody):
    d_start, d_end = _default_period()
    start, end = body.start or d_start, body.end or d_end
    cfg = _build_cfg(body)
    try:
        return run_backtest(body.codes, start, end, cfg,
                            entry_score=body.entry_score, exit_score=body.exit_score)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"回測失敗：{exc}") from exc


class GridBody(BacktestBody):
    tech_weights: list[float] | None = None
    entry_scores: list[float] | None = None
    exit_scores: list[float] | None = None


@router.post("/grid", summary="權重/門檻網格掃描（挑最佳回填設定）")
def backtest_grid(body: GridBody):
    d_start, d_end = _default_period()
    start, end = body.start or d_start, body.end or d_end
    try:
        return grid_search(body.codes, start, end,
                           tech_weights=body.tech_weights,
                           entry_scores=body.entry_scores,
                           exit_scores=body.exit_scores)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"網格回測失敗：{exc}") from exc
