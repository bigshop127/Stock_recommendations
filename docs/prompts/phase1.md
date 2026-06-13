# 階段 1：架構地基 + 資料契約 + 多因子模型定案

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase1.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md` 對齊全局，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深量化 + 全端架構師，負責整個專案的地基。地基沒打好後面 7 階段都會返工，所以本階段重點是**把契約與規格定死**，不是寫很多功能。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`（Windows / PowerShell）。既有 Node.js 內容線天天在跑，本案新增 Python 引擎。
- 終局：把「浦惠投顧老王每日盤勢」內容情報 + 多因子量化 + 多 agent LLM，整合成**會出台股訊號（波段＋短線當沖）、可回測、有前端、能雲端每日自動運作**的策略系統。
- 不可破壞的既有資產：`scripts/puhui_daily.cjs`（每日產 `reports/*.md`）、`data/puhui_analysis/*.json`、`data/puhui_cache.json`、`reports/**/*.md`、`server.cjs`。
- 全局決策見 `docs/ROADMAP.md`。關鍵：「七維度」已作廢改「多因子模型」；數據用 FinMind+富果Fugle+yfinance；LLM 用 Gemini CLI→Claude CLI；雲端用 Oracle VM。

## 本階段目標
1. 新增 Python 引擎骨架（FastAPI + uvicorn）放在 `engine/`，與既有 Node 並存；提供 `GET /health`。
2. 建立 Node ↔ Python HTTP 串接 demo：Node 有一支 script 成功呼叫 `engine /health` 並印出結果。
3. **【最重要】定案「多因子評分模型」**，寫成 `docs/scoring-model.md`：
   - 先給我 **2-3 個台股版因子方案**（每案：因子清單、各因子對應的台股數據來源、初步計算公式、初始權重）。
   - 因子建議涵蓋：技術面（RSI/MA/三陽開泰/乖離/量能）、籌碼面（三大法人/融資券）、盤口（富果，標 live-only 不回測）、消息情緒（新聞+老王 strategy_insights）、大盤環境（0050/漲跌家數/恐懼貪婪 proxy）。
   - 權重**不要寫死**，設計成「初始值 + 之後用回測調」。
   - 讓我從你的方案中選定後再定稿。
4. 定義全系統共用 JSON schema（寫在 `docs/contracts/*.md`，附範例）：
   - `StockSignal`（code/name/date/**mode: swing|daytrade**/action/score/factors/reasons/confidence）
   - `FactorScore`（各因子分數 + 信心 + 是否 live-only）
   - `DailySnapshot`（date/market_regime/water_level/watchlist[]）
   - `Watchlist`（自動帶入的老王個股 + 排序分數）
   - `BacktestResult`（cum_return/annual/sharpe/max_drawdown/win_rate/trades/equity_curve）
5. 確立**收尾規範**並寫進 `docs/contracts/dev-conventions.md`：Obsidian 開發筆記位置（`C:\obsidian\儲存庫\財經APP開發\`）、記憶檔位置（`.claude\projects\C--CC-AI-Agent\memory\`）、每階段 DoD。
6. 決定 repo 目錄結構並記錄（engine/、web/、docs/、data/ 各放什麼）。

## 限制與原則
- **絕對不要改 `scripts/puhui_daily.cjs`** 的每日流程。
- 多因子方案、目錄結構等重大設計，**先給我選項再動手**，不要自己拍板。
- Windows 環境，注意路徑與 UTF-8 編碼。
- 本階段不接真實數據、不寫因子計算實作（那是階段 2、3），只定骨架與契約。

## 驗收標準
- `engine/` 能啟動，`GET /health` 回 200；Node script 能成功呼叫並印出。
- `docs/scoring-model.md`（我已確認的多因子定案）、`docs/contracts/*.md`、`docs/contracts/dev-conventions.md` 都存在。
- 跑一次驗收並把結果貼給我。

## 完成收尾清單（DoD — 每階段必做）
1. 更新 `docs/ROADMAP.md`：把階段 1 標記 ✅、記錄定案的多因子方案與未盡事項。
2. 更新 Obsidian：在 `C:\obsidian\儲存庫\財經APP開發\` 建/更新 `開發進度.md` 與 `階段1-完成紀錄.md`（做了什麼、關鍵決策、怎麼用）。
3. 更新記憶：`.claude\projects\C--CC-AI-Agent\memory\` 內相關 `.md` + `MEMORY.md` 索引。
4. 程式/文件放對位置（engine/ 程式、docs/ 規格）。
5. git add + commit（訊息：`phase1: 架構地基與多因子契約`），但**先別 push**，等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、`server.cjs`、`scripts/puhui_daily.cjs`、`data/puhui_analysis` 任一 json，提出實作計畫與 2-3 個多因子方案讓我確認，再動手。
