# 階段 7：APP 前端 + 端到端整合

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase7.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`docs/api.md`、一篇 `reports/**/*.md`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深前端 + 整合工程師。把後端能力變成你每天會打開來看的 APP。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 6 已提供統一 Node API gateway（`/api/dashboard`、`/api/stocks/:code`、`/api/watchlist`、`/api/reports`、`/api/backtest`…，見 `docs/api.md`）。
- 報告風格參考 `reports/**/*.md`（個股色碼 🟢🟠🔴、水位、callout、螢光重點）。終局見 `docs/ROADMAP.md`。

## ⚠️ 對齊現況（執行前必讀 — 2026-06-14 實查 gateway 與 engine 後補）
> 動工前先讀 `routes/gateway.js`、`engine/app/api/data.py` 確認以下仍成立，別照本檔字面臆測。

1. **🔴 硬缺口：gateway 還沒轉發任何 `/data/*`。** K線圖要的 `/data/ohlcv`、即時盤口要的 `/data/book`、盤中分K要的 `/data/intraday` 在 **engine 有、gateway 無**。本階段鐵律是「前端只透過 gateway、不直接打 engine」→ **必須先在 gateway 補這幾個轉發端點**（建議 `GET /api/stocks/:code/ohlcv`、`/api/stocks/:code/book`、`/api/stocks/:code/intraday`，沿用階段6 的錯誤格式/timeout/degradation 慣例），否則 K線頁與當沖頁無資料可接。這層一樣**只轉發、不重算**。
2. **即時盤口預設是 TWSE MIS（官方免費），富果是可選**（階段2 決策）。本檔提到「富果即時盤口」一律當成「即時盤口（TWSE MIS 預設／富果可選）」。
3. **`/api/agents/decide` 很貴**（每股 7×LLM ≈187s、燒額度、gateway 同步阻塞 1200s）→ 個股頁**絕不**自動觸發，只在使用者明確按鈕時呼叫，且**結果要落地快取**（算過就讀、避免重複燒、避開瀏覽器/反向代理 timeout）。
4. **watchlist 是 engine 自動產生、唯讀**（從老王 mentioned_stocks 帶入，無增刪 API、無持久化）。「觀察清單管理」MVP 先做「檢視＋波段/當沖排序切換」；使用者手動增刪需另建儲存層（前端 localStorage 或後端檔＋端點），列為可選。
5. **老王報告 emoji 語意與股市相反：🔴=看多／🟢=看空／🟠=中性**。gateway 對 `signal`/`stance` 已是分類欄位（safe），但前端自選顏色或渲染 raw markdown 報告時不可「紅跌綠漲」反向（`/api/reports` 回應內附 `emoji_semantics` 提醒）。
6. **K線還原價坑**：`/data/ohlcv` 是 FinMind **未還原價**，畫有分割的個股（如 0050）會失真（階段3 已踩過）→ K線需標註，或對個股改走 yfinance 還原。
7. **engine 掛掉的降級要在前端落地**：讀 `/api/health` 判斷狀態；dashboard 的 `degraded:true` 顯示降級橫幅；其餘頁拿到 503 給友善提示（別當白畫面）。

## 本階段目標
1. 建前端（建議 Vite + React + TypeScript + Tailwind + lightweight-charts）放 `web/`，**行動裝置友善**（常用手機看）。
2. **先補 gateway `/data/*` 轉發**（見上「對齊現況」第 1 點）：`/api/stocks/:code/ohlcv`、`/api/stocks/:code/book`、`/api/stocks/:code/intraday`，沿用階段6 慣例。這是 K線頁/當沖頁的前置。
3. 畫面：
   - **儀表板**：當日水位、market_regime、市場情緒、觀察清單訊號（沿用 🟢🟠🔴，注意語意 🔴=看多）；engine 降級時顯示橫幅。
   - **當沖候選頁**：watchlist 依 `rank_daytrade` 排序的當沖候選 + **即時盤口/強弱（TWSE MIS 預設，富果可選）**（盤中用，走新 `/api/stocks/:code/book`）。
   - **個股詳情頁**：多因子雷達/分數、老王觀點、融合訊號（含衝突標記）、迷你回測權益曲線、K 線圖（走新 `/api/stocks/:code/ohlcv`）；**多 agent 決策摘要採「按鈕觸發 + 長 loading + 結果快取」**，不自動跑（見「對齊現況」第 3 點）。
   - **報告檢視頁**：渲染每日 markdown 報告（表格/callout/螢光；emoji 語意見上）。
   - **觀察清單管理**：MVP 先做檢視＋波段/當沖排序切換；手動增刪為可選（需另建儲存層）。
4. 端到端整合：串好「engine 算訊號 → agent 決策 → gateway → 前端呈現」；確認既有 `puhui_daily.cjs` 每日報告也能在前端看到。

## 限制與原則
- 不破壞既有每日報告流程（`scripts/puhui_daily.cjs`）與既有 `routes/finance.js` 端點。
- 前端只透過 Node gateway 取數，**不直接打 Python engine**（要新資料就先在 gateway 加轉發端點，不在前端硬接 engine）。
- gateway 新增的 `/data/*` 轉發**只轉發、不重算**，沿用階段6 的統一錯誤格式 `{error:{code,message,detail?}}` 與 degradation（engine 掛掉回明確 503）。
- 先做能跑的最小可用版（儀表板 + 個股詳情 + 報告檢視），再加圖表細節與當沖頁。
- K線用 `/data/ohlcv`（FinMind 未還原）需標註失真風險；`/api/agents/decide` 結果要落地快取、絕不自動觸發。
- 部署前瞻（鋪路階段8）：Vite build 出靜態檔，建議讓 gateway 直接 serve `web/dist`（gateway 已有 `express.static`），雲端無頭部署才順。

## 驗收標準
- 本機起前端，看到當日儀表板、點進個股看到完整融合資訊（含 K 線圖）、能讀每日報告。
- 手機瀏覽器排版正常。
- 當沖候選頁能顯示清單（盤中接即時盤口；TWSE MIS 預設）。
- gateway 新增 `/api/stocks/:code/{ohlcv,book,intraday}` 可 curl 拿到資料；engine 掛掉時這些回 503、報告頁照常、dashboard 顯示降級橫幅。
- 多 agent 決策只在按鈕觸發、跑完有快取（重整不重算）。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 7 標 ✅。
2. 更新 Obsidian：`...\財經APP開發\階段7-完成紀錄.md` + `開發進度.md`（附畫面截圖說明）。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `web/`。
5. **git commit & push**（`phase7: APP 前端`）：commit 後直接 push。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/api.md`、`routes/gateway.js`、`engine/app/api/data.py`、一篇 reports，提出（a）gateway 要新增的 `/data/*` 轉發端點清單、（b）前端頁面結構與元件設計（含一張 ASCII 線框），讓我確認，再動手。
