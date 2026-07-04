# 優化專案 10 — 00631L「正2 + 現金」再平衡計算機（單一標的）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt10-rebalance.md`，然後根據裡面的說明進行」。
> 來源：使用者的 Google Sheet（多標的再平衡計算機，Claude 已用 gviz CSV 匯出讀到並逐格驗算）＋「正二實驗室 #03」崩盤策略回測研究文（11 張截圖）。
> **2026-07-04 重寫定案**：使用者明示「**只買 00631L**」→ 本案從多標的塌縮為 **單一標的（00631L＋現金）**。不做 00685L/QLD、不做匯率、不做「每資產目標權重」。**範疇順序＝計算機（本案 opt10）優先、崩盤回測實驗室（opt11）隨後**（使用者 2026-07-04 定）。
> **相依：無**——個人投組工具，資料全存 localStorage、**零新後端、零新請求、零 LLM**。
>
> **2026-07-04 增修 A（opt10 已上線後）**：使用者要「目標 β 1.3、±0.1（1.2~1.4）」。現行容忍區間是**百分比**口徑（±10% 套 1.3＝[1.17,1.43]，非 [1.2,1.4]）。**新增「容忍模式切換：百分比 %／絕對 β」**（使用者選定，預設**絕對 ±β**、預設 0.1）。以下 §2 interface／§2.1 band／§2.3 文案／§3 store／§5 UI／§7 §8 皆已標注增修點；這是在既有 opt10 code 上的增量修改（非重寫）。

<!-- 增修 A：容忍模式切換 pct/abs 的所有改動點，於各節就地標注 -->

> **2026-07-04 增修 B（Claude 直接實作完成）**：使用者要求持倉面板加三項——①**平均成本**輸入（可手動改）→ 顯示未實現損益（金額＋%，台股慣例獲利紅、虧損綠；純顯示、**不影響再平衡計算**）；②**自動抓取 00631L 最新價**（「抓最新價」按鈕＋首次載入若無現價自動抓一次；讀既有 `GET /api/stocks/00631L/ohlcv`＝**未還原原始收盤價**，取最新交易日 close，可手動覆寫；顯示帶入日期）；③**應買進/賣出多少錢**顯眼呈現（既有 `etf_value_delta` 精確達標數字本已計算，但無現價時全為 $0；②補上現價後即生效，並在建議面板加大字行動數字「應買進/賣出 $X（約 Y 股）」）。**架構破例（誠實記軌）**：本頁原「零 `/api` 請求」，增修 B 為了自動抓價**新增一支既有 ohlcv 端點的讀取**（單次、可失敗降級為手動輸入）；`contracts.md` 不動（沿用既有端點）；持倉資料仍僅存 localStorage 不上傳。實作：`RebalanceInput.avg_cost?`＋`RebalanceResult.{cost_basis,unrealized_pnl,unrealized_pnl_pct}`（有股數且成本>0 才算，否則 null）；`RebalanceConfig.avg_cost`（預設 0，逐欄守衛相容舊 localStorage、不改 KEY）；`Rebalance.tsx` 加 avg_cost 輸入、`fetchLatestPrice()`＋首載自動抓、未實現損益 tile、顯眼行動數字、聲明改寫。vitest 48/48（新增 4 案 P&L）、tsc/build 乾淨。**VM 實機驗收（2026-07-04 commit `1edb5c7` 通過）**：三功能全對帳（自動帶入 2026-07-03 收盤價 38.8；成本 35.37×19000→損益 +$65,170/+9.7%；閒置現金 100 萬→應買進 $391,980/約 10,103 股、成交後 β 回 1.30X）。


## 0. 這套系統在做什麼（背景）

「正2 + 現金」策略：用 **X% 00631L（Beta≈2.0）＋(100−X)% 現金（Beta=0）** 配置，使投組 Beta = (X%)×2 落在目標。目標 Beta 1.2 ＝ 60% 00631L／40% 現金 ＝「放大大盤 1.2 倍」。**不擇時，只看投組 Beta 有沒有漂出容忍區間**：漲多→β 升→破上限賣 00631L 換現金（高賣）；跌深→β 降→破下限買 00631L（低買）。單一標的下，投組 Beta 與 00631L 佔比是 1:1（β = 佔比 × 2），目標 Beta 一設，正二/現金配比就定了。

> 崩盤策略回測（研究文那套：0050 從高點跌 −28% 全數加碼、創新高回目標 Beta、Beta 1.0~1.8 全面回測）＝**另一案 opt11**，歷史回測層次、工程量大，本案不含（見 §9）。

## 1. 本案目標

新頁 `/rebalance`「再平衡計算機」（進側欄 nav，比照 `/tide`、`/heatmap`），把 00631L＋現金的再平衡做成一眼可操作的試算：

1. **PORTFOLIO BETA 半圓儀表（手刻 SVG）**：大字現值 `1.20X`、弧 0x→1.0x→2.0x、指針＝現投組 β、白圈 marker＝目標 β。
2. **目標 Beta 滑桿**：0x 全現金 ↔ 1.0x 平衡 ↔ 2.0x 全槓桿，step 0.05，預設 1.3【增修A】；旁顯示「＝ 00631L {X}% / 現金 {100−X}%」。
3. **配置比例條**：目前 00631L%/現金% 對比 目標配比（由目標 β 反推）。
4. **偏離分析 · 再平衡建議面板**：容忍區間設定【增修A：模式切換「±β／±%」＋數值輸入，預設 ±β 0.1】、上限/下限 Beta、Beta 偏離量（絕對＋%）、目前狀態 pill、再平衡建議句、**精確達標**：要買/賣 00631L 多少元、**幾股**、換多少現金。
5. **持倉輸入**：00631L 股數、00631L 現價、現金（TWD）三格；顯示 00631L 市值＝股數×現價、總資產＝市值＋現金。**現價手動輸入**（不抓即時價，對齊 Sheet 作法；QLD/美股問題不存在，因只有 00631L）。
6. **聲明**：卡底小字「本工具為個人資產配置輔助試算，00631L 現價由你手動輸入、不抓即時行情；投組 Beta 以 00631L β=2.0、現金 β=0 計算；非投資建議。」

**本案不做（backlog）**：多標的（00685L/QLD）、匯率、崩盤加碼狀態（opt11 回測範疇）、自動抓即時報價（列 §9 後續增強）。

## 2. 計算模型（本案核心，要可測）

新增純函式模組 `review-web/src/lib/rebalance.ts`（**不碰 DOM、不發請求**）＋vitest：

```ts
export interface RebalanceInput {
  shares: number;        // 00631L 持有股數（≥0）
  price: number;         // 00631L 現價 TWD（手動，>0 才能算交易股數）
  cash: number;          // 現金 TWD（≥0）
  target_beta: number;   // 目標投組 β（滑桿，預設 1.3）
  tolerance_mode: 'pct' | 'abs';  // 【增修A】容忍口徑，預設 'abs'
  threshold_pct: number; // 容忍區間 %（pct 模式用；預設 10 = ±10%）
  threshold_abs: number; // 【增修A】容忍區間 絕對 β（abs 模式用；預設 0.1 = ±0.1）
  etf_beta: number;      // 00631L 標的 β（預設 2.0；進階可調）
}
export interface RebalanceResult {
  etf_value: number;            // shares × price
  total_value: number;          // etf_value + cash
  etf_weight: number | null;    // etf_value / total_value；total≤0 → null
  cash_weight: number | null;
  current_beta: number | null;  // etf_weight × etf_beta；total≤0 → null
  target_beta: number;
  target_etf_weight: number | null;   // clamp(target_beta / etf_beta, 0, 1)；etf_beta≤0 → null
  target_cash_weight: number | null;
  upper_band: number;           // 【增修A】依 tolerance_mode，見 §2.1
  lower_band: number;           // 【增修A】abs 模式下限 clamp ≥ 0
  deviation_abs: number | null; // current_beta − target_beta
  deviation_pct: number | null; // (current_beta − target)/target；target=0 → null
  status: 'empty' | 'sell' | 'buy' | 'normal';
  action_label: string;         // §2.3
  // 精確達標（保持總資產不變，在 00631L↔現金 間搬錢使 β=target）
  target_etf_value: number | null;
  etf_value_delta: number | null; // target_etf_value − etf_value（+買 −賣）；不可解→null
  cash_delta: number | null;      // = −etf_value_delta
  trade_shares: number | null;    // round(etf_value_delta / price)；price≤0→null
  // 依整股成交後的實況
  post_shares: number | null; post_etf_value: number | null; post_cash: number | null;
  post_etf_weight: number | null; post_cash_weight: number | null; post_beta: number | null;
  note?: string;
}
export function computeRebalance(input: RebalanceInput): RebalanceResult;
```

### 2.1 核心公式（定案）

```
etf_value = shares × price ; total = etf_value + cash
etf_weight = etf_value / total          // total≤0 → 全部 null, status='empty'
current_beta = etf_weight × etf_beta
【增修A】容忍區間依 tolerance_mode：
  abs 模式：upper_band = target + threshold_abs ; lower_band = max(target − threshold_abs, 0)
  pct 模式：upper_band = target × (1 + threshold_pct/100) ; lower_band = max(target × (1 − threshold_pct/100), 0)
deviation_abs = current_beta − target ; deviation_pct = (current_beta − target)/target  // target=0→null
status: current_beta > upper_band → 'sell' ; current_beta < lower_band → 'buy' ; else 'normal'
  （示例：target 1.3、abs 0.1 → band [1.2, 1.4]；target 1.2、pct 10 → band [1.08, 1.32]）
```

### 2.2 精確達標（定案，對齊 Sheet 的「需交易金額／交易股數」）

保持總資產 `total` 不變，在 00631L 與現金間搬錢，令 β=target：

```
target_etf_weight = clamp(target / etf_beta, 0, 1)     // etf_beta≤0 或 target<0 → null
target_etf_value  = target_etf_weight × total
etf_value_delta   = target_etf_value − etf_value        // + = 買 00631L；− = 賣
cash_delta        = − etf_value_delta
trade_shares      = round(etf_value_delta / price)       // price≤0 → null（無法換算股數）
整股成交後：
  post_shares    = shares + trade_shares
  post_etf_value = post_shares × price
  post_cash      = cash − trade_shares × price           // 買扣現金、賣加現金
  post_* weight/beta 依 post 值重算（整股殘差 → 佔比會略偏目標，如 Sheet 的 20.00%→19.97% 現象）
不可解護欄：total≤0 → status='empty'、金額/股數全 null、note='尚未輸入持倉'；
           price≤0 → 金額可算但 trade_shares=null、note='填入現價才能換算交易股數'。
```
> 印證：etf_value 600,000＋cash 400,000＝total 1,000,000、weight 60%、β=1.2；target 1.2 → delta 0、normal。若漲到 etf 700,000＋cash 400,000（total 1.1M、β≈1.273 仍在 [1.08,1.32] 內）→ 精確達標 target_etf=660,000、delta=−40,000（賣）、trade_shares=−40000/price。

### 2.3 狀態標籤 / 建議句（定案）

```
empty  → 「尚未輸入持倉」（引導：填入 00631L 股數/現價與現金）
【增修A】normal 文案依 tolerance_mode：
  abs → 「✅ 正常範圍（偏離 {|deviation_abs|兩位小數} β，未超過 ±{threshold_abs} β）」
  pct → 「✅ 正常範圍（偏離 {|dev_pct|一位小數}%，未超過 ±{threshold_pct}%）」
sell   → 「⚠ 已破上限 {upper} → 建議賣出 00631L 約 ${|etf_value_delta|}（約 {|trade_shares|} 股）換現金」
buy    → 「⚠ 已破下限 {lower} → 建議買進 00631L 約 ${|etf_value_delta|}（約 {|trade_shares|} 股）」
另一行（永遠顯示，含 normal）：「若要精確回到目標 β {target}：00631L 調整 {±etf_value_delta}（{±trade_shares} 股）/ 現金 {±cash_delta}」
             不可解 → 改顯示 note。
```

### 2.4 目標配比反推（配置比例條「目標」列）

`target_etf_weight = clamp(target/etf_beta,0,1)`、`target_cash_weight = 1 − 該值`。目前列＝`etf_weight/cash_weight`（total≤0 → 顯「—」）。

## 3. 持倉儲存（localStorage，沿用 userStore 模式）

新增 `review-web/src/lib/rebalanceStore.ts`（比照 `userStore.ts`：版本化 key、get/save、`CustomEvent`+原生 `storage` 跨分頁同步、try/catch 防壞資料，欄位逐一型別守衛）：

```ts
const KEY = 'review:rebalance:v1';
export interface RebalanceConfig {
  shares: number; price: number; cash: number;
  target_beta: number;         // 1.3
  tolerance_mode: 'pct'|'abs'; // 【增修A】'abs'
  threshold_pct: number;       // 10
  threshold_abs: number;       // 【增修A】0.1
  etf_beta: number;            // 2.0
}
export function getRebalanceConfig(): RebalanceConfig;   // 無資料→種子
export function saveRebalanceConfig(cfg: RebalanceConfig): void;  // 存＋dispatch 'userstore:rebalance'
export function subscribeRebalance(cb: () => void): () => void;
```
種子：`shares:0, price:0, cash:0, target_beta:1.3, tolerance_mode:'abs', threshold_pct:10, threshold_abs:0.1, etf_beta:2.0`。**絕不上傳後端**（真實部位屬隱私）。
> 🚨【增修A・遷移】既有 `review:rebalance:v1` 舊資料**沒有** `tolerance_mode`／`threshold_abs` 欄位 → `getRebalanceConfig` 的逐欄守衛要對這兩欄補預設（`tolerance_mode` 非 `'pct'|'abs'` → `'abs'`；`threshold_abs` 非有限數或 <0 → `0.1`），**不改 KEY 版本號**（欄位補齊即相容）。

## 4. 架構鐵律（沿用全案）

- **零後端、零新請求、零 LLM**：`/rebalance` 不打任何 `/api/*`。**嚴禁**自動打 `/api/stocks/:code`、`/api/agents/decide`。
- 台股色慣例：上限（賣、對應漲多）紅、下限（買、對應跌深）綠；「正常」綠勾。**狀態 pill 是偏離狀態非漲跌方向**，用文字＋icon 消歧；金額正負一律文字標「買/賣、+/−」。
- 不動 `web/`、不動 engine/gateway；資料欄位 `snake_case`；`tsc -b && vite build` 乾淨；vitest 通過。
- 全路徑防 NaN/undefined/Infinity/除以零：input 是字串，`Number.isFinite` 守衛（β 允許 0–3、股數/現價/現金 ≥0）；任何顯示不得出現 `NaN`/`undefined`/`Infinity` 字樣。

## 5. 版面規格

- 位置：新頁 `/rebalance`，`App.tsx` lazy 路由、`Layout.tsx` 側欄 nav（icon 建議 `Scale`／`SlidersHorizontal`，標題「再平衡計算機」）。
- 桌面（≥1024）：左卡＝半圓 Beta 儀表＋目標 β 滑桿＋配置比例條；右卡＝偏離/再平衡建議面板；下方＝持倉輸入（股數/現價/現金）＋市值合計。
- 手機（<768）：單欄：儀表 → 滑桿/配比 → 偏離面板 → 持倉輸入。
- 半圓儀表手刻 SVG：半圓弧 0→2x、刻度 0/1/2、指針（現 β）＋目標 marker（白圈）、中央大字 `{β}X`；別引圖表套件。
- 配置比例條：stacked bar（00631L/現金），目前一條、目標一條對照。
- 持倉輸入：三個 number input（股數/現價/現金）即時試算；顯示 00631L 市值與總資產。
- 【增修A】容忍區間控制：一個小型二選一切換（`±β` / `±%`）＋一個數值輸入；`±β` 模式輸入 β 單位（step 0.05，如 0.1），`±%` 模式輸入 % 單位（step 1，如 10）；切換時沿用各自欄位值（`threshold_abs` / `threshold_pct`），上下限 band 與狀態即時重算。

## 6. 工作清單

- `lib/rebalance.ts`＋`lib/rebalance.test.ts`（§2 全公式：β、band、status、精確達標、整股殘差、目標配比、護欄與除零；含 60/40 clean 案例、漲多觸發賣、跌深觸發買、price=0、total=0、target=0/2 邊界）。
- `lib/rebalanceStore.ts`（§3；localStorage、種子、subscribe、型別守衛）。
- `components/`：半圓儀表、偏離面板、持倉輸入可各自成元件或併入頁面，只吃 props/store、不 fetch。
- `pages/Rebalance.tsx`：讀 store → `useMemo(computeRebalance)` → 渲染；編輯即存＋`subscribeRebalance` 重繪。
- `App.tsx` lazy 路由 `/rebalance`、`Layout.tsx` nav 項＋header 標題分支。
- 文件：零新端點 → `contracts.md` 不動；完工後 ROADMAP §8 補紀錄。

## 7. 驗收標準

- [ ] **clean 回歸**：股數×現價=600,000、現金 400,000、target 1.2、thr 10 → β=1.2、status normal、etf_value_delta=0。
- [ ] **觸發**：把現金/股數調到 β>1.32 → status 'sell'、建議賣、etf_value_delta<0、trade_shares<0；調到 β<1.08 → 'buy'、建議買、正值。
- [ ] **精確達標＋整股**：任一情境 delta＝target_etf_value−etf_value、trade_shares＝round(delta/price)、post 佔比因整股略偏目標（如 20.00%→19.9x%）不報錯。
- [ ] 目標 β 滑桿 0→2 全程、閾值調整 → 儀表指針/marker、上下限、配比條、建議金額/股數全連動，無破版。
- [ ] 【增修A】**絕對 β 模式**：target 1.3、±β 0.1 → 上限 1.4、下限 1.2（非 [1.17,1.43]）；normal 文案顯「偏離 X β，未超過 ±0.1 β」。切到 **± % 模式**：target 1.2、±10% → [1.08,1.32]、文案回百分比口徑。切換兩模式各自數值互不覆蓋。
- [ ] 【增修A】**遷移**：手動塞一筆舊 `review:rebalance:v1`（無 `tolerance_mode`/`threshold_abs`）→ 讀取後補預設 `abs`/`0.1`、不報錯、不出現 NaN。
- [ ] 【增修A】abs 下限 clamp：target 0.05、±β 0.1 → 下限 0（不為負）。
- [ ] 護欄：total=0 → 'empty' 引導；price=0 → 金額可算但 trade_shares=null＋note；全程無 NaN/Infinity。
- [ ] localStorage：改股數/現價/現金/目標/閾值 → 重整保留；跨分頁同步。
- [ ] network：進 `/rebalance` **零 `/api` 請求**；三斷點（375/768/1280）不破版；既有頁面零回歸。
- [ ] `tsc -b && vite build` 乾淨、vitest（rebalance）全綠；未動後端、未動 `web/`。

## 8. 坑（帶進 review）

- 🚨 **除以零/空輸入**：`total=0` → β null＋status 'empty'；`price=0` → trade_shares null（不可 `x/0=Infinity`）；input 空字串/`-`/非數字 → `Number.isFinite` 落 0 或維持前值，別讓 NaN 污染整卡。
- 單一標的下「目標 Beta」與「00631L 佔比」是 1:1（β=佔比×etf_beta），UI 兩者連動顯示即可，別各存一份造成不同步。
- 色彩不誤導：紅=賣（漲多）、綠=買（跌深）合台股慣例，但「正常」也是綠勾 → 文字＋icon 消歧，金額正負文字標「買/賣」。
- `etf_beta` 預設 2.0（元大台灣50正2 為 2x 台灣50 日報酬）；設為進階可調但一般不動；聲明寫明 β 假設。
- 整股成交後現金要用 `cash − trade_shares×price`（賣為負股數→加現金），別直接套 cash_delta（那是未整股的理論值）。
- localStorage 壞資料/舊版：`getRebalanceConfig` try/catch 落種子、欄位逐一守衛（比照 `userStore.getFolders`）。
- 現價需手動更新（不抓即時價）→ 聲明明列，避免誤以為即時監控。
- 🚨【增修A】**abs 模式下限可能為負**（target 0.05、abs 0.1 → −0.05）→ 一律 `max(lower, 0)` clamp；band 顯示與 status 判定都用 clamp 後值。
- 🚨【增修A】**舊 localStorage 遷移**：不改 KEY 版本、靠逐欄守衛補 `tolerance_mode`/`threshold_abs` 預設；別讓缺欄位變 `undefined` 流進公式成 NaN。
- 【增修A】deviation 顯示口徑隨模式：abs 顯「β 偏離量」、pct 顯「% 偏離」；別在 abs 模式硬塞百分比讓使用者困惑。
- PWA SW 快取：上版後看不到新頁先照 `deploy.md §4.4` 強制重整（已知坑）。

## 9. 後續（opt11 崩盤策略回測實驗室，本案不做，先記軌）

研究文「正二實驗室 #03」的回測系統：用 00631L＋0050 的 2020–2026 歷史（**既有 `/api/stocks/:code/ohlcv?adjust=1` 可抓還原價**，需先驗證涵蓋 2020 起），前端純函式 `lib/crashBacktest.ts` 跑：多組目標 Beta（1.0/1.2/1.4/1.6/1.8）＋基準（全倉 0050、全倉正二、初始配置不再平衡）；崩盤對策狀態機（0050 自高點跌 −28% → 第1階把現金加碼進 00631L 拉到滿槓桿、−50% 第2階、創新高 → 再平衡回目標 Beta）；輸出期末資產／總報酬／最大回撤／評價表＋權益曲線＋Beta 曲線＋交易紀錄（lightweight-charts）。**零後端可行**（同 indicators 前端自算）但工程量大。opt10 完工後定稿 `opt11-crash-backtest.md`。
