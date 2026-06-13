"""因子層共用型別（階段 3）。

每個因子計算回 `FactorSeries`：一條 date-indexed 的 0~100 分數序列 + 子訊號明細 + 信心序列。
- `/signal`（單日）取最後一列 → 組 `FactorScore`（見 contracts/FactorScore.md）。
- 回測取整條序列向量化。

降級規則（scoring-model §0.5）：某子訊號算不出 → 不納入、對剩餘子訊號重正規化、
信心下降、在 `note` 標註；整個因子無資料 → `available=False`，由上層退出加權重正規化。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class FactorSeries:
    key: str                                   # technical/chips/sentiment/...
    name: str                                  # 中文名
    score: pd.Series                           # 0~100，date index
    confidence: pd.Series                      # 0~1，date index
    subs: pd.DataFrame = field(default_factory=pd.DataFrame)  # 子訊號明細
    live_only: bool = False
    available: bool = True
    note: str = ""

    def latest(self) -> dict:
        """取最後一個有效日 → FactorScore 用的 dict（不含 weight，由引擎填）。"""
        if self.score.empty:
            return {
                "key": self.key, "name": self.name, "score": 50.0,
                "confidence": 0.0, "live_only": self.live_only,
                "inputs": {}, "note": self.note or "無資料",
            }
        i = self.score.index[-1]
        inputs = {}
        if not self.subs.empty and i in self.subs.index:
            row = self.subs.loc[i]
            inputs = {k: _clean(v) for k, v in row.to_dict().items()}
        return {
            "key": self.key,
            "name": self.name,
            "score": round(float(self.score.loc[i]), 1),
            "confidence": round(float(self.confidence.loc[i]), 2),
            "live_only": self.live_only,
            "inputs": inputs,
            "note": self.note,
        }


def _clean(v):
    """把 numpy 型別轉成 JSON 可序列化的 python 原生型別。"""
    if isinstance(v, (np.floating, float)):
        return None if (v is None or (isinstance(v, float) and np.isnan(v))) else round(float(v), 4)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    return v


def weighted_average(subs: dict[str, pd.Series], weights: dict[str, float],
                     index: pd.Index) -> tuple[pd.Series, pd.Series]:
    """對「實際可得」的子訊號加權平均並重正規化（缺項退出），回 (score, coverage)。

    coverage = 實際納入權重佔總權重比例 → 供上層折算 confidence。
    """
    total = pd.Series(0.0, index=index)
    wsum = pd.Series(0.0, index=index)
    for k, s in subs.items():
        w = weights.get(k, 0.0)
        if w <= 0:
            continue
        valid = s.notna()
        contrib = s.fillna(0.0) * w
        total = total.add(contrib.where(valid, 0.0), fill_value=0.0)
        wsum = wsum.add(pd.Series(w, index=index).where(valid, 0.0), fill_value=0.0)
    score = (total / wsum.replace(0.0, np.nan)).fillna(50.0)
    coverage = (wsum / sum(w for w in weights.values() if w > 0)).clip(0.0, 1.0)
    return score, coverage
