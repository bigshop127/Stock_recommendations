# 階段 6：統一 API 層（Node gateway）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase6.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`server.cjs`、engine 各 API、`docs/contracts`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深後端工程師。把所有能力收斂成前端可用的統一 REST gateway。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。既有 `server.cjs`（Express 骨架：`/api/finance/*`、`/api/run-script`）。
- engine（Python FastAPI）已提供：`/signal`、`/signal/blended`、`/watchlist`、`/backtest`、`/agents/decide`、`/data/*`（階段 2-5）。
- 報告在 `reports/**/*.md`，當日快取 `data/puhui_cache.json`。終局見 `docs/ROADMAP.md`。

## 本階段目標
1. 把 Node `server.cjs` 擴成 API gateway：對前端提供統一 REST，內部代理到 Python engine + 讀 `reports/` + 讀 `data/puhui_cache.json`。
2. 端點（最終以 `docs/contracts` 為準）：
   - `GET /api/dashboard?date=`（當日水位 + market_regime + 市場情緒 + 觀察清單摘要）
   - `GET /api/stocks/:code?date=`（多因子分數 + 老王觀點 + 融合訊號 + agent 決策 + 迷你回測）
   - `GET /api/watchlist`（自動觀察清單，含當沖/波段標籤）
   - `GET /api/reports?date=` 與 `GET /api/reports/list`（每日報告 markdown）
   - `GET /api/backtest`（轉發 engine）
   - `POST /api/agents/decide`（轉發 engine）
3. 加 CORS、統一錯誤格式、**engine 不可用時 graceful degradation**（報告/快取類端點仍可用，訊號/回測類回明確錯誤）。

## 限制與原則
- 保留既有端點與 `puhui_daily.cjs` 流程不破壞。
- engine 為可選依賴：engine 掛掉時 `/api/dashboard`、`/api/reports` 仍要能用（degraded）。
- 端點 JSON 形狀對齊 `docs/contracts`。

## 驗收標準
- 用 curl/瀏覽器能打到全部端點並拿到正確 JSON。
- engine 關閉時 `/api/dashboard`、`/api/reports` 仍可用。
- 有 `docs/api.md` 列出所有端點與回傳格式。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 6 標 ✅。
2. 更新 Obsidian：`...\財經APP開發\階段6-完成紀錄.md` + `開發進度.md`。
3. 更新記憶 + `MEMORY.md`。
4. 程式改 `server.cjs`（或拆 `routes/`），API 文件放 `docs/api.md`。
5. **git commit & push**（`phase6: 統一 API gateway`）：commit 後直接 push。

## 開始方式
先讀 `docs/ROADMAP.md`、`server.cjs`、engine 各 API、`docs/contracts`，提出 gateway 路由設計讓我確認，再動手。
