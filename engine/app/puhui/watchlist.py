"""自動觀察清單（階段4 核心需求）— scoring-model §3 / contracts/Watchlist.md。

候選 = 老王報告 `mentioned_stocks`（已反查代號）∪ 引擎自選（factor 宇宙）。
對每檔同時算兩分數、**各自排序**（決策4：純量化分排序，老王只當 tag/來源、不污染排名）：
- `swing_score`（波段潛力，階段3 swing 引擎）→ `rank_swing`
- `daytrade_prob`（短線當沖機率，階段3 daytrade 引擎；盤後無盤口 → null，排末）→ `rank_daytrade`

降級（決策5）：取數失敗 / 盤後無盤口 → 分數 null、排末，**不硬填**。
"""
from __future__ import annotations

from app.factors.config import DEFAULT_CONFIG, FactorConfig
from app.factors.daytrade import build_daytrade_signal
from app.factors.swing import build_swing_signal
from app.puhui import repo

# 引擎自選宇宙（factor 來源）：少量高流動權值股當預設，可由呼叫端覆寫。
DEFAULT_FACTOR_UNIVERSE = ["2330", "2317", "2454", "2308", "2881"]


def _tags_from_swing(swing: dict) -> list[str]:
    tags = []
    for r in swing.get("reasons", []):
        if any(k in r for k in ("外資", "投信", "法人")):
            tags.append("法人買超")
        elif "均線多頭" in r or "站上" in r:
            tags.append("均線偏多")
        elif "量增" in r:
            tags.append("量增")
        elif "三陽開泰" in r:
            tags.append("三陽開泰")
        elif "RSI" in r:
            tags.append("動能區")
    return list(dict.fromkeys(tags))   # 去重保序


def _score_one(code: str, name: str, date: str | None, cfg: FactorConfig) -> dict:
    """單檔：算 swing_score + daytrade_prob（皆容錯降級）。"""
    swing_score, swing_conf, tags = None, None, []
    try:
        sw = build_swing_signal(code, date, cfg)
        swing_score = float(sw["score"])
        swing_conf = float(sw["confidence"])
        name = sw.get("name") or name
        tags = _tags_from_swing(sw)
        if swing_score >= cfg.thresholds.add_watch:
            tags.append("波段潛力")
    except Exception:
        tags.append("波段分不可得")

    daytrade_prob = None
    try:
        dt = build_daytrade_signal(code, cfg)
        # 任一 live 因子可用才有效；否則盤後無盤口 → null（排末）
        if any(f.get("weight", 0) > 0 for f in dt.get("factors", [])):
            daytrade_prob = round(float(dt["score"]) / 100.0, 3)
            if daytrade_prob > 0:
                tags.append("當沖候選")
    except Exception:
        pass

    return {
        "code": code, "name": name,
        "swing_score": round(swing_score, 1) if swing_score is not None else None,
        "swing_confidence": round(swing_conf, 2) if swing_conf is not None else None,
        "daytrade_prob": daytrade_prob,
        "tags": list(dict.fromkeys(tags)),
    }


def _rank(items: list[dict], key: str, rank_field: str) -> None:
    """依 key 由高到低給名次；None 一律排末（並列以原序）。"""
    have = [it for it in items if it.get(key) is not None]
    none = [it for it in items if it.get(key) is None]
    have.sort(key=lambda it: it[key], reverse=True)
    for i, it in enumerate(have, 1):
        it[rank_field] = i
    for j, it in enumerate(none, len(have) + 1):
        it[rank_field] = j


def build_watchlist(date: str | None = None, *, extra_codes: list[str] | None = None,
                    cfg: FactorConfig = DEFAULT_CONFIG) -> dict:
    """自動觀察清單。回 {date, as_of_date, items[], ...}。"""
    daily = repo.get_daily(date, cfg=cfg)
    puhui_map: dict[str, dict] = {}
    if daily:
        for s in daily.get("stocks", []):
            if s.get("code"):
                puhui_map[str(s["code"])] = s

    factor_codes = list(extra_codes) if extra_codes is not None else list(DEFAULT_FACTOR_UNIVERSE)
    all_codes = list(dict.fromkeys(list(puhui_map.keys()) + factor_codes))

    items = []
    for code in all_codes:
        ps = puhui_map.get(code)
        name = (ps or {}).get("name", code)
        item = _score_one(code, name, date, cfg)

        source = []
        if code in puhui_map:
            source.append("puhui")
        if code in factor_codes:
            source.append("factor")
        item["source"] = source

        if ps:
            item["puhui_signal"] = ps.get("signal")
            item["puhui_reason"] = ps.get("raw_action") or ps.get("reason")
            item["puhui_emoji"] = ps.get("emoji")
            item["puhui_score"] = ps.get("score")
            if ps.get("emoji"):
                item["tags"].append(f"老王{ps['emoji']}{ps.get('signal','')}")
        else:
            item["puhui_signal"] = None
            item["puhui_reason"] = None
        item["tags"] = list(dict.fromkeys(item["tags"]))
        items.append(item)

    _rank(items, "swing_score", "rank_swing")
    _rank(items, "daytrade_prob", "rank_daytrade")

    return {
        "date": (date or (daily and daily.get("requested_date"))),
        "as_of_date": daily.get("as_of_date") if daily else None,
        "stale": daily.get("stale") if daily else None,
        "count": len(items),
        "items": items,
        "notes": (daily or {}).get("notes", []) if daily else ["當日及 fallback 視窗內無老王報告"],
    }
