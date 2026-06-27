# 優化專案 4 — 資金潮汐（仿 tide-tw.app）：資金流向 × 動能泡泡圖

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt4-capital-tide.md`，然後根據裡面的說明進行」。
> **獨立專案**（不依賴 1/2/3，但右側監控清單若做，建議複用專案 1 store＋專案 2 `<SymbolSearch>`）。
> 本案是 4 個優化裡**最大**的一個 → **先做 MVP（泡泡圖＋新端點），驗收後再加可選面板**。動手重後端前，先跟 Claude 對齊範圍。

## 1. 參考來源與本案目標

參考 `tide-tw.app`：核心是一張**泡泡圖**，把個股放到二維平面——
- **X 軸＝資金流向**（左 資金流出 ←→ 右 資金流入）
- **Y 軸＝進入慣性 / 動能**（上 漲幅/天 ←→ 下 跌幅/天）
- 每顆泡泡＝一檔股，大小＝成交值/市值，顏色＝象限/類股；點泡泡彈出「今日強弱」明細。
- 周邊：左側強弱統計、法人焦點選股榜、類股熱力、右側自選監控清單。

本案在 review-web 新增一頁 **`/tide`「資金潮汐」**，把這套搬進來（用我們既有 engine 資料算，不接 tide 的 API）。

## 2. 架構鐵律

- 前端**只打 gateway `/api`**、不直連 engine、不重算（數字吃新端點）。
- 新端點要**有界 universe ＋ 每日快取**（不可即時對全市場逐檔硬算 → 會打爆 FinMind）。
- 不引入重量級圖表庫為原則：沿用全案做法（`lightweight-charts` + 手刻 SVG，見 `Dashboard.tsx` sparkline/trend、`ChipsCharts.tsx`）。泡泡圖用**手刻 SVG scatter** 即可（~100 點＋hover 完全可行）。如真要引圖表庫需先說明理由。
- `snake_case`；不動 `web/`、不改壞 `puhui_daily.cjs`；engine `pytest` 綠、`tsc -b && vite build` 乾淨。

## 3. 後端規格（MVP 必做）：`GET /api/market/capital-tide`

### 3.1 Universe（有界）
沿用既有「廣度」用的 universe＝**watchlist 聯集 ∪ 0050 成分**（見 `engine/app/api/market.py` 的 breadth `universe: "watchlist_union_0050"`、sample ~95）。本端點**重用同一份 universe 取得邏輯**，別另立新清單。可加 `?universe=` 預留，預設沿用。

### 3.2 每檔計算（建議公式，可在實作時微調，但要在回應標單位/視窗）
對 universe 內每檔，用既有資料源算兩軸＋輔助欄：
- **flow_x（資金流向）**：近 `N=5` 日**三大法人買賣超淨額**（張或估算金額）。資料複用 `/api/stocks/:code/chips` 背後的 `total_net_buy_qty`（見 `StockChips.data[].total_net_buy_qty`）累計近 5 日。建議對 universe 做 **z-score 或 min-max 正規化到 [-1, 1]** 當座標，同時保留原始值（顯示用）。
- **momentum_y（進入慣性）**：近 `N=5` 日**平均每日漲幅 %**＝(close_t / close_{t-5} − 1) × 100 / 5。用既有 `ohlcv?adjust=1` 還原價（**務必還原價**，否則除權息斷點失真）。
- **size（泡泡大小）**：近日成交值（量×均價）或市值；無則退用固定值。
- **strength（今日強弱 0~100）**：flow 與 momentum 標準化後加權合成（建議各半）。**可直接複用** `/signal/blended` 的 blended_score 當強弱（若不想另算）——你拍板，但要一致。
- **sector**：類股分群（複用 engine 既有類股對照；無對照則 `null`/「其他」）。

### 3.3 回應契約（`snake_case`）
```jsonc
{
  "date": "2026-06-27",
  "window_days": 5,
  "universe": "watchlist_union_0050",
  "axes": { "x": { "label": "資金流向", "unit": "近5日法人淨買賣超(張)" },
            "y": { "label": "進入慣性", "unit": "近5日平均漲幅(%/日)" } },
  "stocks": [
    { "code": "2330", "name": "台積電", "sector": "半導體",
      "flow_x": 0.82, "flow_raw": 125000,          // 正規化座標 + 原始值
      "momentum_y": 0.6, "momentum_raw": 1.2,
      "size": 0.9, "size_raw": 1.85e12,
      "strength": 78,
      "quadrant": "inflow_up" /* inflow_up|inflow_down|outflow_up|outflow_down */ }
  ],
  "source": "FinMind/TWSE/yfinance",
  "degraded": false,
  "errors": []
}
```
- **快取**：engine 端**每日快取**整批結果（沿用既有 cache；key 帶 date+universe）；gateway 再加一層 TTL（建議數十分鐘～數小時）。第一次算可能慢（逐檔），之後吃快取。
- **降級**：個別股缺資料 → 該股略過並記 `errors[]`，不整批 500；engine down → gateway graceful degradation（沿用全案語意）。
- 測試：engine 加最小測試（mock 幾檔 chips+ohlcv → 算出 x/y/quadrant、含一檔缺資料被 skip）。

## 4. 前端規格

### 4.1 必做（MVP）：`/tide` 頁＋泡泡圖
- `App.tsx` 加路由 `/tide`；`Layout.tsx` 加 nav 項「資金潮汐」（`lucide-react` 如 `Waves`/`Droplets`）。
- `pages/CapitalTide.tsx`：打 `api.marketCapitalTide()`，手刻 **SVG scatter**：
  - 中央十字分隔線（x=0 資金流出/流入界、y=0 漲/跌界），四象限淡色背景與標籤（右上「資金流入＋上漲」最強…）。
  - 每股一顆 `<circle>`，半徑由 `size`，位置由 `flow_x/momentum_y`，顏色由 `quadrant` 或 `sector`（**台股慣例：偏多/流入＝紅、偏空/流出＝綠**）。
  - **hover/點選 tooltip**：顯示股名代號、strength（強弱分條）、flow_raw、momentum_raw、sector、「進入審查」連 `/stock/:code`。
  - 載入/空/錯誤/降級三態不破版；RWD（窄螢幕可橫向捲動或縮放）。
- 著色與全站一致（紅漲綠跌、BUY 紅）。

### 4.2 可選（MVP 驗收後再加，可拆成後續提示詞）
- **左側強弱統計**：四象限/強弱分桶計數（如 強勢 N、轉強 N、轉弱 N、弱勢 N）——由 `stocks[]` 前端彙總即可，**免新端點**。
- **法人焦點選股榜**：近日法人買超前 K 名＋漲跌幅。可由 `capital-tide` 的 `flow_raw` 排序前端產生，或複用 `/api/market/institutional`；**先用 capital-tide 排序，免新端點**。
- **類股熱力**：直接複用既有 `/api/market/sectors`（Dashboard 已有元件可借）。
- **右側「Tide 監控清單」**：複用**專案 3** 的自選 store＋**專案 2** 的 `<SymbolSearch>`（＋/－ 增刪）；點清單某股 → 泡泡圖高亮該泡泡。
- 大戶/散戶明細（tide popup 有）：engine 若無對應資料源（如 FinMind `TaiwanStockHoldingSharesPer`）就**先省略**，別硬湊。

## 5. 工作清單
- 後端：universe 重用 → 逐檔算 flow/momentum/strength → `GET /data/market/capital_tide`（engine，每日快取）＋ gateway `GET /api/market/capital-tide`（TTL 快取＋降級）；engine 測試；契約文件。
- 前端：`api.ts` 加 `marketCapitalTide`＋型別；路由＋nav；`pages/CapitalTide.tsx`（SVG 泡泡圖＋tooltip＋三態＋RWD）。
- 可選面板分批做（建議獨立後續提示詞）。

## 6. 驗收標準（MVP）
- [ ] `GET /api/market/capital-tide` 回有界 universe 的逐檔 x/y/strength/quadrant，**每日快取**、個別缺資料降級不 500。
- [ ] `/tide` 泡泡圖正確把股放到對應象限；hover/點選出明細＋「進入審查」連結。
- [ ] flow/momentum 公式與單位**在回應與 UI 標清楚**；momentum 用**還原價**。
- [ ] 著色台股慣例（流入/上漲＝紅、流出/下跌＝綠）；三態/降級/RWD 不破版。
- [ ] 前端只打 `/api`、不重算；universe 重用既有 breadth 邏輯、未另立硬編清單。
- [ ] 未動 `web/`、`puhui_daily.cjs`；`snake_case`；engine `pytest` 綠、`tsc -b && vite build` 乾淨。

## 7. 坑（帶進 review）
- 🚨 **逐檔算很重**：universe ~95 檔，每檔要 chips＋ohlcv → 一定要 **engine 每日快取整批**，否則每次開頁打爆 FinMind/超時。第一次算慢屬正常，要有 loading。
- 🚨 momentum **務必用還原價**（`ohlcv?adjust=1`）；0050 等除權息/分割會斷點失真（全案既有坑）。
- 正規化要對「當日 universe 分布」算（z-score/min-max），別用固定魔數，否則泡泡擠成一團。
- 缺資料的股要**跳過並記 errors**，不可讓一檔壞掉拖垮整批。
- 著色別用西方慣例（紅跌綠漲）——全站一致紅漲綠跌。
- 泡泡重疊：~100 點會擠，需要半透明＋hover 提高 z／或輕量防重疊；先求能用，別過度優化。
- 範圍控制：**先交 MVP（端點＋泡泡圖）**，左右面板與大戶/散戶明細列為可選/後續，避免一次吞太大。
</content>
