"""階段5 多 agent 決策層測試（mock/stub，**不打網路、不燒真實 LLM 額度**）。

重點驗收：
- Gemini CLI 額度用盡 → 自動切 Claude CLI（注入假 runner 模擬，不燒額度）。
- 主 provider 成功不切換；兩者皆失敗 → 降級不中斷。
- token 用量 / 耗時 / provider 遙測匯總。
- LLM 輸出容錯解析（含 markdown fence / 雜訊 / 失敗降級）。
- 完整流程（分析師→辯論→交易員→風控）跑通、用量被記錄。
- 一致性守門：最終決策背離量化 blended 卻沒被點名 → 系統強制標 warning（非無視硬翻）。
"""
from __future__ import annotations

import json

from app.agents import llm_cli, orchestrator, parsing, roles
from app.agents.llm_cli import UsageLog
from app.factors.config import DEFAULT_CONFIG

CFG = DEFAULT_CONFIG


# ── 假 runner 工具 ────────────────────────────────────────────────────────────
def _opinion(stance="bull"):
    return json.dumps({"stance": stance, "confidence": 0.7, "summary": f"{stance} 觀點",
                       "key_points": ["重點A", "重點B"]}, ensure_ascii=False)


def _role_response(blob: str, *, risk_decision="BUY", risk_ack=False) -> str:
    """依提示詞內容判定角色 → 回該角色對應 JSON。"""
    if "風控長" in blob:
        return json.dumps({"approved": True, "final_decision": risk_decision, "confidence": 0.65,
                           "conflict_acknowledged": risk_ack, "risk_notes": "風險可控"}, ensure_ascii=False)
    if "交易員" in blob:
        return json.dumps({"decision": "BUY", "confidence": 0.7, "rationale": "綜合偏多"}, ensure_ascii=False)
    if "多頭研究員" in blob:
        return _opinion("bull")
    if "空頭研究員" in blob:
        return _opinion("bear")
    if "老王在地專家" in blob:
        return _opinion("bull")
    if "消息" in blob:
        return _opinion("neutral")
    return _opinion("bull")   # 技術＋籌碼分析師（預設）


def make_runner(*, gemini_quota=False, both_fail=False, risk_decision="BUY", risk_ack=False):
    """產生假 runner：可模擬 gemini 額度用盡 → 切 claude。"""
    def runner(argv, stdin, timeout, cwd):
        provider = argv[0]
        blob = stdin or ""   # prompt（system＋user）現走 stdin，角色關鍵字在此
        if both_fail:
            return 1, "", "quota exceeded"
        if provider == "gemini" and gemini_quota:
            return 1, "", "Error 429: Resource has been exhausted (e.g. check quota)."
        return 0, _role_response(blob, risk_decision=risk_decision, risk_ack=risk_ack), ""
    return runner


# ── llm_cli：切換邏輯（核心驗收，不燒額度）────────────────────────────────────
def test_primary_success_no_switch():
    res = llm_cli.call_llm("hi", system="你是技術＋籌碼分析師", cfg=CFG, runner=make_runner())
    assert res.ok and res.provider == "gemini" and res.switched is False


def test_quota_exhausted_switches_to_claude():
    usage = UsageLog()
    res = llm_cli.call_llm("hi", system="你是技術＋籌碼分析師", cfg=CFG,
                           runner=make_runner(gemini_quota=True), usage=usage, role="technical")
    assert res.ok and res.provider == "claude" and res.switched is True
    # 切換事件入帳
    assert usage.switch_events and usage.switch_events[0]["to"] == "claude"
    # 第一個嘗試是 gemini 且失敗
    assert res.attempts[0]["provider"] == "gemini" and res.attempts[0]["ok"] is False


def test_quota_detection_keywords():
    assert llm_cli.looks_quota_exhausted("", "RESOURCE_EXHAUSTED", 1) is True
    assert llm_cli.looks_quota_exhausted("Error 429 too many requests", "", 1) is True
    assert llm_cli.looks_quota_exhausted("正常回應", "", 0) is False


def test_both_providers_fail_degrades_not_crash():
    res = llm_cli.call_llm("hi", cfg=CFG, runner=make_runner(both_fail=True))
    assert res.ok is False and res.error and res.text == ""
    assert len(res.attempts) == 2   # gemini + claude 都試過


def test_usage_summary_tracks_tokens_and_time():
    usage = UsageLog()
    for _ in range(3):
        llm_cli.call_llm("一段提示詞", system="你是技術＋籌碼分析師", cfg=CFG,
                         runner=make_runner(), usage=usage)
    s = usage.summarize(CFG.agents)
    assert s["llm_calls"] == 3
    assert s["est_total_tokens"] > 0
    assert "gemini" in s["by_provider"]
    assert s["by_provider"]["gemini"]["calls"] == 3


def test_est_tokens_positive():
    assert llm_cli.est_tokens("", CFG.agents) == 1
    assert llm_cli.est_tokens("台積電技術面偏多", CFG.agents) >= 1


# ── 輸出解析容錯 ──────────────────────────────────────────────────────────────
def test_extract_json_from_fenced_and_noisy():
    assert parsing.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parsing.extract_json('一些前言 {"decision": "BUY"} 後話')["decision"] == "BUY"
    assert parsing.extract_json("完全沒有 JSON") is None


def test_parse_opinion_fallback_when_no_json():
    op = parsing.parse_opinion("我認為這檔偏多、看多後市")
    assert op["parse_failed"] is True and op["stance"] == "bull"


def test_parse_decision_and_risk():
    d = parsing.parse_decision('{"decision":"SELL","confidence":0.8,"rationale":"轉弱"}')
    assert d["decision"] == "SELL" and d["confidence"] == 0.8
    r = parsing.parse_risk('{"approved":true,"final_decision":"HOLD","conflict_acknowledged":true,"risk_notes":"背離"}')
    assert r["final_decision"] == "HOLD" and r["conflict_acknowledged"] is True


# ── 完整流程（monkeypatch 掉取數，注入假 runner）──────────────────────────────
def _fake_inputs(blended_score=72.0, conflict=False):
    return {
        "code": "2330", "name": "台積電", "date": "2026-06-12",
        "fact_base": {"code": "2330", "name": "台積電", "blended_score": blended_score,
                      "blended_action": "add", "quant_swing_score": blended_score,
                      "agreement": "aligned", "conflict": conflict, "regime": "neutral",
                      "regime_gate": 1.0, "water_gate": 0.85, "final_gate": 0.85, "confidence": 0.7},
        "technical": {"code": "2330", "factors": [{"factor": "technical", "score": 70, "subs": {}}],
                      "regime": "neutral", "regime_gate": 1.0, "reasons": ["均線多頭排列"]},
        "news": {"code": "2330", "market_sentiment": {"label": "中性", "score": 50},
                 "headlines": [{"title": "台積電法說樂觀"}], "headline_count": 1},
        "puhui": {"code": "2330", "water_level": 0.5, "market_sentiment": {"label": "中性", "score": 50},
                  "stock": {"signal": "BUY", "stance": "bull", "score": 88, "reason": "可順勢翻多買進"},
                  "stale": False},
        "degraded": [], "_blended": {},
    }


def test_full_flow_runs_and_records_usage(monkeypatch):
    monkeypatch.setattr(orchestrator, "build_agent_inputs", lambda code, date, cfg: _fake_inputs())
    usage = UsageLog()
    rep = orchestrator.decide_one("2330", "2026-06-12", cfg=CFG, runner=make_runner(), usage=usage)
    # 三分析師 + 多空各1 + 交易員 + 風控 = 7 次 LLM 呼叫（1 輪辯論）
    assert usage.summarize(CFG.agents)["llm_calls"] == 7
    assert set(rep["analysts"].keys()) == {"technical", "news_sentiment", "puhui"}
    assert len(rep["debate"]) == 2          # bull + bear（1 輪）
    assert rep["final_decision"] == "BUY"
    assert rep["consistency"]["divergent_from_quant"] is False


def test_full_flow_uses_claude_when_gemini_quota(monkeypatch):
    monkeypatch.setattr(orchestrator, "build_agent_inputs", lambda code, date, cfg: _fake_inputs())
    usage = UsageLog()
    orchestrator.decide_one("2330", "2026-06-12", cfg=CFG,
                            runner=make_runner(gemini_quota=True), usage=usage)
    s = usage.summarize(CFG.agents)
    # 所有呼叫都切到 claude，且記了切換事件
    assert s["by_provider"].get("claude", {}).get("calls") == 7
    assert "gemini" not in s["by_provider"]
    assert len(s["switch_events"]) == 7


def test_consistency_guard_flags_unacknowledged_divergence(monkeypatch):
    """量化偏空(40) 但最終 BUY 且風控沒點名 → 系統強制標 warning（背離不被無視硬翻）。"""
    monkeypatch.setattr(orchestrator, "build_agent_inputs",
                        lambda code, date, cfg: _fake_inputs(blended_score=40.0))
    rep = orchestrator.decide_one("2330", "2026-06-12", cfg=CFG,
                                  runner=make_runner(risk_decision="BUY", risk_ack=False))
    c = rep["consistency"]
    assert c["blended_direction"] == "bear" and c["agent_direction"] == "bull"
    assert c["divergent_from_quant"] is True
    assert c["warning"] is not None        # 被點名

def test_consistency_no_warning_when_acknowledged(monkeypatch):
    monkeypatch.setattr(orchestrator, "build_agent_inputs",
                        lambda code, date, cfg: _fake_inputs(blended_score=40.0))
    rep = orchestrator.decide_one("2330", "2026-06-12", cfg=CFG,
                                  runner=make_runner(risk_decision="BUY", risk_ack=True))
    assert rep["consistency"]["warning"] is None   # 風控已 conflict_acknowledged → 不再強制標
