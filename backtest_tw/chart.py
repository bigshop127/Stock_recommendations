"""
chart.py
Generates candlestick charts with indicators for signal stocks.
"""

from __future__ import annotations

import logging
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # non-interactive, safe for scheduled runs
import matplotlib.pyplot as plt
import mplfinance as mpf
import pandas as pd

logger = logging.getLogger(__name__)

CHART_DIR = Path("charts")
CHART_DIR.mkdir(exist_ok=True)

_MA_COLORS = {
    "ma5":  "#9e9e9e",  # gray
    "ma10": "#ffd700",  # gold
    "ma20": "#2196f3",  # blue
    "ma60": "#e91e63",  # pink-red
}
_RSI_COLOR   = "#00bcd4"
_RSI_OB_LINE = "#e91e63"  # overbought 70
_RSI_MID_LINE = "#555577"  # midline 50

_STYLE = mpf.make_mpf_style(
    base_mpf_style="nightclouds",
    gridcolor="#2a2a4a",
    gridstyle="--",
    gridaxis="both",
    facecolor="#0d0d1a",
    figcolor="#0d0d1a",
    edgecolor="#0d0d1a",
)


def generate_chart(
    symbol: str,
    name: str,
    df: pd.DataFrame,
    lookback: int = 60,
) -> Path:
    """
    Generate and save a candlestick chart for a signal stock.

    Parameters
    ----------
    symbol   : stock code, e.g. "2330"
    name     : display name, e.g. "台積電"
    df       : DataFrame with OHLCV + indicator columns (output of add_indicators + generate_signals)
    lookback : number of recent bars to plot

    Returns
    -------
    Path to the saved PNG file.
    """
    plot_df = df.tail(lookback).copy()
    n = len(plot_df)

    apds = [
        mpf.make_addplot(plot_df["ma5"],  color=_MA_COLORS["ma5"],  width=0.7, panel=0, label="MA5"),
        mpf.make_addplot(plot_df["ma10"], color=_MA_COLORS["ma10"], width=1.0, panel=0, label="MA10"),
        mpf.make_addplot(plot_df["ma20"], color=_MA_COLORS["ma20"], width=1.0, panel=0, label="MA20"),
        mpf.make_addplot(plot_df["ma60"], color=_MA_COLORS["ma60"], width=1.2, panel=0, label="MA60"),
        mpf.make_addplot(plot_df["rsi14"],
                         panel=2, color=_RSI_COLOR, width=1.0, ylabel="RSI"),
        mpf.make_addplot([70.0] * n, panel=2, color=_RSI_OB_LINE,
                         linestyle="--", width=0.6, secondary_y=False),
        mpf.make_addplot([50.0] * n, panel=2, color=_RSI_MID_LINE,
                         linestyle="--", width=0.6, secondary_y=False),
    ]

    # Mark the signal bar (last bar) with a green triangle below
    signal_marker = pd.Series([float("nan")] * n, index=plot_df.index)
    signal_marker.iloc[-1] = float(plot_df["low"].iloc[-1]) * 0.99
    apds.append(
        mpf.make_addplot(signal_marker, panel=0, type="scatter",
                         marker="^", markersize=80, color="#00e676")
    )

    display = f"{name} ({symbol})" if name else symbol
    signal_date = df.index[-1].strftime("%Y-%m-%d")
    title = f"\n{display}  |  訊號日：{signal_date}"

    out_path = CHART_DIR / f"{symbol}.png"

    try:
        mpf.plot(
            plot_df,
            type="candle",
            style=_STYLE,
            addplot=apds,
            volume=True,
            volume_panel=1,
            panel_ratios=(3, 1, 1),
            title=title,
            figsize=(12, 8),
            tight_layout=True,
            savefig=dict(fname=str(out_path), dpi=150, bbox_inches="tight"),
        )
    finally:
        plt.close("all")

    logger.info("Chart saved: %s", out_path)
    return out_path
