# 階段 7：APP 前端 + 端到端整合

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase7.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`docs/api.md`、一篇 `reports/**/*.md`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深前端 + 整合工程師。把後端能力變成你每天會打開來看的 APP。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 6 已提供統一 Node API gateway（`/api/dashboard`、`/api/stocks/:code`、`/api/watchlist`、`/api/reports`、`/api/backtest`…，見 `docs/api.md`）。
- 報告風格參考 `reports/**/*.md`（個股色碼 🟢🟠🔴、水位、callout、螢光重點）。終局見 `docs/ROADMAP.md`。

## 本階段目標
1. 建前端（建議 Vite + React + TypeScript + Tailwind + lightweight-charts）放 `web/`，**行動裝置友善**（常用手機看）。
2. 畫面：
   - **儀表板**：當日水位、market_regime、市場情緒、觀察清單訊號（沿用 🟢🟠🔴）。
   - **當沖候選頁**：階段 4 的當沖候選清單 + 富果即時盤口/強弱（盤中用）。
   - **個股詳情頁**：多因子雷達/分數、老王觀點、融合訊號（含衝突標記）、多 agent 決策摘要、迷你回測權益曲線、K 線圖。
   - **報告檢視頁**：渲染每日 markdown 報告（表格/callout/螢光）。
   - **觀察清單管理**。
3. 端到端整合：串好「engine 算訊號 → agent 決策 → gateway → 前端呈現」；確認既有 `puhui_daily.cjs` 每日報告也能在前端看到。

## 限制與原則
- 不破壞既有每日報告流程。
- 前端只透過 Node gateway 取數，**不直接打 Python engine**。
- 先做能跑的最小可用版（儀表板 + 個股詳情 + 報告檢視），再加圖表細節與當沖頁。

## 驗收標準
- 本機起前端，看到當日儀表板、點進個股看到完整融合資訊、能讀每日報告。
- 手機瀏覽器排版正常。
- 當沖候選頁能顯示清單（盤中接富果即時資料）。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 7 標 ✅。
2. 更新 Obsidian：`...\財經APP開發\階段7-完成紀錄.md` + `開發進度.md`（附畫面截圖說明）。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `web/`。
5. git commit（`phase7: APP 前端`），先別 push 等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/api.md`、一篇 reports，提出前端頁面結構與元件設計（含一張 ASCII 線框）讓我確認，再動手。
