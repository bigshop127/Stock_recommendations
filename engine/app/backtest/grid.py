"""權重調整掛勾（phase3 §5）— 簡單網格，先不上重型最佳化。

掃 (technical:chips 權重比、entry/exit 門檻) → 跑回測 → 依 sharpe（maxDD 不破門檻）挑最佳。
結果回填 `engine/app/factors/config.py` 的設定物件（人工確認後）。權重不散落計算邏輯。

注意：回測排除 sentiment，故只掃 technical/chips 兩者比例（其和正規化為 1）。
"""
from __future__ import annotations

from dataclasses import replace

from app.backtest.engine import run_backtest
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.factors.regime import compute_regime_series


def grid_search(codes: list[str], start: str, end: str,
                tech_weights: list[float] | None = None,
                entry_scores: list[float] | None = None,
                exit_scores: list[float] | None = None,
                max_dd_limit: float = -0.40,
                base_cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """回 {best, grid:[...]}。best 依 sharpe 取最高（且 maxDD 不低於 max_dd_limit）。"""
    tech_weights = tech_weights or [0.3, 0.4, 0.5, 0.6, 0.7]
    entry_scores = entry_scores or [65.0, 70.0, 75.0]
    exit_scores = exit_scores or [40.0, 45.0, 50.0]

    regime = compute_regime_series(start, end, base_cfg)   # 算一次共用，省 API
    results = []
    for tw in tech_weights:
        cw = round(1.0 - tw, 3)
        cfg = replace(base_cfg, swing=replace(base_cfg.swing, technical=tw, chips=cw, sentiment=0.0))
        for en in entry_scores:
            for ex in exit_scores:
                if ex >= en:
                    continue
                bt = run_backtest(codes, start, end, cfg, entry_score=en, exit_score=ex, regime=regime)
                m = bt["metrics"]
                results.append({
                    "technical": tw, "chips": cw, "entry_score": en, "exit_score": ex,
                    "sharpe": m["sharpe"], "cum_return": m["cum_return"],
                    "max_drawdown": m["max_drawdown"], "win_rate": m["win_rate"],
                    "trades": m["trades"],
                })

    eligible = [r for r in results if r["max_drawdown"] >= max_dd_limit] or results
    best = max(eligible, key=lambda r: r["sharpe"]) if eligible else None
    return {"best": best, "grid": sorted(results, key=lambda r: r["sharpe"], reverse=True)}
