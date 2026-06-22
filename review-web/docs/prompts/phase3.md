# Phase 3 — 個股籌碼面（重點模組）

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋schema 規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase3.md`，然後根據裡面的說明進行」。

## 1. 本階段目標

把 `/stock/:code` 的「籌碼面」預留區做成完整模組（**本專案招牌之一，三大法人為重點**）。新增**一個**後端端點 `/api/stocks/:code/chips`（engine 吐聚合時序、gateway 薄轉發），前端畫成法人買賣超 / 信用交易 / 外資持股 的時序圖表。

範圍：
- 必做：① 三大法人買賣超（外資 / 投信 / 自營 / 合計，當日 + 近 N 日 + 累計）② 融資 / 融券餘額與增減 ③ 外資持股比率。
- 可選（行有餘力，否則 Phase 後期再補）：借券餘額、集保大戶持股分散。

## 2. 互動與架構鐵律（務必遵守）

- 前端**只打 gateway `/api`**，不直連 engine、不重算。
- gateway **只薄轉發**（新增 `/api/stocks/:code/chips`，沿用 `routes/gateway.js` 既有 `engineGet` + `sendError` 寫法，**不改既有 handler**）。
- engine **新增** `/data/chips`，**不改既有端點 / 不重算既有因子分**。
- 欄位一律 `snake_case`。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源。

## 3. 希望看到的內容（前端 籌碼面區塊）

在 `StockDetail.tsx` 既有「籌碼/基本面/新聞預留區」中，把籌碼子區塊做成（逐區塊 loading/error 降級，沿用 Phase 2 模式；mock 僅 DEV `?mock=1`）：

1. **三大法人買賣超**
   - 當日卡：外資 / 投信 / 自營 / **合計** 四個數字，**買超紅、賣超綠**（台股慣例），單位「張」。
   - 近 N 日（預設 20）**每日柱狀圖**（外資/投信/自營堆疊或分組）＋**累計淨買超折線**（frontend 自行累加，沿用 Phase 1 institutional 趨勢圖做法）。
2. **信用交易（融資 / 融券）**
   - 融資餘額、融券餘額（張）時序折線；當日增減（`margin_change`/`short_change`）以紅綠標示。
   - 衍生指標：券資比（= 融券餘額 / 融資餘額）可前端算後顯示。
3. **外資持股比率**
   - `foreign_holding_ratio`（%）時序折線；當日值 + 區間變化。
4. **（可選）借券 / 大戶持股** — 有資料才畫，無則整塊降級為「尚未提供」，不破版。

> 著色慣例提醒：**買超/買盤＝紅，賣超/賣盤＝綠**（與 Phase 2 五檔一致）；漲跌數字依正負紅綠。

## 4. API 契約 `/api/stocks/:code/chips`

`GET /api/stocks/:code/chips?days=20`（或 `?start=&end=`）

* **Method**: `GET`
* **Description**: 取得個股近 N 日（預設 20 交易日）籌碼時序：三大法人買賣超、融資券餘額/增減、外資持股比率。盤後資料，最後一列即最近有資料交易日（**不需 rollback 探測**——FinMind 回整段、最後一筆就是最新）。
* **Response Schema (200 OK)**：

```json
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-19",
  "unit": { "net_buy_qty": "張", "balance": "張", "holding_ratio": "%" },
  "data": [
    {
      "date": "2026-06-19",
      "foreign_net_buy_qty": 3500,
      "investment_trust_net_buy_qty": 1200,
      "dealer_net_buy_qty": -450,
      "total_net_buy_qty": 4250,
      "margin_balance": 12500,
      "margin_change": 320,
      "short_balance": 820,
      "short_change": -45,
      "foreign_holding_ratio": 74.2
    }
  ],
  "source": "FinMind"
}
```

欄位說明：
- `*_net_buy_qty`：當日淨買超（**張**，正=買超、負=賣超）。`total_net_buy_qty` = 外資+投信+自營。
- `margin_balance`/`short_balance`：融資/融券餘額（張）；`margin_change`/`short_change` = 今日餘額 − 昨日餘額。
- `foreign_holding_ratio`：全體外資及陸資持股比率（%，0~100）；若資料源缺則該欄 `null`（不要填 0）。
- `as_of`：`data` 最後一列日期。`name`：個股名稱（沿用 `finmind_client.get_stock_name`）。
- 欄名**沿用既有 `contracts.md §2.5` / `api.ts ChipRow` 的 `*_net_buy_qty`**（StockDetail 籌碼預留區已引用，別再改名造成第二次遷移）。`api.ts` 需補上 `total_net_buy_qty`/`margin_change`/`short_change`/`name`/`as_of`/`unit`。

## 5. 後端資料源建議（已對 engine 現況盤點）

**主來源＝FinMind（個股單檔 = 每資料集 1 次呼叫、走 parquet 快取）。** 個股時序用 FinMind 最划算——一次拿整段日期；這與 Phase 1「市場層級避開 FinMind」相反，因為那是全市場單日、這是單檔多日。仍要**aggressive cache + 注意額度**（見 [[finmind-token-location]]，撞牆可多 token 輪替）。

engine **已有可直接複用**（`engine/app/data/finmind_client.py`）：
- `fetch_institutional(code, start, end)` → `date, foreign_net, trust_net, dealer_net`，**單位：股**。
  🚨 **單位坑**：此函式回「股」，但 schema 的 `*_net_buy_qty` 要「張」→ 端點組裝時 **÷1000**（且 `dealer_net` 已是自營合計）。
- `fetch_margin(code, start, end)` → `date, margin_balance, margin_change, short_balance, short_change`，**單位：張**（直接對上 schema，免換算）。
- `get_stock_name(code)` → `name`。

engine **需新增**：
- `fetch_shareholding(code, start, end)`（新函式）取外資持股比率 → FinMind dataset `TaiwanStockShareholding`（欄位 `ForeignInvestmentSharesRatio` 或同義），回 `date, foreign_holding_ratio`。**若一時接不上可先回 `null`**，不擋其他兩塊上線。
- 聚合層：以 `date` 為鍵 **outer-join** 三組（institutional 換張、margin、shareholding），組成 `data[]`；缺值補 `null`（法人那天無資料就 0 還是 null？→ 法人無買賣＝0；持股率無資料＝null）。

**備援 / 不建議當主源**（免金鑰但對「個股時序」很差）：TWSE `T86`(法人買賣超)、`MI_MARGN`(融資券)、`MI_QFIIS`(外資持股) 都是**全市場單日**報表 → 要建單檔 N 日趨勢得抓 N 份日報再濾代號（同 Phase 1 institutional 連發坑）。僅在 FinMind 額度撞牆時，當「補當日最新一筆」的 fallback。OTC（櫃買）個股 FinMind 同樣覆蓋，不必切 TPEx 端點。

## 6. 後端工清單

- engine：新增 `app/api/data.py`（或新檔）端點 `GET /data/chips?code=&days=&start=&end=`，內部複用 `fetch_institutional`(÷1000)＋`fetch_margin`＋新 `fetch_shareholding`，`_guard` 包 `DataSourceError→502`；走既有 parquet 快取機制。
- gateway：`routes/gateway.js` 新增 `GET /api/stocks/:code/chips` → `engineGet('/data/chips', {code, days, start, end}, T.ohlcv)`（或新增 `T.chips`）。**只加 handler，不動既有**。
- 前端：`api.ts` 補 `chips` client 與 `ChipRow` 欄位；`StockDetail.tsx` 籌碼區接真資料 + 圖表 + 降級。
- 測試：engine 加 `test_chips`（解析/單位換算/缺欄 null），維持既有測試綠燈。

## 7. 驗收標準

- [ ] `GET /api/stocks/:code/chips?days=20` 回 snake_case，`data[]` 為近 N 交易日時序，最後一列 = `as_of`。
- [ ] 法人買賣超單位為**張**（已 ÷1000），`total_net_buy_qty` = 三者和；買超紅/賣超綠正確。
- [ ] 融資/融券餘額與 `*_change` 正確；外資持股比率有值或誠實 `null`（不填 0 假裝）。
- [ ] 前端籌碼區：法人 daily + 累計圖、融資券趨勢、外資持股趨勢；逐區塊降級，FinMind 無資料/掛掉不破版。
- [ ] 欄名與既有 `ChipRow` 一致（無第二次 camelCase/命名遷移）。
- [ ] FinMind 走快取、單檔呼叫；engine 既有端點與因子分未改、既有測試仍綠、`web/` 未動。
- [ ] `tsc -b && vite build` 乾淨；engine `pytest` 全綠。

## 8. 沿用既有坑（帶進 review）

- FinMind 額度緊 → 快取優先、單檔少呼叫、撞牆多 token 輪替（[[finmind-token-location]]）。
- 老王 emoji 與股市相反（本模組不碰報告 md）。
- 全域 `NaNResponse` 已護 response 邊界（Phase 1）；但 pandas 聚合易生 NaN，組裝時該補 0/null 的別丟給序列化層硬吞。
- engine 掛掉 / 無資料要 graceful degradation，不假裝成功。
- 單位一律標清楚（股 vs 張），UI 顯示「張」。
