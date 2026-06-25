# Phase 5 — 個股技術面（指標疊圖／量價／型態）

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋指標規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase5.md`，然後根據裡面的說明進行」。

## 1. 本階段目標

把 `/stock/:code` 的 K 線技術圖表（Phase 2 的 `components/PriceChart.tsx`，現只有 MA20/MA50＋量）升級成**完整技術分析面板**：主圖疊更多均線＋布林通道，下方掛 MACD／KD／RSI 振盪指標副圖，量價著色，並（行有餘力）做型態標註與技術因子分呈現。

**範圍：**
- **必做**：① 主圖可切換的多均線（MA5/10/20/60，台股慣例）＋ **布林通道 BBands(20,2)** ② **MACD** 副圖（DIF／MACD／OSC 柱）③ **KD** 副圖（%K／%D，9,3,3）④ **RSI** 副圖（RSI6／RSI12）⑤ 指標開關 UI（勾選顯示/隱藏，預設一組合理子集）⑥ 量價：成交量柱沿用現有紅綠，疊**量能均線（VMA5/VMA20）**。
- **可選（行有餘力，否則 Phase 後期再補）**：型態標註（均線黃金/死亡交叉、KD 超買超賣、量價背離 markers）、技術因子分呈現（**複用** `/api/stocks/:code` 既有訊號，不重算）、PER 不在此（屬 Phase 4）。

## 2. 互動與架構鐵律（務必遵守）

- 🟢 **本階段零後端工（定案）**：所有指標都由**前端用已抓到的還原日 K（`/api/stocks/:code/ohlcv?adjust=1`，PriceChart 已在用）就地計算**，**不新增 engine 端點、不改 gateway、不重算後端因子分**。理由：MA/MACD/KD/RSI/BBands 都是便宜的滾動運算，瀏覽器已握有整段 OHLCV，加端點只是多一份契約＋快取去算瀏覽器 1ms 能算完的東西。
  - 逃生門（**本階段不做**）：若未來要「指標值與後端因子引擎完全對齊」或做重型型態偵測，再補 `/data/indicators`；Phase 5 一律前端算。
- 前端**只打既有 gateway `/api`**，不直連 engine、不重算後端分數；技術因子分若要呈現＝**讀既有 `/api/stocks/:code` 回應現成欄位**，沒有就略過（不為它加後端）。
- 🚨 **lightweight-charts 版本鐵律（最大坑）**：review-web 實裝 **v4.2.3**，`PriceChart.tsx` 用的是 v4 series API（`chart.addCandlestickSeries / addLineSeries / addHistogramSeries`）。**v4.2.3 沒有原生多面板（panes）**——現有「成交量副圖」其實是同一個 chart 上用 `priceScaleId:'vol'` + `scaleMargins` 疊出來的，不是真 pane。**多面板（`addPane`/`chart.addSeries(SeriesType,…)`）是 v5 才有的 API → 千萬不要為了做 MACD/KD/RSI 把 review-web 升上 v5，會整個 K 線爆掉**（見 §5 的 v4 正確做法）。根 `package.json` 若殘留多餘 `lightweight-charts ^5.x` 一併別碰 review-web。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源；欄位/型別一律 `snake_case`（本階段多為前端內部運算，沿用既有命名）。
- **不要打壞 Phase 2 既有行為**：日K↔分K 切換、`adjust` 還原、五檔、crosshair 圖例都要照常。

## 3. 希望看到的內容（前端 技術面）

在現有「互動式 K 線技術圖表」區（`StockDetail.tsx` 約 line 1619、`<PriceChart>`）擴充。建議：**擴充 `PriceChart.tsx` 主圖**（均線＋布林），**振盪指標另做 1~3 個時間軸同步的副圖**（見 §5），上方加一排**指標開關**。

1. **主圖疊加（同一個 candle chart）**
   - **多均線**：MA5/10/20/60（沿用既有 `calculateMA` SMA，擴成可設定週期集合；保留現有 MA20黃/MA50藍可運作，建議改成台股慣例 5/10/20/60，**勿破壞既有**）。均線用**中性配色盤**（各週期不同色），**不是漲跌紅綠**——均線是參考線不是多空。
   - **布林通道 BBands(20,2)**：上軌／中軌(=MA20)／下軌三條線，可選淡色帶填充；中性色，勿套紅綠。
   - 圖例 overlay 沿用現有寫法，新增指標數值欄（hover 顯示當點 MA/布林/量）。
2. **MACD 副圖**：DIF（快線）、MACD（慢線/訊號）、OSC 柱狀；**OSC 正＝紅、負＝綠**（台股慣例，同籌碼/營收）；DIF/MACD 線用中性色。
3. **KD 副圖**：%K、%D 兩線（中性配色）＋ 80/20 超買超賣參考線（可淡色帶）。
4. **RSI 副圖**：RSI6、RSI12 兩線＋ 50 中線、70/30（或 80/20）參考線。
5. **量價**：成交量柱沿用現有紅綠（收≥開紅、否則綠），疊 **VMA5/VMA20** 量能均線（中性色）。
6. **指標開關 UI**：主圖均線/布林、各振盪副圖可勾選顯示/隱藏；預設開一組合理子集（如 MA5/20/60＋量＋MACD；KD/RSI/布林預設關，避免一進來太滿）。狀態可存 `localStorage`（沿用 Phase 2/3 既有偏好存法，如果有）。
7. **降級**：指標全衍生自已載入的 OHLCV → K 線出得來指標就算得出，不新增失敗模式；資料太短（不足週期）時該指標**前段自然無值**（不要補 0/假線），副圖可顯示「資料不足」而非破圖。分K 模式：振盪指標以**日K 為主**；分K 至少不破圖（可只保留均線，或在分K bars 上重算——擇一，預設分K 只保留 MA）。

> 著色慣例重申：**MACD OSC／量柱 正紅負綠**（多空語意，台股 bull=紅）；**均線／布林／KD／RSI 線是參考線→中性配色，不要套紅綠**（避免「RSI 高就紅」被誤讀成利多）。交叉/型態 markers 若做：黃金交叉(偏多)＝紅、死亡交叉(偏空)＝綠。

## 4. 指標公式規格（請照此實作，避免細節走鐘）

> 這些指標很容易在「種子值／平滑法」上算錯，請依台股常用定義：

- **SMA(n)**：近 n 根 close 算術平均（現有 `calculateMA` 即是；量能均線同法用 volume）。
- **EMA(n)**：`EMA_t = EMA_{t-1} + α·(C_t − EMA_{t-1})`，`α = 2/(n+1)`；種子 `EMA_0 = 首根 close`（或前 n 根 SMA，擇一一致即可）。
- **MACD（12,26,9）**：`DIF = EMA12 − EMA26`；`MACD(訊號/DEA) = EMA9(DIF)`；`OSC(柱) = DIF − MACD`。
- **KD（9,3,3）**：
  - `RSV_t = (C_t − L9) / (H9 − L9) × 100`，`L9`/`H9` = 近 9 根最低低/最高高；若 `H9 == L9` → `RSV = 50`（防除零）。
  - `K_t = (2/3)·K_{t-1} + (1/3)·RSV_t`，種子 `K = 50`。
  - `D_t = (2/3)·D_{t-1} + (1/3)·K_t`，種子 `D = 50`。
- **RSI(n)（Wilder 平滑）**：首值 = 前 n 根漲幅平均 / 跌幅平均；之後 `avgGain_t = (avgGain_{t-1}·(n−1) + gain_t)/n`（跌幅同理）；`RS = avgGain/avgLoss`，`RSI = 100 − 100/(1+RS)`；`avgLoss == 0 → RSI = 100`。預設 RSI6＋RSI12。
- **布林通道（20,2）**：`中軌 = SMA20`；`σ = 近 20 根 close 標準差`（母體 n，定義一致即可）；`上/下軌 = 中軌 ± 2σ`。
- **暖機**：指標在序列左端會有 NaN/無值段——**對整段 `rows` 計算後再交給圖表**（現有 `calculateMA` 已是這模式：不足週期就 `continue` 不 push）。若希望畫面左緣指標也完整，確保 `ohlcv` 抓取視窗夠長（MA60/MACD 需 ~60–90 根暖機）；**不足就讓它左端空白，不要補假值**。

## 5. lightweight-charts v4 多面板實作指引（關鍵技術）

v4.2.3 **沒有原生 panes**。主圖疊加（均線/布林/量）直接在現有 `PriceChart` 的 candle chart 上多 `addLineSeries`/`addHistogramSeries` 即可。**振盪指標副圖（MACD/KD/RSI）有自己的 y 軸尺度**，請用下列其一：

- **建議：分離的堆疊 chart 實例 + 時間軸同步**（v4 標準做法，能與 K 線對齊縮放/十字線）：
  - 每個振盪副圖各自 `createChart`（較矮，如 height 120），垂直堆在 K 線下方。
  - **時間軸雙向同步**：`chartA.timeScale().subscribeVisibleLogicalRangeChange(r => r && chartB.timeScale().setVisibleLogicalRange(r))`，兩邊互訂；**加一個 guard flag 防無限迴圈**。
  - **十字線同步**：`subscribeCrosshairMove` + 對另一張 `setCrosshairPosition` / `clearCrosshairPosition`，讓 hover 對齊。
  - 右側 priceScale 寬度對齊（固定 `rightPriceScale` 寬或 `rightOffset`），否則時間軸會錯位。
  - 清理：每個 chart 都要在 effect cleanup `chart.remove()`、`ResizeObserver.disconnect()`（沿用 `PriceChart` 現有清理寫法）。
- **可接受的較簡替代：自繪 SVG 副圖**（本專案 `ChipsCharts.tsx`／基本面已用自繪 SVG）——MACD/KD/RSI 算好直接畫 SVG。**較簡單但不會跟 K 線縮放/平移連動**；若你覺得多 chart 同步太繁，可先用 SVG 把指標做出來（hover tooltip 自理），對齊縮放當後續優化。
- **不要**：升 v5 用原生 panes（破 K 線）；也不要把 MACD 柱硬塞進 K 線主圖的 `priceScaleId` 疊著（尺度差太多會壓扁價格）。

> 二選一你決定；review 會看「指標正確、不破既有 K 線、不升 v5」。建議主圖擴充用法 A，振盪副圖**用法 A 同步**為佳、**SVG 為可接受退路**。

## 6. 工作清單（前端為主）

- `components/PriceChart.tsx`：擴充均線集合（MA5/10/20/60，可設定）＋布林三線（＋可選帶填充）＋量能均線；圖例 overlay 增欄；**保留日K/分K、adjust、crosshair 既有行為**。
- 新元件（建議）`components/IndicatorPanels.tsx`（或拆 `MacdPanel`/`KdPanel`/`RsiPanel`）：依 §4 公式算指標、依 §5 做副圖與時間軸同步。指標純函式（SMA/EMA/MACD/KD/RSI/BBands）建議集中放 `lib/indicators.ts` 方便寫單元測試。
- `StockDetail.tsx`：在 K 線區加**指標開關列**（勾選）＋掛載振盪副圖；（可選）一個小「技術面結論」chip **複用** `signalState` 既有資料，不重算、不新增後端。
- （可選）`lib/indicators.ts` 加 **Vitest 單元測試**：用一小段已知 OHLCV 驗 MACD/KD/RSI/BBands 數值（KD 種子=50、RSI Wilder、布林 2σ）——指標算錯是本階段最可能的 bug，**建議至少測 KD 與 RSI**。
- 無後端改動 → engine/gateway/`docs/contracts.md` **不需動**（若你在 `api.ts` 加了純前端型別可順手補註解，但別動 API 契約）。

## 7. 驗收標準

- [ ] 主圖：多均線（≥MA5/20/60）＋布林通道(20,2) 正確疊加，均線/布林為**中性色**（非紅綠），日K/分K 切換與還原價不被打壞。
- [ ] MACD/KD/RSI 三振盪指標**數值正確**（依 §4 公式：KD 種子 50、RSI Wilder、MACD EMA、布林 2σ），副圖與 K 線**時間對齊**（用法 A 須縮放/十字線連動；用法 B SVG 至少同 x 範圍）。
- [ ] **MACD OSC 柱與量柱 正紅負綠**；KD/RSI/均線/布林線中性色；超買超賣/中線參考線有畫。
- [ ] 指標開關可顯示/隱藏，預設一組合理子集（不一進來就爆滿）；切換不破圖、不漏記憶體（chart 正確 remove）。
- [ ] 資料不足週期時該指標左端自然空白（**不補 0/假線**）；分K 模式不破圖。
- [ ] **零後端改動**：未新增 engine/gateway 端點、未改既有因子分、`web/` 未動、`docs/contracts.md` 未變；技術因子分（若呈現）來自既有 `/api/stocks/:code`，不重算。
- [ ] **未升 lightweight-charts 到 v5**（review-web 仍 v4.2.3，沿用 v4 series API）。
- [ ] `tsc -b && vite build` 乾淨；若加了 `lib/indicators.ts` 測試則 Vitest 綠。

## 8. 沿用既有坑（帶進 review）

- 🚨 **v4/v5 陷阱**（§2/§5）：review-web 鎖 v4.2.3、`addCandlestickSeries/addLineSeries/addHistogramSeries`；多面板用「分離 chart + 時間軸同步」或自繪 SVG，**別升 v5**。根 `package.json` 殘留的 v5 依賴別牽動 review-web。
- 著色：台股 **bull=紅 / bear=綠**；多空語意（OSC/量/交叉）才用紅綠，**參考線（均線/布林/KD/RSI）一律中性色**，避免誤導。
- K 線**預設還原價**（`ohlcv?adjust=1`，PriceChart 已是）；指標算在還原價上才不會被除權息斷點汙染。
- 指標公式種子/平滑易錯（KD、RSI、EMA）→ 照 §4，能寫單元測試最好。
- 效能：指標純前端滾動運算，整段一次算完即可；避免在 render/crosshair callback 內重算整段（算一次存起來）。
- 多 chart 實例務必在 effect cleanup 全部 `remove()` + `ResizeObserver.disconnect()`，否則切股票/切日分K 會洩漏（沿用 `PriceChart` 既有清理）。
- engine/老王/報告本階段都不碰；技術因子分只「讀現成、不重算」。
