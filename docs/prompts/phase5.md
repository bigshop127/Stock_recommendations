# 階段 5：多 agent LLM 決策層（TradingAgents 式）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase5.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、階段 3/4 的 engine API，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深 AI agent 工程師。在量化引擎之上加一層「模擬交易公司」的 LLM 決策，但要嚴格控制成本。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 3（多因子+回測）、階段 4（老王融合訊號 + 自動觀察清單）已完成，engine 能吐結構化數據。
- 參考：`TauricResearch/TradingAgents`（LangGraph 多 agent）。**沿用其「分析師→多空辯論→交易員→風控」架構與提示詞設計，數據改吃我們 engine 的台股結構化輸出**，不用它美股數據層。
- 終局見 `docs/ROADMAP.md`。

## 本階段目標（重點：成本控制——每日盤後對觀察清單跑，不進回測）
1. 用 LangGraph（或等價輕量編排）建多 agent 流程：
   - 技術分析師 agent（吃 engine 多因子分數，**不吃原始 K 線**）
   - 消息/情緒分析師 agent（吃新聞摘要 / 老王 strategy_insights）
   - **老王在地專家 agent**（吃階段 4 老王觀點）← 我們的獨家 agent
   - 多空研究員辯論 → 交易員決策 → 風控檢查 → 最終 BUY/SELL/HOLD + 信心 + 理由
2. 每個 agent 只吃「已結構化的精簡輸入」（控 token）。
3. **LLM 政策**：**Gemini CLI 主 → 當天額度用完自動切 Claude CLI**。要能偵測額度用盡並切換、要能在**無頭環境**跑（為階段 8 雲端鋪路：CLI 預先登入態）。把切換邏輯做成可重用模組。
4. engine API：`POST /agents/decide`（body: codes[], date）→ 每股一份多 agent 決策報告。觀察清單預設 ≤10 檔。

## 限制與原則
- **不要把 agent 流程放進回測迴圈**（太貴）。
- 不要動 `puhui_daily.cjs`。
- agent 提示詞可參考 TradingAgents，但落地成繁中、吃我們的數據格式。
- LLM 呼叫要記錄用量與耗時，方便估每日成本。

## 驗收標準
- 對 3-5 檔觀察股跑完整多 agent 流程，輸出「各 agent 意見 + 多空辯論摘要 + 最終決策 + 信心」。
- Gemini CLI 額度用盡時能自動切 Claude CLI（可用測試或模擬驗證）。
- 回報單檔決策的 LLM 成本/耗時實測值。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 5 標 ✅，記錄 agent 圖設計與成本實測。
2. 更新 Obsidian：`...\財經APP開發\階段5-完成紀錄.md` + `開發進度.md`。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `engine/`（agent 模組獨立資料夾），提示詞放 `engine/agents/prompts/`。
5. git commit（`phase5: 多 agent LLM 決策層`），先別 push 等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、階段 3/4 engine API，並上網看 TradingAgents 的 agent 結構，提出我們的 agent graph 設計 + LLM 切換模組設計讓我確認，再動手。
