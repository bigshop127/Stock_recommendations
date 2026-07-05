# 優化專案 14 — 個股「籌碼分析」分頁強化：股權分散（大戶/散戶）＋三大法人/融資融券子頁

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt14-stock-chips-plus.md`，然後根據裡面的說明進行」。
> 參考範本：aistockmap `籌碼分析` 分頁（子頁：大戶資訊／三大法人／融資融券；「持股人數趨勢」折線＝大戶/中實戶/散戶人數；「大戶資訊」表＝每週各級距人數/增減、可切人數/佔比）。**資料走自家 engine（FinMind 集保股權分散表）。**
> **相依：opt12（tab 骨架）須先完成。** 本案強化 `籌碼分析` tab。

---

## 1. 本案目標

現在 `籌碼分析` tab 內是 opt12 搬進來的 `<ChipsCharts>`（多天期三大法人/融資券/外資持股比率）。本案在其上加**子頁切換**，補上 aistockmap 最招牌的**股權分散（大戶 vs 散戶）趨勢**：

```
籌碼分析 tab
 ├─ 子頁「大戶／散戶結構」← 新增（本案主工）
 │    ├─ 持股人數趨勢折線（大戶 / 中實戶 / 散戶，近 ~15 週）
 │    └─ 股權分散明細表（每週各級距人數/增減，可切 人數↔佔比）
 ├─ 子頁「三大法人」← 現有 ChipsCharts 的法人部分
 └─ 子頁「融資融券」← 現有 ChipsCharts 的融資券部分
```

---

## 2. 資料源（FinMind，已在專案內，覆蓋度佳）

- **股權分散＝FinMind `TaiwanStockHoldingSharesPer`（集保戶股權分散表，週頻）**：每週各「持股張數級距」的人數與股數佔比。這正是 aistockmap「持股人數趨勢／大戶資訊」的底層資料。engine 已用 FinMind，加一個 fetch 即可。
- 大戶/中實戶/散戶的**級距定義沿用範本**（可調的一組門檻，寫死一處）：
  - 散戶 ≤ 50 張；中實戶 50–400 張；大戶 > 400 張。
  - 對應 FinMind 的級距欄位聚合（`TaiwanStockHoldingSharesPer` 的級距是「1-999股、1,000-5,000股…」以**股**計；1 張=1000 股 → 50 張=50,000 股、400 張=400,000 股，做級距歸併時以此換算）。**歸併邏輯是本案重點，要寫純函式＋測試。**
- 三大法人與融資融券**已有**：`/api/stocks/:code/chips`（engine `get_chips`／`get_chips_series`，契約 §2.5）已含三大法人買賣超＋融資券＋外資持股比率。本案子頁 2、3 直接復用現有 `<ChipsCharts>` 拆分呈現，**不重抓**。

---

## 3. 後端規格（engine + gateway）

- engine `service.get_shareholding_dispersion(code, weeks=16)`：
  - 讀 FinMind `TaiwanStockHoldingSharesPer` 近 ~16 週。
  - 依 §2 門檻把級距歸併成 `retail / mid / large` 三組，各週算：`people`（人數）、`shares_pct`（股數佔比）。
  - 回傳：
    ```json
    {
      "code": "3450", "name": "聯鈞",
      "levels": { "retail": "≤50 張", "mid": "50–400 張", "large": ">400 張" },
      "weekly": [
        { "date": "2026-07-03",
          "retail": { "people": 71047, "people_delta": 1119, "shares_pct": 42.1 },
          "mid":    { "people": 145,  "people_delta": 1,    "shares_pct": 18.3 },
          "large":  { "people": 49,   "people_delta": -3,   "shares_pct": 39.6 } },
        ...
      ],
      "source": "FinMind TaiwanStockHoldingSharesPer", "as_of": "2026-07-03"
    }
    ```
  - `people_delta` = 相對前一週；首週為 null。
  - **歸併與 delta 計算抽純函式** `aggregate_dispersion(rows, thresholds)` 並加 pytest（給一組假 FinMind rows → 驗三組人數/佔比/delta）。
- gateway `GET /api/stocks/:code/shareholding` 薄轉發＋TTL 快取（週頻資料，TTL 可 6–12h）。
- 契約 `docs/contracts.md` 新增 §2.15。

---

## 4. 前端規格

- `籌碼分析` tab 內加子頁切換 pill：`大戶／散戶結構 | 三大法人 | 融資融券`（沿用站上子 tab 樣式，如 `renderFundamentals` 子 tab）。預設落在「大戶／散戶結構」。
- **持股人數趨勢折線**（手刻 SVG，沿用站上折線手法）：三線＝大戶/中實戶/散戶人數，近 16 週；hover 顯示該週三組人數。可仿範本用左右雙 Y 軸（散戶人數級距大、大戶小）——或各自正規化。你決定，讀得清楚為準。
- **股權分散明細表**：每列一週，欄＝日期｜大戶 人數/增減｜中實戶 人數/增減｜散戶 人數/增減｜總計；右上角 `人數 ↔ 佔比` 切換（佔比模式顯示 `shares_pct`）。增減著色沿台股慣例（增紅減綠）或中性箭頭，做清楚即可。
- 新增 `dispersionState`（data/loading/error），切到本子頁時抓一次（或 tab 首見即抓）。三態齊全。
- 「三大法人」「融資融券」子頁：把現有 `<ChipsCharts>` 依面向拆兩塊呈現（若 ChipsCharts 難拆，最省作法＝該元件加一個 `only?: 'inst' | 'margin' | 'all'` prop，各子頁傳不同值只顯示對應圖；**不改它的資料契約**）。

---

## 5. 驗收標準

1. `tsc -b && vite build` 乾淨；engine `pytest` 綠（`aggregate_dispersion` 測試涵蓋級距歸併＋delta＋首週 null）。
2. 3450 進「大戶／散戶結構」：折線三條、表格近 16 週，大戶人數與範本量級同數量級（個位到數十）、散戶數萬級，數字方向合理。
3. 級距門檻集中一處、換門檻只改一個常數物件。
4. `/api/stocks/:code/shareholding` 有快取、契約 §2.15 同步。
5. 三大法人/融資融券子頁與改版前 `<ChipsCharts>` 內容一致（沒因拆分掉資料）。
6. 查無股權分散資料（新股/ETF）→ 該子頁顯示空態，不影響另兩子頁。

---

## 6. 不做 / backlog

- 主力分點進出（券商分點）：FinMind 免費層無逐分點，**不做**。
- 融券回補天數、當沖比等衍生指標：backlog。
- aistockmap 的「老王／主力吃貨」等策展判讀＝它的 IP，**不做**（我們的老王子訊號已在 F_sentiment，別重造）。
