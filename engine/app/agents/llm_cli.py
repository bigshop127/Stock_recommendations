"""可重用 LLM provider 模組（階段5）— 無頭 CLI 呼叫 ＋ 自動備援 ＋ 用量遙測。

政策（ROADMAP §1.6 / phase5）：**Gemini CLI 主 → 當天額度/速率用盡自動切 Claude CLI**。
- 無頭：`gemini -p "<prompt>"`、`claude -p "<prompt>"`（不開互動視窗，為階段8 雲端鋪路）。
- 偵測額度/速率用盡（關鍵字 / 非零 exit / 空輸出）→ 切備援，記一筆切換事件。
- 每次呼叫記 **token 估算 / 耗時 / provider** → `UsageLog` 匯總每日成本估算。
- **測試以注入 `runner` stub 驗證切換邏輯，不實際燒 LLM 額度**。

設計要點：
- `runner(argv, stdin, timeout, cwd) -> (returncode, stdout, stderr)` 可注入 → 單元測試用假 runner。
- CLI 在乾淨臨時 cwd 執行（避免 Claude Code 載入整個專案 context 暴增成本）。
- token 為「估算」（CLI 訂閱制非 per-token 計費）；遙測主軸是 token 用量＋耗時，金額僅粗估。
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from typing import Callable

from app.factors.config import DEFAULT_CONFIG, AgentConfig, FactorConfig

# runner 介面：吃 argv + stdin，回 (returncode, stdout, stderr)
Runner = Callable[[list[str], str, int, str | None], tuple[int, str, str]]

# 額度/速率用盡的已知訊號（小寫比對；用精確片語避免誤判模型答案內容裡的字眼）。
# 注意：成功（rc==0）時**只掃 stderr**，不掃 stdout，避免股票分析答案出現「exceeded
# expectations」之類字眼被誤判成額度用盡而無謂切換。
_QUOTA_MARKERS = (
    "quota", "rate limit", "rate-limit", "ratelimit", "rate_limit",
    "resource_exhausted", "resource has been exhausted", "429",
    "too many requests", "overloaded", "usage limit", "insufficient_quota",
    "exceeded your", "out of capacity",
)


# 餵 stdin 後的尾端指示（單行、無特殊字元）。
_GEMINI_DIRECTIVE = "請嚴格依以上系統指示與輸入作答，只輸出指定的 JSON 物件。"


@dataclass(frozen=True)
class ProviderSpec:
    """單一 CLI provider 的無頭呼叫方式。

    🚨 關鍵：**整段 prompt（system＋user）一律走 stdin、不放命令列參數**。
    Windows npm CLI 是 `.CMD` 殼、以 `%*` 轉發參數 → 含換行/`{}`/引號的多行 prompt 當 argv
    會被 cmd.exe 批次解析打爛（實測 7 呼叫全失敗）。改走 stdin 後 gemini/claude 皆正常。
    """
    name: str               # "gemini" | "claude"
    base_argv: tuple[str, ...]

    def build_call(self, prompt: str, system: str | None, model: str) -> tuple[list[str], str]:
        """回 (argv, stdin_text)。argv 一律保持單行無特殊字元。"""
        stdin_text = f"{system}\n\n{prompt}" if system else prompt
        argv = list(self.base_argv)
        if self.name == "gemini":
            if model:
                argv += ["-m", model]
            # --skip-trust：在非互動/臨時 cwd 也信任 workspace（否則 rc=55 失敗）；為雲端鋪路
            argv += ["--skip-trust", "-p", _GEMINI_DIRECTIVE]   # -p 觸發無頭；內容由 stdin 帶入
        elif self.name == "claude":
            if model:
                argv += ["--model", model]
            argv += ["-p"]                       # -p 無位置參數 → 讀 stdin
        else:  # pragma: no cover - 防呆
            raise ValueError(f"未知 provider：{self.name}")
        return argv, stdin_text


GEMINI = ProviderSpec("gemini", ("gemini",))
CLAUDE = ProviderSpec("claude", ("claude",))


@dataclass
class LLMResult:
    """單次（含備援）LLM 呼叫結果。"""
    text: str
    provider: str               # 實際成功回應的 provider
    model: str
    elapsed_s: float
    est_prompt_tokens: int
    est_completion_tokens: int
    switched: bool              # 是否觸發備援切換
    attempts: list[dict]        # 每個 provider 嘗試明細（含失敗）
    error: str | None = None    # 全部失敗時的錯誤訊息

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.text.strip())


@dataclass
class UsageLog:
    """一次 /agents/decide 流程的 LLM 用量遙測累加器。"""
    calls: list[LLMResult] = field(default_factory=list)
    switch_events: list[dict] = field(default_factory=list)

    def record(self, r: LLMResult, *, role: str | None = None) -> None:
        self.calls.append(r)
        if r.switched:
            self.switch_events.append({
                "role": role, "to": r.provider,
                "attempts": [a["provider"] for a in r.attempts],
            })

    def summarize(self, cfg: AgentConfig = DEFAULT_CONFIG.agents) -> dict:
        by: dict[str, dict] = {}
        tot_tok = tot_s = 0.0
        for c in self.calls:
            b = by.setdefault(c.provider, {"calls": 0, "prompt_tokens": 0,
                                           "completion_tokens": 0, "elapsed_s": 0.0})
            b["calls"] += 1
            b["prompt_tokens"] += c.est_prompt_tokens
            b["completion_tokens"] += c.est_completion_tokens
            b["elapsed_s"] = round(b["elapsed_s"] + c.elapsed_s, 2)
            tot_tok += c.est_prompt_tokens + c.est_completion_tokens
            tot_s += c.elapsed_s
        return {
            "llm_calls": len(self.calls),
            "by_provider": by,
            "est_total_tokens": int(tot_tok),
            "total_elapsed_s": round(tot_s, 2),
            "switch_events": self.switch_events,
            "est_usd": round(tot_tok / 1000.0 * cfg.est_usd_per_1k_tokens, 4),
            "note": "CLI 訂閱制（非 per-token 計費）；token 為估算、金額僅粗估，遙測主軸為用量＋耗時。",
        }


def est_tokens(text: str, cfg: AgentConfig = DEFAULT_CONFIG.agents) -> int:
    """粗略 token 估算（CJK 約 1 token≈1.7 字，用 est_chars_per_token 折算）。"""
    return max(1, round(len(text or "") / cfg.est_chars_per_token))


def _default_runner(argv: list[str], stdin: str, timeout: int,
                    cwd: str | None) -> tuple[int, str, str]:
    """真正呼叫子行程。

    Windows 上 npm 全域 CLI 是 `gemini.CMD`/`claude.CMD` 殼，`subprocess` 需「完整路徑」
    才找得到 → 用 `shutil.which` 解析 argv[0]（PATHEXT 會挑到 .CMD）。shell=False 直接執行
    解析後的完整路徑可正常運作（實測 gemini/claude 皆 OK），同時避免 cmd.exe 引號地獄。
    Linux 雲端 VM（階段8）則 which 取到無副檔名執行檔，同一段碼通用。
    """
    resolved = shutil.which(argv[0]) or argv[0]
    proc = subprocess.run(
        [resolved, *argv[1:]], input=stdin or None, capture_output=True, text=True,
        timeout=timeout, cwd=cwd, encoding="utf-8", errors="replace",
        shell=False,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def looks_quota_exhausted(stdout: str, stderr: str, returncode: int) -> bool:
    """判定是否額度/速率用盡（→ 應切備援）。"""
    blob = f"{stdout}\n{stderr}".lower()
    return any(m in blob for m in _QUOTA_MARKERS)


def _provider_for(name: str) -> ProviderSpec:
    return {"gemini": GEMINI, "claude": CLAUDE}[name]


def _model_for(name: str, cfg: AgentConfig) -> str:
    return {"gemini": cfg.gemini_model, "claude": cfg.claude_model}.get(name, "")


def call_llm(prompt: str, *, system: str | None = None,
             cfg: FactorConfig = DEFAULT_CONFIG,
             runner: Runner | None = None,
             usage: UsageLog | None = None,
             role: str | None = None) -> LLMResult:
    """無頭呼叫 LLM：主 provider 失敗/額度用盡 → 自動切備援。

    回 `LLMResult`（含實際 provider、耗時、token 估算、是否切換、各嘗試明細）。
    `runner` 可注入（測試用假 runner，不燒額度）。
    """
    acfg = cfg.agents
    run = runner or _default_runner
    cwd = tempfile.gettempdir()   # 乾淨 cwd：避免 Claude Code 載入整個專案 context
    order = [acfg.primary_provider, acfg.fallback_provider]

    attempts: list[dict] = []
    est_p = est_tokens((system or "") + prompt, acfg)

    for idx, pname in enumerate(order):
        spec = _provider_for(pname)
        model = _model_for(pname, acfg)
        argv, stdin_text = spec.build_call(prompt, system, model)
        t0 = time.monotonic()
        try:
            rc, out, err = run(argv, stdin_text, acfg.llm_timeout_s, cwd)
        except FileNotFoundError as exc:
            attempts.append({"provider": pname, "ok": False, "reason": f"CLI 不存在：{exc}",
                             "elapsed_s": round(time.monotonic() - t0, 2)})
            continue
        except subprocess.TimeoutExpired:
            attempts.append({"provider": pname, "ok": False, "reason": "逾時",
                             "elapsed_s": round(time.monotonic() - t0, 2)})
            continue
        except Exception as exc:  # noqa: BLE001 — 任一 provider 例外都應嘗試備援
            attempts.append({"provider": pname, "ok": False, "reason": f"例外：{exc}",
                             "elapsed_s": round(time.monotonic() - t0, 2)})
            continue
        elapsed = round(time.monotonic() - t0, 2)
        text = (out or "").strip()
        # 成功判定只看 stderr（不掃 stdout 答案內容，避免誤判）；失敗再用全 blob 標原因
        stderr_quota = looks_quota_exhausted("", err, rc)
        if rc == 0 and text and not stderr_quota:
            result = LLMResult(
                text=text, provider=pname, model=model, elapsed_s=elapsed,
                est_prompt_tokens=est_p, est_completion_tokens=est_tokens(text, acfg),
                switched=(idx > 0), attempts=attempts + [{"provider": pname, "ok": True,
                                                          "elapsed_s": elapsed}],
            )
            if usage is not None:
                usage.record(result, role=role)
            return result
        quota = stderr_quota or looks_quota_exhausted(out, err, rc)
        reason = "額度/速率用盡" if quota else (f"非零 exit={rc}" if rc != 0 else "空輸出")
        attempts.append({"provider": pname, "ok": False, "reason": reason,
                         "elapsed_s": elapsed, "stderr_tail": (err or "")[-200:]})

    # 全部失敗
    result = LLMResult(
        text="", provider=order[-1], model=_model_for(order[-1], acfg),
        elapsed_s=round(sum(a.get("elapsed_s", 0.0) for a in attempts), 2),
        est_prompt_tokens=est_p, est_completion_tokens=0,
        switched=len(attempts) > 1, attempts=attempts,
        error="所有 LLM provider 皆失敗：" + "；".join(
            f"{a['provider']}={a.get('reason')}" for a in attempts),
    )
    if usage is not None:
        usage.record(result, role=role)
    return result
