"""多 agent 角色函式（階段5）— 每個 agent ＝「提示詞 ＋ 結構化輸入 → CLI → 解析」的純函式。

角色（沿用 TradingAgents，數據改吃我們台股結構化輸出）：
- 三分析師：技術＋籌碼 / 消息情緒 / 老王在地專家。
- 多空研究員辯論（1 輪，使用者定案）。
- 交易員決策 → 風控檢查。

所有 LLM 呼叫一律走 `llm_cli.call_llm`（Gemini 主 → Claude 備）；`runner`/`usage` 可注入測試。
"""
from __future__ import annotations

import json

from app.agents import llm_cli, parsing, prompts
from app.agents.llm_cli import Runner, UsageLog
from app.factors.config import DEFAULT_CONFIG, FactorConfig


def _payload_str(obj: dict, cfg: FactorConfig) -> str:
    s = json.dumps(obj, ensure_ascii=False, default=str)
    limit = cfg.agents.max_input_chars
    return s if len(s) <= limit else s[:limit] + "…(截斷)"


def _run(role: str, system_name: str, header: str, payload: dict, parse_fn,
         cfg: FactorConfig, runner: Runner | None, usage: UsageLog | None) -> dict:
    system = prompts.load(system_name)
    prompt = f"{header}\n\n```json\n{_payload_str(payload, cfg)}\n```"
    res = llm_cli.call_llm(prompt, system=system, cfg=cfg, runner=runner, usage=usage, role=role)
    parsed = parse_fn(res.text) if res.ok else _llm_failed(parse_fn)
    parsed["_llm"] = {
        "provider": res.provider, "switched": res.switched,
        "elapsed_s": res.elapsed_s,
        "est_tokens": res.est_prompt_tokens + res.est_completion_tokens,
        "error": res.error,
    }
    parsed["role"] = role
    return parsed


def _llm_failed(parse_fn) -> dict:
    """LLM 全失敗 → 中性降級結果（流程不中斷）。"""
    base = parse_fn("")
    base["llm_failed"] = True
    base["summary"] = base.get("summary") or "LLM 不可用 → 此 agent 退出，僅供占位"
    return base


# ── 分析師（吃各自結構化精簡輸入）─────────────────────────────────────────────
def analyst_technical(inputs: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
                      runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    return _run("technical_analyst", "technical_analyst",
                "以下是引擎算好的技術＋籌碼 factor 分數與子訊號（數字已算好，勿重算）：",
                inputs["technical"], parsing.parse_opinion, cfg, runner, usage)


def analyst_news(inputs: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
                 runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    return _run("news_sentiment_analyst", "news_sentiment_analyst",
                "以下是近期相關新聞標題與大盤情緒：",
                inputs["news"], parsing.parse_opinion, cfg, runner, usage)


def analyst_puhui(inputs: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
                  runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    return _run("puhui_expert", "puhui_expert",
                "以下是老王報告已解析好的個股觀點（signal/stance 已分類，請直接相信、勿用紅綠反推）：",
                inputs["puhui"], parsing.parse_opinion, cfg, runner, usage)


_ANALYSTS = {
    "technical": analyst_technical,
    "news_sentiment": analyst_news,
    "puhui": analyst_puhui,
}


def run_analysts(inputs: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
                 runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    """依 cfg.agents.analysts 跑啟用的分析師，回 {name: opinion}。"""
    out = {}
    for name in cfg.agents.analysts:
        fn = _ANALYSTS.get(name)
        if fn:
            out[name] = fn(inputs, cfg=cfg, runner=runner, usage=usage)
    return out


# ── 多空研究員辯論 ────────────────────────────────────────────────────────────
def researcher_bull(inputs: dict, analyst_opinions: dict, prior: list[dict] | None = None, *,
                    cfg: FactorConfig = DEFAULT_CONFIG, runner: Runner | None = None,
                    usage: UsageLog | None = None) -> dict:
    payload = {"fact_base": inputs["fact_base"], "analysts": _slim_opinions(analyst_opinions),
               "debate_so_far": prior or []}
    return _run("bull_researcher", "bull_researcher",
                "請建構做多論點（不得無視量化事實底座 blended_score/conflict）：",
                payload, parsing.parse_opinion, cfg, runner, usage)


def researcher_bear(inputs: dict, analyst_opinions: dict, prior: list[dict] | None = None, *,
                    cfg: FactorConfig = DEFAULT_CONFIG, runner: Runner | None = None,
                    usage: UsageLog | None = None) -> dict:
    payload = {"fact_base": inputs["fact_base"], "analysts": _slim_opinions(analyst_opinions),
               "debate_so_far": prior or []}
    return _run("bear_researcher", "bear_researcher",
                "請建構看空/保守論點並反駁多方（不得無視量化事實底座）：",
                payload, parsing.parse_opinion, cfg, runner, usage)


def run_debate(inputs: dict, analyst_opinions: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
               runner: Runner | None = None, usage: UsageLog | None = None) -> list[dict]:
    """多空辯論 N 輪（使用者定案 1 輪）。回每回合 [bull, bear] 攤平的序列。"""
    transcript: list[dict] = []
    for _ in range(max(1, cfg.agents.debate_rounds)):
        bull = researcher_bull(inputs, analyst_opinions, transcript, cfg=cfg, runner=runner, usage=usage)
        transcript.append({"side": "bull", **_slim_one(bull)})
        bear = researcher_bear(inputs, analyst_opinions, transcript, cfg=cfg, runner=runner, usage=usage)
        transcript.append({"side": "bear", **_slim_one(bear)})
    return transcript


# ── 交易員 → 風控 ─────────────────────────────────────────────────────────────
def trader_decide(inputs: dict, analyst_opinions: dict, debate: list[dict], *,
                  cfg: FactorConfig = DEFAULT_CONFIG, runner: Runner | None = None,
                  usage: UsageLog | None = None) -> dict:
    payload = {"fact_base": inputs["fact_base"], "analysts": _slim_opinions(analyst_opinions),
               "debate": debate}
    return _run("trader", "trader",
                "綜合分析師意見、多空辯論與量化事實底座，做出單一交易決策：",
                payload, parsing.parse_decision, cfg, runner, usage)


def risk_review(inputs: dict, trader_decision: dict, *, cfg: FactorConfig = DEFAULT_CONFIG,
                runner: Runner | None = None, usage: UsageLog | None = None) -> dict:
    payload = {"fact_base": inputs["fact_base"],
               "trader_decision": {k: trader_decision.get(k) for k in ("decision", "confidence", "rationale")}}
    return _run("risk_manager", "risk_manager",
                "審核交易員決策的風險與一致性（背離量化必須點名，不得無視量化分硬翻）：",
                payload, parsing.parse_risk, cfg, runner, usage)


# ── 精簡輔助（控 token：辯論/交易員只看意見摘要，不重複塞全文）──────────────────
def _slim_one(op: dict) -> dict:
    return {"stance": op.get("stance"), "confidence": op.get("confidence"),
            "summary": op.get("summary"), "key_points": op.get("key_points", [])[:3]}


def _slim_opinions(opinions: dict) -> dict:
    return {name: _slim_one(op) for name, op in opinions.items()}
