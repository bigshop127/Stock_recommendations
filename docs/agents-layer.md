# 多 agent LLM 決策層（階段 5）

> 完成 2026-06-14。實作見 `engine/app/agents/`、提示詞 `engine/app/agents/prompts/`。
> 設計確認（使用者 2026-06-14）：**輕量自寫編排 / 3 分析師 / 1 輪辯論**。
> 全局見 `ROADMAP.md`；融合事實底座見 `blend-rules.md`；型別見 `contracts/`。

---

## 0. 定位（這層只判讀，不重算數字）

在既有**確定性量化引擎之上**加一層「模擬交易公司」的 LLM 決策。**數字一律吃階段 3/4 的結構化
輸出**（`/signal`、`/signal/blended`、`/puhui/view`、`/data/news`），agent 只做判讀與辯論。
**不進回測**（太貴、且老王/情緒 live-only）；僅每日盤後對 watchlist（≤N，預設 10）跑。

### 先對齊現況（動手前實查，非照舊提示詞臆測）
- `/signal/blended` 已做掉**確定性融合**（blended_score / agreement / conflict / 雙方理由 / gate 明細）
  → **agent 吃這顆當不可變事實底座，不重做融合**。
- 沒有 `strategy_insights` 欄位（舊幻想 JSON）；老王「策略洞察」＝ `market_sentiment` ＋ 個股 `reason`。
- 🚨 **老王 emoji 語意與股市相反（🔴=看多/🟢=看空）**。餵 agent **一律用已分類的 `signal`/`stance`/
  `reason`，不餵原始 emoji**；提示詞內仍明寫此語意，避免 LLM 用「紅跌綠漲」反向。

---

## 1. Agent graph（沿用 TradingAgents，數據換台股結構化輸出）

```
                 ┌─ 技術＋籌碼分析師  ← /signal?mode=swing 的 technical/chips FactorScore＋子訊號摘要（不吃原始 K 線）
 watchlist 取股 ─┼─ 消息情緒分析師    ← /data/news 標題摘要 ＋ 老王 market_sentiment
                 └─ 老王在地專家(獨家) ← /puhui/view water_level ＋ 個股 signal/stance/reason
                          │
            ┌─────────────┴──────────────┐
        多頭研究員  →  空頭研究員     （辯論 1 輪，吃三分析師意見＋事實底座）
            └─────────────┬──────────────┘
                      交易員決策 → BUY/SELL/HOLD ＋ 信心 ＋ 理由（須對照 blended_score）
                          │
                      風控檢查 ← 對照 /signal/blended（背離必須點名，不得無視量化分硬翻）
                          │
                ┌─ 一致性守門（確定性，非靠 LLM）─┐
                最終決策報告（各 agent 意見＋辯論摘要＋最終決策＋信心＋一致性＋LLM 用量）
```

每股 LLM 呼叫數 = 3 分析師 + 多空各 1 + 交易員 + 風控 = **7 次**（1 輪辯論）。

### 一致性守門（驗收標準）
最終決策方向 vs 量化 blended 方向（`quant_bull_th`/`bear_th` 判向）：若**背離量化**（多翻空/空翻多）
卻沒被風控/交易員點名（無 `conflict_acknowledged`、文字無「背離/分歧/衝突」）→ **系統強制標 `warning`**，
確保「背離有被點名、而非被無視硬翻」。`orchestrator._consistency` 實作，有專測鎖死。

---

## 2. 編排選型（決策：輕量自寫）

Plain-Python 有向流程 ＋ 共享 state；每個 agent ＝純函式 `(提示詞 ＋ 結構化輸入 → llm_cli → 解析)`。
因 LLM 走 **CLI subprocess**（非 API key），LangGraph/langchain 的 API-LLM 包裝價值有限、仍得自寫
CLI wrapper → 自寫更省、相依更少、最好測、為雲端鋪路。`engine/app/agents/`：

| 檔 | 職責 |
|---|---|
| `llm_cli.py` | 可重用 provider 模組：Gemini 主 → Claude 備、額度偵測、用量遙測（見 §3） |
| `inputs.py` | 每股結構化精簡輸入（in-process 呼叫階段3/4 builder，等同打那些端點） |
| `parsing.py` | LLM 輸出容錯抽 JSON（fence/雜訊/失敗降級，永不中斷流程） |
| `roles.py` | 各 agent 角色函式（分析師/研究員/交易員/風控） |
| `orchestrator.py` | 有向流程串接 ＋ 一致性守門 ＋ `decide_one`/`decide_many` |
| `prompts/*.md` | 繁中提示詞（吃我們的台股結構化格式，與程式分離方便調校） |

---

## 3. LLM 切換模組 `llm_cli.py`（成本控制核心）

**政策**：Gemini CLI 主 → 額度/速率用盡自動切 Claude CLI（兩者本機皆 npm 全域 CLI）。

- **無頭呼叫**：`gemini --skip-trust -p <短指示>`、`claude -p`；**整段 prompt（system＋user）走 stdin**。
  - 🚨 **踩過的坑**：Windows npm CLI 是 `.CMD` 殼、以 `%*` 轉發參數 → 含**換行/`{}`/引號的多行 prompt
    當命令列參數會被 cmd.exe 批次解析打爛**（實測 7 呼叫全失敗、completion=0）。改走 **stdin** 後正常。
  - 🚨 **第二坑**：gemini 在非互動/臨時 cwd 需 `--skip-trust`，否則 **rc=55 workspace-trust** 失敗。
  - CLI 在乾淨臨時 cwd 執行 → 避免 Claude Code 載入整個專案 context 暴增成本。
- **額度偵測**：成功（rc==0 且有輸出）判定**只掃 stderr**（不掃 stdout 答案內容，避免模型答案出現
  「exceeded…」字眼被誤判切換）；非零 exit / stderr 命中精確片語（quota、429、resource_exhausted、
  too many requests、overloaded…）→ 切備援、記一筆切換事件。
- **遙測**：每次呼叫記 token 估算（CJK 約 1 token≈1.7 字）/ 耗時 / provider → `UsageLog.summarize()`
  匯總每日成本估算。**CLI 訂閱制（非 per-token 計費）→ 主軸是用量＋耗時，金額僅粗估**。
- **可測**：`runner(argv, stdin, timeout, cwd)` 可注入 → 假 runner 模擬 gemini 額度用盡切 claude，
  **不燒真實額度**。

### 成本實測（單股 2330，canned inputs，gemini 主）
7 次呼叫 / est ≈ 4,890 tokens / 總 LLM 耗時 ≈ 187s（≈27s/call）/ 0 切換。
備援路徑：gemini 全失敗時 7 次自動切 claude、completion ≈ 1,261 tokens、≈113s，流程不中斷。
→ ≤10 檔每日盤後批次 ≈ 30 分鐘量級，符合成本控制目標。

---

## 4. API

| 端點 | 說明 |
|---|---|
| `POST /agents/decide` | body `{codes?: string[], date?: string}`；`codes` 省略 → 取 `/watchlist` 前 N（≤10）。回每股一份多 agent 報告（各 agent 意見＋辯論摘要＋最終決策＋信心＋一致性＋LLM 用量遙測）。**不進回測。** |

秘密/登入態不入庫（`.env` gitignored、CLI token 不印明文）。對 Node 既有產物唯讀。

---

## 5. 限制 / 未盡（階段 6+）

- 否定/條件式判讀仍倚賴提示詞紀律＋一致性守門，非完整保證；LLM 偶發不回 JSON → 容錯降級為中性占位。
- `/agents/decide` 線上路徑需 FinMind/yfinance 取數（build_blended_signal）＋ CLI 登入態。
- 多 agent 記憶/長期學習、portfolio manager 持倉層、辯論多輪自適應 → 留後續。
- 階段 6 由 Node gateway 統一吐 報告/訊號/水位/回測/agent 決策；階段 8 上 Oracle VM 無頭跑（CLI 預登入）。
