"""子訊號 → 0~100 正規化工具（階段 3）。

定案（使用者 2026-06-13）：**滾動分位數為主**。
- 分佈型子訊號（量比、法人淨買、乖離…）：`rolling_percentile`——每個 t 取「過去視窗(含當日)」
  的分位數 → 天生有界 0~100、抗離群、**只用 t 及之前資料 = 無未來函數**。
- 結構/布林型子訊號（MA 站上幾條、三陽開泰、連買天數）：`threshold_score` / `linear_score` 確定性映射。

所有函式皆為純向量化、causal（不看未來），可直接用於回測序列。
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def rolling_percentile(s: pd.Series, window: int = 252, min_periods: int = 20) -> pd.Series:
    """每個 t 的值在「過去 window 個值(含當日)」中的百分位 → 0~100。

    無未來函數：rolling 視窗只涵蓋 t 及更早。樣本不足 min_periods → 回中性 50。
    """
    s = s.astype(float)

    def _pct(arr: np.ndarray) -> float:
        n = len(arr)
        if n < 2:
            return 50.0
        last = arr[-1]
        # 當日值在視窗中的排名百分位（含等值的一半，避免極端跳動）
        less = np.sum(arr < last)
        equal = np.sum(arr == last)
        return (less + 0.5 * equal) / n * 100.0

    out = s.rolling(window=window, min_periods=min_periods).apply(_pct, raw=True)
    return out.fillna(50.0)


def linear_score(x: pd.Series | float, lo: float, hi: float) -> pd.Series | float:
    """把 [lo,hi] 線性映到 [0,100]（超界 clamp）。x<lo→0，x>hi→100。"""
    if isinstance(x, pd.Series):
        return ((x - lo) / (hi - lo) * 100.0).clip(0.0, 100.0)
    return clamp((x - lo) / (hi - lo) * 100.0)


def threshold_score(x: pd.Series, breakpoints: list[tuple[float, float]]) -> pd.Series:
    """分段門檻映射：breakpoints=[(門檻, 分數), ...] 由小到大。

    x < 第一門檻 → 第一分數；落在 [bp_i, bp_{i+1}) → bp_i 的分數；≥ 最後門檻 → 最後分數。
    用於布林/離散結構訊號（連買天數、站上幾條 MA 等）。
    """
    x = x.astype(float)
    result = pd.Series(breakpoints[0][1], index=x.index, dtype=float)
    for thr, score in breakpoints:
        result = result.mask(x >= thr, score)
    return result


def triangular_score(x: pd.Series, peak: float, half_width: float,
                     base: float = 30.0, top: float = 100.0) -> pd.Series:
    """三角形映射：在 peak 給 top 分，偏離 peak 線性遞減至 base（用於「適度為佳」的乖離率）。

    |x-peak| >= half_width → base；x==peak → top。
    """
    x = x.astype(float)
    dist = (x - peak).abs() / half_width
    score = top - (top - base) * dist
    return score.clip(base, top)


def consecutive_positive(s: pd.Series) -> pd.Series:
    """連續為正的天數（causal）。每個 t 回到 t 為止連續 >0 的長度。"""
    s = s.astype(float)
    pos = (s > 0).astype(int)
    # 連續計數：在每段非零區塊內累加，遇 0 歸零
    grp = (pos == 0).cumsum()
    return pos.groupby(grp).cumsum()
