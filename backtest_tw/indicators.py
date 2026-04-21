"""
indicators.py
Fully vectorised indicator computation. No iterrows / Python loops.
All outputs are aligned on the SAME DatetimeIndex as the input DataFrame.
"""

import numpy as np
import pandas as pd


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Input:  df with columns [open, high, low, close, volume], DatetimeIndex.
    Output: df with additional columns:
            ma5, ma20, ma60, rsi14, vol_ma20,
            rolling_max20, breakout_day
    """
    df = df.copy()
    close = df["close"]
    volume = df["volume"]

    # ── Moving Averages ────────────────────────────────────────────────────────
    df["ma5"]  = close.rolling(5,  min_periods=5).mean()
    df["ma10"] = close.rolling(10, min_periods=10).mean()
    df["ma20"] = close.rolling(20, min_periods=20).mean()
    df["ma60"] = close.rolling(60, min_periods=60).mean()

    # ── RSI(14) — Wilder's smoothed RS ────────────────────────────────────────
    df["rsi14"] = _rsi(close, 14)

    # ── Volume MA20 ────────────────────────────────────────────────────────────
    df["vol_ma20"] = volume.rolling(20, min_periods=20).mean()

    # ── Rolling 20-day High (for breakout detection) ───────────────────────────
    # rolling(...).max() uses only the current + past 19 bars → no look-ahead
    df["rolling_max20"] = close.rolling(20, min_periods=20).max()

    # ── Breakout day: today's close equals the 20-day rolling max ─────────────
    df["breakout_day"] = (close == df["rolling_max20"]) & df["rolling_max20"].notna()

    return df


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """
    Wilder's RSI using exponential smoothing (alpha = 1/period).
    First `period` rows are NaN (warm-up).
    """
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    # Use ewm with com = period - 1 → equivalent to Wilder's alpha = 1/period
    avg_gain = gain.ewm(com=period - 1, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    # When avg_loss == 0 and avg_gain > 0 → RSI = 100
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi
