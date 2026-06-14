"""多 agent LLM 決策層 API（階段5）。

`POST /agents/decide`（body：`{codes?: string[], date?: string}`）
→ 每股一份多 agent 決策報告（各 agent 意見 ＋ 多空辯論摘要 ＋ 最終決策 ＋ 信心
  ＋ 對照 blended_score 的一致性檢查 ＋ LLM 用量遙測）。
`codes` 省略 → 取 `/watchlist` 前 N（預設 ≤10）。

**不進回測**；僅每日盤後對觀察清單跑。所有 LLM 走 Gemini CLI 主 → Claude CLI 備援。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from app.agents.orchestrator import decide_many
from app.data.http import DataSourceError

router = APIRouter(prefix="/agents", tags=["agents"])


@router.post("/decide", summary="多 agent 決策（分析師→多空辯論→交易員→風控）")
def decide(payload: dict = Body(default={}, examples=[{"codes": ["2330", "2317"], "date": None}])):
    codes = payload.get("codes")
    date = payload.get("date")
    if codes is not None and not isinstance(codes, list):
        raise HTTPException(status_code=400, detail="codes 須為字串陣列或省略")
    try:
        return decide_many(codes, date)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"多 agent 決策失敗：{exc}") from exc
