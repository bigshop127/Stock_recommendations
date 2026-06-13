"""F_technical（技術面，可回測）— scoring-model §1.1。

子訊號（皆 causal，只用當日收盤前已知）：
- MA 多頭排列：5>10>20>60 站上幾條（結構門檻映射）
- 乖離率 BIAS20：適度正乖離佳、過熱扣分（三角映射）
- 量能：量/5 日均量 的滾動分位數，量增配合上漲加分、配合下跌降分
- RSI(14)：50~70 動能加分、>80 過熱扣分、自超賣翻揚加分（確定性映射）
- 三陽開泰：連 3 根收紅（收>開）

指標用純 pandas 自寫（phase3 §3：不裝 pandas-ta），無未來函數。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.factors import normalize as nz
from app.factors.base import FactorSeries
from app.factors.config import FactorConfig


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Wilder RSI（causal）。"""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    rsi = 100.0 - 100.0 / (1.0 + rs)
    return rsi.fillna(50.0)


def compute_technical(ohlcv: pd.DataFrame, cfg: FactorConfig) -> FactorSeries:
    name = "技術面"
    if ohlcv is None or ohlcv.empty:
        idx = pd.Index([], name="date")
        return FactorSeries("technical", name, pd.Series(dtype=float), pd.Series(dtype=float),
                            available=False, note="無 OHLCV 資料")

    df = ohlcv.sort_index()
    close, vol = df["close"].astype(float), df["volume"].astype(float)
    op = df["open"].astype(float)
    idx = df.index
    w = cfg.technical_sub

    # 1) MA 多頭排列：站上 5/10/20/60 與排列順序
    ma5, ma10, ma20, ma60 = (close.rolling(n, min_periods=n).mean() for n in (5, 10, 20, 60))
    aligned = (
        (close > ma5).astype(int) + (ma5 > ma10).astype(int)
        + (ma10 > ma20).astype(int) + (ma20 > ma60).astype(int)
    )  # 0~4
    s_ma = nz.linear_score(aligned, 0, 4)

    # 2) 乖離率 BIAS20：適度正乖離(~+3%)佳，過熱(>+12%)/負乖離扣分
    bias20 = (close - ma20) / ma20 * 100.0
    s_bias = nz.triangular_score(bias20, peak=3.0, half_width=12.0, base=20.0, top=100.0)

    # 3) 量能：量/5日均量 分位數；配合漲跌調整方向
    vol_ratio = vol / vol.rolling(5, min_periods=5).mean()
    s_vol_raw = nz.rolling_percentile(vol_ratio, cfg.normalize.window, cfg.normalize.min_periods)
    up_day = close.pct_change() > 0
    # 量增配合上漲 → 用原分位；量增配合下跌 → 反向（高量下跌偏出貨）
    s_vol = s_vol_raw.where(up_day, 100.0 - s_vol_raw)

    # 4) RSI(14)
    rsi = _rsi(close, 14)
    rsi_prev = rsi.shift(1)
    s_rsi = pd.Series(50.0, index=idx)
    s_rsi = s_rsi.mask((rsi >= 50) & (rsi <= 70), 85.0)        # 動能區
    s_rsi = s_rsi.mask((rsi > 70) & (rsi <= 80), 65.0)          # 偏強
    s_rsi = s_rsi.mask(rsi > 80, 35.0)                          # 過熱
    s_rsi = s_rsi.mask((rsi < 50) & (rsi >= 40), 45.0)
    s_rsi = s_rsi.mask(rsi < 40, 30.0)
    s_rsi = s_rsi.mask((rsi < 50) & (rsi > rsi_prev) & (rsi_prev < 35), 70.0)  # 自超賣翻揚

    # 5) 三陽開泰：連 3 根收紅
    red = (close > op)
    three_red = red & red.shift(1) & red.shift(2)
    s_three = pd.Series(40.0, index=idx).mask(three_red, 90.0)

    subs = pd.DataFrame({
        "ma_aligned_count": aligned,
        "bias20_pct": bias20,
        "vol_ratio": vol_ratio,
        "rsi14": rsi,
        "three_red": three_red.astype(int),
        "s_ma": s_ma, "s_bias": s_bias, "s_vol": s_vol, "s_rsi": s_rsi, "s_three": s_three,
    }, index=idx)

    score = (
        w.ma_alignment * s_ma + w.bias20 * s_bias + w.volume * s_vol
        + w.rsi * s_rsi + w.three_red * s_three
    )

    # 信心：MA60 需 60 根；資料夠長才滿信心
    n = np.arange(1, len(idx) + 1)
    confidence = pd.Series(np.clip(n / 60.0, 0.3, 0.9), index=idx)

    return FactorSeries("technical", name, score.clip(0, 100), confidence, subs=subs,
                        note="技術面：MA排列/乖離/量能/RSI/三陽開泰")
