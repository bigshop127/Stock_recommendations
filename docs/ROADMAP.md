# 財經 APP 整合藍圖（老王情報 + 多因子量化 + 多 agent LLM + 前端 + 雲端）

> 建立 2026-06-13。目標：把現有「浦惠投顧老王每日盤勢自動化」（內容工具）升級成
> **會出台股買賣訊號（波段＋短線當沖）、可回測、有前端、能雲端每日自動運作**的策略系統。
> 整合：(1) 多因子量化引擎 (2) TradingAgents 式多 agent 決策 (3) APP 前端 (4) 雲端化。

---

## 0. 既有資產（任何階段都不可破壞）

- `scripts/puhui_daily.cjs`：每天抓老王盤勢文 → AI 摘要 → 產 `reports/YYYY-MM/Wn/*.md`，天天在跑。
- `data/puhui_analysis/*.json`：歷史文章結構化分析（market_regime、mentioned_stocks[code/name/signal/reason]、entry/exit_conditions、strategy_insights）。
- `data/puhui_cache.json`：當日水位、個股、market_sentiment、confidence_level。
- `reports/**/*.md`、`server.cjs`（Express 骨架）。

---

## 1. 已定案的關鍵決策

1. **架構**：Node 內容線保留不動；新增 **Python FastAPI 引擎**（`engine/`）做數據/因子/回測/agent；Node 當 gateway；前端獨立。三者走 HTTP。
2. **「七維度」作廢** → 改 **多因子評分模型**（`docs/scoring-model.md`，第 1 階段定案）。因子用真實台股數據，權重不寫死、用回測調：
   - 技術面（RSI/MA/三陽開泰/乖離/量能）← OHLCV
   - 籌碼面（三大法人買賣超、融資融券）← FinMind
   - 盤口/主力（內外盤、五檔委買賣、大單）← 富果 Fugle **（live-only，不進回測）**
   - 消息情緒面（新聞情緒 + 老王 strategy_insights）
   - 大盤環境（0050/大盤 regime、漲跌家數/恐懼貪婪 proxy）
3. **數據源**：
   - **FinMind**（免費）：歷史 OHLCV + 三大法人 + 融資融券 → **回測主力**。
   - **富果 Fugle**（API key，玉山）：即時報價 + 五檔盤口 + 盤中分K/tick → **live 訊號 + 當沖**。歷史盤口拿不到。
   - **yfinance**：美股四大指數 / 費半（大盤環境）。
4. **訊號兩模式**：波段（swing，可回測）、短線當沖（daytrade，吃富果盤中，回測受歷史資料限制）。
5. **觀察清單**：自動從老王 `mentioned_stocks` 帶入，依「潛力(波段分) + 短線當沖機率」排序成重點關注。
6. **LLM 政策**：**Gemini CLI 主 → 當天額度用完切 Claude CLI**；多 agent 只在每日盤後對觀察清單（≤10 檔）跑，不進回測。需可在無頭雲端 VM 跑。
7. **雲端**：**Oracle Cloud Always-Free ARM VM 為主**（24h 常開、保留 CLI 訂閱登入態），**GitHub Actions** 跑無 LLM 的數據/回測刷新。解決「不能 24h 開機」+ 既有 puhui_daily 本機單點故障。
8. **TradingAgents**：沿用其 agent 架構與提示詞設計，數據層換台股（不直接用其美股數據層）。
9. **每階段收尾規範（DoD）**：完成後必須同步 (a) `docs/ROADMAP.md` 進度 (b) Obsidian `C:\obsidian\儲存庫\財經APP開發\` (c) 記憶 `.claude\projects\C--CC-AI-Agent\memory\` (d) 程式/文件放對位置。

---

## 2. 8 階段總覽與進度

| # | 階段 | 產出 | 依賴 | 狀態 |
|---|---|---|---|---|
| 1 | 架構地基 + 資料契約 | FastAPI 骨架、Node↔Python、**多因子模型定案**、共用 schema、收尾規範 | — | ⬜ 未開始 |
| 2 | 台股數據層 | FinMind + 富果 Fugle + yfinance + 快取 | 1 | ⬜ |
| 3 | 多因子引擎 + 回測核心 | 確定性訊號（波段＋當沖）+ 向量化回測 | 1,2 | ⬜ |
| 4 | 老王整合 + 觀察清單 | 老王融合訊號 + 自動觀察清單（潛力/當沖排序） | 3 | ⬜ |
| 5 | 多 agent LLM 決策層 | 分析師→多空辯論→交易員→風控 | 3,4 | ⬜ |
| 6 | 統一 API 層 | Node gateway，吐 報告/訊號/水位/回測/agent決策 | 3,4,5 | ⬜ |
| 7 | APP 前端 + 端到端整合 | Vite+React 儀表板 + 當沖候選 | 6 | ⬜ |
| 8 | 雲端部署 + 每日排程 | Oracle VM（主）+ GitHub Actions；runbook | 7 | ⬜ |

執行節奏：第 1 定契約最關鍵；第 3 完成＝有可回測策略硬核；第 5 才上 LLM；第 7 接前端；第 8 上雲。

---

## 3. 技術選型（建議）

- 引擎：Python 3.11+ / FastAPI / uvicorn；TA：pandas + pandas-ta；回測：純 pandas 向量化（避免未來函數）
- 數據：FinMind、fugle-marketdata（富果）、yfinance；快取 parquet 或 sqlite
- 多 agent：LangGraph + langchain；LLM 走 Gemini CLI → Claude CLI
- Gateway：Node Express（server.cjs）
- 前端：Vite + React + TypeScript + Tailwind + lightweight-charts（行動友善）
- 雲端：Oracle Cloud Always-Free（ARM Ampere）+ GitHub Actions

---

## 4. 各階段提示詞檔案

放在 `docs/prompts/phase1.md … phase8.md`。
使用方式：開新對話 →「請幫我閱讀 docs/prompts/phaseN.md 然後按照裡面的說明進行。」

---

## 5. 仍待定案（執行到對應階段時決定）

- [ ] 多因子最終因子組合與初始權重（第 1 階段提方案讓我選）
- [ ] 當沖訊號的具體進出規則與風控（第 3 階段）
- [ ] Oracle VM vs GitHub Actions 各跑哪一段（第 8 階段細分）
