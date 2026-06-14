"""LLM 輸出解析（階段5）— 容錯抽取結構化結果。

每個 agent 被要求回一小段 JSON；LLM 偶爾會包裹多餘文字/markdown code fence。
本模組做「盡力抽第一個 JSON 物件」，失敗則回退到啟發式（從文字推 stance/decision），
**永不讓解析失敗中斷整條流程**——降級成 raw text + parse_failed 標記，仍產出報告。
"""
from __future__ import annotations

import json
import re

_DECISION_WORDS = {
    "BUY": ("buy", "買進", "做多", "看多", "加碼", "進場"),
    "SELL": ("sell", "賣出", "做空", "看空", "出清", "減碼"),
    "HOLD": ("hold", "持有", "觀望", "中性", "續抱", "等待"),
}
_STANCE_WORDS = {
    "bull": ("bull", "看多", "偏多", "做多", "樂觀"),
    "bear": ("bear", "看空", "偏空", "做空", "保守", "悲觀"),
    "neutral": ("neutral", "中性", "觀望"),
}


def _strip_fences(text: str) -> str:
    t = text.strip()
    # 去掉 ```json ... ``` 或 ``` ... ``` 外殼
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    return t.strip()


def extract_json(text: str) -> dict | None:
    """抽第一個平衡的 JSON 物件；抽不到回 None。"""
    if not text:
        return None
    cleaned = _strip_fences(text)
    # 先試整段
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    # 掃第一個 { 起的平衡括號區段
    start = cleaned.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(cleaned)):
            ch = cleaned[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = cleaned[start:i + 1]
                    try:
                        obj = json.loads(chunk)
                        if isinstance(obj, dict):
                            return obj
                    except (json.JSONDecodeError, ValueError):
                        break
        start = cleaned.find("{", start + 1)
    return None


def _keyword_guess(text: str, table: dict[str, tuple]) -> str | None:
    low = (text or "").lower()
    counts = {k: sum(low.count(w.lower()) for w in words) for k, words in table.items()}
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else None


def parse_opinion(text: str) -> dict:
    """分析師/研究員意見：期望 {stance, confidence, summary, key_points}。容錯降級。"""
    obj = extract_json(text)
    if obj:
        stance = str(obj.get("stance", "")).lower()
        if stance not in ("bull", "bear", "neutral"):
            stance = _keyword_guess(stance + " " + str(obj.get("summary", "")), _STANCE_WORDS) or "neutral"
        return {
            "stance": stance,
            "confidence": _clamp01(obj.get("confidence")),
            "summary": str(obj.get("summary", "")).strip()[:600],
            "key_points": _as_str_list(obj.get("key_points")),
            "parse_failed": False,
        }
    return {
        "stance": _keyword_guess(text, _STANCE_WORDS) or "neutral",
        "confidence": None,
        "summary": (text or "").strip()[:600],
        "key_points": [],
        "parse_failed": True,
    }


def parse_decision(text: str) -> dict:
    """交易員決策：期望 {decision: BUY|SELL|HOLD, confidence, rationale}。容錯降級。"""
    obj = extract_json(text)
    if obj:
        dec = str(obj.get("decision", "")).upper()
        if dec not in ("BUY", "SELL", "HOLD"):
            dec = _keyword_guess(dec + " " + str(obj.get("rationale", "")), _DECISION_WORDS) or "HOLD"
        return {
            "decision": dec,
            "confidence": _clamp01(obj.get("confidence")),
            "rationale": str(obj.get("rationale", "")).strip()[:800],
            "parse_failed": False,
        }
    return {
        "decision": _keyword_guess(text, _DECISION_WORDS) or "HOLD",
        "confidence": None,
        "rationale": (text or "").strip()[:800],
        "parse_failed": True,
    }


def parse_risk(text: str) -> dict:
    """風控檢查：期望 {approved, final_decision, confidence, conflict_acknowledged, risk_notes}。"""
    obj = extract_json(text)
    if obj:
        dec = str(obj.get("final_decision", "")).upper()
        if dec not in ("BUY", "SELL", "HOLD"):
            dec = _keyword_guess(dec + " " + str(obj.get("risk_notes", "")), _DECISION_WORDS) or "HOLD"
        return {
            "approved": _as_bool(obj.get("approved"), default=True),
            "final_decision": dec,
            "confidence": _clamp01(obj.get("confidence")),
            "conflict_acknowledged": _as_bool(obj.get("conflict_acknowledged"), default=False),
            "risk_notes": str(obj.get("risk_notes", "")).strip()[:800],
            "parse_failed": False,
        }
    return {
        "approved": True,
        "final_decision": _keyword_guess(text, _DECISION_WORDS) or "HOLD",
        "confidence": None,
        "conflict_acknowledged": False,
        "risk_notes": (text or "").strip()[:800],
        "parse_failed": True,
    }


def _clamp01(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(min(1.0, max(0.0, f)), 2)


def _as_str_list(v) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()][:8]
    if isinstance(v, str) and v.strip():
        return [v.strip()[:200]]
    return []


def _as_bool(v, *, default: bool) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1", "approve", "approved", "是", "通過")
    return default
