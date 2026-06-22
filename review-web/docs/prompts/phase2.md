# Phase 2 — 個股殼＋報價頭部＋K線

## 1. 本階段目標

在 `/stock/:code` 個股詳情頁面建立多欄位 Dashboard 結構，並實作即時報價頭部、最佳五檔、與串接真實 API 的互動式 K 線圖表（Lightweight Charts）。

## 2. 希望看到的內容

### 前端個股頁面 `/stock/:code`
1. **個股報價頭部 (Stock Header)**：
   * 顯示個股名稱、代號、最新成交價、漲跌金額、漲跌幅（依台股慣例：漲紅跌綠）。
   * 顯示當日開盤、最高、最低、昨收、以及成交量（股/張數）。
   * 資料來源優先使用既有五檔與即時端點。

2. **互動式 K 線圖表 (K-Line Chart)**：
   * 正式掛載 `lightweight-charts` 元件。
   * 支持切換：**還原日 K 線**（`GET /api/stocks/:code/ohlcv?adjust=true`）與 **盤中分 K 線**（`GET /api/stocks/:code/intraday`）。
   * 包含價格主圖（K 線及移動平均線 MA20/MA50）與下方成交量副圖（Volume Bar）。
   * 滑鼠游標十字線 (Crosshair) 聯動，顯示對應點的數值。

3. **最佳五檔委買委賣 (Order Book)**：
   * 顯示即時最佳五檔買賣價與量（`GET /api/stocks/:code/book`）。
   * 支持秒級定時輪詢（Poll）以模擬即時更新。
   * 著色顯示買賣氣勢（外盤偏紅，內盤偏綠）。

4. **多欄 Dashboard 骨架與降級處理**：
   * 頁面劃分為：報價/K線區、AI 訊號/五檔區、籌碼基本面預留區。
   * 逐區塊處理 loading 與 error，任一 API 失敗僅該區塊降級顯示，不破壞全頁。

## 3. API 契約與欄位
本階段全數沿用既有端點，資料格式與參數定義如下：
* `GET /api/stocks/:code` (基本訊號)
* `GET /api/stocks/:code/ohlcv?adjust=true` (還原日K)
* `GET /api/stocks/:code/book` (即時五檔)
* `GET /api/stocks/:code/intraday?timeframe=1` (盤中分K)

## 4. 驗收標準
- [ ] 點擊首頁 watchlist 或指數卡個股能正確載入 `/stock/:code` 頁面。
- [ ] 報價頭部資訊完整，漲跌幅著色正確（漲紅跌綠）。
- [ ] Lightweight Charts 成功載入日K與分K資料，成交量柱狀圖顏色與當日收盤紅綠一致。
- [ ] 最佳五檔顯示正常，並能自動/手動重新整理。
- [ ] 降級測試：若五檔 API 失敗，僅五檔區塊顯示錯誤，K線與頭部正常呈現。
