# 階段 5：多 agent LLM 決策層（TradingAgents 式）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase5.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`（特別是 §0 修正框與 §9 階段4 紀錄）、`docs/scoring-model.md`、`docs/blend-rules.md`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深 AI agent 工程師。在**既有確定性量化引擎之上**加一層「模擬交易公司」的 LLM 決策，嚴格控成本。**這層只做判讀與辯論，不重算數字**——數字一律吃階段 3/4 的結構化輸出。

## ⚠️ 先對齊現況（動手前必做，省得重蹈階段 4 覆轍）
階段 4 實查推翻過一個幻想前提（不存在的 `data/puhui_analysis JSON`）。本階段同樣**先確認真實可用的 engine 介面與欄位**，不要照舊提示詞臆測。實際打一次下列端點看回傳：

- 量化訊號：`GET /signal?code=&date=&mode=swing|daytrade` → factor 子分在回傳裡。
- **量化 × 老王 融合（階段 4 已做掉確定性融合）**：`GET /signal/blended?code=&date=` → 已含 `blended_score`、`agreement`、`conflict`、雙方理由、gate 明細。**agent 層吃這顆當事實底座，不要重做融合。**
- 純老王觀點：`GET /puhui/view?code=&date=` → `water_level`、`market_sentiment`、個股 `{emoji, stance, signal, score, reason}`。
- 候選股來源：`GET /watchlist?date=` → 波段/當沖雙排序清單（含老王 tag）。
- 🚨 **老王報告 emoji 語意與股市相反**（🔴=看多/🟢=看空，見 `blend-rules.md`）。**餵 agent 一律用已分類的 `signal`（BUY/ADD/HOLD/WATCH/REDUCE/SELL）與文字 `reason`，不要餵原始 emoji**；提示詞內仍明寫此語意，避免 LLM 用「紅跌綠漲」直覺把訊號反向。
- **沒有 `strategy_insights` 這個欄位**（那是舊幻想 JSON 的欄位）；老王的「策略洞察」＝ `market_sentiment` ＋ 個股 `reason`。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 3（多因子+回測）、階段 4（老王融合訊號 + 自動觀察清單）已完成，engine 能吐上列結構化數據。
- 參考：`TauricResearch/TradingAgents`（LangGraph 多 agent）。**沿用其「分析師→多空辯論→交易員→風控」流程與提示詞設計，數據改吃我們 engine 的台股結構化輸出**，不用它的美股數據層。
- 終局見 `docs/ROADMAP.md`。

## 本階段目標（重點：成本控制——每日盤後對觀察清單跑，不進回測）
1. 建多 agent 流程，每個 agent 只吃「已結構化的精簡輸入」（控 token、避免 emoji 反向）：
   - **技術分析師 agent**：吃 `/signal?mode=swing` 的 factor 分數與子訊號摘要，**不吃原始 K 線**。
   - **消息/情緒分析師 agent**：吃新聞摘要（階段 2 `/data/news`）＋ 老王 `market_sentiment`。
   - **老王在地專家 agent（我們的獨家 agent）**：吃 `/puhui/view` 的 `water_level` ＋ 個股 `signal`/`stance`/`reason`。
   - **多空研究員辯論 → 交易員決策 → 風控檢查** → 最終 `BUY/SELL/HOLD` ＋ 信心 ＋ 理由。
2. **以 `/signal/blended` 為事實底座**：agent 最終決策要與確定性 `blended_score`/`conflict` 對照——同向則強化、背離則在報告裡點明分歧與理由，**不得無視量化分硬翻**。
3. **編排選型（建議，設計確認時定案）**：因 LLM 走 **CLI subprocess**（非 API key），LangGraph/langchain 的 API-LLM 包裝價值有限、仍得自寫 CLI wrapper → **建議用輕量自寫編排**（plain-Python 有向流程 ＋ 共享 state dict），把每個 agent 當「prompt ＋ 結構化輸入 → CLI → 解析」的純函式串起來。LangGraph 仍可選；若採用，需自寫吃 CLI 的 Runnable。
4. **LLM 政策**：**Gemini CLI 主 → 當天額度用完自動切 Claude CLI**（兩者本機皆已裝為 npm 全域 CLI）。做成**可重用 provider 模組**（`engine/app/agents/llm_cli.py`）：
   - **無頭呼叫**（stdin / `-p`/`--prompt`），不開互動視窗——為階段 8 雲端鋪路（CLI 預先登入態）。
   - **偵測額度/速率用盡**（關鍵字 / 非零 exit / 已知錯誤訊息）→ 自動切備援，並記一筆切換事件。
   - 記錄每次呼叫的 **token 估算 / 耗時 / 用哪個 provider**，匯總成每日成本估算。
   - **測試用 mock/stub 驗證切換邏輯，不實際燒 LLM 額度**。
5. engine API：`POST /agents/decide`（body：`{codes?: string[], date?: string}`）→ 每股一份多 agent 決策報告（各 agent 意見 ＋ 辯論摘要 ＋ 最終決策 ＋ 信心 ＋ LLM 用量）。`codes` 省略時取 `/watchlist` 前 N（預設 ≤10 檔）。

## 限制與原則
- **不要把 agent 流程放進回測迴圈**（太貴、且老王/情緒 live-only）。**本階段不新增回測。**
- 不要動 `scripts/puhui_daily.cjs`；engine 對 Node 既有產物唯讀。
- agent 提示詞可參考 TradingAgents，但**落地成繁中、吃我們的數據格式**，放 `engine/app/agents/prompts/`。
- 所有 LLM 呼叫一律走 `llm_cli` provider；**祕密/登入態不入庫**（`.env` gitignored，CLI token 不印明文）。
- 因走 CLI 訂閱（非 per-token 計費），「成本」以 **token 用量 ＋ 耗時** 為主要 telemetry，金額為估算。

## 驗收標準
- 對 3-5 檔觀察股跑完整多 agent 流程，輸出「各 agent 意見 ＋ 多空辯論摘要 ＋ 最終決策 ＋ 信心 ＋ 對照 `blended_score`」。
- Gemini CLI 額度用盡時能自動切 Claude CLI（**mock/模擬**驗證，不燒真實額度）。
- 回報單檔決策的 **token 用量 / 耗時** 實測或估算值。
- 最終決策與 `/signal/blended` 的 `conflict` 做一致性檢查（背離有被點名，而非被無視翻盤）。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 5 標 ✅，記錄 agent 圖設計、編排選型、LLM 切換模組與成本實測。
2. 更新 Obsidian：`...\財經APP開發\階段5-完成紀錄.md` ＋ `開發進度.md`。
3. 更新記憶 ＋ `MEMORY.md`。
4. 程式放 `engine/app/agents/`（既有骨架資料夾），提示詞放 `engine/app/agents/prompts/`。
5. **git commit & push**（`phase5: 多 agent LLM 決策層`）：commit 後直接 push。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/blend-rules.md` 與階段 3/4 engine API，**實際打一次 `/signal/blended` 與 `/puhui/view` 看回傳欄位**，並上網看 TradingAgents 的 agent 結構，**提出我們的 agent graph 設計 ＋ 編排選型 ＋ LLM 切換模組設計讓我確認，再動手。**
