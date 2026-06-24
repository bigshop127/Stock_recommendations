"""F_sentiment（消息情緒面）— scoring-model §1.1，本階段輕量版。

子訊號：
- 新聞極性（次）：對 service.get_news 標題/摘要做輕量中文關鍵字詞典極性 −1..+1 → 0~100。
- 老王訊號（主，可選）：**階段4 改由 `app.puhui.repo` 供應**——確定性解析 `reports/**/*.md`
  得到的個股 0~100 分（emoji 色碼語意相反、操作建議關鍵詞映射，見 puhui/mapping.py）。
  **舊版讀 `data/puhui_analysis/*.json` 的路徑已廢**（該檔從未存在、且 gitignored）。
  老王當日未提及 / 報告過舊（超 fallback 視窗）→ 該子訊號退出加權、重正規化、降信心、note 標註。

重要分流：新聞/老王皆**無乾淨歷史語料** → `live_only=True`、**不進回測**（回測由 swing 引擎排除 sentiment、
對 technical/chips 重正規化）。
"""
from __future__ import annotations

import pandas as pd

from app.factors.base import FactorSeries
from app.factors.config import FactorConfig
from app.puhui import repo as puhui_repo

# 輕量中文財經極性詞典（階段3 暫用；階段4 換語料庫/模型）
_POS = ["利多", "看好", "看多", "成長", "突破", "創高", "創新高", "大漲", "強勢", "買超",
        "樂觀", "上修", "調升", "受惠", "訂單", "暢旺", "旺季", "漲停", "噴出", "轉強", "回升", "獲利"]
_NEG = ["利空", "看壞", "看空", "衰退", "跌破", "重挫", "大跌", "弱勢", "賣超", "悲觀",
        "下修", "調降", "虧損", "示警", "跌停", "違約", "賣壓", "疑慮", "踩雷", "轉弱", "下滑", "停損"]


def classify_polarity(text: str) -> dict:
    """分類單則文字的情緒極性。"""
    pos = sum(text.count(w) for w in _POS)
    neg = sum(text.count(w) for w in _NEG)
    hits = [w for w in _POS if text.count(w) > 0] + [w for w in _NEG if text.count(w) > 0]

    if pos == 0 and neg == 0:
        return {
            "label": "neutral",
            "score": 50.0,
            "hits": []
        }

    pol = (pos - neg) / (pos + neg)
    score = (pol + 1) / 2 * 100.0

    if pol > 0:
        label = "positive"
    elif pol < 0:
        label = "negative"
    else:
        label = "neutral"

    return {
        "label": label,
        "score": score,
        "hits": hits
    }


def _news_polarity(items: list[dict]) -> tuple[float | None, int]:
    """回 (平均極性 0~100 或 None, 有效則數)。逐則算 (pos-neg)/(pos+neg)。"""
    if not items:
        return None, 0
    scores, used = [], 0
    for it in items:
        text = f"{it.get('title', '')} {it.get('summary', '')}"
        res = classify_polarity(text)
        if not res["hits"]:
            continue
        scores.append(res["score"])
        used += 1
    if not scores:
        return 50.0, len(items)   # 有新聞但無極性詞 → 中性
    return sum(scores) / len(scores), used



def _read_puhui_signal(code: str, as_of: str, cfg: FactorConfig) -> float | None:
    """老王個股分數（0~100）— 階段4 由 puhui repo（reports/*.md 解析）供應。

    含缺日 fallback（沿用最近前一篇 ≤fallback_max_days）；當日未提及 / 太舊 → None（觸發降級）。
    """
    try:
        return puhui_repo.get_stock_score(code, as_of, cfg=cfg)
    except Exception:
        return None


def compute_sentiment(as_of: str, code: str, news_items: list[dict],
                      cfg: FactorConfig) -> FactorSeries:
    """單日情緒快照（live_only）。回 FactorSeries（單列 index=as_of）。"""
    name = "消息情緒面"
    idx = pd.Index([as_of], name="date")
    w = cfg.sentiment_sub

    news_score, news_n = _news_polarity(news_items)
    puhui_score = _read_puhui_signal(code, as_of, cfg)

    parts, weights, notes = {}, {}, []
    if news_score is not None:
        parts["news"], weights["news"] = news_score, w.news
        notes.append(f"新聞{news_n}則極性")
    else:
        notes.append("無新聞")
    if puhui_score is not None:
        parts["puhui"], weights["puhui"] = puhui_score, w.puhui
        notes.append("老王訊號")
    else:
        notes.append("老王當日未提及/報告過舊 → 退出重正規化")

    wsum = sum(weights.values())
    if wsum == 0:
        score, conf = 50.0, 0.2
    else:
        score = sum(parts[k] * weights[k] for k in parts) / wsum
        # 信心：兩源齊備高、單源中、語料輕量本就打折
        coverage = wsum / (w.news + w.puhui)
        conf = round(0.4 + 0.3 * coverage, 2)

    subs = pd.DataFrame([{
        "news_score": news_score, "news_count": news_n,
        "puhui_score": puhui_score,
    }], index=idx)

    return FactorSeries(
        "sentiment", name,
        pd.Series([round(score, 1)], index=idx),
        pd.Series([conf], index=idx),
        subs=subs, live_only=True,
        note="情緒輕量版（" + "、".join(notes) + "）；不進回測",
    )
