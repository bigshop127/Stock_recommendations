# 優化專案 7 — 盤勢總覽 2.0（資訊架構重整，仿 alpha.futures-ai.com/market-overview）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt7-market-overview.md`，然後根據裡面的說明進行」。
> **零後端改動**：所有資料都來自既有端點（`/api/dashboard`、`/api/market/{indices,breadth,institutional,sectors}`）。參考：`https://alpha.futures-ai.com/market-overview`。

## 1. 本案目標（要「全面但不雜亂」）

現況 Dashboard 是四張等權大卡＋watchlist 直落排列，資訊都有但**沒有層次**：使用者要自己掃完四張卡才知道「今天市場怎麼樣」。本案照 futures-ai 的資訊架構原則重整：

1. **市場狀態列（Ticker Strip）**：頁面最頂一條緊湊橫列——加權/櫃買/電子/金融/台指期的「現值＋漲跌%」小 chip（紅漲綠跌），一眼掃完五個指數。資料＝既有 indices（Dashboard 已在抓，**不加請求**）。點 chip 平滑捲動到下方指數大卡。
2. **市場總結卡（規則式，零 LLM）**：一張「今天市場一句話」卡——
   - **市場溫度 0–100 半圓儀表**（紅偏多／灰中性／綠偏空，台股色慣例）。
   - 一句規則式總結，例：「多方偏強：上漲家數 62%、三大法人合計買超 124 億、大盤位於 20MA 之上」。
   - 2–4 條「關鍵訊號」bullets（規則式，引用真實數字）。
3. **漲跌家數分布條**：breadth 既有 `up/down/flat/limit_up/limit_down` 畫成一條橫向 stacked bar（紅左綠右、漲停/跌停深色段、標數字），比現在的純數字表格直觀。
4. **版面重排（12-col grid）＋卡片規格統一**：每張卡統一「標題＋一句話解讀（規則式 caption）＋內容＋資料時間」；產業熱力排行卡縮成 Top 10 橫條並加「開啟熱力圖 →」連 `/heatmap`；資金潮汐入口卡連 `/tide`。
5. **手機單欄順序**：狀態列 → 市場總結 → 指數 → 漲跌分布/寬度 → 法人 → 熱力 Top10 → watchlist。

## 2. 市場溫度與規則式文案（本案核心，要可測）

新增純函式模組 `review-web/src/lib/marketSummary.ts`（**不碰 DOM、不發請求**，輸入既有 API 回傳型別，輸出數字與字串），＋vitest 單元測試：

```ts
export interface MarketSummaryInput {
  breadth: MarketBreadth | null;        // up/down/flat/limit_up/limit_down/total、ma20/ma50 比率
  institutional: MarketInstitutional | null; // 當日三大法人合計買賣超
  regime: MarketRegime | null;          // dashboard 的 water_level (0~1)、regime 標籤
}
export interface MarketSummary {
  temperature: number;        // 0–100，50=中性
  stance: 'bull' | 'neutral' | 'bear';
  headline: string;           // 一句話總結
  signals: { text: string; tone: 'bull' | 'bear' | 'neutral' }[];  // 2–4 條
}
export function buildMarketSummary(input: MarketSummaryInput): MarketSummary;
```

**溫度公式（定案，可微調權重但要寫死在一處）**：
```
breadth_score = up / (up + down)             // 0~1，缺值 0.5
inst_score    = clamp(net_buy_億 / 300, -1, 1) / 2 + 0.5   // ±300億 飽和 → 0~1
level_score   = water_level                   // 已是 0~1，缺值 0.5
temperature   = round((0.4*breadth_score + 0.3*inst_score + 0.3*level_score) * 100)
stance: >=60 bull / <=40 bear / 其餘 neutral
```

**規則式 signals（取符合條件的前 3–4 條，模板寫死）**：
- 上漲家數比 ≥60% →「上漲 X 家（Y%），盤面偏多」（bull）；≤40% 反向（bear）。
- |法人合計| ≥50 億 →「三大法人合計買超/賣超 X 億」。
- 漲停 ≥20 家 →「漲停 X 家，投機情緒熱」；跌停同理。
- `water_level` ≥0.7 →「大盤水位高檔（X%）」；≤0.3 低檔。
- 任一輸入缺失 → 該條不出，**不得**出現 `NaN`/`undefined` 字樣。

**誠實聲明**：卡片底部固定小字「規則式合成，非投資建議」。任一輸入整段缺（如 engine 降級）→ 溫度卡顯示「資料不足」灰態，**不要**用 0.5 假裝中性還配一句多空話。

## 3. 架構鐵律（沿用全案）

- **零後端**：只用既有端點；不加輪詢頻率、不在首頁打貴端點（`/api/stocks/:code`、`/api/agents/decide` 嚴禁）。
- 台股色慣例：多/漲＝紅、空/跌＝綠、中性灰。儀表配色同理（這與西方儀表相反，別照抄國外元件範例）。
- 不動 `web/`；`snake_case`；`tsc -b && vite build` 乾淨；vitest 通過。
- 現有四卡的內部圖表（sparkline、法人趨勢、MA 比率）**不重寫**，只動排版容器與新增模組。

## 4. 版面規格（桌面 ≥1280）

```
┌─ 市場狀態列（h~40px：5 指數 chips ＋ 資料時間 ＋ 重新整理鈕）────────────┐
├─ Row1：市場總結卡（4 col：溫度儀表＋headline＋signals） │ 指數走勢卡（8 col，現有） ─┤
├─ Row2：市場寬度卡（6 col：漲跌分布條＋現有 MA 比率）    │ 三大法人卡（6 col，現有）  ─┤
├─ Row3：產業熱力 Top10（6 col＋「開啟熱力圖→」）        │ 資金潮汐入口卡（6 col）    ─┤
└─ Row4：Watchlist（12 col，現有） ─────────────────────────────────────┘
```
- 768–1280：2 欄；<768：單欄依 §1.5 順序。
- 卡片統一元件化：抽 `components/OverviewCard.tsx`（title、caption、children、footer 時間），四張舊卡換殼**不換餡**。

## 5. 工作清單

- `lib/marketSummary.ts`＋`lib/marketSummary.test.ts`（溫度公式、stance 邊界 60/40、缺值降級、signals 模板）。
- `components/OverviewCard.tsx`（統一卡殼）。
- `pages/Dashboard.tsx`：狀態列、市場總結卡、漲跌分布條、grid 重排、熱力 Top10 縮卡＋連結、潮汐入口卡。
- `components/Layout.tsx`：若 header 與狀態列資訊重複，微調（自行判斷，變動最小化）。
- 文件：零後端 → `contracts.md` 不動；完工後 ROADMAP §8 補紀錄。

## 6. 驗收標準

- [ ] 首屏（1280×800）不捲動即可看到：五指數狀態列、市場溫度＋一句話、漲跌分布條。
- [ ] 溫度儀表/一句話/signals 與 breadth・institutional・water_level 數字互相印證（抽查 2 個交易日）；「規則式非投資建議」小字存在。
- [ ] 任一資料源降級：該模組灰態「資料不足」，其餘模組正常（逐區塊降級，不整頁壞）。
- [ ] 漲跌分布條紅漲綠跌方向正確、漲停/跌停深色段與數字正確。
- [ ] 四張舊卡功能零回歸（sparkline hover、法人趨勢切換、watchlist 增刪照舊）。
- [ ] 三斷點（375/768/1280）不破版；手機順序符合 §1.5。
- [ ] `tsc -b && vite build` 乾淨、vitest（marketSummary）全綠；未動後端、未動 `web/`。

## 7. 坑（帶進 review）

- 🚨 **儀表/文案配色**：紅=多、綠=空。用現成 gauge 範例最容易搞反。
- 🚨 `water_level` 是 **0~1 float**（另有 `water_level_text` 中文），別當百分比整數用（型別分歧已知坑）。
- 法人單位：engine 回傳是「元」等級數字，換算「億」再進公式與文案（除 1e8）。
- `MarketBreadth` 各欄可能缺（冷啟/降級）：`buildMarketSummary` 全路徑防 null，測試要覆蓋。
- 指數 chips 資料重用現有 indices state，別多打一次 `/api/market/indices`。
- 一句話模板避免預測性字眼（「將上漲」禁用；只描述現況「偏多/偏空/中性」）。
- PWA SW 快取：上版後看不到新版面先強制重整（已知坑）。
