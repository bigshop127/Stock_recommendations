# 優化專案 6 — 熱力圖 2.0：週/月切換＋產業鑽取個股熱力圖（仿 aistockmap.com）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt6-stock-heatmap.md`，然後根據裡面的說明進行」。
> 前置：opt5（產業層級 treemap）已完工，本案在其之上升級。
> 參考範本：`C:\Users\bigsh\Downloads\概念圖\熱力圖模板.jpg`、`熱力圖的族群點進去後的樣式 1.jpg`、`樣式 2.jpg`（aistockmap.com 實際截圖，**2026-07-02 依此校準規格**）。

## 1. 本案目標（對齊範本的互動模式）

範本的核心流程是「**總覽 → 鑽取**」兩層頁面，不是單一畫面塞兩層：

1. **頂層 `/heatmap`（＝opt5 現狀升級）**：產業 treemap，區塊大小＝`|產業平均漲跌%|`、色階紅漲綠跌 ±5% 飽和（沿用）。本案新增：
   - **單日／單週／單月 全部啟用**（範本右上的時間切換）。
   - 說明文案比照範本：「依產業平均漲跌幅度(絕對值)顯示區塊大小，顏色深淺代表漲跌方向與強度。**點擊產業可直接進入該產業總覽**。」
2. **新頁「產業總覽」`/heatmap/sector/:name`（本案主體，仿 樣式1/樣式2）**，由頂層點產業區塊進入：
   - 麵包屑「← 返回熱力圖」。
   - 頁首：產業名稱＋基本說明（我們沒有範本的 CAGR/市場規模敘事資料，改放：**當日產業平均漲跌%、成交值合計、檔數、資料日期**四個關鍵指標卡）。
   - **產業漲跌熱力圖（個股層級 treemap）**：該產業所有個股，**區塊大小＝`|個股漲跌%|`**（範本原文「依個股漲跌幅度(絕對值)決定區塊大小」，注意**不是**成交值）、色階同全站、時間切換 單日/單週/單月。
   - **點個股方塊 → 跳 `/stock/:code`**（比範本強的地方：直通深度審視頁）。
   - （增強 A，可後續交）**籌碼訊號**：仿樣式2 — 外資／投信／自營 三條進度條，顯示「近 6 個交易日該產業合計淨買超為正的天數 X/6」＋紅綠趨勢小箭頭。
   - （backlog，本案不做）產業價值鏈結構圖：需要人工整理的上中下游資料，我們沒有。
3. 市場範圍：**MVP 只做上市（TWSE）**；「上櫃」tab disabled＋tooltip「即將推出」。範本的台股/美股/日股 tabs 不做。

## 2. 後端規格（engine + gateway 各一支）

### 2.1 engine `GET /market/stock-heatmap?period=day|week|month&date=YYYY-MM-DD`

放 `engine/app/api/market.py`（與 sectors/capital-tide 同檔同風格，走 `_guard` 包 502）。**一支端點同時餵頂層與產業頁**：回傳全市場個股列，前端自行聚合產業平均。

**資料源（單請求全市場，不吃 FinMind 額度）**：
- TWSE `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={YYYYMMDD}&type=ALLBUT0999`
  → 全部上市個股當日「收盤價、漲跌價差、成交金額」，**一個請求拿完 900+ 檔**。
- 實作放 `engine/app/data/twse_report_client.py` 新增 `fetch_mi_index_allbut0999_raw(date_str)`＋`get_mi_index_allbut0999(date_str)`，比照既有 `fetch_mi_index_ms_raw`／`get_mi_index_ms`（同 `_HEADERS`、`_clean_num`、`get_with_rollback` 非交易日回滾）。
- 🚨 MI_INDEX 回傳多個 tables，要挑「每日收盤行情（全部(不含權證、牛熊證)）」那張；漲跌方向在**獨立欄位且可能是 HTML**（`<p ...>+</p>`），strip 後配「漲跌價差」轉正負；`X`＝除權息等特殊情況。

**個股過濾**：只留「4 碼純數字、且不以 `00` 開頭」的代號（排除 ETF/受益證券），其餘丟棄。

**產業歸屬**：複用既有 `get_sector_by_code(code)`（`market.py`，FinMind TaiwanStockInfo `industry_category` 記憶體快取）；對不到的落 `"其他"`（照樣回傳，別 silent drop）。

**period 計算**：
- `day`：當日快照的 漲跌價差/(收盤−價差)。
- `week`／`month`：用既有 `get_recent_trading_days(date, n)` 取 **5／21 個交易日前**基準日，抓基準日快照，`change_pct = (close_now − close_base)/close_base × 100`。基準日缺該股（新上市）→ `change_pct: null`。
- ⚠️ **未還原價**：期間跨除權息會失真（全市場拿不到還原價，參考站亦然）。頁面小字註明，不假裝精確。

**快取（必做，否則打爆 TWSE）**：
- 每日期的解析後快照存 `settings.cache_path / "stock_heatmap" / "{YYYYMMDD}.json"`（比照 capital-tide 的日檔快取寫法）。先讀快取、缺才打 TWSE；週/月的基準日快照同樣進快取。冷載最多 2 請求（當日＋基準日）。

**回傳契約（snake_case）**：
```json
{
  "date": "2026-07-02",
  "period": "week",
  "base_date": "2026-06-25",        // day 時 = date
  "market": "twse",
  "stocks": [
    { "code": "2330", "name": "台積電", "sector": "半導體業",
      "close": 1080.0, "change_pct": 2.35, "turnover": 51234567890.0 }
  ],
  "source": "twse_mi_index"
}
```
- `turnover` 單位「元」（前端格式化億/兆）。個股缺值給 `null` 或略過，**不可整端點 500**（`_guard`＋NaN sanitizer 鐵律）。

### 2.2 gateway `GET /api/market/stock-heatmap`

薄轉發（比照 `/api/market/capital-tide`）：透傳 `period`/`date`、timeout 120s、engine down 走 `sendError` 降級。

### 2.3（增強 A 才做）engine `GET /market/sector-chips?sector=&date=`

- 資料源：TWSE `https://www.twse.com.tw/fund/T86?response=json&date={YYYYMMDD}&selectType=ALLBUT0999`（全市場三大法人買賣超，**一天一請求**），日檔快取 `cache_path/t86/{YYYYMMDD}.json`。
- 聚合：近 6 交易日，該產業成分股 外資／投信／自營 各自「合計淨買超>0 的天數」與逐日合計序列。
- 契約：`{ sector, days: [...], foreign: {positive_days, series}, trust: {...}, dealer: {...} }`。
- MVP 可先不做；先交 §2.1/2.2＋前端，這支列增強。

## 3. 架構鐵律（沿用全案）

- 前端只打 gateway `/api`；不動 `web/`、不改壞 `puhui_daily.cjs`；新聚合放 service/api 層，不塞進 `fetch_*`。
- 台股色慣例紅漲綠跌；API `snake_case`；`tsc -b && vite build` 乾淨；engine pytest 全綠。
- 不引第三方圖表庫；treemap 沿用自寫 `lib/treemap.ts`（單層 `squarify` 已夠用，兩頁各自squarify，**不需要**分組版面演算法）。

## 4. 前端規格

### 4.1 路由與導覽
- `App.tsx`：`/heatmap`（既有）＋新 lazy 路由 `/heatmap/sector/:name`（產業名 `encodeURIComponent`）。
- `Layout.tsx`：header 標題支援產業頁（如「產業熱力圖 · 半導體業」）；側欄 nav 不加新項（產業頁從熱力圖進入）。

### 4.2 頂層 `/heatmap`（`SectorHeatmap.tsx` 升級）
- 資料改打 `api.marketStockHeatmap({ period })`，前端聚合：`產業平均漲跌% = 該產業個股 change_pct 簡單平均（null 排除）`、`成交值合計 = Σ turnover`。
  - ⚠️ 既有 `/api/market/sectors`（TWSE 官方類股指數）**只有單日**且口徑不同（指數 vs 成分平均）；本案頂層一律改吃新端點，口徑統一、週月才有資料。`marketSectors()` 保留給 Dashboard，不動。
- 時間切換 單日/單週/單月 三顆啟用（active 樣式沿用）；週/月時顯示「基準日 base_date」。
- 點區塊 → `navigate('/heatmap/sector/' + encodeURIComponent(name))`。
- 其餘（色階、legend、tooltip、三態、RWD、viewBox 1000×600）沿用 opt5。

### 4.3 產業頁 `pages/SectorDetail.tsx`（新檔）
- 進頁打同一支 `api.marketStockHeatmap({ period })`，前端 filter `sector === :name`（**不加新請求**；資料已含全市場）。
- 麵包屑「← 返回熱力圖」（`navigate(-1)` 或固定回 `/heatmap`，注意 period 選擇要透過 URL query `?period=` 保留）。
- 關鍵指標卡 ×4：產業平均漲跌%（上色）、成交值合計（億/兆）、成分檔數、資料日期（週/月加 base_date）。
- 個股 treemap：`value = max(|change_pct|, 0.05)`、色階同全站、文字分級沿用 opt5（大塊＝名稱+漲跌%、中塊＝名稱、小塊無字）；hover tooltip：代號/名稱/收盤/漲跌%/成交值；click → `/stock/:code`。
- 時間切換同頂層（單日/單週/單月）。
- 三態＋查無產業（URL 亂打）→ 顯示「查無此產業」＋返回鈕，不白屏。
- （增強 A）籌碼訊號區：三條橫向進度條（外資/投信/自營），`positive_days/6` 填充比例、右側 `X/6`＋趨勢小圖示；紅=偏買、綠=偏賣（台股慣例）。資料打 `/api/market/sector-chips`。

### 4.4 `lib/api.ts`
```ts
export interface HeatmapStock { code: string; name: string; sector: string; close: number | null; change_pct: number | null; turnover: number | null; }
export interface StockHeatmap { date: string; period: 'day' | 'week' | 'month'; base_date: string; market: string; stocks: HeatmapStock[]; source: string; }
export function marketStockHeatmap(params?: { period?: string; date?: string }): Promise<StockHeatmap>;
```
- 數值欄**誠實標 `| null`**，前端過濾或灰塊（opt5 教訓）。
- 建議前端對 response 做 5–10 分鐘記憶體快取（module-level Map by `period`），頂層→產業頁往返不重打。

## 5. 工作清單

- engine：`twse_report_client.py` 新 fetch/get；`market.py` 新 `/market/stock-heatmap`＋日檔快取；pytest 新增（沿 live-integration 風格）。
- gateway：`routes/` 新 `/api/market/stock-heatmap` 轉發。
- 前端：`SectorHeatmap.tsx` 改資料源＋啟用週月＋點擊導頁；新 `pages/SectorDetail.tsx`；`App.tsx` 路由；`api.ts` client＋型別。
- 文件：`docs/api.md`＋`review-web/docs/contracts.md` 新增 §2.12；完工後 ROADMAP §8 補紀錄。
- 部署：**含 engine 端點變動 → VM 上 gateway＋engine 都要重啟**（deploy.md §4.2 🚨）。
- （增強 A 另計：`/market/sector-chips`＋T86 日檔快取＋前端籌碼訊號區＋契約 §2.13。）

## 6. 驗收標準（MVP＝不含增強 A）

- [ ] 頂層 `/heatmap`：單日/單週/單月三 period 可切，區塊大小＝|產業平均漲跌%|、週月顯示 base_date（週≈5、月≈21 交易日前）；非交易日自動回滾。
- [ ] 點產業 → `/heatmap/sector/:name`：關鍵指標卡數字與 treemap 一致；個股區塊大小＝|個股漲跌%|、點個股跳 `/stock/:code`；返回後 period 保留。
- [ ] 產業頁與頂層數字互相印證（抽 2 產業手算平均）；`change_pct: null` 個股不破版；未還原價小字存在。
- [ ] engine 快照日檔快取生效（同日第二次請求不打 TWSE）；`_guard` 降級不 500；URL 亂打產業名不白屏。
- [ ] engine pytest 全綠（含新測試）、`tsc -b && vite build` 乾淨。
- [ ] 契約文件同步；未動 `web/`／`puhui_daily.cjs`；Dashboard 既有 sectors 卡零回歸。

## 7. 坑（帶進 review）

- 🚨 MI_INDEX 漲跌方向欄是 HTML、`X`＝特殊情況；價差要配方向轉正負。
- 🚨 TWSE exchangeReport **限流**：日檔快取沒做好前別上線；冷載偶發拒絕屬上游限流，retry/rollback 即可。
- 週/月＝**未還原價**：除權息股顯示假下跌，小字註明、別修數字。
- `00` 開頭 ETF 要排除；上櫃 5 碼股不在 TWSE 檔內屬正常（上櫃 tab 本來就 disabled）。
- 產業名走 URL 要 `encodeURIComponent`／`decodeURIComponent` 成對，中文名別直接拼字串。
- 頂層口徑改變（官方類股指數 → 成分簡單平均）：兩者單日數字**會有差**，屬預期；Dashboard 熱力排行卡仍吃舊 `sectors` 端點，兩處數字不必一致，別硬對齊。
- 小方塊文字分級不做會整張糊掉；hover 用事件委派，別每個 rect 掛 listener。
- PWA SW 快取：上版後看不到新 UI 先強制重整（已知坑）。
