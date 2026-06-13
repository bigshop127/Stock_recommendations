# 階段 2：台股行情/籌碼數據層

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase2.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md` 與 `docs/scoring-model.md`、`docs/contracts/`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深數據工程師，負責替引擎打好數據地基。數據品質決定後面訊號與回測的可信度。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1 已建好 `engine/`（FastAPI）、`docs/scoring-model.md`（多因子定案）、`docs/contracts/`（schema）。
- 終局：台股策略系統（多因子量化 + 老王情報 + 多 agent + 前端 + 雲端）。本階段是第 2 階段。
- 既有不可破壞：`scripts/puhui_daily.cjs` 等（見 `docs/ROADMAP.md`）。

## 本階段目標
在 `engine/` 內建台股數據層，三個來源：
1. **FinMind（免費，回測主力）**：日 K OHLCV、成交量、三大法人買賣超、融資融券餘額（依 `docs/scoring-model.md` 實際需要的欄位）。API token 走 `.env`。
2. **富果 Fugle（玉山，API key）— live 與當沖用**：即時報價、**最佳五檔（委買委賣盤口）**、盤中分K/tick。
   - 注意：富果**歷史盤口/委買賣明細拿不到** → 在數據層明確標記「盤口為 live-only，不可回測」。
   - 確認富果歷史「分K」可取得的範圍（給當沖回測用，可能僅近期），把限制寫進文件。
3. **yfinance**：美股四大指數、費城半導體（給大盤環境因子）。
4. 加本地快取（parquet 或 sqlite，放 `engine/data_cache/`），支援「抓歷史區間」與「更新到最新」，重跑命中快取不重打 API。
5. engine API：
   - `GET /data/ohlcv?code=2330&start=&end=`
   - `GET /data/chips?code=2330&start=&end=`（法人/融資券）
   - `GET /data/book?code=2330`（富果即時五檔，live）
   - `GET /data/intraday?code=2330&date=`（富果盤中分K）
   - `GET /data/market?date=`（美股指數/大盤快照）

## 限制與原則
- 不要動 `puhui_daily.cjs`。
- FinMind / 富果都有頻率限制 → retry + 快取；金鑰一律走 `.env`，不可硬編。
- 若 `docs/scoring-model.md` 需要的某數據拿不到，**明確標示並提替代方案問我**，不要靜默略過。

## 驗收標準
- 對任一台股代號（如 2330、2317）回傳乾淨的歷史 OHLCV + 籌碼資料。
- 富果即時五檔能取到（盤中測試）；盤中分K 能取到並標明可回溯範圍。
- 重跑命中快取、不重打 API。
- 有測試腳本示範抓 2330 近一年 OHLCV+籌碼、與即時五檔。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 2 標 ✅，記錄各數據源實際可取得欄位與限制（尤其富果歷史限制）。
2. 更新 Obsidian：`C:\obsidian\儲存庫\財經APP開發\階段2-完成紀錄.md` + `開發進度.md`。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `engine/`、快取放 `engine/data_cache/`、文件放 `docs/`。
5. git commit（`phase2: 台股數據層`），先別 push 等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、`docs/contracts/`，列出需要哪些 FinMind 資料集 + 富果端點 + 對應 schema 給我確認，再動手。
