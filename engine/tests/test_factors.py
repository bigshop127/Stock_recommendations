"""階段 3 因子層測試（純運算，不打網路）。

重點：正規化無未來函數、技術/籌碼因子合理、regime gate 非對稱映射、缺資料降級。
"""
import numpy as np
import pandas as pd

from app.factors import normalize as nz
from app.factors.config import DEFAULT_CONFIG, FactorConfig, RegimeConfig
from app.factors.chips import compute_chips
from app.factors.technical import compute_technical
from app.factors.regime import _gate


def _uptrend_ohlcv(n=160, seed=1):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2024-01-01", periods=n).strftime("%Y-%m-%d")
    close = np.linspace(100, 180, n) + rng.normal(0, 1.0, n)
    op = close - rng.normal(0, 0.4, n)
    return pd.DataFrame({
        "open": op, "high": np.maximum(op, close) + 1, "low": np.minimum(op, close) - 1,
        "close": close, "volume": rng.integers(20000, 50000, n).astype(float),
    }, index=pd.Index(dates, name="date"))


def test_rolling_percentile_no_lookahead():
    """分位數在 t 只能依賴 ≤t 的資料：在全序列上算的 p[i] 必須等於只用 series[:i+1] 算的最後值。"""
    rng = np.random.default_rng(0)
    s = pd.Series(rng.normal(size=120))
    full = nz.rolling_percentile(s, window=60, min_periods=20)
    for i in (30, 60, 90, 119):
        partial = nz.rolling_percentile(s.iloc[: i + 1], window=60, min_periods=20)
        assert abs(full.iloc[i] - partial.iloc[-1]) < 1e-9


def test_rolling_percentile_bounds():
    s = pd.Series(np.arange(300, dtype=float))
    p = nz.rolling_percentile(s, window=100, min_periods=20)
    assert (p >= 0).all() and (p <= 100).all()
    # 嚴格遞增序列 → 最新值永遠是視窗最大 → 分位接近 100
    assert p.iloc[-1] > 95


def test_technical_uptrend_high_score():
    ohlcv = _uptrend_ohlcv()
    fs = compute_technical(ohlcv, DEFAULT_CONFIG)
    assert fs.available
    assert (fs.score.dropna() >= 0).all() and (fs.score.dropna() <= 100).all()
    # 穩定上升趨勢 → 末段技術分偏高
    assert fs.score.iloc[-1] > 60


def test_technical_empty_degrades():
    fs = compute_technical(pd.DataFrame(), DEFAULT_CONFIG)
    assert not fs.available


def test_chips_renormalizes_on_missing_margin():
    """只有法人、無融資券 → 仍可算分、信心下降（不可硬填）。"""
    dates = pd.bdate_range("2024-01-01", periods=40).strftime("%Y-%m-%d")
    chips = pd.DataFrame({
        "foreign_net": np.r_[np.ones(20) * 5000, -np.ones(20) * 3000],
        "trust_net": np.ones(40) * 1000,
    }, index=pd.Index(dates, name="date"))
    fs = compute_chips(chips, DEFAULT_CONFIG)
    assert fs.available
    assert fs.confidence.iloc[-1] <= 0.6   # 缺融資券 → 信心降


def test_regime_gate_asymmetric():
    """非對稱：score<0 重罰（斜率0.5）、score≥0 緩獎（斜率0.1），且界在 [0.5,1.1]。"""
    cfg = DEFAULT_CONFIG
    score = pd.Series([-1.0, -0.5, 0.0, 0.5, 1.0])
    g = _gate(score, cfg)
    assert abs(g.iloc[0] - 0.5) < 1e-9    # -1 → 0.5
    assert abs(g.iloc[2] - 1.0) < 1e-9    # 0 → 1.0
    assert abs(g.iloc[4] - 1.1) < 1e-9    # +1 → 1.1
    # 逆風端比順風端陡：|gate(-0.5)-1| > |gate(0.5)-1|
    assert abs(g.iloc[1] - 1.0) > abs(g.iloc[3] - 1.0)
    assert (g >= 0.5).all() and (g <= 1.1).all()
