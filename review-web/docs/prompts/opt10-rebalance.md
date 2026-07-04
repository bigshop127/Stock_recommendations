# 優化專案 10 — 00631L「正2 + 現金」Beta 再平衡系統

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt10-rebalance.md`，然後根據裡面的說明進行」。
> 參考範本：使用者提供的「正2 + 現金」再平衡計畫兩張截圖（PORTFOLIO BETA 儀表卡＋偏離分析/再平衡建議面板）＋說明文字。Google Sheet／Notion 原文為授權/動態頁，工具無法讀取 → **本規格為 Claude 純從截圖＋說明文字重建**；若與使用者 Sheet 算法有出入，以使用者為準、回頭修規格。
> **相依：無**——本案為使用者個人投組工具，資料全存 localStorage、**零新後端、零新請求、零 LLM**（SymbolSearch 為既有元件，僅選用於帶入股名）。獨立於 opt9（合理價估算），可先做。
> **2026-07-04 定稿**。定案的三個設計岔路（使用者當下未回覆，Claude 依慣例取建議值，回頭可改）：① **多標的·每檔可調 β**（非單一正二固定 2.0）；② **手動填市值＋現金**（非填股數自動抓即時價）；③ **照慣例：Claude 寫規格→使用者寫 code→review**。

## 0. 這套系統在做什麼（背景，務必理解再動手）

「正2 + 現金」策略：用 **60% 正二（Beta≈2.0）＋ 40% 現金（Beta=0）** 配置，使投組 Beta = 0.6×2.0 = **1.2**，等於「把大盤放大 1.2 倍」＝目標跑贏大盤 20%。**不靠盤感擇時，只看投組 Beta 有沒有漂出區間**：

- 市場漲多 → 槓桿部位市值變大 → 投組 Beta 升 → **破上限就賣正二換現金**（高賣）
- 市場跌深 → 槓桿部位市值縮 → 投組 Beta 降 → **破下限就買正二**（低買）

三檔標的（皆可放進本工具、β 自訂）：00631L（元大台灣50正2·量大·操作首選）、00685L（群益臺灣加權正2·費用低·長抱）、QLD（2x 那斯達克·美股分散）。

> 🚨 **誠實前提（要寫進卡片聲明）**：QLD 是 **2x 那斯達克、非台股**，它對台股大盤的真實 β 不等於 2.0；把它當 2.0 是個人啟發式簡化。本工具讓**每檔 β 自己填**，使用者自負模型假設。本工具為**個人資產配置輔助試算，非投資建議**。

## 1. 本案目標

新頁 `/rebalance`「再平衡系統」（比照 `/tide`、`/heatmap` 進側欄 nav），把上面的策略做成一張可操作的試算卡：

1. **PORTFOLIO BETA 半圓儀表（手刻 SVG）**：大字現值 `1.20X`、弧線 0x→1.0x→2.0x、指針＝現投組 β、另一 marker（白圈）＝目標 β。
2. **目標 Beta 滑桿**：0x 全現金 ↔ 1.0x 平衡 ↔ 2.0x 全槓桿，step 0.05，預設 1.2。
3. **配置比例條**：目前 現金% / 槓桿%（＝非現金部位佔比）對比 目標配比（由目標 β 反推，見 §2.4）。
4. **偏離分析 · 再平衡建議面板**：觸發閾值設定（±%，number，預設 10）、上限/下限 Beta band、Beta 偏離量（絕對＋%）、目前狀態 pill、再平衡建議句、**精確達標金額**（槓桿調整 ±$、現金調整 ∓$）。
5. **持倉編輯表**：每列 標的代號／股名／β／目前市值（皆可編輯）＋增刪列；獨立現金欄；合計列。可選「＋」用既有 `<SymbolSearch>` 帶入台股股名。
6. **聲明**：卡底小字「本工具為個人資產配置輔助試算，數值由你手動輸入的市值/現金計算，不抓即時行情；非投資建議。QLD 等非台股標的 β 為你自訂假設。」

**本案不做（backlog）**：自動抓即時報價算市值（TW ETF 可接既有 `/api/stocks/:code` 報價，列 §7 後續增強）；歷史 Beta 回測；多幣別換匯；下單串接。

## 2. 計算模型（本案核心，要可測）

新增純函式模組 `review-web/src/lib/rebalance.ts`（**不碰 DOM、不發請求**）＋vitest：

```ts
export interface RebalancePosition {
  symbol: string;        // '00631L' 等；顯示用自由字串
  name: string;          // 股名（可空）
  beta: number;          // 每檔自訂 β（正二≈2.0、原型股≈1、反向/低波<1、現金另計）
  market_value: number;  // 目前市值（TWD，手動；非現金）
}
export interface RebalanceInput {
  positions: RebalancePosition[];
  cash: number;          // 現金（TWD，β=0）
  target_beta: number;   // 目標投組 β（滑桿）
  threshold_pct: number; // 觸發閾值 %（如 10 = ±10%）
}
export interface WeightRow { symbol: string; beta: number; market_value: number; weight: number; contribution: number; } // contribution = weight×beta
export interface RebalanceResult {
  total_value: number;          // cash + Σ market_value
  invested_value: number;       // Σ market_value（風險部位）
  cash: number;
  portfolio_beta: number | null;// Σ(weight_i × beta_i)；total_value≤0 → null
  sleeve_beta: number | null;   // 風險部位加權 β = Σ(mv_i·β_i)/invested_value；invested_value≤0 → null
  target_beta: number;
  upper_band: number;           // target×(1+thr/100)
  lower_band: number;           // target×(1−thr/100)
  deviation_abs: number | null; // portfolio_beta − target_beta
  deviation_pct: number | null; // (portfolio_beta − target)/target
  status: 'empty' | 'sell' | 'buy' | 'normal';  // empty=無市值
  action_label: string;         // 見 §2.3
  leverage_delta: number | null;// 精確達標：風險部位要 +/−多少（+買 −賣）；不可解→null
  cash_delta: number | null;    // = −leverage_delta
  cash_weight: number | null;   // cash/total_value
  leverage_weight: number | null;// 1 − cash_weight
  target_cash_weight: number | null;   // §2.4
  target_leverage_weight: number | null;
  weights: WeightRow[];
  note?: string;                // 不可解等說明
}
export function computeRebalance(input: RebalanceInput): RebalanceResult;
```

### 2.1 核心公式（定案）

令 `V = cash + Σ mv_i`（總市值）、`R = Σ mv_i`（風險/非現金部位合計）。

```
portfolio_beta β_P = Σ (mv_i / V) × β_i          // 現金貢獻 0；V≤0 → null, status='empty'
sleeve_beta   β_R = Σ (mv_i × β_i) / R           // R≤0 → null
upper_band = target × (1 + thr/100)
lower_band = target × (1 − thr/100)
deviation_abs = β_P − target ; deviation_pct = (β_P − target) / target   // target=0 → deviation_pct=null
status:  β_P > upper_band → 'sell' ; β_P < lower_band → 'buy' ; else 'normal'
```

### 2.2 精確達標金額（定案，對齊截圖的單一「槓桿調整」數字）

保持 `V` 不變，在**現金 ↔ 風險部位（整體按比例縮放，故 β_R 不變）**間搬錢，令 β_P 精確等於 target：

```
目標風險部位市值  R* = target × V / β_R
leverage_delta = R* − R          // + = 買風險部位（現金→槓桿）；− = 賣
cash_delta     = − leverage_delta
不可解護欄：R≤0 或 β_R ≤ 0（無風險部位/純現金/加權β非正）且 target>0
             → leverage_delta = cash_delta = null，note='現有風險部位無法達成此目標 β（請先加入正二部位）'
target 對應配比 §2.4。
```
> 印證截圖：配比 60.1%槓桿/39.9%現金、β_R=2.0 → β_P=1.202、target 1.2 → R*=0.6V、leverage_delta=(0.6−0.601)V=−0.001V；當 V≈$26.25M 時 ≈ **槓桿 −$26,253 / 現金 +$26,253**（賣一點槓桿補現金）。方向與數字皆吻合。

### 2.3 狀態標籤 / 建議句（定案）

```
empty  → 「尚未輸入市值」（面板顯示引導：先在下方持倉表填入市值與現金）
normal → 「✅ 正常範圍（偏離 {|dev_pct|一位小數}%，未超過 ±{thr}%）」
sell   → 「⚠ 已破上限 {upper} → 建議賣出風險部位 ${|leverage_delta|} 換現金」
buy    → 「⚠ 已破下限 {lower} → 建議買進風險部位 ${|leverage_delta|}」
另一行（永遠顯示，即使 normal）：「若要精確達到目標 β {target}：槓桿調整 {±leverage_delta} / 現金調整 {±cash_delta}」
             leverage_delta=null → 改顯示 note。
```

### 2.4 目標配比反推（給配置比例條的「目標」列）

以現有風險部位加權 β_R 為準，目標槓桿佔比 `target_leverage_weight = clamp(target / β_R, 0, 1)`、`target_cash_weight = 1 − 該值`（β_R=null → 兩者 null，條顯示「—」）。目前列＝`leverage_weight / cash_weight`。

## 3. 持倉儲存（localStorage，沿用 userStore 模式）

新增 `review-web/src/lib/rebalanceStore.ts`（比照 `userStore.ts`：版本化 key、get/save、`CustomEvent` + 原生 `storage` 跨分頁同步、try/catch 防壞資料）：

```ts
const KEY = 'review:rebalance:v1';
export interface RebalanceConfig {
  target_beta: number;    // 預設 1.2
  threshold_pct: number;  // 預設 10
  cash: number;           // 預設 0
  positions: RebalancePosition[];
}
export function getRebalanceConfig(): RebalanceConfig;   // 無資料→種子
export function saveRebalanceConfig(cfg: RebalanceConfig): void;  // 存＋dispatch 'userstore:rebalance'
export function subscribeRebalance(cb: () => void): () => void;
```
種子（示範用、市值 0）：`target_beta:1.2, threshold_pct:10, cash:0, positions:[{symbol:'00631L',name:'元大台灣50正2',beta:2.0,market_value:0}]`。使用者可增列 00685L/QLD。**絕不上傳後端**（真實部位屬隱私）。

## 4. 架構鐵律（沿用全案）

- **零後端、零新請求、零 LLM**：`/rebalance` 不打任何 `/api/*`（唯一例外＝使用者主動在持倉表點搜尋時的既有 `/api/symbols/search`，選用）。**嚴禁**自動打 `/api/stocks/:code`、`/api/agents/decide`。
- 台股色慣例：儀表/band——上限（賣、對應漲多）紅、下限（買、對應跌深）綠；正常狀態綠勾。**注意**：狀態 pill 是「偏離狀態」非漲跌方向，用清楚文字＋icon，別讓紅綠誤導。金額調整正負用文字標明（買/賣、+/−）。
- 不動 `web/`、不動 engine/gateway；資料欄位 `snake_case`；`tsc -b && vite build` 乾淨；vitest 通過。
- 全路徑防 NaN/undefined/除以零：市值/現金/β 允許使用者輸入空或 0；任何顯示**不得**出現 `NaN`/`undefined`/`Infinity` 字樣；輸入框做 runtime `Number` 解析＋非負/合理範圍守衛（β 允許 0–3、市值/現金 ≥0）。

## 5. 版面規格

- 位置：新頁 `/rebalance`，`App.tsx` lazy 路由、`Layout.tsx` 側欄 nav（建議 icon `Scale` 或 `SlidersHorizontal`，標題「再平衡系統」）。
- 桌面（≥1024）：左卡＝PORTFOLIO BETA 半圓儀表＋目標 β 滑桿＋配置比例條；右卡＝偏離分析/再平衡建議面板（觸發閾值、上下限、偏離量、狀態 pill、建議句、精確金額）。下方全寬＝持倉編輯表。
- 手機（<768）：單欄：儀表 → 滑桿/配比 → 偏離面板 → 持倉表。
- 半圓儀表手刻 SVG：半圓弧 0→2x、刻度（0/1/2）、資料指針（現 β）＋目標 marker（白圈）、中央大字 `{β}X`；別引圖表套件。
- 配置比例條：兩段式 stacked bar（現金/槓桿），目前一條、目標一條對照。
- 持倉表：可編輯 input（symbol/name/β/market_value）、刪列鈕、加列鈕、現金 input、合計列（總市值/投組 β）。行動端表格橫向可捲。

## 6. 工作清單

- `lib/rebalance.ts`＋`lib/rebalance.test.ts`（§2 全部公式：β_P/β_R、band、status、leverage_delta、目標配比、不可解護欄、空/純現金/多標的混 β、除零；含截圖數字回歸案例）。
- `lib/rebalanceStore.ts`（§3；localStorage、種子、subscribe）。
- `components/`：半圓儀表 SVG、偏離面板、持倉表可各自成元件或併入頁面（自由），只吃 props/store、不 fetch。
- `pages/Rebalance.tsx`：讀 store → `useMemo(computeRebalance)` → 渲染；編輯即存 `saveRebalanceConfig`、`subscribeRebalance` 重繪。
- `App.tsx` lazy 路由 `/rebalance`、`Layout.tsx` nav 項＋header 標題分支。
- 文件：零新端點 → `contracts.md` 不動；完工後 ROADMAP §8 補紀錄。

## 7. 驗收標準

- [ ] **回歸截圖**：輸入「風險部位市值＝60.1%、現金 39.9%、各檔 β=2.0、target 1.2、thr 10」→ β_P≈1.202、狀態 normal、`leverage_delta` 為小負值、`cash_delta` 等額正值（比例吻合截圖 −$26,253/+$26,253 的正負與量級）。
- [ ] 多標的混 β（如 00631L β2.0 + QLD β2.0 + 0056 β0.7）→ β_P＝加權平均正確；改一檔市值後 β_P、band、建議金額即時更新。
- [ ] 觸發邊界：手動調 target 或市值使 β_P 剛好 = upper/lower → status 切換正確（`>`/`<` 邊界語意如 §2.1）；破上限顯「賣」、破下限顯「買」、區間內「正常」。
- [ ] 護欄：純現金（無風險部位）或風險部位 β 合計 ≤0 且 target>0 → `leverage_delta=null`＋顯示 note，不出現 NaN/Infinity；市值全 0 → status='empty' 引導文案。
- [ ] 目標 β 滑桿 0→2 全程、閾值 ±% 調整，儀表指針/marker、上下限、配比條、建議金額全部連動且無破版。
- [ ] localStorage：增/刪/改持倉、改現金/目標/閾值 → 重整頁面保留；跨分頁同步（`subscribeRebalance`）。
- [ ] network：進 `/rebalance` **零 `/api` 請求**（除非使用者主動點搜尋）；三斷點（375/768/1280）不破版；既有頁面零回歸。
- [ ] `tsc -b && vite build` 乾淨、vitest（rebalance）全綠；未動後端、未動 `web/`。

## 8. 坑（帶進 review）

- 🚨 **QLD 是美股·非台股**：engine 無其報價，本案一律手動填市值；β 為使用者自訂假設（對台股大盤嚴格說 ≠2.0），聲明要寫清楚。混不同 benchmark 的「投組 β」是啟發式，別在文案上宣稱它是嚴謹單一大盤 β。
- 🚨 **除以零**：`V=0`（全空）→ β_P null、status='empty'；`R=0` 或 `β_R≤0`→ leverage_delta null＋note；量比式一律先判分母。
- 輸入解析：input 是字串，空字串/`-`/非數字要 `Number.isFinite` 守衛落 0 或維持前值，別讓 `NaN` 傳進公式污染整卡。
- 色彩不誤導：紅=賣（漲多）、綠=買（跌深）合台股慣例，但「正常」也是綠勾——用文字＋icon 消歧，金額正負一律文字標「買/賣」。
- 精確達標假設「風險部位整體按比例縮放（β_R 不變）」，故只給**一個**槓桿調整總額（對齊截圖）；不做「買哪一檔」的分解（那是使用者操作首選 00631L 的事，可在文案提示「以 00631L 執行」）。
- 目標配比反推用**現有** β_R；若使用者一檔都還沒放，配比目標顯「—」而非硬算。
- localStorage 壞資料/舊版：`getRebalanceConfig` try/catch 落種子，欄位逐一型別守衛（比照 `userStore.getFolders`）。
- PWA SW 快取：上版後看不到新頁先照 `deploy.md §4.4` 強制重整（已知坑）。
- 這是**個人試算工具非投資建議**，且不抓即時價——市值需使用者自行更新；聲明明列，避免誤以為是即時監控。
