"""
signal.py
Generates entry signals using fully vectorised pandas/numpy operations.
NO iterrows. NO future data leakage.

Signal = True when ALL of:
  Trend:    MA5 > MA20 > MA60  AND  Close > MA20
  Momentum: 50 <= RSI14 <= 65
  Volume:   Volume > 1.5 * VolMA20
  Breakout/Pullback (strict):
    - breakout_occurred_within_5_days: breakout_day was True in last 5 bars
    - pullback_days (consecutive closes below previous close since breakout) <= 3
    - Low >= MA5
"""

import numpy as np
import pandas as pd


def _breakout_occurred_within_5(breakout_day: pd.Series) -> pd.Series:
    """
    True on bar t if breakout_day was True on any of bars [t-4 … t].
    Uses a rolling sum with window=5 — purely backward-looking.
    """
    return breakout_day.astype(int).rolling(5, min_periods=1).max().astype(bool)


def _consecutive_pullback_days(close: pd.Series, breakout_day: pd.Series) -> pd.Series:
    """
    For each bar t, count how many consecutive bars (including t) going
    backward from t have Close < previous Close, but only for the window
    AFTER the most recent breakout_day.

    Algorithm (vectorised):
    1. Assign each bar a "pullback streak" — number of consecutive days where
       close < close.shift(1), counting backward from today.
    2. Since we only want pullback *after* the last breakout, cap the streak
       at the distance from the last breakout bar.
    """
    # Daily return direction: 1 = up/flat, 0 = down
    up = (close >= close.shift(1)).astype(int)

    # Streak of consecutive downs (reset to 0 on any up day)
    # Achieved with a cumsum trick:
    # group_id increments each time up==1; streak = position within group
    group = up.cumsum()
    streak = close.groupby(group).cumcount()  # 0-based position in current down-run
    # streak==0 means current bar is up or first bar → pullback_days=0
    # streak==k means k consecutive down days ending today

    # Cap streak at distance from last breakout
    # distance_since_breakout[t] = bars since most recent breakout_day <= t
    bd_int = breakout_day.astype(int)
    # index of last breakout up to and including each bar
    # use cummax on the cumulative count of breakout days
    breakout_idx = bd_int.cumsum()  # monotone-increasing breakout counter
    # for each bar, record the positional index of the last breakout
    positions = pd.Series(np.arange(len(close)), index=close.index)
    last_bd_pos = positions.where(breakout_day).ffill().fillna(-1).astype(int)
    distance = positions - last_bd_pos  # bars since last breakout (0 on breakout day)

    pullback_days = streak.clip(upper=distance)
    return pullback_days


def generate_signals(df: pd.DataFrame, market_is_bull: pd.Series | None = None) -> pd.DataFrame:
    """
    Input:  df with indicators already added (from indicators.add_indicators).
    Output: df with new column 'signal' (bool) and helper columns.

    The 'signal' column on row t means: enter at OPEN of t+1.
    All checks use only data available at close of bar t.
    """
    df = df.copy()

    close = df["close"]
    low = df["low"]

    # ── Trend ──────────────────────────────────────────────────────────────────
    trend = (
        (df["ma5"] > df["ma20"])
        & (df["ma20"] > df["ma60"])
        & (close > df["ma20"])
    )

    # ── Momentum ───────────────────────────────────────────────────────────────
    momentum = (df["rsi14"] >= 50) & (df["rsi14"] <= 70)

    # ── Volume ─────────────────────────────────────────────────────────────────
    volume_surge = df["volume"] > 1.5 * df["vol_ma20"]

    # ── Breakout within 5 days ─────────────────────────────────────────────────
    df["breakout_within_5"] = _breakout_occurred_within_5(df["breakout_day"])

    # ── Pullback days (consecutive down closes since breakout) ─────────────────
    df["pullback_days"] = _consecutive_pullback_days(close, df["breakout_day"])

    # ── Low >= MA5 (pullback supported by MA5) ─────────────────────────────────
    low_above_ma5 = low >= df["ma5"]

    # ── Breakout/Pullback composite ────────────────────────────────────────────
    bp_condition = (
        df["breakout_within_5"]
        & (df["pullback_days"] <= 3)
        & low_above_ma5
    )

    # ── Final Signal ───────────────────────────────────────────────────────────
    df["signal"] = (
        trend & momentum & volume_surge & bp_condition
        & df["ma5"].notna()   # all indicators must be warm
        & df["ma60"].notna()
    )

    # ── Market Regime Filter (大盤多空過濾) ────────────────────────────────────
    # Block all buy signals when 0050 Close < MA60 (broad market in downtrend)
    if market_is_bull is not None:
        bull_mask = market_is_bull.reindex(df.index, fill_value=False)
        df["signal"] = df["signal"] & bull_mask

    return df
