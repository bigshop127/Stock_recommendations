"""當沖引擎（daytrade，live-only，**不回測**）— scoring-model §2。

core_day = 0.45·F_orderbook + 0.35·F_intraday_tech + 0.20·F_market_today（各 0~100）
daytrade_prob = sigmoid((core_day-50)/scale)，再經「籌碼過濾」gate（流動性）。

**source-aware 降級（phase3 §2 / scoring-model §0.5）**：
- 盤口預設走 **TWSE MIS**（免金鑰）：**無內外盤**（inner_outer=None）、無 tick 大單 →
  「內外盤比」「大單流向」兩子訊號**退出加權、重正規化、confidence 下降、note 標註**，
  **不可用預設值硬填**。唯 `BOOK_SOURCE=fugle` 且有 key 時納內外盤。
- 分K（F_intraday_tech）需富果；無富果 key / 非交易時段 → 該因子退出、降信心。
- 全因子皆 live_only → 只能 forward 驗證、**不進回測**。
"""
from __future__ import annotations

import math
from datetime import datetime, timezone, timedelta

import pandas as pd

from app.data import service
from app.data.http import DataSourceError
from app.factors import normalize as nz
from app.factors.config import DEFAULT_CONFIG, FactorConfig

_TPE = timezone(timedelta(hours=8))
_SIGMOID_SCALE = 12.0
_MIN_AVG_VOLUME_LOTS = 1000   # 籌碼過濾：近 20 日均量門檻（張），太低不適合當沖


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _orderbook_factor(book: dict, source: str, cfg: FactorConfig) -> dict:
    """F_orderbook：五檔力道（MIS 可算）＋內外盤/大單（僅富果，否則退出）。"""
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    parts, weights, notes = {}, {}, []

    # 子訊號1：五檔委買賣力道（MIS/富果皆有）
    bid_sz = sum((b.get("size") or 0) for b in bids)
    ask_sz = sum((a.get("size") or 0) for a in asks)
    depth_imb = None
    if bid_sz + ask_sz > 0:
        depth_imb = (bid_sz - ask_sz) / (bid_sz + ask_sz)   # [-1,1]
        parts["depth"] = nz.clamp((depth_imb + 1) / 2 * 100)
        weights["depth"] = 0.5
        notes.append(f"委買/賣量 {bid_sz}/{ask_sz}")

    # 子訊號2：內外盤比（只有富果有 inner_outer 分量；MIS=None → 退出）
    io = book.get("inner_outer") or {}
    at_bid, at_ask = io.get("at_bid"), io.get("at_ask")
    bid_ask_ratio = None
    if at_bid is not None and at_ask is not None and (at_bid + at_ask) > 0:
        bid_ask_ratio = at_ask / at_bid if at_bid else None
        parts["inner_outer"] = nz.clamp(at_ask / (at_bid + at_ask) * 100)
        weights["inner_outer"] = 0.5
        notes.append(f"外/內盤 {at_ask}/{at_bid}")
    else:
        notes.append("MIS 無內外盤→退出重正規化")
    # 子訊號3：大單流向 — MIS/富果 quote 皆無 tick 級 → 不納（標註，不硬填）

    if not weights:
        return {"available": False, "score": 50.0, "confidence": 0.0,
                "inputs": {}, "note": "盤口無有效子訊號"}
    wsum = sum(weights.values())
    score = sum(parts[k] * weights[k] for k in parts) / wsum
    coverage = wsum / 1.0   # 滿配=depth0.5+inner_outer0.5
    conf = round(0.35 + 0.35 * coverage, 2)   # MIS 僅 depth → ~0.52；富果雙子→~0.7
    return {
        "available": True, "score": round(score, 1), "confidence": conf,
        "inputs": {"depth_imbalance": round(depth_imb, 3) if depth_imb is not None else None,
                   "bid_ask_inner_outer": round(bid_ask_ratio, 3) if bid_ask_ratio else None,
                   "source": source},
        "note": "盤口（" + "、".join(notes) + "）",
    }


def _intraday_factor(code: str, cfg: FactorConfig) -> dict:
    """F_intraday_tech：開盤強弱/量比/分K 動能（需富果分K；缺則退出）。"""
    try:
        resp = service.get_intraday(code)
    except DataSourceError as e:
        return {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
                "note": f"分K 不可得（{str(e)[:40]}）→ 退出"}
    data = resp.get("data") or []
    if not data:
        return {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
                "note": "無分K（非交易時段或無富果 key）→ 退出"}
    df = pd.DataFrame(data)
    closes = pd.to_numeric(df.get("close"), errors="coerce").dropna()
    if len(closes) < 3:
        return {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
                "note": "分K 過少 → 退出"}
    # 分K 動能：最近 5 根方向
    mom = closes.tail(5).diff().dropna()
    up_ratio = float((mom > 0).mean())
    intraday_ret = float(closes.iloc[-1] / closes.iloc[0] - 1) if closes.iloc[0] else 0.0
    score = nz.clamp(50 + intraday_ret * 1000 + (up_ratio - 0.5) * 40)
    return {"available": True, "score": round(score, 1), "confidence": 0.55,
            "inputs": {"intraday_ret": round(intraday_ret, 4), "up_bar_ratio": round(up_ratio, 2),
                       "bars": int(len(closes))},
            "note": "分K：當日走勢/動能"}


def _market_today_factor(cfg: FactorConfig) -> dict:
    """F_market_today：大盤即時強弱（^TWII）＋ A/D proxy（無乾淨漲跌家數）。"""
    try:
        snap = service.get_market()
    except DataSourceError as e:
        return {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
                "note": f"大盤快照不可得（{str(e)[:40]}）"}
    idx = snap.get("indices", {})
    twii = idx.get("twii", {})
    chg = twii.get("change_pct")
    if chg is None:
        return {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
                "note": "無 ^TWII 漲跌"}
    score = float(nz.linear_score(pd.Series([chg]), -2.0, 2.0).iloc[0])
    vix = idx.get("vix", {})
    return {"available": True, "score": round(score, 1), "confidence": 0.6,
            "inputs": {"twii_change_pct": chg, "vix_change_pct": vix.get("change_pct"),
                       "ad_proxy": "用 ^TWII＋VIX 代漲跌家數（無乾淨 A/D）"},
            "note": "大盤當日（A/D 用 proxy）"}


def _liquidity_gate(code: str) -> tuple[int, str]:
    """籌碼過濾：近 20 日均量門檻（不計分，過濾能否當沖）。處置股/券源待補（另需來源）。"""
    today = datetime.now(_TPE).date()
    start = (today - timedelta(days=40)).isoformat()
    try:
        ohlcv = service.get_ohlcv_adj(code, start, today.isoformat()).get("data") or []
    except DataSourceError:
        return 1, "流動性未知（取數失敗），暫不過濾"
    if not ohlcv:
        return 1, "流動性未知，暫不過濾"
    vol = pd.to_numeric(pd.DataFrame(ohlcv).get("volume"), errors="coerce").dropna()
    avg_lots = float(vol.tail(20).mean()) / 1000.0 if len(vol) else 0.0   # 股→張
    if avg_lots < _MIN_AVG_VOLUME_LOTS:
        return 0, f"近20日均量 {avg_lots:.0f} 張 < {_MIN_AVG_VOLUME_LOTS}，流動性不足、不宜當沖"
    return 1, f"近20日均量 {avg_lots:.0f} 張，流動性足（處置股/券源過濾待補）"


def build_daytrade_signal(code: str, cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """產一筆 daytrade StockSignal（live_only=True，不回測）。"""
    now = datetime.now(_TPE)
    # 盤口（預設 MIS）
    try:
        book_resp = service.get_book(code)
        book, source = book_resp.get("book", {}), book_resp.get("source", "")
        ob = _orderbook_factor(book, source, cfg)
        name = book.get("name")
    except DataSourceError as e:
        ob = {"available": False, "score": 50.0, "confidence": 0.0, "inputs": {},
              "note": f"盤口不可得（{str(e)[:50]}）→ 非交易時段請盤中重試"}
        source, name = "TWSE MIS", None

    it = _intraday_factor(code, cfg)
    mt = _market_today_factor(cfg)

    from app.data import finmind_client
    name = name or finmind_client.get_stock_name(code) or code

    w = cfg.daytrade
    cand = {"orderbook": (ob, w.orderbook), "intraday_tech": (it, w.intraday_tech),
            "market_today": (mt, w.market_today)}
    avail = {k: (f, wt) for k, (f, wt) in cand.items() if f["available"]}
    factor_names = {"orderbook": "盤口/主力", "intraday_tech": "當日技術", "market_today": "大盤當日"}

    factors = []
    if avail:
        wsum = sum(wt for _, wt in avail.values())
        core = sum(f["score"] * wt for f, wt in avail.values()) / wsum
    else:
        wsum, core = 0.0, 50.0
    for k, (f, wt) in cand.items():
        factors.append({
            "key": k, "name": factor_names[k], "score": f["score"],
            "weight": round((wt / wsum) if (f["available"] and wsum) else 0.0, 3),
            "confidence": f["confidence"], "live_only": True,
            "inputs": f["inputs"], "note": f["note"],
        })

    gate, gate_note = _liquidity_gate(code)
    prob = _sigmoid((core - 50) / _SIGMOID_SCALE) * gate
    score = round(prob * 100, 1)

    # action（當沖偏短：高機率 watch/買進候選，過濾不過→觀望）
    if gate == 0:
        action = "watch"
    elif score >= 65:
        action = "buy"
    elif score >= 50:
        action = "watch"
    else:
        action = "hold"

    base_conf = (sum(f["confidence"] * wt for f, wt in avail.values()) / wsum) if (avail and wsum) else 0.2
    # 可用因子越少、信心越低（live-only 盤口缺源時誠實反映）
    coverage_pen = len(avail) / 3.0
    confidence = round(min(1.0, base_conf * (0.5 + 0.5 * coverage_pen)), 2)

    reasons = [f["note"] for f in factors if f["weight"] > 0] or ["當沖訊號需盤中即時資料（盤口/分K）"]
    reasons.append(f"籌碼過濾：{gate_note}")
    reasons.append("⚠️ live-only：盤口/分K 無歷史，只能 forward 驗證、不進回測")

    return {
        "code": code, "name": name, "date": now.date().isoformat(), "mode": "daytrade",
        "action": action, "score": score, "confidence": confidence,
        "factors": factors, "reasons": reasons,
        "regime_gate": None, "live_only": True,
        "book_source": source,
        "generated_at": now.isoformat(timespec="seconds"),
    }
