# Gateway API（階段 6：統一 API 層）

> Node Express gateway（`server.cjs` + `routes/` + `lib/`），對前端（階段7）提供統一 REST。
> **這層只組合/轉發/降級，不重算分數、不重做融合、不碰回測**——數字一律吃 Python engine 與 `reports/`。
> 對外型別以 `docs/contracts/*.md` 為單一事實來源。

- Base URL：`http://localhost:3000`（`PORT` env 可改）
- Engine：Python FastAPI，base 走 `ENGINE_BASE_URL` env（預設 `http://127.0.0.1:8000`），啟動見 `engine/README.md`
- **CORS 全開**（`app.use(cors())`），前端可跨網域呼叫
- 程式分層：`server.cjs`（組裝）→ `routes/finance.js`（既有端點）+ `routes/gateway.js`（新 `/api/*`）→ `lib/engine.js`（engine 代理）/`lib/reports.js`（FS）/`lib/puhui_cache.js`（degraded）/`lib/errors.js`

## 🚨 老王報告 emoji 語意（前端渲染務必知道）

老王報告的 emoji 色碼**與股市紅綠相反**：**🔴 = 看多 / 🟢 = 看空 / 🟠 = 中性觀望**。
gateway 轉發 engine 的是**已分類欄位**（`signal`/`stance`，safe）；但 `GET /api/reports` 直接吐 raw markdown，
前端自行渲染時不可「紅跌綠漲」反向（回應內附 `emoji_semantics` 提醒）。

---

## 統一錯誤格式

所有 `/api/*` 失敗一律回：

```json
{ "error": { "code": "ENGINE_UNAVAILABLE", "message": "人話訊息", "detail": "（可選）原始細節" } }
```

| HTTP | `code` | 時機 |
|---|---|---|
| 400 | `BAD_REQUEST` | 參數錯誤 / engine 回 400·422 透傳 |
| 404 | `NOT_FOUND` / `REPORT_NOT_FOUND` | engine 回 404 透傳 / 報告日不存在 |
| 502 | `ENGINE_ERROR` | engine 回 5xx（例：DataSourceError 502、FinMind 額度） |
| 503 | `ENGINE_UNAVAILABLE` | **連不到 engine**（ECONNREFUSED）→ degradation 判斷依據 |
| 504 | `UPSTREAM_TIMEOUT` | engine 呼叫逾時 |

每端點代理 timeout：signal 60s、watchlist/dashboard 90s、backtest 180s、**agents/decide 1200s**、health 5s。

---

## 端點

### `GET /api/health`
Gateway 自身 + 探 engine 是否可用（前端可據此判斷是否進 degraded 模式）。

```json
{ "gateway": "ok", "engine": "up" | "down", "engine_base_url": "http://127.0.0.1:8000", "time": "ISO" }
```
engine 掛掉也回 200（`engine:"down"`）。

---

### `GET /api/dashboard?date=`
首頁全局快照。組合 engine `/puhui/view`（水位/情緒）+ `/watchlist`（清單）+ 代表股 `/signal?mode=swing` 的 `regime`（大盤環境，market-wide，不重算）。對應契約 **`DailySnapshot`**。

```json
{
  "date": "2026-06-12",
  "as_of_date": "2026-06-12",
  "market_regime": { "label": "risk_on", "score": 1.0, "gate": 1.1, "confidence": 0.55, "note": "...", "inputs": {...} },
  "water_level": 0.5,
  "water_level_text": "五成",
  "puhui_sentiment": { "label": "中性", "score": 50 },
  "watchlist": [ /* Watchlist[]，見 contracts/Watchlist.md */ ],
  "degraded": false,
  "generated_at": "ISO"
}
```

- `water_level`：**數值 0~1**（正規化；engine 原生 float、degraded 由「五成」轉換）；`water_level_text` 為中文顯示字串。
- `puhui_sentiment.score`：**0~100**（engine 原生；degraded 由 cache 的 1~10 ×10 對齊）。
- 老王當日無報告（fallback 視窗外）→ `water_level`/`puhui_sentiment` 為 `null`，`watchlist` 仍照常。
- **engine 掛掉 → degraded（見下）**。

---

### `GET /api/stocks/:code?date=&backtest=0`
個股詳情。組合 `/signal?mode=swing` + `/signal?mode=daytrade` + `/signal/blended` + `/puhui/view?code=`（該股）。
`backtest=1` 才額外跑迷你 `POST /backtest`（預設**不跑**，避免拖慢）。對應 **`StockSignal`×2 + blended**。

```json
{
  "code": "2330", "name": "台積電", "date": "2026-06-12",
  "swing":    { /* StockSignal mode=swing，含 regime 物件 */ },
  "daytrade": { /* StockSignal mode=daytrade；盤後無盤口時 { mode, unavailable:true, reason } */ },
  "blended":  { /* 融合訊號：mode=blended, agreement, conflict, puhui, blend{...} */ },
  "puhui":    { /* /puhui/view 該股結果；老王未提及 → null */ },
  "backtest": { /* 僅 backtest=1 */ },
  "generated_at": "ISO"
}
```
- `daytrade` 為 live-only：盤後常無盤口，會回 `unavailable:true` 而**不拖垮**整體回應。
- `puhui` 為 `null` 代表老王當日報告未提及此股（404 容忍）。

---

### `GET /api/stocks/:code/ohlcv?start=&end=&adjust=`
日K OHLCV（供前端畫 K 線）。`start`/`end` 省略 → engine 預設近一年。回 `{ code, name, source, rows, data:[{date,open,high,low,close,volume,turnover}] }`。

- `adjust` 省略/0 → 透傳 engine **`/data/ohlcv`**（FinMind **未還原價**）。
- `adjust=1`（或 `true`/`yes`/`on`）→ 透傳 engine **`/data/ohlcv_adj`**（yfinance `auto_adjust` **還原價**，含除權息/分割；無 turnour 欄）。**階段7 新增**：`service.get_ohlcv_adj` 已掛上 HTTP 路由。

> 🚨 **K線還原價**：未還原源（`adjust` 省略）對含分割/除權的個股（如 0050）會有斷點失真（階段3 已踩過）。
> 前端 K 線**預設走 `adjust=1` 還原價**；另提供「原始」分頁並標註失真風險。仍只轉發、不重算。

### `GET /api/stocks/:code/book`
即時最佳五檔（engine `/data/book` 透傳，當沖盤口/強弱用）。**預設 TWSE MIS（官方免金鑰）**，設定 `FUGLE_API_KEY` + `BOOK_SOURCE=fugle` 才走富果。回 `{ code, source, live_only:true, book:{ last_price, bids[], asks[], total, ... } }`。

> live-only、不可回測；盤口為近即時（延遲數秒），供訊號評分非下單執行。

### `GET /api/stocks/:code/intraday?date=&timeframe=`
盤中分K（engine `/data/intraday` 透傳）。`timeframe` ∈ `1/5/10/15/30/60`（預設 `1`）；`date` 省略=今日 live、過去日=歷史（受富果回溯限制）。回 `{ code, date, timeframe, source, rows, data[] }`。

> **需 `FUGLE_API_KEY`**（富果為唯一盤中分K源）。未設金鑰 → engine 回 502 → gateway `ENGINE_ERROR`。

---

### `GET /api/watchlist?date=`
自動觀察清單（engine `/watchlist` 透傳）。`items[]` 為 **`Watchlist`** 元素（`swing_score`/`daytrade_prob`/`rank_*`/`source`/`puhui_*`/`tags`），波段與當沖各自排序。

---

### `GET /api/reports/list`
列可用老王報告日期（**純檔案系統，engine 掛掉照常**）。

```json
{ "count": 18, "latest": "2026-06-12", "dates": ["2026-06-12", ...],
  "reports": [ { "date": "2026-06-12", "path": "reports/2026-06/W2/2026-06-12.md", "month": "2026-06", "week": "W2" } ] }
```

### `GET /api/reports?date=`
讀當日報告 markdown（**純檔案系統**）；`date` 省略 → 最新一篇；查無 → 404 `REPORT_NOT_FOUND`。

```json
{ "date": "2026-06-12", "path": "reports/2026-06/W2/2026-06-12.md", "markdown": "# ...", "emoji_semantics": "🔴=看多 / 🟢=看空 / 🟠=中性觀望（與股市紅漲綠跌相反）" }
```

---

### `POST /api/backtest`
波段策略回測（engine `/backtest` body 透傳）。對應 **`BacktestResult`**。

```jsonc
// body
{ "codes": ["2330"], "start": "2026-03-01", "end": "2026-06-12",
  "weights": { "technical": 0.6, "chips": 0.4 }, "entry_score": 70, "exit_score": 40, "cost": {} }
```
回 `{ strategy, period, params, metrics{cum_return,annual_return,sharpe,max_drawdown,win_rate,trades,avg_holding_days}, equity_curve[], benchmark{name,cum_return,...} }`。

### `POST /api/backtest/grid`
權重/門檻網格掃描（engine `/backtest/grid` 透傳）。回 `{ best, grid[] }`。

---

### `POST /api/agents/decide`
多 agent LLM 決策（engine `/agents/decide` 透傳）。body `{ codes?: string[], date?: string }`；`codes` 省略 → engine 取 `/watchlist` 前 N（≤10）。

> 🚨 **很貴**：每股 7 次 LLM 呼叫、單股 ≈187s。**只在前端明確 POST 時呼叫**；
> **絕不**在 `/api/dashboard`、`/api/stocks/:code` 內自動觸發。gateway timeout 已放寬至 1200s。

回 `{ date, count, decisions[], errors[], usage, config }`。

---

## Graceful degradation（engine 掛掉時）

| 端點 | engine down 行為 |
|---|---|
| `GET /api/health` | 200，`engine:"down"` |
| `GET /api/reports/list`、`GET /api/reports` | **照常可用**（純檔案系統，不依賴 engine） |
| `GET /api/dashboard` | **degraded 200**：水位/情緒退讀 `data/puhui_cache.json`（僅全域 `water_level`/`puhui_sentiment`，**無個股清單**）、`market_regime:null`、`watchlist:[]`、**`degraded:true`** + `notes`。連 cache 都沒 → 仍 200，欄位 `null` |
| `GET /api/stocks/:code`、`GET /api/stocks/:code/{ohlcv,book,intraday}`、`GET /api/watchlist`、`POST /api/backtest`、`POST /api/backtest/grid`、`POST /api/agents/decide` | **明確 503** `ENGINE_UNAVAILABLE`（不假裝成功、不吐殘缺數字） |

degraded dashboard 範例（engine down + 有 cache）：
```json
{ "date": "2026-06-12", "as_of_date": "2026-06-12",
  "water_level": 0.5, "water_level_text": "五成",
  "puhui_sentiment": { "label": "中性", "score": 50 },
  "market_regime": null, "watchlist": [], "degraded": true,
  "notes": ["engine 不可用 → 退讀 data/puhui_cache.json（僅全域 water_level/sentiment，無個股清單）", "..."] }
```

> `data/puhui_cache.json` 由 Node 內容線 `scripts/puhui_daily.cjs` 每日覆寫、**gitignored、可能不在**；
> schema＝`{date, water_level:"五成"(中文), stocks:[{name,emoji}](無代號/無買賣), market_sentiment:{label,score:1-10}, ...}`。
> **僅 engine 掛掉時的後援**，不可當主要老王資料（結構化老王觀點一律走 engine `/puhui/view`）。

---

## 既有端點（不破壞，`routes/finance.js`）

| 方法 | 端點 | 說明 |
|---|---|---|
| GET | `/api/finance/status` | 讀 `data/finance_progress.json` |
| POST | `/api/finance/update` | 更新單筆任務進度（body `{id,status,progress?,message?}`） |
| POST | `/api/run-script` | 白名單跑 `puhui_synthesize.js`/`sync_to_obsidian.js`（其餘 403） |

---

## 本機啟動 / 驗收

```powershell
# 1) 起 engine（另一個視窗）
cd "C:\CC AI Agent\engine"; .\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# 2) 起 gateway
cd "C:\CC AI Agent"; node server.cjs    # http://localhost:3000
# 3) 打端點
curl http://localhost:3000/api/health
curl http://localhost:3000/api/dashboard
curl http://localhost:3000/api/stocks/2330
curl "http://localhost:3000/api/stocks/2330/ohlcv?start=2026-06-06&end=2026-06-13"
curl http://localhost:3000/api/stocks/2330/book          # 即時五檔（TWSE MIS 預設）
curl "http://localhost:3000/api/stocks/2330/intraday?timeframe=5"  # 需 FUGLE_API_KEY
curl http://localhost:3000/api/reports/list
curl -X POST http://localhost:3000/api/backtest -H "Content-Type: application/json" -d '{"codes":["2330"],"start":"2026-03-01","end":"2026-06-12"}'
```
engine 關掉再打：`/api/reports*` 照常、`/api/dashboard` 回 `degraded:true`、其餘回 503。
