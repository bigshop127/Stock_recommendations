# Phase 4 — 個股基本面・財報

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋schema 規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase4.md`，然後根據裡面的說明進行」。

## 1. 本階段目標

把 `/stock/:code` 的「基本面」預留區做成完整模組，並**回填 Phase 2 報價頭部缺的「市值 / 本益比」**（ROADMAP 表頭已標 🟡 缺、註明「併入基本面新端點」）。

新增**一個**後端端點 `/api/stocks/:code/fundamentals`（engine 吐聚合、gateway 薄轉發），前端畫成 估值 / 月營收 / 獲利(EPS) / 股利 四塊。

範圍：
- 必做：① 估值（PER / PBR / 殖利率，日頻時序＋當前值）② 月營收（近 ~24 月，YoY / MoM）③ 獲利能力（近 ~8 季 EPS 趨勢）④ 股利政策（近數年現金／股票股利）⑤ **回填報價頭部市值 / 本益比**（取 `summary`）。
- 可選（行有餘力，否則 Phase 後期再補）：三率（毛利率／營益率／淨利率）、PER/PBR 歷史分位帶（河流圖）、財報摘要（營收/毛利/稅後淨利季表）。

## 2. 互動與架構鐵律（務必遵守）

- 前端**只打 gateway `/api`**，不直連 engine、不重算。
- gateway **只薄轉發**（新增 `/api/stocks/:code/fundamentals`，沿用 `routes/gateway.js` 既有 `engineGet` + `sendError` 寫法，**不改既有 handler**）。
- engine **新增** `/data/fundamentals` 與**新** `service.get_fundamentals`、**新** `fetch_*` client 函式；**不改既有端點 / 不重算既有因子分 / 不就地改既有共用函式**。
- 🚨 **帶進 Phase 3 的血淚教訓**：上一階段第一版把共用的 `service.get_chips` 就地改名/換單位，靜默打壞了 `factors/swing.py`＋`backtest` 經 `compute_chips` 的籌碼分（測試剛好 mock 掉那條邊界沒抓到）。本階段一律**新增函式**，不動任何被因子/回測消費的既有函式。
- 欄位一律 `snake_case`。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源。

## 3. 希望看到的內容（前端 基本面區塊）

在 `StockDetail.tsx` 既有「基本面預留區」中，做成（逐區塊 loading/error 降級，沿用 Phase 2/3 模式；mock 僅 DEV `?mock=1`），可用 Tab 或分段卡片：

1. **估值（Valuation）**
   - 當前卡：本益比 PER、股價淨值比 PBR、殖利率（%）、市值。
   - 近一年 **PER 日頻折線**（可選：疊 PBR 雙軸，或 PER 歷史分位帶河流圖）。
   - 數字色：估值「便宜/貴」非漲跌，**不要硬套紅綠**；用中性色＋分位標籤（如「近一年偏低」）較不誤導。
2. **月營收（Monthly Revenue）**
   - 近 ~24 月**營收柱狀圖**＋ **YoY 折線**；當月 YoY / MoM 以紅綠標（**YoY 正＝紅、負＝綠**，台股慣例同籌碼）。
3. **獲利能力（EPS）**
   - 近 ~8 季 **EPS 柱狀**（可選：累計 4 季 EPS / 近四季本益比）。
   - 可選：三率折線（毛利率／營益率／淨利率）。
4. **股利政策（Dividend）**
   - 近數年**現金股利 / 股票股利堆疊柱**＋（可選）當年殖利率。
5. **回填報價頭部**：Phase 2 的報價頭部把「市值 / 本益比」補上，值取自本端點 `summary`（前端組裝，不重算）。
6. 任一塊資料源缺 → 該塊降級為「尚未提供」，不破版（**不要用假 0 充數**）。

> 著色慣例：**營收/EPS YoY 正＝紅、負＝綠**（與籌碼一致）；估值高低用中性色＋分位標籤，避免「PER 高就標紅」誤導成利多。

## 4. API 契約 `/api/stocks/:code/fundamentals`

`GET /api/stocks/:code/fundamentals`

* **Method**: `GET`
* **Description**: 取得個股估值（日頻）、月營收（月頻）、獲利 EPS（季頻）、股利（年頻）與一個 `summary` 快照。各區不同時間粒度 → **分開成各自的子陣列**，不要硬塞同一個 `metrics[]` 同一個 `date`。
* **Response Schema (200 OK)**：

```json
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-19",
  "summary": {
    "pe_ratio": 24.5,
    "pb_ratio": 6.8,
    "dividend_yield": 2.45,
    "market_cap": 18250000000000,
    "eps_ttm": 42.1
  },
  "valuation": [
    { "date": "2026-06-19", "pe_ratio": 24.5, "pb_ratio": 6.8, "dividend_yield": 2.45 }
  ],
  "revenue": [
    { "month": "2026-05", "revenue": 250000000000, "yoy": 15.4, "mom": -2.1 }
  ],
  "financials": [
    { "quarter": "2026-Q1", "eps": 8.7, "gross_margin": 56.2, "operating_margin": 42.1, "net_margin": 38.5 }
  ],
  "dividend": [
    { "year": "2025", "cash_dividend": 13.5, "stock_dividend": 0.0 }
  ],
  "unit": { "revenue": "元", "market_cap": "元", "dividend": "元/股", "ratio": "%" },
  "source": "FinMind"
}
```

欄位說明：
- `summary`：最新快照。`pe_ratio`/`pb_ratio`/`dividend_yield` 取 `valuation` 最後一列；`eps_ttm` = 近四季 EPS 合計；`market_cap` 見 §5（接不上先 `null`）。
- `valuation[]`：日頻，近一年。FinMind `TaiwanStockPER` 的 `dividend_yield` 已是 %。
- `revenue[]`：月頻。`yoy` =（本月 ÷ 去年同月 − 1）×100；`mom` =（本月 ÷ 上月 − 1）×100；缺前期資料該欄 `null`（不要填 0）。
- `financials[]`：季頻，`eps` 必，三率可選（接不上先省略或 `null`）。
- `dividend[]`：年頻，現金 / 股票股利（元/股）。
- 任一區塊資料源缺 → 回**空陣列** `[]`（前端據此降級），個別欄位缺 → `null`（**誠實，不填 0 假裝**）。
- `as_of`：最新有資料日（取 `valuation` 末列日期或當日回溯）。`name`：沿用 `finmind_client.get_stock_name`。

> ⚠️ 現有 `contracts.md §2.6` 與 `api.ts FundamentalMetric` 是**舊 placeholder**（把日/月/季頻硬塞同一列、`source:"TWSE"`），**目前僅 mock、無真實消費者** → 不算二次遷移，本階段**直接改寫成上面的分頻 schema**，同步更新 `contracts.md §2.6` 與 `api.ts`。

## 5. 後端資料源建議（已對 engine 現況盤點）

**engine 目前零基本面資料層**（不像 Phase 3 籌碼能複用既有 `fetch_institutional/fetch_margin`）。本階段都是**新接 FinMind dataset**，呼叫數會變多 → **aggressive cache + 注意額度**（[[finmind-token-location]]，撞牆多 token 輪替）。全部走既有 `_finmind_get(dataset, code, start, end)` ＋ `cache.get_timeseries`（parquet）。

engine **需新增**（`engine/app/data/finmind_client.py`）：
- `fetch_valuation(code, start, end)` → FinMind **`TaiwanStockPER`**，回 `date, pe_ratio, pb_ratio, dividend_yield`。**🔎 pre-flight 先確認欄名**（常見 `PER` / `PBR` / `dividend_yield`，大小寫以實打為準）。日頻、走 parquet 快取（同 ohlcv 模式）。
- `fetch_month_revenue(code, start, end)` → **`TaiwanStockMonthRevenue`**，回 `month(YYYY-MM), revenue`。YoY/MoM 由 service 端用整段資料算（要對齊去年同月／上月，缺則 `null`）。
- `fetch_financials(code, start, end)` → **`TaiwanStockFinancialStatements`**，**長格式（`type`/`value`、季度）**→ 需 **pivot** 取 EPS（與可選三率）。**🚨 pre-flight 必做**：先打一檔（如 2330）確認 `type` 值的中英文鍵（EPS、營業毛利、營業利益、稅後淨利…）與季度欄格式，再決定 pivot 與三率算法；一時接不上**先只回 `eps`**，三率留 `null`/省略，不擋其他塊。
- `fetch_dividend(code, start, end)` → **`TaiwanStockDividend`**（或 `TaiwanStockDividendResult`，pre-flight 擇一），回 `year, cash_dividend, stock_dividend`。年頻。
- **市值 `market_cap`**：FinMind 免費級無乾淨單一來源（需在外流通股數 × 收盤價）。**best-effort**：若能從既有 `TaiwanStockInfo` 或其他免費欄位湊出股本/股數就算，**接不上先回 `null`**，不擋整端點；報價頭部市值欄位同步顯示「—」。

聚合層 `service.get_fundamentals(code)`（**新函式，勿碰既有**）：各 dataset 各自抓（estimation 視窗：valuation 近一年、revenue 近 ~25 月、financials 近 ~10 季、dividend 近 ~6 年），組成上面四個子陣列 ＋ `summary`；缺值補 `null`（**該補 0 還是 null？營收 YoY 缺前期＝null；股利該年無＝0；估值缺＝null**），別把 NaN 丟給序列化層。

**備援 / 不建議當主源**：TWSE `BWIBBU`(本益比/殖利率/股價淨值比 全市場單日)、公開資訊觀測站月營收 → 全市場單日報表，建單檔時序得抓 N 份（同 Phase 1/3 連發坑）。僅 FinMind 撞牆時當「補當日最新一筆」fallback。

## 6. 後端工清單

- engine：`finmind_client.py` 新增上述 4 個 `fetch_*`；`service.py` 新增 `get_fundamentals`（**新函式**，各 dataset 走 `cache.get_timeseries`）；`app/api/data.py` 新增 `GET /data/fundamentals?code=`，`_guard` 包 `DataSourceError→502`。
- gateway：`routes/gateway.js` 新增 `GET /api/stocks/:code/fundamentals` → `engineGet('/data/fundamentals', {code}, T.fundamentals)`（新增 `T.fundamentals`，給長一點 timeout，多 dataset 首抓慢）。**只加 handler，不動既有**。
- 前端：`api.ts` 改寫 `StockFundamentals`/新增子型別（`valuation/revenue/financials/dividend/summary`，欄位可 `null`）；`StockDetail.tsx` 基本面區接真資料 + 圖表 + 降級；**報價頭部市值/PE 從 `summary` 回填**。
- 測試：engine 加 `test_fundamentals`（PER 解析、月營收 YoY/MoM 計算、財報 long→pivot 取 EPS、缺值 `null`、空陣列降級），維持既有測試綠燈。

## 7. 驗收標準

- [ ] `GET /api/stocks/:code/fundamentals` 回 snake_case，四個子陣列各自正確時間粒度（valuation 日 / revenue 月 / financials 季 / dividend 年）＋ `summary` 快照。
- [ ] 月營收 YoY/MoM 計算正確（對齊去年同月／上月，缺前期＝`null`）；財報 long-format 正確 pivot 出 EPS。
- [ ] 估值用中性色＋分位標籤（不誤導成紅綠利多利空）；營收/EPS YoY 正紅負綠。
- [ ] **報價頭部市值/本益比回填成功**（值來自 `summary`，前端組裝不重算）；市值接不上時誠實顯示「—」。
- [ ] 任一資料源缺 → 該區塊降級「尚未提供」不破版；個別欄位 `null` 不填 0 假裝。
- [ ] `contracts.md §2.6`／`api.ts` 同步成新分頻 schema（舊 placeholder 改寫，無殘留）。
- [ ] FinMind 走快取、單檔呼叫；engine 既有端點與因子分未改、既有測試仍綠、`web/` 未動。
- [ ] `tsc -b && vite build` 乾淨；engine `pytest` 全綠。

## 8. 沿用既有坑（帶進 review）

- 🚨 **Phase 3 教訓**：不就地改任何被因子/回測消費的既有共用函式，一律新增；測試別只 mock 邊界（要有真走 `service`→序列化的整合測試）。
- FinMind 額度緊 + 本階段 dataset 變多 → 快取優先、單檔少呼叫、撞牆多 token 輪替（[[finmind-token-location]]）。
- 全域 `NaNResponse` 已護 response 邊界（Phase 1）；但 pandas 聚合（pivot/YoY/對齊）易生 NaN，組裝時該補 0/null 的別丟給序列化層硬吞（[[engine-nan-json-500]]）。
- 財報 / 月營收為**長格式 / 跨期對齊**，pre-flight 先實打一檔確認欄位與鍵值再寫解析，別憑記憶。
- engine 掛掉 / 無資料要 graceful degradation，不假裝成功。
- 單位一律標清楚（元 vs 億、%、元/股），UI 顯示對應單位；估值高低不套漲跌紅綠。
- 老王 emoji 與股市相反（本模組不碰報告 md）。
