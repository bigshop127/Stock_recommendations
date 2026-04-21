"""
scanner.py
Daily signal scanner.
Fetches recent OHLCV (no backtest cache), runs indicators + signals,
and returns today's actionable buy signals sorted by RSI descending.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta

import pandas as pd

from data_loader import (
    REQUEST_DELAY,
    MVP_UNIVERSE,
    _fetch_raw_price,
    _fetch_dividends,
    _apply_forward_adjust,
)
from indicators import add_indicators
from signal import generate_signals

logger = logging.getLogger(__name__)

# Calendar days to fetch — must be >= 60 (MA60 warmup) + enough trading days
LOOKBACK_CALENDAR_DAYS = 200


def _fetch_recent(symbol: str) -> pd.DataFrame:
    """
    Fetch and forward-adjust the last LOOKBACK_CALENDAR_DAYS of OHLCV for `symbol`.
    Returns an empty DataFrame if no data is available.
    """
    end = datetime.today()
    # Extra 90 days for dividend lookback accuracy
    fetch_start = end - timedelta(days=LOOKBACK_CALENDAR_DAYS + 90)
    s_date = fetch_start.strftime("%Y-%m-%d")
    e_date = end.strftime("%Y-%m-%d")

    df_raw = _fetch_raw_price(symbol, s_date, e_date)
    if df_raw.empty:
        return pd.DataFrame()

    time.sleep(REQUEST_DELAY)
    div_df = _fetch_dividends(symbol, s_date, e_date)
    time.sleep(REQUEST_DELAY)

    df_adj = _apply_forward_adjust(df_raw, div_df)
    df_adj = df_adj.set_index("date").sort_index()

    # Trim to actual lookback window (keep dividend fetch range wide)
    cutoff = pd.Timestamp(end - timedelta(days=LOOKBACK_CALENDAR_DAYS))
    return df_adj[df_adj.index >= cutoff]


def scan_today(symbols: list[str] | None = None) -> tuple[list[dict], bool]:
    """
    Run the full daily scan.

    Returns
    -------
    (signals, market_is_bull)
      signals        : list of signal dicts, sorted by RSI descending
      market_is_bull : True if 0050 Close > MA60 today
    """
    if symbols is None:
        symbols = MVP_UNIVERSE

    # ── Step 1: Market regime via 0050 ────────────────────────────────────────
    logger.info("Fetching 0050 for market regime check …")
    df_0050 = _fetch_recent("0050")

    if df_0050.empty or len(df_0050) < 65:
        logger.error("Insufficient 0050 data — aborting scan.")
        return [], False

    df_0050_ind = add_indicators(df_0050)
    market_bull_series = df_0050_ind["close"] > df_0050_ind["ma60"]
    today_is_bull = bool(market_bull_series.iloc[-1])
    regime_date = df_0050_ind.index[-1].strftime("%Y-%m-%d")

    logger.info(
        "Market regime [%s]: %s  (0050 close=%.2f, MA60=%.2f)",
        regime_date,
        "BULL" if today_is_bull else "BEAR",
        float(df_0050_ind["close"].iloc[-1]),
        float(df_0050_ind["ma60"].iloc[-1]),
    )

    if not today_is_bull:
        logger.info("Bear market — skipping individual stock scan.")
        return [], False

    # ── Step 2: Scan individual stocks ────────────────────────────────────────
    signals: list[dict] = []

    for i, symbol in enumerate(symbols):
        if symbol == "0050":
            continue

        df = _fetch_recent(symbol)
        if df.empty or len(df) < 65:
            continue

        df_ind = add_indicators(df)
        df_sig = generate_signals(df_ind, market_is_bull=market_bull_series)

        if not bool(df_sig["signal"].iloc[-1]):
            continue

        last = df_sig.iloc[-1]
        close = float(df_sig["close"].iloc[-1])
        stop = float(last["ma10"])
        risk_pct = (close - stop) / close * 100 if close > 0 else 0.0
        vol_ratio = float(last["volume"] / last["vol_ma20"]) if last["vol_ma20"] > 0 else 0.0

        signals.append({
            "symbol": symbol,
            "date": df_sig.index[-1],
            "close": close,
            "stop": stop,
            "risk_pct": risk_pct,
            "rsi14": float(last["rsi14"]),
            "vol_ratio": vol_ratio,
            "df": df_sig,
        })

        logger.info(
            "  SIGNAL [%d] %s | RSI=%.1f | Vol=%.1fx | Risk=-%.1f%%",
            len(signals), symbol, float(last["rsi14"]), vol_ratio, risk_pct,
        )

    # Sort by RSI descending (same tie-breaker as backtest engine)
    signals.sort(key=lambda s: s["rsi14"], reverse=True)

    logger.info("Scan complete: %d signal(s) out of %d stocks scanned.", len(signals), len(symbols))
    return signals, True
