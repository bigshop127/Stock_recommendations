"""多 agent 編排（階段5）— 輕量自寫有向流程 ＋ 共享 state。

流程（每股）：
    三分析師 → 多空辯論（1 輪）→ 交易員決策 → 風控檢查 → 一致性守門 → 報告

**一致性守門（確定性，非靠 LLM）**：把最終決策方向與 `/signal/blended` 的量化方向對照，
若背離量化（多翻空/空翻多）卻沒被風控點名 → 主動標 `warning`，確保「背離有被點名、
而非被無視硬翻」（驗收標準）。不進回測；僅每日盤後對 watchlist（≤N）跑。
"""
from __future__ import annotations

from app.agents import roles
from app.agents.inputs import build_agent_inputs
from app.agents.llm_cli import Runner, UsageLog
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.puhui.watchlist import build_watchlist

_DIR_FROM_DECISION = {"BUY": "bull", "SELL": "bear", "HOLD": "neutral"}


def _dir_from_score(score: float | None, cfg: FactorConfig) -> str:
    if score is None:
        return "neutral"
    th = cfg.puhui
    if score >= th.quant_bull_th:
        return "bull"
    if score <= th.quant_bear_th:
        return "bear"
    return "neutral"


def _consistency(fact_base: dict, final_decision: str, risk: dict, trader: dict,
                 cfg: FactorConfig) -> dict:
    """最終決策 vs 量化 blended 的確定性一致性檢查。"""
    blended_dir = _dir_from_score(fact_base.get("blended_score"), cfg)
    agent_dir = _DIR_FROM_DECISION.get(final_decision, "neutral")
    divergent = (blended_dir == "bull" and agent_dir == "bear") or \
                (blended_dir == "bear" and agent_dir == "bull")
    notes = f"{risk.get('risk_notes', '')} {trader.get('rationale', '')}"
    flagged = bool(risk.get("conflict_acknowledged")) or any(
        k in notes for k in ("背離", "分歧", "衝突", "conflict"))
    warning = None
    if divergent and not flagged:
        warning = (f"⚠️ 最終決策（{final_decision}）與量化 blended 方向（{blended_dir}）背離，"
                   f"但風控/交易員未點名分歧——已由系統強制標記，未被無視硬翻。")
    return {
        "blended_direction": blended_dir,
        "agent_direction": agent_dir,
        "blended_conflict_quant_vs_puhui": fact_base.get("conflict"),
        "divergent_from_quant": divergent,
        "divergence_flagged": flagged or (not divergent),
        "warning": warning,
    }


def decide_one(code: str, date: str | None = None, *, cfg: FactorConfig = DEFAULT_CONFIG,
               runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    """單股完整多 agent 決策報告。"""
    usage = usage if usage is not None else UsageLog()
    inputs = build_agent_inputs(code, date, cfg)
    fact_base = inputs["fact_base"]

    analysts = roles.run_analysts(inputs, cfg=cfg, runner=runner, usage=usage)
    debate = roles.run_debate(inputs, analysts, cfg=cfg, runner=runner, usage=usage)
    trader = roles.trader_decide(inputs, analysts, debate, cfg=cfg, runner=runner, usage=usage)
    risk = roles.risk_review(inputs, trader, cfg=cfg, runner=runner, usage=usage)

    final_decision = risk.get("final_decision") or trader.get("decision") or "HOLD"
    consistency = _consistency(fact_base, final_decision, risk, trader, cfg)

    return {
        "code": code,
        "name": inputs.get("name"),
        "date": inputs.get("date"),
        "fact_base": fact_base,
        "analysts": analysts,
        "debate": debate,
        "trader": trader,
        "risk": risk,
        "final_decision": final_decision,
        "confidence": risk.get("confidence") if risk.get("confidence") is not None else trader.get("confidence"),
        "consistency": consistency,
        "degraded": inputs.get("degraded", []),
    }


def _watchlist_codes(date: str | None, top_n: int, cfg: FactorConfig) -> list[str]:
    wl = build_watchlist(date, cfg=cfg)
    items = [it for it in wl.get("items", []) if it.get("code")]
    items.sort(key=lambda it: (it.get("rank_swing") is None, it.get("rank_swing") or 9999))
    return [it["code"] for it in items[:top_n]]


def decide_many(codes: list[str] | None = None, date: str | None = None, *,
                cfg: FactorConfig = DEFAULT_CONFIG, runner: Runner | None = None) -> dict:
    """多股決策（codes 省略 → /watchlist 前 N，預設 ≤10）。共用一份 UsageLog 匯總用量。"""
    usage = UsageLog()
    if not codes:
        codes = _watchlist_codes(date, cfg.agents.watchlist_top_n, cfg)
    codes = codes[: cfg.agents.watchlist_top_n]

    decisions = []
    errors = []
    for code in codes:
        try:
            decisions.append(decide_one(code, date, cfg=cfg, runner=runner, usage=usage))
        except Exception as exc:  # noqa: BLE001 — 單股失敗不拖垮整批
            errors.append({"code": code, "error": str(exc)})

    return {
        "date": date,
        "count": len(decisions),
        "decisions": decisions,
        "errors": errors,
        "usage": usage.summarize(cfg.agents),
        "config": {
            "analysts": list(cfg.agents.analysts),
            "debate_rounds": cfg.agents.debate_rounds,
            "primary_provider": cfg.agents.primary_provider,
            "fallback_provider": cfg.agents.fallback_provider,
        },
    }
