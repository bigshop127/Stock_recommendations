# 優化專案 7 — 盤勢總覽 2.0（資訊架構重整，仿 futures-ai 台股概況）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt7-market-overview.md`，然後根據裡面的說明進行」。
> 參考範本：`C:\Users\bigsh\Downloads\概念圖\個股審視網站 模板.jpg`、`模板2.jpg`（期天資訊 alpha.futures-ai.com 台股概況實際截圖，**2026-07-02 依此校準規格**）。
> **相依：建議在 opt6 之後做**——本案的「漲跌分布直方圖」與「強勢/弱勢/熱門 Top15」直接複用 opt6 的 `/api/market/stock-heatmap` 全市場快照，**自身零新後端**。若先做本案，這兩個模組先降級隱藏。

## 1. 本案目標（要「全面但不雜亂」）

現況 Dashboard 是四張等權大卡＋watchlist 直落排列，資訊都有但**沒有層次**。範本的可取之處：頂部先給「盤面分析」總結區（關鍵數字＋氣氛儀表），再往下依序指數卡、漲跌分布、排行榜，一屏一層、越往下越細。本案照此重整：

1. **市場狀態列（頂條）**：加權/櫃買/電子/金融/台指期 五個緊湊 chips（現值＋漲跌%、紅漲綠跌）＋資料時間＋刷新鈕。資料＝現有 indices state，**不加請求**。點 chip 平滑捲動到指數大卡。
2. **盤面分析卡（仿範本左上，規則式零 LLM）**：
   - 關鍵數字小格（2×3）：大盤漲跌點數、漲跌家數（`612:375` 上色比）、類股漲跌比（上漲類股數:下跌類股數）、漲停:跌停、三大法人合計（億）、大盤水位%。缺哪項就少一格，不硬湊。
   - **盤面氣氛半圓儀表**：**−100 ～ +100**（對齊範本刻度），指針＋大字 `+43` 樣式；紅=偏多、綠=偏空（台股慣例，與範本配色相反——範本是西式配色，**別照抄**）。
   - 一句規則式總結＋2–4 條關鍵訊號 bullets（引用真實數字）。
3. **漲跌家數分布直方圖（仿範本「上市漲跌家數」）**：X 軸 −10%…+10% 每 1% 一桶的家數直條（漲桶紅、跌桶綠、平盤灰），下方一條「跌停/下跌/平盤/上漲/漲停」五段 strip＋數字。資料＝opt6 `stock-heatmap`（period=day）前端分桶。**上櫃版不做**（我們只有上市快照）。
4. **強勢／弱勢／熱門 Top15（仿範本三表）**：三個 tab 或三欄表——熱門＝成交值 Top15、強勢＝漲幅 Top15、弱勢＝跌幅 Top15；欄位：代號/名稱/收盤/漲跌%/成交值；**點列跳 `/stock/:code`**。同樣由 stock-heatmap 快照前端排序，零後端。
5. **版面重排（12-col grid）＋卡片規格統一**：抽 `components/OverviewCard.tsx`（title、一句話 caption、children、footer 資料時間），四張舊卡換殼**不換餡**；產業熱力卡縮成 Top10 橫條＋「開啟熱力圖 →」連 `/heatmap`；資金潮汐入口卡連 `/tide`。
6. **手機單欄順序**：狀態列 → 盤面分析 → 指數 → 漲跌分布 → 法人 → Top15 → 熱力/潮汐入口 → watchlist。

**本案不做（backlog，範本有但資料太重）**：盤中創高低家數（5–240 日）、站上周/月/季線家數統計、類股/權值/高價股 K 線群、題材關鍵字 chips、台指波動率卡。

## 2. 盤面氣氛與規則式文案（本案核心，要可測）

新增純函式模組 `review-web/src/lib/marketSummary.ts`（**不碰 DOM、不發請求**）＋vitest：

```ts
export interface MarketSummaryInput {
  breadth: MarketBreadth | null;             // up/down/flat/limit_up/limit_down/total
  institutional: MarketInstitutional | null; // 當日三大法人合計買賣超（元）
  regime: MarketRegime | null;               // dashboard 的 water_level (0~1)
}
export interface MarketSummary {
  mood: number;              // −100 ～ +100，0=中性
  stance: 'bull' | 'neutral' | 'bear';
  headline: string;
  signals: { text: string; tone: 'bull' | 'bear' | 'neutral' }[];  // 2–4 條
}
export function buildMarketSummary(input: MarketSummaryInput): MarketSummary;
```

**氣氛公式（定案，權重可微調但寫死一處）**：
```
breadth_score = up/(up+down)*2 − 1                    // −1~1，缺值 0
inst_score    = clamp(法人合計億 / 300, −1, 1)         // ±300 億飽和，缺值 0
level_score   = water_level*2 − 1                      // −1~1，缺值 0
mood          = round((0.4*breadth_score + 0.3*inst_score + 0.3*level_score) * 100)
stance: ≥+20 bull ／ ≤−20 bear ／ 其餘 neutral
```

**規則式 signals（模板寫死，取符合的前 3–4 條）**：
- 上漲家數比 ≥60% →「上漲 X 家（Y%），盤面偏多」（bull）；≤40% 反向（bear）。
- |法人合計| ≥50 億 →「三大法人合計買超/賣超 X 億」。
- 漲停 ≥20 家 →「漲停 X 家，投機情緒熱」；跌停同理。
- `water_level` ≥0.7 →「大盤水位高檔（X%）」；≤0.3 低檔。
- 缺值 → 該條不出；**任何情況不得**出現 `NaN`/`undefined` 字樣。

**誠實聲明**：卡底固定小字「規則式合成，非投資建議」。輸入整段缺（engine 降級）→ 儀表灰態「資料不足」，**不要**用 0 假裝中性還配多空話術。

## 3. 架構鐵律（沿用全案）

- **零新後端**：只用既有端點＋opt6 的 `stock-heatmap`；不加輪詢頻率；首頁嚴禁打 `/api/stocks/:code`、`/api/agents/decide`。
- 台股色慣例：多/漲＝紅、空/跌＝綠、中性灰。**儀表與直方圖配色同理**（範本是西式綠多紅空，別照抄）。
- 不動 `web/`；`snake_case`；`tsc -b && vite build` 乾淨；vitest 通過。
- 現有四卡內部圖表（sparkline、法人趨勢、MA 比率）**不重寫**，只動容器與新增模組。

## 4. 版面規格（桌面 ≥1280）

```
┌─ 市場狀態列（h~40px：5 指數 chips ＋ 資料時間 ＋ 刷新）───────────────────┐
├─ Row1：盤面分析卡（5 col：關鍵數字格＋氣氛儀表＋headline/signals）│ 指數走勢卡（7 col，現有）─┤
├─ Row2：漲跌分布直方圖＋漲跌停 strip（6 col）      │ 三大法人卡（6 col，現有）────────────┤
├─ Row3：市場寬度卡（6 col，現有 MA 比率等）        │ 強勢/弱勢/熱門 Top15（6 col，tab 切換）─┤
├─ Row4：產業熱力 Top10＋入口（6 col）              │ 資金潮汐入口卡（6 col）──────────────┤
└─ Row5：Watchlist（12 col，現有）───────────────────────────────────────┘
```
- 768–1280：2 欄；<768：單欄依 §1.6 順序。
- stock-heatmap 快照一次 fetch、直方圖與 Top15 共用（module state / context，別打兩次）。

## 5. 工作清單

- `lib/marketSummary.ts`＋`lib/marketSummary.test.ts`（公式、±20 邊界、缺值降級、signals 模板、無 NaN）。
- `components/OverviewCard.tsx`（統一卡殼）。
- `pages/Dashboard.tsx`：狀態列、盤面分析卡（含手刻 SVG 半圓儀表）、直方圖＋strip、Top15 表、grid 重排、熱力 Top10 縮卡、潮汐入口卡。
- `components/Layout.tsx`：若與狀態列資訊重複，微調（變動最小化）。
- 文件：零新端點 → `contracts.md` 不動；完工後 ROADMAP §8 補紀錄。

## 6. 驗收標準

- [ ] 首屏（1280×800）不捲動可見：五指數狀態列、盤面分析（關鍵數字＋氣氛儀表＋一句話）、漲跌分布直方圖上緣。
- [ ] 氣氛儀表 −100~+100、紅多綠空；數值與 breadth/institutional/water_level 手算吻合（抽 2 個交易日）；「規則式非投資建議」小字存在。
- [ ] 直方圖分桶總和＝快照個股數（±平盤/null 處理說得清）；五段 strip 數字與 breadth 一致或標注口徑差異。
- [ ] Top15 三表排序正確、點列跳個股頁；與熱力圖同一份快照（network 面板只見一次 stock-heatmap）。
- [ ] 任一資料源降級：該模組灰態「資料不足」，其餘正常（逐區塊降級）；opt6 未部署時直方圖/Top15 隱藏且不報錯。
- [ ] 四張舊卡功能零回歸；三斷點（375/768/1280）不破版；手機順序符合 §1.6。
- [ ] `tsc -b && vite build` 乾淨、vitest（marketSummary）全綠；未動後端、未動 `web/`。

## 7. 坑（帶進 review）

- 🚨 **配色**：範本（期天/西式）綠=多、紅=空——我們全站台股慣例**相反**，儀表/直方圖/Top15 全要紅多綠空。
- 🚨 `water_level` 是 **0~1 float**（另有 `water_level_text`），別當百分比整數（型別分歧已知坑）。
- 法人單位是「元」：換算「億」（/1e8）再進公式與文案。
- 直方圖口徑：stock-heatmap 只含上市普通股（已濾 ETF），與 breadth 的全市場家數**會有差**，兩處別硬對齊，footer 註明口徑即可。
- `MarketBreadth` 各欄可能缺（冷啟/降級）：`buildMarketSummary` 全路徑防 null，測試覆蓋。
- 指數 chips 重用現有 indices state，別多打一次 `/api/market/indices`。
- 文案禁預測性字眼（「將上漲」禁用；只描述現況偏多/偏空/中性）。
- 半圓儀表手刻 SVG（arc path＋針），別引 gauge 套件。
- PWA SW 快取：上版後看不到新版面先強制重整（已知坑）。
