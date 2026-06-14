"""每股「已結構化的精簡輸入」組裝（階段5）。

agent 一律吃**結構化精簡輸入**（控 token、避免 emoji 反向）——不吃原始 K 線、不餵原始 emoji。
資料直接呼叫階段3/4 的 builder（in-process），等同打 `/signal`、`/signal/blended`、
`/puhui/view`、`/data/news`，但省去自打 HTTP 的來回。

`build_agent_inputs(code, date)` 回一包 dict：
- `fact_base`：`/signal/blended` 的確定性事實底座（blended_score/action/agreement/conflict/blend）。
- `technical`：swing factor 分數＋子訊號摘要（技術＋籌碼），給技術分析師。
- `news`：新聞標題摘要＋大盤情緒，給消息情緒分析師。
- `puhui`：老王個股 signal/stance/reason＋water_level，給老王在地專家。

**容錯**：任一子來源失敗 → 該區塊降級為 None/空，並在 `degraded` 標註，不中斷整條流程。
"""
from __future__ import annotations

from app.data import service
from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.puhui import repo
from app.puhui.blend import build_blended_signal


def _compact_factor(f: dict) -> dict:
    """FactorScore → 精簡（保留分數/信心/權重 + 數個關鍵子訊號）。"""
    subs = f.get("inputs", {}) or {}
    # 只留非 None 的子訊號，最多 6 個，避免 token 膨脹
    keep = {k: v for k, v in subs.items() if v is not None}
    trimmed = dict(list(keep.items())[:6])
    return {
        "factor": f.get("key"),
        "name": f.get("name"),
        "score": f.get("score"),
        "confidence": f.get("confidence"),
        "weight": f.get("weight"),
        "subs": trimmed,
    }


def build_agent_inputs(code: str, date: str | None = None,
                       cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """組一檔的多 agent 結構化輸入（含確定性事實底座）。"""
    degraded: list[str] = []

    # ── 事實底座：/signal/blended（內含 swing factors + 老王 block）──────────────
    blended = build_blended_signal(code, date, cfg)
    name = blended.get("name") or code

    fact_base = {
        "code": code,
        "name": name,
        "date": blended.get("date"),
        "blended_score": blended.get("score"),
        "blended_action": blended.get("action"),
        "quant_swing_score": blended.get("blend", {}).get("quant_swing_score"),
        "agreement": blended.get("agreement"),
        "conflict": blended.get("conflict"),
        "regime": blended.get("regime", {}).get("label") if isinstance(blended.get("regime"), dict) else None,
        "regime_gate": blended.get("blend", {}).get("regime_gate"),
        "water_gate": blended.get("blend", {}).get("water_gate"),
        "final_gate": blended.get("blend", {}).get("final_gate"),
        "confidence": blended.get("confidence"),
    }

    # ── 技術＋籌碼：swing factors（technical/chips；情緒另走老王/新聞）──────────────
    factors = blended.get("factors", []) or []
    tech_factors = [_compact_factor(f) for f in factors if f.get("key") in ("technical", "chips")]
    technical = {
        "code": code, "name": name,
        "factors": tech_factors,
        "regime": fact_base["regime"], "regime_gate": fact_base["regime_gate"],
        "reasons": [r for r in blended.get("reasons", []) if "老王" not in r][:6],
    }
    if not tech_factors:
        degraded.append("technical")

    # ── 老王：個股 signal/stance/reason + water_level + market_sentiment ──────────
    daily = None
    try:
        daily = repo.get_daily(date, cfg=cfg)
    except Exception:  # noqa: BLE001 — 老王層不可得不應中斷
        degraded.append("puhui_daily")
    market_sentiment = (daily or {}).get("market_sentiment") if daily else None
    puhui_block = blended.get("puhui")   # 已是分類後 signal/stance/reason（非原始 emoji）
    puhui = {
        "code": code, "name": name,
        "water_level": blended.get("blend", {}).get("water_level"),
        "market_sentiment": market_sentiment,
        "stock": puhui_block,            # None = 老王當日未提及
        "stale": (puhui_block or {}).get("stale") if puhui_block else None,
    }
    if puhui_block is None:
        degraded.append("puhui_stock")

    # ── 新聞：標題摘要 + 大盤情緒（消息情緒分析師）────────────────────────────────
    news_items = []
    try:
        raw = service.get_news(keyword=name or code, limit=cfg.agents.max_news_items).get("items", [])
        for it in raw[: cfg.agents.max_news_items]:
            news_items.append({
                "title": (it.get("title") or "").strip()[:120],
                "source": it.get("source"),
                "date": it.get("published") or it.get("date"),
            })
    except Exception:  # noqa: BLE001 — 新聞缺失降級
        degraded.append("news")
    news = {
        "code": code, "name": name,
        "market_sentiment": market_sentiment,
        "headlines": news_items,
        "headline_count": len(news_items),
    }

    return {
        "code": code, "name": name, "date": blended.get("date"),
        "fact_base": fact_base,
        "technical": technical,
        "news": news,
        "puhui": puhui,
        "degraded": degraded,
        "_blended": blended,   # 原始融合訊號（供 orchestrator 一致性檢查，不餵 LLM）
    }
