"""F_chips（籌碼面，可回測）— scoring-model §1.1。

子訊號（causal，三大法人/融資券於當日盤後公布，T 收盤後已知，供 T+1 決策）：
- 三大法人連買：外資連續淨買超天數 × 金額分位
- 投信認養：投信連買天數（中小型權重高）
- 融資增減：融資減=籌碼乾淨(加分)、融資暴增追高(扣分)
- 券資比/軋空：高券資比 = 軋空題材加分

數據源 FinMind（service.get_chips）。單位：法人為股、融資券為張。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.factors import normalize as nz
from app.factors.base import FactorSeries
from app.factors.config import FactorConfig


def compute_chips(chips: pd.DataFrame, cfg: FactorConfig) -> FactorSeries:
    name = "籌碼面"
    if chips is None or chips.empty:
        return FactorSeries("chips", name, pd.Series(dtype=float), pd.Series(dtype=float),
                            available=False, note="無籌碼資料")

    df = chips.sort_index()
    idx = df.index
    w = cfg.chips_sub
    win, mp = cfg.normalize.window, cfg.normalize.min_periods

    def col(c: str) -> pd.Series:
        return df[c].astype(float) if c in df.columns else pd.Series(np.nan, index=idx)

    foreign, trust = col("foreign_net"), col("trust_net")
    margin_chg, margin_bal = col("margin_change"), col("margin_balance")
    short_bal = col("short_balance")

    # 1) 外資連買：連續天數 + 當日金額分位
    f_streak = nz.consecutive_positive(foreign)
    s_streak = nz.threshold_score(f_streak, [(0, 35.0), (1, 55.0), (3, 75.0), (5, 90.0)])
    f_mag = nz.rolling_percentile(foreign, win, mp)        # 淨買金額相對自身歷史
    s_foreign = 0.6 * s_streak + 0.4 * f_mag

    # 2) 投信認養：連買天數
    t_streak = nz.consecutive_positive(trust)
    s_trust = nz.threshold_score(t_streak, [(0, 40.0), (1, 60.0), (3, 80.0), (5, 92.0)])

    # 3) 融資增減：以「融資變動/餘額」衡量；融資減=加分、暴增=扣分（反向分位）
    margin_pct = (margin_chg / margin_bal.replace(0.0, np.nan)).replace([np.inf, -np.inf], np.nan)
    s_margin = 100.0 - nz.rolling_percentile(margin_pct.fillna(0.0), win, mp)  # 融資增→分位高→扣分

    # 4) 券資比 / 軋空：short/margin 比值越高，軋空題材分越高
    sm_ratio = (short_bal / margin_bal.replace(0.0, np.nan)).replace([np.inf, -np.inf], np.nan)
    s_squeeze = nz.rolling_percentile(sm_ratio.fillna(0.0), win, mp)

    subs = pd.DataFrame({
        "foreign_net": foreign,
        "foreign_streak": f_streak,
        "trust_streak": t_streak,
        "margin_change_pct": margin_pct,
        "short_margin_ratio": sm_ratio,
        "s_foreign": s_foreign, "s_trust": s_trust, "s_margin": s_margin, "s_squeeze": s_squeeze,
    }, index=idx)

    score = (
        w.foreign_streak * s_foreign + w.trust_streak * s_trust
        + w.margin * s_margin + w.short_squeeze * s_squeeze
    )

    # 信心：有法人 + 融資券雙源 → 高；單源 → 降
    has_inst = foreign.notna() | trust.notna()
    has_margin = margin_bal.notna()
    confidence = pd.Series(0.5, index=idx)
    confidence = confidence.mask(has_inst & has_margin, 0.82)
    confidence = confidence.mask(has_inst ^ has_margin, 0.6)

    return FactorSeries("chips", name, score.clip(0, 100), confidence, subs=subs,
                        note="籌碼面：法人連買/投信/融資增減/券資比")
