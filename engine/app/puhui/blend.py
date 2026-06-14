"""融合訊號：量化（階段3 swing）× 老王（階段4）— 決策3，使用者 2026-06-14 定案。

規則（細節見 docs/blend-rules.md）：
1. **同向加成**：量化與老王同看多/同看空 → 信心 +`agree_conf_boost`。
2. **背離標記**：一方看多、另一方看空 → `conflict=True`、信心 −`conflict_conf_penalty`，
   **不直接蓋掉量化分**（量化仍是分數主體；老王只調信心＋標衝突）。
3. **water_level 大盤過濾**：老王持股水位 → `water_gate`，與階段3 `regime_gate`
   **取較嚴 min**（決策3）疊加，避免相乘雙重重罰。

老王個股訊號本就透過 `sentiment.puhui` 子訊號（0.20×0.5）進到 swing_score；
本層**不再把老王分數重加進核心分**（避免雙重計分），只做：信心調整＋衝突標記＋water gate。
"""
from __future__ import annotations

import numpy as np

from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.factors.swing import _action, build_swing_signal
from app.puhui import repo


def water_to_gate(water: float | None, cfg: FactorConfig = DEFAULT_CONFIG) -> float | None:
    """持股水位 0~1 → 大盤過濾乘數（clamp）；water 缺 → None（不過濾）。"""
    if water is None:
        return None
    pc = cfg.puhui
    g = pc.water_gate_intercept + pc.water_gate_slope * water
    return round(float(np.clip(g, pc.water_gate_floor, pc.water_gate_cap)), 3)


def _direction(score: float, bull_th: float, bear_th: float) -> str:
    if score >= bull_th:
        return "bull"
    if score <= bear_th:
        return "bear"
    return "neutral"


def assess_agreement(quant_score: float, puhui_score: float | None,
                     cfg: FactorConfig = DEFAULT_CONFIG) -> tuple[str, bool]:
    """(agreement, conflict)。agreement ∈ aligned|divergent|neutral|no_puhui。"""
    if puhui_score is None:
        return "no_puhui", False
    pc = cfg.puhui
    qd = _direction(quant_score, pc.quant_bull_th, pc.quant_bear_th)
    pd_ = _direction(puhui_score, pc.puhui_bull_th, pc.puhui_bear_th)
    if qd == "neutral" or pd_ == "neutral":
        return "neutral", False
    if qd == pd_:
        return "aligned", False
    return "divergent", True   # 一多一空 → 背離


def build_blended_signal(code: str, date: str | None = None,
                         cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """量化 swing + 老王 → 融合 StockSignal（含 conflict 標記與雙方理由）。"""
    swing = build_swing_signal(code, date, cfg)
    quant_score = float(swing["score"])
    regime_gate = swing.get("regime_gate") or 1.0

    daily = repo.get_daily(date, cfg=cfg)
    puhui_stock = None
    water = None
    conf_factor = 1.0
    if daily:
        water = daily.get("water_level")
        conf_factor = daily.get("confidence_factor", 1.0)
        for s in daily.get("stocks", []):
            if str(s.get("code")) == str(code):
                puhui_stock = s
                break

    # ── water gate × regime gate 取較嚴 min（決策3）──────────────────────────
    water_gate = water_to_gate(water, cfg)
    final_gate = regime_gate if water_gate is None else min(regime_gate, water_gate)
    core = quant_score / regime_gate if regime_gate else quant_score   # 還原 pre-gate 核心
    blended_score = float(np.clip(core * final_gate, 0, 100))

    # ── 同向/背離（決策3）──────────────────────────────────────────────────────
    puhui_score = float(puhui_stock["score"]) if puhui_stock else None
    agreement, conflict = assess_agreement(quant_score, puhui_score, cfg)

    pc = cfg.puhui
    conf = float(swing["confidence"])
    if agreement == "aligned":
        conf = min(1.0, conf + pc.agree_conf_boost)
    elif agreement == "divergent":
        conf = max(pc.conf_floor, conf - pc.conflict_conf_penalty)
    if puhui_stock is not None:
        conf *= conf_factor   # 老王資料 stale/legacy → 折扣（fresh 時 factor=1.0）
    confidence = round(float(np.clip(conf, 0, 1)), 2)

    # ── reasons / 老王區塊 ─────────────────────────────────────────────────────
    reasons = list(swing.get("reasons", []))
    puhui_block = None
    if puhui_stock:
        puhui_block = {
            "signal": puhui_stock["signal"], "score": puhui_stock["score"],
            "emoji": puhui_stock.get("emoji"), "stance": puhui_stock.get("stance"),
            "reason": puhui_stock.get("reason"), "raw_action": puhui_stock.get("raw_action"),
            "as_of_date": daily["as_of_date"], "stale": daily["stale"],
        }
        tag = {"aligned": "✅同向", "divergent": "⚠️背離", "neutral": "中性", "no_puhui": ""}[agreement]
        reasons.append(f"老王 {puhui_stock['emoji'] or ''}{puhui_stock['signal']}"
                       f"（{puhui_stock.get('raw_action') or puhui_stock.get('reason') or ''}）{tag}".strip())
        if conflict:
            reasons.append("⚠️ 量化與老王方向背離 → 標記 conflict、降信心，未蓋掉量化分")
        if daily["stale"]:
            reasons.append(f"老王觀點沿用 {daily['as_of_date']}（{daily['fallback_days']} 天前）")
    else:
        reasons.append("老王當日未提及此股 → 僅量化訊號")
    if water is not None:
        reasons.append(f"老王持股水位 {water:.0%} → water_gate {water_gate}；"
                       f"與 regime_gate {regime_gate} 取較嚴 → {round(final_gate, 3)}")

    return {
        **swing,
        "mode": "blended",
        "score": round(blended_score, 1),
        "action": _action(blended_score, cfg),
        "confidence": confidence,
        "reasons": reasons,
        "puhui": puhui_block,
        "agreement": agreement,
        "conflict": conflict,
        "blend": {
            "quant_swing_score": round(quant_score, 1),
            "regime_gate": round(regime_gate, 3),
            "water_level": water,
            "water_gate": water_gate,
            "final_gate": round(final_gate, 3),
        },
    }
