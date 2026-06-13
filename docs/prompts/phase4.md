# 階段 4：老王訊號整合 + 自動觀察清單

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase4.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、階段 3 的 `/signal`、`/backtest`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深量化工程師。把專案**獨家**的老王內容情報接進量化引擎——這是別人沒有的護城河。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 3 已有確定性多因子引擎 + 回測（`engine /signal`、`/backtest`）。
- 獨家資產：
  - `data/puhui_analysis/*.json`：歷史每篇老王文章結構化分析（market_regime、mentioned_stocks[code/name/signal(BUY/SELL/WATCH)/reason]、entry/exit_conditions、strategy_insights）。
  - `data/puhui_cache.json`：當日 water_level、stocks、market_sentiment、confidence_level。
  - `reports/**/*.md`：每日報告原文。
- 終局見 `docs/ROADMAP.md`。

## 本階段目標
1. 在 engine 建「老王情報層」：載入 `puhui_analysis` + `puhui_cache`，依日期/個股建索引，對齊階段 3 的 `StockSignal`。
2. **自動觀察清單**（你的核心需求）：從老王 `mentioned_stocks` 自動帶入候選，依兩個分數排序成「重點關注」：
   - **潛力分（波段）**：老王偏多 + 量化波段分高。
   - **短線當沖機率分**：用階段 3 當沖模式 + 富果盤中（量能爆發、內外盤、強弱）。
   - 產出 `Watchlist`（依 `docs/contracts`），標哪些是「當沖候選」哪些是「波段潛力」。
3. **融合規則**（先給我選項再實作，寫進 `docs/blend-rules.md`）：
   - 老王明確 BUY/SELL 且量化同向 → 提升信心；背離 → 標記衝突並降信心。
   - 老王 market_regime / water_level 當大盤過濾層，疊加到個股訊號。
4. engine API：
   - `GET /signal/blended?code=&date=`（量化 + 老王 融合訊號 + 衝突標記）
   - `GET /watchlist?date=`（自動觀察清單，含當沖/波段標籤與排序）
   - `GET /puhui/view?code=&date=`（純老王觀點查詢）

## 限制與原則
- 不要動 `puhui_daily.cjs`（它持續產生新 analysis/cache，本階段是讀取消費端）。
- 老王資料可能缺日/缺股 → 優雅處理 missing。
- 融合權重與衝突處理規則先給我選項再做。

## 驗收標準
- 任選 reports 提到的個股+日期，能同時看到「量化訊號 / 老王觀點 / 融合訊號 / 是否衝突」。
- `GET /watchlist` 能吐出當日自動觀察清單，當沖候選與波段潛力分開排序。
- 融合邏輯有 `docs/blend-rules.md`。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 4 標 ✅，記錄融合規則與觀察清單邏輯。
2. 更新 Obsidian：`...\財經APP開發\階段4-完成紀錄.md` + `開發進度.md`。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `engine/`，規則文件放 `docs/`。
5. git commit（`phase4: 老王整合與觀察清單`），先別 push 等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、`data/puhui_analysis` 幾個 json、`data/puhui_cache.json`、階段 3 `/signal`，提出融合規則與觀察清單排序方案讓我選，再動手。
