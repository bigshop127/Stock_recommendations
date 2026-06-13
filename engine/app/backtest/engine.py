"""向量化回測器（純 pandas，**禁用 LLM**）— 只回測 swing 引擎。

嚴守 phase3 §4 / BacktestResult 契約：
- live_only 因子（盤口/分K）不進輸入；只用 technical + chips × regime gate。
- **無未來函數**：T 日收盤計分 → **T+1 開盤成交**（出場同規則）。以 pos[t]=target[t-1] 強制延遲一日。
- **台股交易成本**：買 手續費×折數；賣 手續費×折數＋證交稅 0.3%（round-trip≈0.45%）。以 (1-cost)
  乘數扣在進/出場當日財富。
- 部位：long-only、等權一籃子（每檔 1/N，獨立進出），組合日報酬=各檔日報酬均值。
- 輸出 metrics + equity_curve（1.0 起）+ benchmark（0050 同期 buy&hold）。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

from app.data import service
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.factors.regime import RegimeResult, compute_regime_series
from app.factors.swing import swing_score_series, _df

_TPE = timezone(timedelta(hours=8))
_TRADING_DAYS = 252


def _position(score: np.ndarray, entry: float, exit_: float) -> np.ndarray:
    """狀態機：score≥entry 進場、≤exit 出場，期間 hysteresis 持有。

    target[t]=收盤 t 決定的「下一日起持有狀態」；pos[t]=target[t-1] → T+1 才生效（無未來函數）。
    """
    n = len(score)
    target = np.zeros(n)
    held = False
    for t in range(n):
        if not held and score[t] >= entry:
            held = True
        elif held and score[t] <= exit_:
            held = False
        target[t] = 1.0 if held else 0.0
    pos = np.empty(n)
    pos[0] = 0.0
    pos[1:] = target[:-1]
    return pos


def _stock_daily_mult(ohlcv: pd.DataFrame, score: pd.Series, entry: float, exit_: float,
                      cost: FactorConfig) -> tuple[pd.Series, list[dict]]:
    """單檔每日財富乘數序列 + 交易明細。"""
    df = ohlcv.sort_index()
    op = df["open"].astype(float).to_numpy()
    cl = df["close"].astype(float).to_numpy()
    sc = score.reindex(df.index).ffill().fillna(0.0).to_numpy()
    pos = _position(sc, entry, exit_)
    n = len(df)
    buy_c, sell_c = cost.buy_cost, cost.sell_cost

    mult = np.ones(n)
    for t in range(1, n):
        if pos[t] == 1 and pos[t - 1] == 0:        # 進場：T 開盤買 → 當日 open→close
            mult[t] = (cl[t] / op[t]) * (1.0 - buy_c)
        elif pos[t] == 1 and pos[t - 1] == 1:       # 持有：close→close
            mult[t] = cl[t] / cl[t - 1]
        elif pos[t] == 0 and pos[t - 1] == 1:       # 出場：T 開盤賣 → 昨close→open
            mult[t] = (op[t] / cl[t - 1]) * (1.0 - sell_c)
        else:
            mult[t] = 1.0

    # 交易明細：entry(0→1) ... exit(1→0)
    trades = []
    entry_idx = None
    for t in range(1, n):
        if pos[t] == 1 and pos[t - 1] == 0:
            entry_idx = t
        elif pos[t] == 0 and pos[t - 1] == 1 and entry_idx is not None:
            net = float(np.prod(mult[entry_idx:t + 1]) - 1.0)
            trades.append({"entry": df.index[entry_idx], "exit": df.index[t],
                           "days": t - entry_idx, "ret": net})
            entry_idx = None
    if entry_idx is not None:   # 期末仍持有 → 以最後收盤計未實現
        net = float(np.prod(mult[entry_idx:]) - 1.0)
        trades.append({"entry": df.index[entry_idx], "exit": df.index[-1],
                       "days": n - 1 - entry_idx, "ret": net, "open": True})

    return pd.Series(mult, index=df.index), trades


def _metrics(equity: pd.Series, trades: list[dict]) -> dict:
    eq = equity.to_numpy()
    n = len(eq)
    daily_ret = np.diff(eq) / eq[:-1] if n > 1 else np.array([0.0])
    cum = float(eq[-1] - 1.0)
    years = n / _TRADING_DAYS if n else 1.0
    annual = float(eq[-1] ** (1 / years) - 1.0) if years > 0 and eq[-1] > 0 else 0.0
    sd = float(np.std(daily_ret, ddof=1)) if len(daily_ret) > 1 else 0.0
    sharpe = float(np.mean(daily_ret) / sd * np.sqrt(_TRADING_DAYS)) if sd > 0 else 0.0
    running_max = np.maximum.accumulate(eq)
    mdd = float(np.min(eq / running_max - 1.0)) if n else 0.0
    wins = [t for t in trades if t["ret"] > 0]
    win_rate = float(len(wins) / len(trades)) if trades else 0.0
    avg_hold = float(np.mean([t["days"] for t in trades])) if trades else 0.0
    return {
        "cum_return": round(cum, 4),
        "annual_return": round(annual, 4),
        "sharpe": round(sharpe, 3),
        "max_drawdown": round(mdd, 4),
        "win_rate": round(win_rate, 4),
        "trades": len(trades),
        "avg_holding_days": round(avg_hold, 1),
    }


def _benchmark_0050(start: str, end: str, dates: pd.Index) -> dict:
    """0050 同期 buy&hold 累積報酬（還原價，首日收盤買、末日收盤賣，扣一次 round-trip）。"""
    try:
        bench = _df(service.get_ohlcv_adj("0050", start, end))
    except Exception:
        return {"name": "0050", "cum_return": None, "note": "0050 取數失敗"}
    if bench.empty:
        return {"name": "0050", "cum_return": None, "note": "0050 無資料"}
    bench = bench.reindex(dates).ffill().dropna(subset=["close"])
    if bench.empty:
        return {"name": "0050", "cum_return": None}
    c = bench["close"].astype(float)
    cum = float(c.iloc[-1] / c.iloc[0] - 1.0)
    eq = (c / c.iloc[0]).round(6)
    return {"name": "0050", "cum_return": round(cum, 4),
            "equity_curve": [{"date": str(d), "equity": float(v)} for d, v in eq.items()]}


def run_backtest(codes: list[str], start: str, end: str,
                 cfg: FactorConfig = DEFAULT_CONFIG,
                 entry_score: float | None = None, exit_score: float | None = None,
                 regime: RegimeResult | None = None, strategy: str = "swing_v1") -> dict:
    """回測一籃子台股的 swing 策略 → BacktestResult dict。"""
    entry = entry_score if entry_score is not None else cfg.thresholds.entry_score
    exit_ = exit_score if exit_score is not None else cfg.thresholds.exit_score
    regime = regime if regime is not None else compute_regime_series(start, end, cfg)

    per_stock_ret: dict[str, pd.Series] = {}
    all_trades: list[dict] = []
    excluded: list[str] = []
    for code in codes:
        ohlcv = _df(service.get_ohlcv_adj(code, start, end))   # 還原價（避免除權/分割斷點）
        chips = _df(service.get_chips(code, start, end))
        if ohlcv.empty:
            excluded.append(code)
            continue
        sig = swing_score_series(ohlcv, chips, regime, cfg)
        mult, trades = _stock_daily_mult(ohlcv, sig["swing_score"], entry, exit_, cfg.cost)
        per_stock_ret[code] = mult - 1.0   # 日報酬
        for t in trades:
            t["code"] = code
        all_trades.extend(trades)

    if not per_stock_ret:
        raise ValueError("無任何標的可回測（OHLCV 全空，檢查 FINMIND_TOKEN 與代號）。")

    # 組合：等權，各檔日報酬均值（NaN=該日無資料不計入）
    ret_df = pd.DataFrame(per_stock_ret).sort_index()
    port_ret = ret_df.mean(axis=1, skipna=True).fillna(0.0)
    equity = (1.0 + port_ret).cumprod()   # 首日各檔皆 flat（mult=1）→ equity[0]=1.0

    metrics = _metrics(equity, all_trades)
    bench = _benchmark_0050(start, end, equity.index)

    return {
        "strategy": strategy,
        "universe": f"{len(codes)} 檔（{', '.join(codes[:8])}{'…' if len(codes) > 8 else ''}）",
        "period": {"start": start, "end": end},
        "params": {
            "weights": cfg.swing.as_dict(),
            "weights_note": "回測排除 sentiment（無歷史語料）→ technical/chips 重正規化為 0.5/0.5",
            "entry_score": entry, "exit_score": exit_,
            "regime_gate": [cfg.regime.gate_floor, cfg.regime.gate_cap],
            "cost": {"fee_rate": cfg.cost.fee_rate, "fee_discount": cfg.cost.fee_discount,
                     "tax_rate": cfg.cost.tax_rate, "round_trip": round(cfg.cost.round_trip, 5)},
            "execution": "T 收盤計分 → T+1 開盤成交",
            "excluded_codes": excluded,
        },
        "metrics": metrics,
        "equity_curve": [{"date": str(d), "equity": round(float(v), 6)} for d, v in equity.items()],
        "benchmark": {k: v for k, v in bench.items() if k != "equity_curve"} | (
            {"equity_curve": bench["equity_curve"]} if "equity_curve" in bench else {}),
        "trades_detail": all_trades,
        "generated_at": datetime.now(_TPE).isoformat(timespec="seconds"),
    }
