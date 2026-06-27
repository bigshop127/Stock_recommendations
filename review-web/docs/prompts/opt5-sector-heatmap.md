# 優化專案 5 — 產業熱力圖（Treemap，仿 aistockmap.com）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt5-sector-heatmap.md`，然後根據裡面的說明進行」。
> **獨立專案**（不依賴 opt1–4）。**MVP 先交：單日 treemap＋新頁**，週/月與點擊跳轉列為可選/後續。
> 參考：`https://aistockmap.com/?activeTab=heatmap`。

## 1. 本案目標
新增一頁 **`/heatmap`「產業熱力圖」**，把各產業類股畫成 **treemap（方塊樹圖）**：
- **區塊大小 ＝ 該類股漲跌幅「絕對值」**（`|change_pct|`，跟參考站一致：大漲或大跌都是大塊）。
- **區塊顏色 ＝ 漲跌方向 × 強度**：發散色階，**台股慣例「紅漲綠跌」**，±5% 飽和（深紅＝漲超 5%、深綠＝跌超 5%、≈0% 接近灰）。
- 區塊內顯示「類股名＋漲跌幅%」；hover 出明細（名／漲跌幅／成交值）。
- 底部放一條**色階圖例**（跌超5% 綠 ←→ 漲超5% 紅）。
- 時間切換鈕 **單日／單週／單月**：**本案只做「單日」**，單週/單月鈕**先 disabled**＋tooltip「即將推出」。

> ⚠️ **範圍誠實話**：參考站用的是**自家細分主題**（MCU 嵌入式 IC、CXL 技術、矽光子與 CPO… 數百個），我們**沒有**那套分類。本案用引擎既有的 **~28–30 個 TWSE 官方類股**（半導體、航運、金融保險…）。版型/色階/大小邏輯一比一仿，但**方塊是廣義類股、不是細分主題**。

## 2. 資料來源（實查・MVP 零後端改動）
- 既有端點 **`GET /api/market/sectors?date=`** → `{ date, sectors: [{ name, change_pct, turnover, source }] }`（契約 `review-web/docs/contracts.md §2.3`）。
- 前端已有 `api.marketSectors()` 與型別 `MarketSectors`／`SectorPerformance`（`review-web/src/lib/api.ts:352-361`，Dashboard 已在用）。**直接複用，零後端改動。**
- 🚨 **`change_pct` 實際可能是 `null`**（引擎 `market.py get_sectors`：MIS 對不到該類股 channel 時給 `None`），但 TS 型別目前寫 `number`。**本案務必防 `null`/`NaN`**（過濾或畫成灰塊），別讓它破壞 treemap 版面；可順手把 `SectorPerformance.change_pct` 型別改成 `number | null`。
- `turnover` 單位為「元」，顯示請格式化成 億／兆。

## 3. 架構鐵律
- 前端**只打 gateway `/api`**、不直連 engine、不重算（數字吃 `/api/market/sectors`）。
- **不引重量級圖表庫**：沿用全案做法手刻 **SVG**（見 `CapitalTide.tsx` 的手刻 scatter、`Dashboard.tsx` sparkline）。treemap 版面用**自寫 squarified 演算法**（見 §5）。如真的想引第三方（如 `d3-hierarchy`）需先說明理由再決定，預設**不引**。
- `snake_case` 對後端；前端 TS 既有風格。不動 `web/`、不改壞 `puhui_daily.cjs`；`tsc -b && vite build` 乾淨。
- 著色**台股慣例**：漲＝紅、跌＝綠（與全站一致，別用西方紅跌綠漲）。

## 4. 前端規格
### 4.1 路由與導覽
- `App.tsx`：加 lazy 路由 `/heatmap`（比照 `CapitalTide` 的 `lazy(() => import(...))`）。
- `Layout.tsx`：側欄加 nav 項「產業熱力圖」（`lucide-react` 圖示建議 `LayoutGrid` 或 `Grid3x3`），放在「資金潮汐」與「個股多維度審查」之間；header 標題列加 `'/heatmap' → '產業熱力圖'` 分支。

### 4.2 頁面 `pages/SectorHeatmap.tsx`
- 載入時 `api.marketSectors()`；**三態**：loading（spinner）／error（訊息＋重試）／空（查無類股）。沿用 `CapitalTide.tsx` 既有三態樣式。
- 頂部：標題＋說明＋資料日期（`data.date`）＋重新整理鈕；右側時間切換鈕（單日 active；單週/單月 disabled＋tooltip「即將推出」）。
- 主體：treemap SVG（見 §5）。
- 底部：色階 legend 漸層條（左綠右紅，標「跌超5%／漲超5%」）。
- hover tooltip（手刻 DOM，浮在 SVG 上，比照 `CapitalTide.tsx` 的 tooltip）：類股名、`change_pct`（紅漲綠跌上色）、`turnover`（億/兆）。
- 點區塊（MVP）：設 `selected` 高亮該塊（描邊），**先不跳轉**（我們沒有類股主題頁）；保留 `onClick` hook 供日後接「主題總覽」。
- RWD：treemap 容器用固定 `viewBox`（如 `0 0 1000 600`）＋ `w-full h-auto` 自適應縮放；窄螢幕字級保護（見 §5 文字分級）。

### 4.3 色階映射（具體建議，可微調但要一致）
```
clamp t = max(-5, min(5, change_pct)) / 5      // → [-1, 1]，±5% 飽和
change_pct > 0（漲）：灰 #3f3f46 → 紅 #ef4444 → 深紅 #b91c1c，依 |t| 內插
change_pct < 0（跌）：灰 #3f3f46 → 綠 #22c55e → 深綠 #15803d，依 |t| 內插
change_pct ≈ 0 或 null：灰 #3f3f46（null 也可整塊排除，擇一但要一致）
```
- 區塊文字顏色固定白/淺（`#fff`／`zinc-100`），深底對比足夠即可。

## 5. Treemap 版面（自寫 squarified）
寫一支純函式 helper `review-web/src/lib/treemap.ts`，**不碰 DOM、純算座標**，方便 review／測試：
```ts
export interface TreemapInput { key: string; value: number; datum: SectorPerformance; }
export interface TreemapTile { x: number; y: number; w: number; h: number; item: TreemapInput; }
// squarify：value 需 > 0、且輸入前由大到小排序；回傳填滿 [0,0,width,height] 的不重疊矩形
export function squarify(items: TreemapInput[], width: number, height: number): TreemapTile[];
```
要點：
- `value = max(|change_pct|, FLOOR)`，`FLOOR` 取個小正數（如 `0.05`）避免 0% 類股變 0 面積消失。
- **過濾掉 `change_pct == null`**（或單獨歸到灰塊區），再 `sort` 由大到小，再丟進 `squarify`。
- 演算法用經典 **squarified treemap（Bruls 2000）**：沿較短邊鋪一「row」，逐一加入方塊，計算目前 row 的最差長寬比 `worst()`，**加入後比值變差就收掉這個 row**、在剩餘矩形繼續，直到鋪完。網路上有標準虛擬碼，照著實作即可（~50–70 行）。
- 面積換算：先把所有 `value` 正規化成總和 ＝ `width*height`。

### 文字分級（避免小塊爆字）
依方塊像素大小決定顯示層級：
- 夠大（如 `w>70 && h>40`）：顯示「類股名（換行）＋漲跌幅%」。
- 中等：只顯示類股名（可截斷）。
- 太小（如 `w<32 || h<22`）：不顯示文字，只靠顏色＋hover。

## 6. 工作清單
- `review-web/src/lib/api.ts`：（可選）把 `SectorPerformance.change_pct` 改 `number | null`。
- `review-web/src/lib/treemap.ts`：squarified 純函式 helper。
- `review-web/src/pages/SectorHeatmap.tsx`：頁面（fetch＋三態＋SVG treemap＋tooltip＋legend＋時間鈕）。
- `review-web/src/App.tsx`：路由 `/heatmap`。
- `review-web/src/components/Layout.tsx`：側欄 nav＋header 標題分支。
- 文件：端點不變，`contracts.md` 不必動；完工後 ROADMAP §8 補列 opt5（review 通過時由 Claude 補）。

## 7. 驗收標準（MVP）
- [ ] `/heatmap` 顯示 ~28 類股 treemap，**區塊大小＝`|change_pct|`**、**顏色紅漲綠跌且強度合理、±5% 飽和**、不重疊填滿畫布。
- [ ] hover 出「類股名／漲跌幅／成交值（億/兆）」；底部色階 legend 正確（左綠右紅）。
- [ ] `change_pct == null` 不破版（過濾或灰塊）；無 `NaN` 座標、無重疊/破圖。
- [ ] 單日可用；單週/單月鈕 **disabled＋「即將推出」** tooltip。
- [ ] 側欄新增「產業熱力圖」nav、header 標題正確、三態（loading/error/空）皆不破版、RWD 縮放正常。
- [ ] 前端只打 `/api`、未改後端、未動 `web/`／`puhui_daily.cjs`；`tsc -b && vite build` 乾淨。

## 8. 坑（帶進 review）
- 🚨 **squarify 前置**：先濾掉 `null`/`<=0` 的 value、給 `FLOOR`、由大到小排序，否則版面會破（0 面積、極端長寬比）。
- 🚨 **配色別搞反**：台股紅漲綠跌；且 0% 不該很深（強度要隨 `|t|` 由灰漸深）。
- `change_pct` 型別謊報（寫 `number` 實可 `null`）→ 一定要 runtime 防護。
- 小塊文字溢出：照 §5 文字分級，加截斷，別讓字蓋滿整張圖。
- `turnover` 是「元」→ 顯示要 `/1e8` 億、`/1e12` 兆。
- 時間鈕：單週/單月**只是 disabled 佔位**，別讓人以為壞掉——給 tooltip/「即將推出」標示。
- **PWA 快取**：上版後瀏覽器可能仍顯示舊殼（service worker 快取，已知坑）。驗收/部署後若沒看到新頁，先強制重整或清 SW（見 `main.tsx` SW 註冊註解）。
- 點區塊 MVP 不跳轉（無類股主題頁）；保留 `onClick` hook，別硬接不存在的路由。
