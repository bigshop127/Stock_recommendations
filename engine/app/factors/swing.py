"""波段引擎（swing，可回測）— 組裝三因子 × regime gate → StockSignal。

- `/signal`：build_swing_signal(code,date) → 一筆 StockSignal（技術+籌碼+情緒×gate）。
- 回測：swing_score_series(...) 只用 technical+chips（情緒無歷史語料 → 退出、重正規化），
  與 regime gate 序列相乘 → 每日 swing_score。

combine 對「實際可得」因子重正規化（scoring-model §0.5）；權重一律取自 config，不寫死。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

from app.data import service
from app.factors import normalize as nz
from app.factors.base import FactorSeries
from app.factors.chips import compute_chips
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.factors.regime import RegimeResult, compute_regime_series
from app.factors.sentiment import compute_sentiment
from app.factors.technical import compute_technical

_TPE = timezone(timedelta(hours=8))


def _df(resp: dict) -> pd.DataFrame:
    data = resp.get("data", [])
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    if "date" in df.columns:
        df = df.sort_values("date").set_index("date")
    return df


def combine_core(factor_scores: dict[str, pd.Series], weights: dict[str, float],
                 index: pd.Index) -> tuple[pd.Series, dict[str, float]]:
    """對可得因子重正規化的加權核心分。回 (core_series, 實際使用權重)。"""
    avail = {k: w for k, w in weights.items() if k in factor_scores and w > 0}
    wsum = sum(avail.values()) or 1.0
    norm = {k: w / wsum for k, w in avail.items()}
    core = pd.Series(0.0, index=index)
    for k, w in norm.items():
        core = core.add(factor_scores[k].reindex(index).ffill().fillna(50.0) * w, fill_value=0.0)
    return core.clip(0, 100), norm


def swing_score_series(ohlcv: pd.DataFrame, chips: pd.DataFrame, regime: RegimeResult,
                       cfg: FactorConfig) -> dict:
    """回測用：每日 swing_score（technical+chips×gate，無 sentiment）。"""
    tech = compute_technical(ohlcv, cfg)
    chp = compute_chips(chips, cfg)
    idx = ohlcv.index
    scores = {}
    if tech.available:
        scores["technical"] = tech.score
    if chp.available:
        scores["chips"] = chp.score
    core, used_w = combine_core(scores, cfg.swing.as_dict(), idx)
    gate = regime.gate.reindex(idx).ffill().fillna(1.0) if not regime.gate.empty else pd.Series(1.0, index=idx)
    swing = (core * gate).clip(0, 100)
    return {"swing_score": swing, "core": core, "gate": gate,
            "technical": tech, "chips": chp, "weights_used": used_w}


# ── /signal（單日）─────────────────────────────────────────────────────────────
def _action(score: float, cfg: FactorConfig) -> str:
    t = cfg.thresholds
    if score >= t.buy:
        return "buy"
    if score >= t.add_watch:
        return "add"
    if score >= t.hold:
        return "hold"
    return "reduce"


def _reasons(tech: FactorSeries, chp: FactorSeries, sent: FactorSeries,
             regime: dict, as_of: str) -> list[str]:
    out = []
    if tech.available and as_of in tech.subs.index:
        r = tech.subs.loc[as_of]
        if r.get("ma_aligned_count", 0) >= 3:
            out.append("均線多頭排列（站上多條 MA）")
        if r.get("three_red", 0) >= 1:
            out.append("三陽開泰連 3 紅")
        vr = r.get("vol_ratio", np.nan)
        if pd.notna(vr) and vr >= 1.5:
            out.append(f"量增 {vr:.1f} 倍")
        rsi = r.get("rsi14", np.nan)
        if pd.notna(rsi) and 50 <= rsi <= 70:
            out.append(f"RSI {rsi:.0f} 處動能區")
    if chp.available and as_of in chp.subs.index:
        r = chp.subs.loc[as_of]
        fs = r.get("foreign_streak", 0)
        if fs >= 2:
            out.append(f"外資連 {int(fs)} 買")
        ts = r.get("trust_streak", 0)
        if ts >= 2:
            out.append(f"投信連 {int(ts)} 買")
        mp = r.get("margin_change_pct", np.nan)
        if pd.notna(mp) and mp < 0:
            out.append(f"融資減 {abs(mp) * 100:.1f}%，籌碼乾淨")
    if sent.available and not sent.subs.empty:
        r = sent.subs.iloc[-1]
        ps = r.get("puhui_score")
        if ps is not None and pd.notna(ps):
            out.append("老王訊號偏多" if ps >= 60 else "老王訊號偏空")
        ns = r.get("news_score")
        if ns is not None and pd.notna(ns) and r.get("news_count", 0):
            out.append("新聞情緒偏多" if ns >= 55 else ("新聞情緒偏空" if ns <= 45 else "新聞情緒中性"))
    out.append(f"大盤環境 {regime['label']}（gate {regime['gate']:.2f}）")
    return out or ["資料不足，僅供參考"]


def build_swing_signal(code: str, date: str | None = None,
                       cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """產一筆 swing StockSignal（contracts/StockSignal.md）。"""
    today = datetime.now(_TPE).date()
    end = date or today.isoformat()
    start = (datetime.fromisoformat(end).date() - timedelta(days=420)).isoformat()

    ohlcv = _df(service.get_ohlcv_adj(code, start, end))   # 還原價算指標（與回測一致）
    chips = _df(service.get_chips(code, start, end))
    from app.data import finmind_client
    name = finmind_client.get_stock_name(code) or code

    tech = compute_technical(ohlcv, cfg)
    chp = compute_chips(chips, cfg)

    # as_of = ≤ end 的最後交易日
    as_of = ohlcv.index[ohlcv.index <= end][-1] if not ohlcv.empty else end

    # 情緒（live 新聞 + 老王可選）
    try:
        news = service.get_news(keyword=name or code, limit=20).get("items", [])
    except Exception:
        news = []
    sent = compute_sentiment(as_of, code, news, cfg)

    # regime（同期序列，取 as_of）
    regime = compute_regime_series(start, end, cfg)
    reg_latest = regime.latest()
    gate = reg_latest["gate"]

    # 組核心分（三因子重正規化）
    factor_latest = {}
    if tech.available:
        factor_latest["technical"] = float(tech.score.reindex([as_of]).ffill().iloc[-1]) if as_of in tech.score.index else float(tech.score.iloc[-1])
    if chp.available:
        factor_latest["chips"] = float(chp.score.reindex([as_of]).ffill().iloc[-1]) if not chp.score.empty else 50.0
    if sent.available:
        factor_latest["sentiment"] = float(sent.score.iloc[-1])

    weights = cfg.swing.as_dict()
    avail_w = {k: weights[k] for k in factor_latest}
    wsum = sum(avail_w.values()) or 1.0
    norm_w = {k: w / wsum for k, w in avail_w.items()}
    core = sum(factor_latest[k] * norm_w[k] for k in factor_latest)
    swing_score = float(np.clip(core * gate, 0, 100))

    # FactorScore[]
    def _fs(fseries: FactorSeries, key: str) -> dict:
        d = fseries.latest()
        d["weight"] = round(norm_w.get(key, 0.0), 3)
        return d

    factors = []
    if tech.available:
        factors.append(_fs(tech, "technical"))
    if chp.available:
        factors.append(_fs(chp, "chips"))
    if sent.available:
        factors.append(_fs(sent, "sentiment"))

    # 整體信心：因子信心加權 × regime 信心微調
    conf_parts = [(f["confidence"], norm_w.get(f["key"], 0)) for f in factors]
    base_conf = sum(c * w for c, w in conf_parts) if conf_parts else 0.3
    confidence = round(float(np.clip(base_conf * (0.7 + 0.3 * reg_latest["confidence"]), 0, 1)), 2)

    reasons = _reasons(tech, chp, sent, reg_latest, as_of)

    return {
        "code": code,
        "name": name,
        "date": as_of,
        "mode": "swing",
        "action": _action(swing_score, cfg),
        "score": round(swing_score, 1),
        "confidence": confidence,
        "factors": factors,
        "reasons": reasons,
        "regime_gate": round(gate, 3),
        "regime": reg_latest,
        "live_only": False,
        "generated_at": datetime.now(_TPE).isoformat(timespec="seconds"),
    }
