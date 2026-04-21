"""
report.py
Computes KPIs from the trade log and prints them to console.

KPIs are computed on AGGREGATED trades (one row per symbol+entry_date).
The raw per-leg CSV is exported alongside the aggregated version.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd

from backtest import Trade, INITIAL_CAPITAL

logger = logging.getLogger(__name__)

OUTPUT_CSV = "trade_log.csv"
OUTPUT_CSV_RAW = "trade_log_raw.csv"


def _aggregate_trades(df: pd.DataFrame) -> pd.DataFrame:
    """
    Collapse partial exit legs into one row per (symbol, entry_date).
    Uses standard pandas agg to avoid groupby key exclusion issues.
    """
    keys = ["symbol", "entry_date"]

    # Sort so that .last() picks the chronologically latest exit leg
    df_sorted = df.sort_values("exit_date")

    sums = df_sorted.groupby(keys, sort=False)[["pnl", "position_size"]].sum()

    last_vals = df_sorted.groupby(keys, sort=False)[
        ["entry_price", "exit_date", "exit_price", "exit_reason"]
    ].last()

    result = sums.join(last_vals).reset_index()

    invested = result["entry_price"] * result["position_size"]
    result["return_pct"] = result["pnl"] / invested.where(invested > 0) * 100
    result["holding_days"] = (
        pd.to_datetime(result["exit_date"]) - pd.to_datetime(result["entry_date"])
    ).dt.days

    return result


def _equity_curve(agg_df: pd.DataFrame, initial_capital: float) -> pd.Series:
    """Equity curve built from aggregated trade PnL sorted by exit_date."""
    df = agg_df.sort_values("exit_date").reset_index(drop=True)
    equity = initial_capital + df["pnl"].cumsum()
    equity.index = df["exit_date"]
    return equity


def _max_drawdown(equity: pd.Series) -> float:
    peak = equity.cummax()
    dd = (equity - peak) / peak
    return float(dd.min() * 100)


def compute_and_print(trades: list[Trade], csv_path: str = OUTPUT_CSV) -> pd.DataFrame:
    if not trades:
        print("No trades executed.")
        return pd.DataFrame()

    raw_df = pd.DataFrame([t.__dict__ for t in trades])

    # ── Aggregate legs → one trade per entry ──────────────────────────────────
    agg_df = _aggregate_trades(raw_df)

    wins = agg_df[agg_df["pnl"] > 0]
    losses = agg_df[agg_df["pnl"] <= 0]

    n_total = len(agg_df)
    n_wins = len(wins)
    n_losses = len(losses)

    win_rate = n_wins / n_total * 100 if n_total > 0 else 0.0
    avg_win_pct = wins["return_pct"].mean() if n_wins > 0 else 0.0
    avg_loss_pct = losses["return_pct"].mean() if n_losses > 0 else 0.0

    p_win = n_wins / n_total if n_total > 0 else 0.0
    p_loss = n_losses / n_total if n_total > 0 else 0.0
    expectancy = (p_win * avg_win_pct) - (p_loss * abs(avg_loss_pct))

    equity = _equity_curve(agg_df, INITIAL_CAPITAL)
    mdd = _max_drawdown(equity)

    total_pnl = agg_df["pnl"].sum()
    final_capital = INITIAL_CAPITAL + total_pnl
    total_return_pct = total_pnl / INITIAL_CAPITAL * 100

    reason_counts = agg_df["exit_reason"].value_counts().to_dict()

    # ── Print KPIs ─────────────────────────────────────────────────────────────
    divider = "─" * 45
    print(f"\n{'═' * 45}")
    print("  BACKTEST RESULTS — Taiwan Stock Universe")
    print(f"{'═' * 45}")
    print(f"  Unique Entries      : {n_total}  (legs in raw log: {len(raw_df)})")
    print(f"  Win Rate            : {win_rate:.1f}%  ({n_wins}W / {n_losses}L)")
    print(f"  Avg Win             : {avg_win_pct:.2f}%")
    print(f"  Avg Loss            : {avg_loss_pct:.2f}%")
    print(f"  Expectancy          : {expectancy:.3f}%")
    print(divider)
    print(f"  Max Drawdown        : {mdd:.2f}%")
    print(f"  Total Return        : {total_return_pct:.2f}%")
    print(f"  Initial Capital     : {INITIAL_CAPITAL:,.0f}")
    print(f"  Final Capital       : {final_capital:,.0f}")
    print(divider)
    print("  Exit Reason Breakdown (aggregated):")
    for reason, count in sorted(reason_counts.items()):
        print(f"    {reason:<20}: {count}")
    print(f"{'═' * 45}\n")

    # ── Export CSVs ────────────────────────────────────────────────────────────
    date_fmt = "%Y-%m-%d"
    export_cols = ["symbol", "entry_date", "entry_price",
                   "exit_date", "exit_price", "position_size",
                   "pnl", "return_pct", "holding_days", "exit_reason"]

    # Aggregated (primary)
    out = agg_df[export_cols].copy()
    out["entry_date"] = pd.to_datetime(out["entry_date"]).dt.strftime(date_fmt)
    out["exit_date"] = pd.to_datetime(out["exit_date"]).dt.strftime(date_fmt)
    out = out.sort_values("entry_date").reset_index(drop=True)
    out.to_csv(csv_path, index=False)
    print(f"Trade log (aggregated) → {Path(csv_path).resolve()}")

    # Raw legs (for debugging)
    raw_out = raw_df[export_cols].copy()
    raw_out["entry_date"] = pd.to_datetime(raw_out["entry_date"]).dt.strftime(date_fmt)
    raw_out["exit_date"] = pd.to_datetime(raw_out["exit_date"]).dt.strftime(date_fmt)
    raw_out = raw_out.sort_values("entry_date").reset_index(drop=True)
    raw_out.to_csv(OUTPUT_CSV_RAW, index=False)
    print(f"Trade log (raw legs)   → {Path(OUTPUT_CSV_RAW).resolve()}\n")

    return out
