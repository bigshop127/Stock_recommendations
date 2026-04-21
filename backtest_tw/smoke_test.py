"""
smoke_test.py — Functional validation using synthetic price data.
No API token needed. Verifies the full pipeline end-to-end.
"""

import numpy as np
import pandas as pd
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from indicators import add_indicators
from signal import generate_signals
from backtest import run_backtest
from report import compute_and_print


def _make_trending_stock(seed: int, n: int = 500) -> pd.DataFrame:
    """
    Generates a synthetic stock that has a clear uptrend,
    high volume surges, and periodic 20-day breakouts.
    Designed to trigger multiple valid signals.
    """
    rng = np.random.default_rng(seed)

    # Base trend: slowly rising price
    drift = 0.0008
    vol = 0.018
    log_ret = rng.normal(drift, vol, n)
    price = 100 * np.exp(np.cumsum(log_ret))

    # Volume: baseline + occasional 2-3x surges
    base_vol = rng.integers(5_000_000, 15_000_000, n)
    surge_days = rng.choice(n, size=n // 15, replace=False)
    multiplier = np.ones(n)
    multiplier[surge_days] = rng.uniform(2.0, 3.5, len(surge_days))
    volume = (base_vol * multiplier).astype(int)

    # OHLC from close
    high = price * (1 + np.abs(rng.normal(0, 0.005, n)))
    low  = price * (1 - np.abs(rng.normal(0, 0.005, n)))
    open_ = price * (1 + rng.normal(0, 0.003, n))

    dates = pd.date_range("2022-01-03", periods=n, freq="B")
    df = pd.DataFrame({
        "open": open_,
        "high": high,
        "low": low,
        "close": price,
        "volume": volume,
    }, index=dates)
    return df


def main():
    print("Building synthetic universe (10 stocks × 500 days)…")

    universe_raw = {f"SYN{i:03d}": _make_trending_stock(seed=i) for i in range(10)}

    # Add indicators + signals
    processed = {}
    for sym, df in universe_raw.items():
        df_ind = add_indicators(df)
        df_sig = generate_signals(df_ind)
        processed[sym] = df_sig

    total_signals = sum(df["signal"].sum() for df in processed.values())
    print(f"Total signal bars: {total_signals}")

    if total_signals == 0:
        print("\n⚠ No signals generated — check indicator warm-up or conditions.")
        # Print diagnostic for one stock
        sym = list(processed.keys())[0]
        df = processed[sym]
        print(df[["close","ma5","ma20","ma60","rsi14","vol_ma20",
                   "breakout_day","breakout_within_5","pullback_days","signal"]].tail(20).to_string())
        return

    trades = run_backtest(processed)
    compute_and_print(trades, csv_path="smoke_trade_log.csv")

    # Show CSV sample
    import csv as csv_mod
    log = pd.read_csv("smoke_trade_log.csv")
    print("── Trade Log Sample (first 10 rows) ──")
    print(log.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
