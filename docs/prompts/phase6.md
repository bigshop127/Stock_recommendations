# 階段 6：統一 API 層（Node gateway）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase6.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`server.cjs`、`engine/app/api/*`（實際路由）、`docs/contracts/*`，
> **動手前先做「先對齊現況」實查**（不照本檔臆測），再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深後端工程師。把階段 2-5 的引擎能力 + 老王報告，收斂成前端（階段7）可直接消費的統一 REST gateway。
**這層只做組合/轉發/降級，不重算數字、不碰回測邏輯**——數字一律吃 engine 與 `reports/`。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。Windows / PowerShell；檔案一律 **UTF-8**（中文路徑）。
- 既有 `server.cjs`（Express，port 3000）目前只有：`GET /api/finance/status`、`POST /api/finance/update`、
  `POST /api/run-script`（白名單 `puhui_synthesize.js`/`sync_to_obsidian.js`）。**這些要保留不破壞。**
  - ⚠️ `cors` 套件雖已 `require`，但**目前沒有 `app.use(cors())`**——CORS 實際未啟用，本階段要補。
- engine（Python FastAPI，預設 `http://127.0.0.1:8000`，啟動見 `engine/README.md`）已提供（階段 2-5）：

  | 方法 | 端點 | 說明 |
  |---|---|---|
  | GET | `/health` | 健康檢查 |
  | GET | `/signal?code=&mode=swing\|daytrade&date=` | 個股訊號（swing 可回測 / daytrade live-only） |
  | GET | `/signal/blended?code=&date=` | 量化 × 老王 **融合訊號**（含 conflict 標記、雙方理由、gate 明細） |
  | GET | `/watchlist?date=` | 自動觀察清單（波段潛力 / 當沖候選各自排序） |
  | GET | `/puhui/view?date=` | **純老王觀點**（Phase4 解析 `reports/**/*.md` 的結果：water_level / market_sentiment / 個股 signal·stance·reason） |
  | POST | `/backtest` | 波段策略回測（含成本 + 0050 benchmark） |
  | POST | `/backtest/grid` | 權重/門檻網格掃描 |
  | POST | `/agents/decide` | 多 agent 決策（body `{codes?, date?}`） |
  | GET | `/data/{ohlcv,chips,book,intraday,market,futures,news,macro}` | 原始數據層（一般前端不直連，gateway 內部用） |

- **老王資料來源（重要，舊提示詞寫錯過）**：
  - 真實獨家資產 ＝ git 追蹤的 `reports/**/*.md`（老王每日報告）。**結構化老王觀點一律走 engine `/puhui/view`**（Phase4 確定性解析器消費 reports）。
  - `data/puhui_cache.json` 是**淺層 regex 快取**（gitignored），只有全域 `water_level`/`market_sentiment`，**沒有個股代號/買賣訊號**——僅當 **engine 掛掉時的 degraded 後援**讀它，**不可**拿它當主要老王資料。
  - 🚨 **老王報告 emoji 語意與股市相反（🔴=看多 / 🟢=看空）**。gateway 轉發 engine 的是**已分類**欄位（safe）；但若 `/api/reports` 直接吐 raw markdown 給前端，前端渲染需知道此語意——在 API 文件明寫，避免「紅跌綠漲」反向。
- 終局藍圖見 `docs/ROADMAP.md`；對外型別以 `docs/contracts/*.md` 為**單一事實來源**。

## 先對齊現況（動手前實查，非照本檔臆測）
1. **實打 engine** 確認上表每個端點的真實回傳形狀（`GET http://127.0.0.1:8000/docs` 或直接 curl）；
   特別確認 `/signal/blended`、`/puhui/view`、`/watchlist` 的欄位名，對齊 `docs/contracts`。
2. **讀 `server.cjs`** 確認現有端點與 `express.json()`/`express.static` 設定，規劃如何擴充而非重寫。
3. 確認 `reports/` 目錄的日期/檔名結構（gateway 要能依 `date` 找到當日報告）。
4. 確認 `data/puhui_cache.json` 實際欄位（degraded 後援只能拿到哪些）。

## 本階段目標
1. 把 `server.cjs` 擴成 API gateway：對前端提供統一 REST，內部**代理 engine** + **讀 `reports/` 檔案系統**。
   - engine 代理建議集中一個 helper（`fetch`/axios，帶 timeout、統一錯誤轉譯、base URL 走 `ENGINE_BASE_URL` env，預設 `http://127.0.0.1:8000`）。
   - 程式可拆 `routes/`（建議）或留在 `server.cjs`；**既有端點與 `puhui_daily.cjs` 流程不可破壞**。
2. 端點（最終以 `docs/contracts` 為準；前綴 `/api`）：

   | 方法 | gateway 端點 | 組合來源 | 對應契約 |
   |---|---|---|---|
   | GET | `/api/dashboard?date=` | engine `/puhui/view` + `/watchlist` + 大盤環境（`/data/market` 或 blended 內的 regime） | `DailySnapshot` |
   | GET | `/api/stocks/:code?date=` | engine `/signal?mode=swing` + `/signal?mode=daytrade` + `/signal/blended` + `/puhui/view`(該股) + 迷你回測（可選） | `StockSignal`(×2) + blended |
   | GET | `/api/watchlist?date=` | engine `/watchlist` 轉發 | `Watchlist[]` |
   | GET | `/api/reports/list` | 列 `reports/` 可用日期/檔案（純檔案系統） | — |
   | GET | `/api/reports?date=` | 讀當日報告 markdown（純檔案系統） | — |
   | POST | `/api/backtest` | 轉發 engine **`POST /backtest`**（body 透傳） | `BacktestResult` |
   | POST | `/api/backtest/grid` | 轉發 engine `POST /backtest/grid`（可選） | — |
   | POST | `/api/agents/decide` | 轉發 engine `POST /agents/decide`（body `{codes?, date?}`） | agent 決策報告 |

   - 🚨 **`/api/agents/decide` 很貴**（每股 7 次 LLM 呼叫、單股 ≈187s）→ **只在前端明確請求時呼叫**，
     **絕不**在 `/api/dashboard` 或 `/api/stocks/:code` 內自動觸發；代理 timeout 要放寬（或考慮非同步/輪詢，留意即可）。
   - `/api/stocks/:code` 的「迷你回測」若會拖慢回應，設為可選參數（如 `?backtest=1`），預設不跑。
3. 橫切需求：
   - **啟用 CORS**（補 `app.use(cors())`，前端跨網域可打）。
   - **統一錯誤格式**（如 `{ error: { code, message, detail? } }`），HTTP status 合理（400/404/502/503）。
   - **engine 不可用時 graceful degradation**（見下表）。

### graceful degradation 對照（engine 關閉時的行為）

| 端點 | engine 掛掉時 |
|---|---|
| `/api/reports`、`/api/reports/list` | **照常可用**（純檔案系統，不依賴 engine） |
| `/api/dashboard` | **degraded 可用**：水位/情緒退而讀 `data/puhui_cache.json`（僅全域 water_level/sentiment，無個股清單）；明確標記 `degraded: true` |
| `/api/stocks/:code`、`/api/watchlist`、`/api/backtest`、`/api/agents/decide` | 回**明確 503**（engine 不可用），不可假裝成功、不可吐殘缺數字 |

## 限制與原則
- 保留既有端點與 `scripts/puhui_daily.cjs` 流程**不破壞**；對 Node 既有產物（`reports/`、`data/*`）**唯讀**。
- engine 為**可選依賴**：engine 掛掉時 reports 類與 degraded dashboard 仍要能用。
- gateway **不重算分數、不重做融合、不碰回測邏輯**——只組合/轉發/降級。
- 端點 JSON 形狀對齊 `docs/contracts`；改欄位要同步契約 + 範例。
- 機密走 `.env`（gitignored、不印明文）；engine base URL 走 `ENGINE_BASE_URL` env。

## 驗收標準
- engine 開著：用 curl/瀏覽器能打到全部 `/api/*` 端點並拿到對齊契約的正確 JSON（含 `POST /api/backtest`、`POST /api/agents/decide`）。
- engine 關閉：`/api/reports*` 照常、`/api/dashboard` 回 degraded（標記 `degraded:true` 且來自 puhui_cache）、其餘回明確 503。
- CORS 生效（跨網域請求不被擋）；錯誤格式統一。
- 有 `docs/api.md` 列出所有端點、方法、參數、回傳格式、degradation 行為。

## 完成收尾清單（DoD）
1. **驗收**：跑上面「驗收標準」，把 curl 結果貼給使用者。
2. 更新 `docs/ROADMAP.md`：階段 6 標 ✅、記錄關鍵決策與未盡事項。
3. 更新 Obsidian：`C:\obsidian\儲存庫\財經APP開發\階段6-完成紀錄.md` + `開發進度.md`。
4. 更新記憶：`.claude\projects\C--CC-AI-Agent\memory\` 相關 `.md` + `MEMORY.md` 索引。
5. 程式改 `server.cjs`（或拆 `routes/`），API 文件放 `docs/api.md`。
6. **git commit & push**（`phase6: 統一 API gateway`）：commit 後直接 `git push origin master`（2026-06-13 定案：自動 push 不再等確認）。

## 開始方式
先做「先對齊現況」實查（實打 engine 各端點、讀 `server.cjs`、確認 `reports/` 與 `puhui_cache.json` 結構），
**提出 gateway 路由設計（端點對照表 + degradation 行為 + 錯誤格式）讓我確認，再動手寫。**
