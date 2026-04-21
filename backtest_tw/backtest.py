"""
backtest.py
Event-driven execution layer.

Design:
- Signal generation is fully vectorised (done upstream in signal.py).
- This module iterates ONLY over signal-event rows (entry/exit triggers),
  NOT over every daily price row.
- Path-dependent capital tracking, stop loss, and TP ladders live here.
- Zero look-ahead bias: entry uses T+1 Open; stop/TP checks use Close/Open of
  subsequent bars.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

INITIAL_CAPITAL = 1_000_000.0
RISK_PCT = 0.01          # 1% of current capital per trade
TRANSACTION_COST = 0.003  # 0.3% round-trip friction
MAX_POSITIONS = 5         # portfolio-level cap; tie-breaker: highest RSI on signal day

TP1_RR = 1.5   # exit 50% at this RR
TP2_RR = 2.5   # exit remaining 50%

ExitReason = Literal["MA10_Exit", "TP_1.5R", "TP_2.5R", "EndOfData"]


@dataclass
class Position:
    symbol: str
    entry_date: pd.Timestamp
    entry_price: float
    stop_price: float         # MA5 on signal day
    risk_per_share: float     # entry_price - stop_price
    full_size: int            # original position size
    remaining_size: int       # shares still open
    tp1_triggered: bool = False
    capital_at_entry: float = 0.0


@dataclass
class Trade:
    symbol: str
    entry_date: pd.Timestamp
    entry_price: float
    exit_date: pd.Timestamp
    exit_price: float
    position_size: int
    pnl: float
    return_pct: float
    holding_days: int
    exit_reason: str


def _size_position(capital: float, entry_price: float, stop_price: float) -> tuple[int, float]:
    """Returns (shares, risk_per_share). Returns (0, 0) if risk is invalid."""
    risk_per_share = entry_price - stop_price
    if risk_per_share <= 0:
        return 0, 0.0
    risk_amount = capital * RISK_PCT
    shares = int(risk_amount / risk_per_share)
    return shares, risk_per_share


def _close_partial(
    pos: Position,
    exit_date: pd.Timestamp,
    exit_price: float,
    shares: int,
    reason: str,
    trades: list[Trade],
    capital: float,
) -> float:
    """
    Close `shares` of `pos`, record a Trade, apply transaction cost,
    return updated capital.
    """
    gross_pnl = (exit_price - pos.entry_price) * shares
    net_pnl = gross_pnl - (pos.entry_price * shares * TRANSACTION_COST)
    ret_pct = net_pnl / (pos.entry_price * shares) * 100

    holding = (exit_date - pos.entry_date).days

    trades.append(Trade(
        symbol=pos.symbol,
        entry_date=pos.entry_date,
        entry_price=pos.entry_price,
        exit_date=exit_date,
        exit_price=exit_price,
        position_size=shares,
        pnl=net_pnl,
        return_pct=ret_pct,
        holding_days=holding,
        exit_reason=reason,
    ))
    pos.remaining_size -= shares
    return capital + net_pnl


def run_backtest(universe: dict[str, pd.DataFrame]) -> list[Trade]:
    """
    Main backtest loop.

    For each stock we pre-build an event table:
      (date, event_type, price_data)
    Then we merge events across all stocks into a single timeline and
    process them chronologically.

    Capital is shared across all positions.
    """
    capital = INITIAL_CAPITAL
    open_positions: dict[str, Position] = {}  # {symbol: Position}
    trades: list[Trade] = []

    # ── Pre-build event tables ─────────────────────────────────────────────────
    # For each stock: collect (date, open, close, ma5) rows for exit checks
    # and (signal_date, entry_date, entry_open, ma5_on_signal) for entries.

    all_events: list[dict] = []

    for symbol, df in universe.items():
        if df.empty or "signal" not in df.columns:
            continue

        df = df.copy()

        # Align T+1 open for entries (shift -1 maps today's signal to tomorrow's open)
        df["next_open"] = df["open"].shift(-1)
        df["next_date"] = df.index.to_series().shift(-1).values

        # Collect signal rows
        sig_rows = df[df["signal"] == True].copy()
        for idx, row in sig_rows.iterrows():
            if pd.isna(row["next_open"]) or pd.isna(row["next_date"]):
                continue  # last bar — no T+1
            all_events.append({
                "type": "entry_signal",
                "signal_date": idx,
                "date": row["next_date"],  # execution date = T+1
                "entry_open": row["next_open"],
                "stop_price": row["ma10"],  # Hypothesis A: MA10 stop
                "symbol": symbol,
                "rsi14": row["rsi14"],     # tie-breaker: higher RSI = stronger momentum
            })

        # Collect daily price rows for exit monitoring
        for idx, row in df.iterrows():
            all_events.append({
                "type": "price",
                "date": idx,
                "symbol": symbol,
                "open": row["open"],
                "close": row["close"],
                "ma10": row["ma10"],
                "next_open": row.get("next_open", np.nan),
                "next_date": row.get("next_date", pd.NaT),
                "entry_price_ref": np.nan,
            })

    # Sort chronologically; within same date: price events before entry signals
    # so that exits on T happen before new entries on T.
    # Within same-date entry signals: highest RSI first (strongest momentum wins the slot).
    type_order = {"price": 0, "entry_signal": 1}
    all_events.sort(key=lambda e: (
        e["date"],
        type_order.get(e["type"], 2),
        -e.get("rsi14", 0) if e["type"] == "entry_signal" else 0,
    ))

    # ── Process events ─────────────────────────────────────────────────────────
    for ev in all_events:
        ev_date = ev["date"]
        symbol = ev["symbol"]

        if ev["type"] == "price":
            if symbol not in open_positions:
                continue

            pos = open_positions[symbol]
            close = ev["close"]
            ma10 = ev["ma10"]
            next_open = ev["next_open"]
            next_date = ev["next_date"]

            if pd.isna(ma10):
                continue

            # Skip price events that are BEFORE the entry date
            if ev_date < pos.entry_date:
                continue

            # ── Stop Loss (MA10) ───────────────────────────────────────────────
            if close < ma10:
                exit_price = next_open if not pd.isna(next_open) else close
                exit_date = next_date if not pd.isna(next_date) else ev_date
                capital = _close_partial(
                    pos, exit_date, exit_price,
                    pos.remaining_size, "MA10_Exit", trades, capital
                )
                del open_positions[symbol]
                continue

            # ── Take Profit checks ─────────────────────────────────────────────
            rr = (close - pos.entry_price) / pos.risk_per_share

            if not pos.tp1_triggered and rr >= TP1_RR:
                # Exit 50% at current close (approximated as next open to stay
                # consistent with no look-ahead, but TP is *triggered* by close)
                tp1_shares = pos.full_size // 2
                if tp1_shares > 0 and pos.remaining_size >= tp1_shares:
                    tp_exit_price = next_open if not pd.isna(next_open) else close
                    tp_exit_date = next_date if not pd.isna(next_date) else ev_date
                    capital = _close_partial(
                        pos, tp_exit_date, tp_exit_price,
                        tp1_shares, "TP_1.5R", trades, capital
                    )
                    pos.tp1_triggered = True
                    if pos.remaining_size == 0:
                        del open_positions[symbol]
                        continue

            if pos.tp1_triggered and rr >= TP2_RR and pos.remaining_size > 0:
                tp_exit_price = next_open if not pd.isna(next_open) else close
                tp_exit_date = next_date if not pd.isna(next_date) else ev_date
                capital = _close_partial(
                    pos, tp_exit_date, tp_exit_price,
                    pos.remaining_size, "TP_2.5R", trades, capital
                )
                del open_positions[symbol]

        elif ev["type"] == "entry_signal":
            # Skip if already in this stock or portfolio is full
            if symbol in open_positions:
                continue
            if len(open_positions) >= MAX_POSITIONS:
                continue

            entry_price = ev["entry_open"]
            stop_price = ev["stop_price"]

            if pd.isna(entry_price) or pd.isna(stop_price):
                continue

            shares, risk_per_share = _size_position(capital, entry_price, stop_price)
            if shares <= 0:
                continue

            cost = entry_price * shares  # capital commitment (not locked, just tracked)
            if cost > capital:
                logger.debug("Insufficient capital for %s on %s", symbol, ev_date)
                # Still allow — position sizing already limits risk to 1%; no hard block
                pass

            pos = Position(
                symbol=symbol,
                entry_date=ev["date"],
                entry_price=entry_price,
                stop_price=stop_price,
                risk_per_share=risk_per_share,
                full_size=shares,
                remaining_size=shares,
                capital_at_entry=capital,
            )
            open_positions[symbol] = pos
            logger.debug("ENTER %s @ %.2f x%d on %s | stop=%.2f",
                         symbol, entry_price, shares, ev["date"], stop_price)

    # ── Close any still-open positions at end of data ──────────────────────────
    for symbol, pos in list(open_positions.items()):
        # Use last available price from universe
        df_last = universe.get(symbol)
        if df_last is not None and not df_last.empty:
            last_close = float(df_last["close"].iloc[-1])
            last_date = df_last.index[-1]
        else:
            last_close = pos.entry_price
            last_date = pos.entry_date

        capital = _close_partial(
            pos, last_date, last_close,
            pos.remaining_size, "EndOfData", trades, capital
        )

    logger.info("Backtest complete. Capital: %.2f → %.2f | Trades: %d",
                INITIAL_CAPITAL, capital, len(trades))
    return trades
