"""
main.py — Entry point.
Usage:
    python main.py                      # full run (300 stocks, cached)
    python main.py --top 30             # quick test with 30 stocks
    python main.py --no-cache           # force re-download
"""

import argparse
import logging
import sys
import os

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")


def main():
    parser = argparse.ArgumentParser(description="Taiwan Stock Backtester")
    parser.add_argument("--top", type=int, default=300, help="Universe size (default: 300)")
    parser.add_argument("--no-cache", action="store_true", help="Re-download even if cache exists")
    parser.add_argument("--csv", default="trade_log.csv", help="Output CSV path")
    args = parser.parse_args()

    # Lazy imports so logging is configured first
    from data_loader import load_universe
    from indicators import add_indicators
    from signal import generate_signals
    from backtest import run_backtest
    from report import compute_and_print

    cache_path = "cache_universe.parquet"
    if args.no_cache and os.path.exists(cache_path):
        os.remove(cache_path)
        logger.info("Cache cleared.")

    # ── 1. Load universe ───────────────────────────────────────────────────────
    logger.info("Loading universe (top %d) …", args.top)
    universe = load_universe(top_n=args.top, cache_path=cache_path)
    logger.info("Universe size: %d stocks", len(universe))

    # ── 2. Add indicators + signals per stock ─────────────────────────────────
    logger.info("Computing indicators and signals …")

    # Build market regime filter from 0050 (Close > MA60 → bull market)
    market_is_bull = None
    if "0050" in universe:
        df_0050 = add_indicators(universe["0050"])
        market_is_bull = df_0050["close"] > df_0050["ma60"]
        bull_days = int(market_is_bull.sum())
        total_days = len(market_is_bull)
        logger.info("Market regime filter ready: %d/%d bull days (%.1f%%)",
                    bull_days, total_days, bull_days / total_days * 100)

    processed: dict = {}
    for symbol, df in universe.items():
        if symbol == "0050":
            continue  # regime proxy only — not traded
        df_ind = add_indicators(df)
        df_sig = generate_signals(df_ind, market_is_bull=market_is_bull)
        processed[symbol] = df_sig

    total_signals = sum(df["signal"].sum() for df in processed.values())
    logger.info("Total signal bars across universe: %d", total_signals)

    # ── 3. Run backtest ────────────────────────────────────────────────────────
    logger.info("Running backtest …")
    trades = run_backtest(processed)

    # ── 4. Report ──────────────────────────────────────────────────────────────
    compute_and_print(trades, csv_path=args.csv)


if __name__ == "__main__":
    main()
