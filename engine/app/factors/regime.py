"""大盤環境閘門 regime gate（可回測）— scoring-model §1.2。

把多個環境輸入各映射到 [-1,+1]，加權平均成 regime_score∈[-1,1]，再**非對稱分段線性**
映到 gate∈[0.5,1.1]（順風緩獎、逆風重罰，使用者 2026-06-13 定案）：
    score≥0 → gate = 1.0 + 0.10·score   # [1.0,1.1]
    score<0 → gate = 1.0 + 0.50·score   # [0.5,1.0]

輸入（皆走 service，吃快取）：
- 0050 趨勢（站上 MA60）          ← get_ohlcv("0050")
- TAIFEX 外資期貨淨未平倉方向      ← get_futures（**A/D 漲跌家數 proxy 主力**）
- Put/Call ratio                  ← get_futures
- FRED 殖利率倒掛 / VIX            ← get_macro（需 key，缺則退出該子訊號＋降信心）

⚠️ A/D 漲跌家數無乾淨單一 dataset（data-layer §10）→ 用「外資期貨方向＋P/C＋VIX」proxy，
   輸出 note 明確標註「A/D 為 proxy」。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from app.data import service
from app.data.http import DataSourceError
from app.factors import normalize as nz
from app.factors.config import FactorConfig

_REGIME_WINDOW = 252
_MIN_PERIODS = 20


@dataclass
class RegimeResult:
    gate: pd.Series          # 0.5~1.1，date index
    score: pd.Series         # -1~1
    label: pd.Series         # risk_off/neutral/risk_on
    subs: pd.DataFrame
    confidence: pd.Series    # 0~1（依可得子訊號覆蓋率）
    note: str

    def latest(self) -> dict:
        if self.gate.empty:
            return {"gate": 1.0, "score": 0.0, "label": "neutral", "confidence": 0.3,
                    "note": self.note, "inputs": {}}
        i = self.gate.index[-1]
        inputs = {k: (None if pd.isna(v) else round(float(v), 4))
                  for k, v in self.subs.loc[i].to_dict().items()} if i in self.subs.index else {}
        return {
            "gate": round(float(self.gate.loc[i]), 3),
            "score": round(float(self.score.loc[i]), 3),
            "label": str(self.label.loc[i]),
            "confidence": round(float(self.confidence.loc[i]), 2),
            "note": self.note, "inputs": inputs,
        }


def _to_pm1(pct: pd.Series) -> pd.Series:
    """0~100 分位 → [-1,+1]。"""
    return (pct - 50.0) / 50.0


def _label(score: pd.Series) -> pd.Series:
    lab = pd.Series("neutral", index=score.index)
    lab = lab.mask(score <= -0.2, "risk_off")
    lab = lab.mask(score >= 0.2, "risk_on")
    return lab


def _gate(score: pd.Series, cfg: FactorConfig) -> pd.Series:
    r = cfg.regime
    up = 1.0 + r.gate_up_slope * score
    down = 1.0 + r.gate_down_slope * score
    gate = down.where(score < 0, up)
    return gate.clip(r.gate_floor, r.gate_cap)


def compute_regime_series(start: str, end: str, cfg: FactorConfig) -> RegimeResult:
    subs: dict[str, pd.Series] = {}
    weights: dict[str, float] = {}
    r = cfg.regime
    notes = ["A/D 漲跌家數用 proxy（外資期貨方向＋P/C＋VIX）"]

    # 1) 0050 趨勢（站上 MA60，距離正規化；還原價避免分割斷點造成假趨勢）
    try:
        ohlcv = _df(service.get_ohlcv_adj("0050", start, end))
        if not ohlcv.empty:
            close = ohlcv["close"].astype(float)
            ma60 = close.rolling(60, min_periods=60).mean()
            trend = ((close / ma60 - 1.0) / 0.05).clip(-1, 1)   # +5% 以上 → +1
            subs["index_trend"] = trend
            weights["index_trend"] = r.w_index_trend
    except DataSourceError as e:
        notes.append(f"0050 趨勢缺：{e}")

    # 2)/3) TAIFEX 外資期貨未平倉方向 + P/C ratio
    try:
        fut = _df(service.get_futures(start, end, "TXF"))
        if not fut.empty:
            if "foreign_oi_net" in fut.columns:
                pct = nz.rolling_percentile(fut["foreign_oi_net"].astype(float), _REGIME_WINDOW, _MIN_PERIODS)
                subs["foreign_fut"] = _to_pm1(pct)
                weights["foreign_fut"] = r.w_foreign_fut
            pc_col = "pc_oi_ratio" if "pc_oi_ratio" in fut.columns else (
                "pc_volume_ratio" if "pc_volume_ratio" in fut.columns else None)
            if pc_col:
                pc_pct = nz.rolling_percentile(fut[pc_col].astype(float), _REGIME_WINDOW, _MIN_PERIODS)
                subs["pc_ratio"] = -_to_pm1(pc_pct)   # P/C 升高 → 偏避險 risk_off
                weights["pc_ratio"] = r.w_pc_ratio
    except DataSourceError as e:
        notes.append(f"TAIFEX 缺：{e}")

    # 4) FRED 殖利率倒掛 + VIX（需 key；缺則退出並降信心）
    fred_ok = True
    try:
        yc = _df(service.get_macro("yield_curve", start, end))
        if not yc.empty:
            val = _series_value(yc)
            subs["yield_curve"] = (val / 0.5).clip(-1, 1)   # 正利差>0 健康；倒掛<0 risk_off
            weights["yield_curve"] = r.w_yield_curve
    except DataSourceError:
        fred_ok = False
    try:
        vix = _df(service.get_macro("vix", start, end))
        if not vix.empty:
            vpct = nz.rolling_percentile(_series_value(vix), _REGIME_WINDOW, _MIN_PERIODS)
            subs["vix"] = -_to_pm1(vpct)   # VIX 高 → risk_off
            weights["vix"] = r.w_vix
    except DataSourceError:
        fred_ok = False
    if not fred_ok:
        notes.append("FRED 無 key → 殖利率/VIX 子訊號退出、信心下降")

    if not subs:
        idx = pd.Index([], name="date")
        return RegimeResult(pd.Series(dtype=float), pd.Series(dtype=float), pd.Series(dtype=str),
                            pd.DataFrame(), pd.Series(dtype=float), "；".join(notes) + "（無任何環境源）")

    # 對齊到所有子訊號日期聯集，ffill（環境值於 T 收盤已知，可沿用至下一交易日）
    master = sorted(set().union(*[s.index for s in subs.values()]))
    master_idx = pd.Index(master, name="date")
    aligned = {k: s.reindex(master_idx).ffill() for k, s in subs.items()}

    total = pd.Series(0.0, index=master_idx)
    wsum = pd.Series(0.0, index=master_idx)
    for k, s in aligned.items():
        w = weights[k]
        valid = s.notna()
        total = total.add((s.fillna(0.0) * w).where(valid, 0.0), fill_value=0.0)
        wsum = wsum.add(pd.Series(w, index=master_idx).where(valid, 0.0), fill_value=0.0)
    score = (total / wsum.replace(0.0, np.nan)).fillna(0.0).clip(-1, 1)
    # coverage 以「全部應有環境權重」為分母 → 缺 TAIFEX/FRED 等子訊號時信心真實下降
    total_possible = r.w_index_trend + r.w_foreign_fut + r.w_pc_ratio + r.w_yield_curve + r.w_vix
    coverage = (wsum / total_possible).clip(0, 1)
    confidence = (0.4 + 0.5 * coverage).clip(0, 0.95)

    gate = _gate(score, cfg)
    label = _label(score)
    subs_df = pd.DataFrame(aligned)
    subs_df["regime_score"] = score
    subs_df["gate"] = gate
    return RegimeResult(gate, score, label, subs_df, confidence, "；".join(notes))


# ── helpers ──────────────────────────────────────────────────────────────────
def _df(resp: dict) -> pd.DataFrame:
    """service 回傳 dict → date-indexed DataFrame。"""
    data = resp.get("data", [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    if "date" in df.columns:
        df = df.sort_values("date").set_index("date")
    return df


def _series_value(df: pd.DataFrame) -> pd.Series:
    """FRED/單序列 dict 的數值欄（欄名常為 value）→ Series（date index）。"""
    for c in ("value", "vix", "yield_curve"):
        if c in df.columns:
            return df[c].astype(float)
    # 取第一個數值欄
    num = df.select_dtypes("number")
    return num.iloc[:, 0].astype(float) if not num.empty else pd.Series(dtype=float)
