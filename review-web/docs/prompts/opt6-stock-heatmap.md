# 優化專案 6 — 個股層級熱力圖（heatmap 2.0，仿 aistockmap.com）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt6-stock-heatmap.md`，然後根據裡面的說明進行」。
> 前置：opt5（產業層級 treemap）已完工，本案在其之上升級。參考：`https://aistockmap.com/?activeTab=heatmap`。

## 1. 本案目標

把 `/heatmap` 從「產業層級」升級成 aistockmap 風格的**個股層級**熱力圖：

1. **兩層 treemap**：外層＝產業群組（TWSE 官方類股分類），內層＝該產業的**個股方塊**。
   - **方塊大小 ＝ 當日成交金額**（不是 |漲跌%|；這點與 opt5 不同，個股層級用成交值才有「熱度」語意）。
   - **方塊顏色 ＝ 漲跌% 方向×強度**：沿用 opt5 的 ±5% 飽和紅漲綠跌色階（`SectorHeatmap.tsx` 既有映射函式直接複用）。
   - 產業群組有小標題列（產業名＋整體漲跌%），群組間留 2–4px 間隙。
2. **時間切換 單日／單週／單月 全部啟用**（opt5 的 disabled 佔位在本案兌現）。
3. **點個股方塊 → 跳轉 `/stock/:code`**（既有路由，這是我們比 aistockmap 強的地方：熱力圖直通深度審視頁）。
4. 保留**視圖切換**：「產業視圖」（＝opt5 現狀，零改動）／「個股視圖」（本案新做），頂部 chip 切換。
5. 市場範圍：**MVP 只做上市（TWSE）**；「上櫃」tab 先 disabled＋tooltip「即將推出」（TPEx 是另一套 API，後續案）。

## 2. 後端規格（本案有後端：engine + gateway 各一支）

### 2.1 engine `GET /market/stock-heatmap?period=day|week|month&date=YYYY-MM-DD`

放 `engine/app/api/market.py`（與 sectors/capital-tide 同檔同風格，走 `_guard` 包 502）。

**資料源（單請求全市場，不吃 FinMind 額度）**：
- TWSE `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={YYYYMMDD}&type=ALLBUT0999`
  → 全部上市個股當日「收盤價、漲跌價差、成交金額」，**一個請求拿完 900+ 檔**。
- 實作放 `engine/app/data/twse_report_client.py` 新增 `fetch_mi_index_allbut0999_raw(date_str)`＋`get_mi_index_allbut0999(date_str)`，比照既有 `fetch_mi_index_ms_raw`／`get_mi_index_ms`（同 `_HEADERS`、同 `_clean_num`、同 `get_with_rollback` 非交易日回滾）。
- 🚨 MI_INDEX 回傳多個 tables，要挑「每日收盤行情（全部(不含權證、牛熊證)）」那張；欄位含 `證券代號/證券名稱/成交金額/收盤價/漲跌(+/-)/漲跌價差`。漲跌方向在**獨立欄位**（`+`/`-`/`X` HTML），價差要配方向轉正負。

**個股過濾**：只留「4 碼純數字、且不以 `00` 開頭」的代號（排除 ETF/受益證券/特別股後綴），其餘丟棄。

**產業歸屬**：複用既有 `get_sector_by_code(code)`（`market.py`，FinMind TaiwanStockInfo `industry_category` 記憶體快取）；對不到的落 `"其他"`。

**period 計算**：
- `day`：直接用當日快照的 漲跌價差/(收盤−價差) 算 `change_pct`。
- `week`／`month`：用 `get_recent_trading_days(date, n)`（既有 helper）取 **5／21 個交易日前**的基準日，再抓該基準日的 ALLBUT0999 快照，`change_pct = (close_now − close_base) / close_base × 100`。基準日缺該股（新上市）→ `change_pct: null`。
- ⚠️ **未還原價**：期間跨除權息會失真（全市場拿不到還原價，aistockmap 同樣如此）。頁面加一行小字註明即可，不要假裝精確。

**快取（必做，否則打爆 TWSE）**：
- 每個日期的解析後快照存 `settings.cache_path / "stock_heatmap" / "{YYYYMMDD}.json"`（比照 capital-tide 的每日檔快取 `get_capital_tide_cache`／`write_capital_tide_cache` 寫法）。
- endpoint 先讀快照快取，缺才打 TWSE；`week`/`month` 需要的基準日快照同樣進快取。TWSE exchangeReport 有限流（約 5 req/min），首次冷載最多 2 個請求（當日＋基準日），可接受。

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
- `turnover` 單位「元」（前端格式化億/兆，同 opt5）。
- 個股缺值略過或欄位給 `null`，**不可整端點 500**（沿用 `_guard`＋NaN sanitizer 鐵律）。

### 2.2 gateway `GET /api/market/stock-heatmap`

薄轉發（比照 `/api/market/capital-tide`）：透傳 `period`/`date`、timeout 120s、engine down 走 `sendError` 降級。可加 10 分鐘記憶體 TTL 快取（非必須，engine 已有日檔快取）。

## 3. 架構鐵律（沿用全案）

- 前端只打 gateway `/api`，不直連 engine、不重算數字。
- 不動 `web/`、不改壞 `puhui_daily.cjs`、不碰既有因子計算；新聚合放 service/api 層，**不塞進 `fetch_*`**。
- 台股色慣例紅漲綠跌；API `snake_case`；`tsc -b && vite build` 乾淨；engine pytest 全綠。
- 不引第三方圖表庫，treemap 沿用自寫 `lib/treemap.ts` 擴充。

## 4. 前端規格

### 4.1 `lib/treemap.ts` 擴充：兩層版面
新增純函式（保持不碰 DOM、可測）：
```ts
export interface TreemapGroup { key: string; label: string; items: TreemapInput[]; }
export interface GroupedTile extends TreemapTile { groupKey: string; }
export interface GroupLayout { key: string; label: string; x: number; y: number; w: number; h: number; headerH: number; tiles: GroupedTile[]; }
// 外層先以「群組總值」squarify 分配區域；每群組扣掉 headerH 後，內層再 squarify 該群組個股
export function squarifyGrouped(groups: TreemapGroup[], width: number, height: number, headerH?: number): GroupLayout[];
```
- 外層群組 value ＝ Σ 個股 value（value ＝ `max(turnover, FLOOR)`）。
- 群組太小放不下 header（如 `h < headerH + 12`）→ 不畫 header 文字、只畫色塊。
- 補 vitest：群組面積比例正確、tiles 不重疊、不溢出群組矩形（比照 `treemap.test.ts` 既有 3 條的風格）。

### 4.2 `pages/SectorHeatmap.tsx`（或拆新元件，自行決定但別讓單檔爆到 800 行）
- 頂部控制列：
  - 視圖 chip：`產業` / `個股`（預設記住上次選擇，localStorage）。
  - 時間鈕：單日/單週/單月（個股視圖三顆全啟用；產業視圖仍只有單日——`/api/market/sectors` 沒有週月，**不要**為產業視圖加後端）。
  - 市場 tab：`上市` active、`上櫃` disabled＋「即將推出」。
- 個股視圖主體：SVG（沿用 `viewBox 0 0 1000 600` RWD 自適應）：
  - 產業 header 列：產業名＋該產業加權平均漲跌%（以成交值加權，前端算）。
  - 個股方塊：文字分級沿用 opt5 規則（大塊＝名稱+漲跌%、中塊＝名稱、小塊無字）；900+ 檔小塊很多，**務必**照分級，否則整張圖糊掉。
  - hover tooltip（手刻 DOM，沿用）：代號、名稱、產業、漲跌%（上色）、成交值（億/兆）；週/月時多顯示「基準日 base_date」。
  - click 個股方塊 → `navigate('/stock/' + code)`；click 產業 header → **聚焦模式**：只畫該產業（放大重排），再點一次或麵包屑「← 全部」返回。
- 三態、色階 legend、資料日期列：沿用 opt5。
- 效能：900+ `<rect>`＋部分 `<text>` 一般沒問題，但 hover 請用**事件委派**（SVG 根節點一個 handler 讀 `data-code`），不要每個 rect 掛 listener。

### 4.3 `lib/api.ts`
```ts
export interface HeatmapStock { code: string; name: string; sector: string; close: number | null; change_pct: number | null; turnover: number | null; }
export interface StockHeatmap { date: string; period: 'day' | 'week' | 'month'; base_date: string; market: string; stocks: HeatmapStock[]; source: string; }
export function marketStockHeatmap(params?: { period?: string; date?: string }): Promise<StockHeatmap>;
```
- `change_pct`/`close`/`turnover` 型別**誠實標 `| null`**，前端過濾或灰塊（opt5 的教訓）。

## 5. 工作清單

- engine：`twse_report_client.py` 新 fetch/get；`market.py` 新 `/market/stock-heatmap`＋日檔快取 helpers；pytest 新增（沿既有 live-integration 風格）。
- gateway：`routes/` 新 `/api/market/stock-heatmap` 轉發。
- 前端：`lib/treemap.ts` `squarifyGrouped`＋測試；`SectorHeatmap.tsx` 視圖切換＋個股視圖；`lib/api.ts` client＋型別。
- 文件：`docs/api.md`＋`review-web/docs/contracts.md` 新增 §2.12 契約；完工後 ROADMAP §8 補紀錄。
- 部署：**含 engine 端點變動 → VM 上 gateway＋engine 都要重啟**（deploy.md §4.2 的 🚨）。

## 6. 驗收標準

- [ ] 個股視圖：900+ 檔上市個股依產業分組呈現，大小＝成交值、顏色＝漲跌%（±5% 飽和紅漲綠跌）、群組 header 正確、無重疊破版。
- [ ] 單日/單週/單月三 period 都能載入且 `base_date` 正確（週≈5 交易日前、月≈21 交易日前）；非交易日自動回滾最近交易日。
- [ ] 點個股跳 `/stock/:code`；點產業 header 進聚焦模式、可返回。
- [ ] 產業視圖＝opt5 現狀零回歸；視圖/period/市場控制列狀態清楚（disabled 有「即將推出」）。
- [ ] `change_pct: null`（新上市等）不破版；期間未還原價的小字註明存在。
- [ ] engine 快照日檔快取生效（同日第二次請求不打 TWSE）；`_guard` 降級不 500。
- [ ] engine pytest 全綠（含新測試）、`tsc -b && vite build` 乾淨、vitest treemap 測試通過。
- [ ] 契約文件同步；未動 `web/`／`puhui_daily.cjs`。

## 7. 坑（帶進 review）

- 🚨 MI_INDEX 的「漲跌(+/-)」是**獨立欄位且可能是 HTML**（`<p style=...>+</p>`），要 strip 後判方向；`X`＝除權息等特殊情況。
- 🚨 TWSE exchangeReport **限流**：沒做日檔快取前別上線；冷載偶發拒絕就 retry/rollback，屬上游限流非程式錯（同 sectors 既有經驗）。
- 週/月為**未還原價**比較：除權息股會顯示假下跌；小字註明，別修數字。
- `00` 開頭＝ETF 要排除；5 碼（如 8069 上櫃）不會出現在 TWSE 檔裡，屬正常。
- 產業 map 對不到落「其他」，別 silent drop（「其他」群組照畫）。
- 小方塊文字分級不做會整張糊掉；hover 用事件委派防 900+ listener。
- PWA SW 快取：上版後看不到新 UI 先強制重整（已知坑）。
