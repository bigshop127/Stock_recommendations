# 優化專案 20 — 崩盤三層市場狀態燈號（TAIEX 訊號，承接 opt11／opt19／增修K）

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt20-crash-tiered-status.md`，然後根據裡面的說明進行」。
> 範圍：`lib/rebalance.ts`＋`lib/rebalanceStore.ts`＋`pages/Rebalance.tsx`（Part A：即時市場狀態）／`lib/crashBacktest.ts`＋`pages/CrashBacktest.tsx`（Part B：三層回測驗證）。**不動** `routes/rebalance.js`、`scripts/rebalance_alert.cjs`、engine 後端。

---

## 0. 背景與決策依據（已回測完成，不用重跑，直接照這裡的結論實作）

使用者現行崩盤應對設計（增修K）＝股災時優先變現 00687B（美債）加碼 00631L 拉滿槓桿。2026-07-10～07-11 兩天用真實歷史資料（00631L 2014+、00687B 2017+，之前年份用「TAIEX 每日報酬×2倍複利」合成槓桿指數＋VUSTX×匯率還原代理補到 2000 年）做了完整回測鏈，**已拍板定案**：

**三層市場狀態燈號**（訊號改用 TAIEX 加權指數自身回撤，取代原本的 0050）：

| 層級 | TAIEX 自高點回撤 | 燈號 | 操作 |
|---|---|---|---|
| 第一警戒 | ≥10% | 黃 | 純提醒，**不做任何機械動作** |
| 小股災 | ≥15% | 淡紅 | 加碼 00631L 到中繼目標 β |
| 股災來臨 | ≥20% | 深紅 | 全力出清防守端拉滿槓桿（原有清單） |

**中繼 β 拍板 1.7~1.8**（本規格預設值取中點 **1.75**，UI 開放調整）：回測 20 次歷史 −15% 事件（1999~2025，排除 2000 年一次因合成槓桿 17 年失真的極端值），85% 情況只是虛驚一場（加碼越多賺越多）、15% 真的惡化成全面股災（加碼越少越好），加總後 β 越高越好但差距不到 20%；選 1.7~1.8 是為了讓「小股災」跟「股災來臨」兩層真的有操作區隔，不是為了追求理論最優（β=2.0 兩層會變成同一件事）。

**股災來臨（−20%）的原有操作清單經兩次精細化實測，結論是維持原設計、不要拆更細**（4 次真實升級股災事件：1999-08／2020-03／2022-06／2025-04）：
- 「分批進場」（先到 β1.85、續跌到 −25%/−28%/−30% 才補滿 β2.0）比「一次到位衝滿 β2.0」平均差 −0.13%~−2.26%，且不穩定（只在緩跌型股災有利、V 型急跌急彈時反而變差，但當下無法預知是哪一種）。**不要實作分批進場。**
- 「提前減碼鎖利」（回到 −15%/−10%/−5% 就先降回目標 β，不等創新高）比「等 TAIEX 創新高才出場」四次事件無一例外全部變差（−11.4%~−3.6%），因為 2 倍槓桿部位在「創新高前最後一段」複利效果最強，提前下車＝主動放棄報酬最肥的一段。**不要實作提前出場／trailing stop。**

完整數據與圖表：Artifact 報告（本次對話已產出，內含全部回測表格與方法論警示，若需要可請使用者提供連結）。**本規格只需要把上面這些已驗證的結論做成可用的軟體功能，不需要重新回測。**

---

## 1. 整體設計：分兩個各自獨立的部分

- **Part A（`/rebalance` 即時計算機）**：加一個「市場狀態」面板，抓 TAIEX 歷史收盤、算出目前自高點回撤幾%、判斷落在哪一層，顯示對應燈號＋一鍵套用建議 β 的按鈕。**這部分完全不需要新的再平衡數學**——中繼 β／滿倉 β 都只是把既有的 `target_beta` 滑桿設成不同數值，`computeRebalance` 本體零改動。
- **Part B（`/backtest` 崩盤實驗室）**：比照增修J 加 `mode='ladder'` 的先例，新增 `mode='tiered'`，把上面驗證過的三層邏輯做成可回測、可視覺化驗證的模式，方便未來訊號/門檻有調整時能重新拉歷史資料驗證，不用再手動寫 Python 腳本。

兩部分互相獨立、可以分開實作分開驗收；共用的只有「TAIEX 是新的訊號來源」這個概念，沒有共用 code。

---

## 2. 資料層：TAIEX 歷史收盤

**實作前務必先驗證**（沿用本站一貫教訓：換資料源即使 200 也要檢查數值合理性，見增修K／opt17 的坑）：

```bash
curl -s 'http://localhost:3000/api/stocks/TAIEX/ohlcv?start=2020-01-01' | head -c 500
```

`GET /api/stocks/:code/ohlcv` 透傳到 engine `/data/ohlcv?code=TAIEX`，該端點走 FinMind `TaiwanStockPrice` dataset（`data_id=TAIEX`）。FinMind 這個 dataset 本來就有 `TAIEX`（加權指數）與 `TPEx`（櫃買指數）這兩個特殊 data_id，理論上可直接用，但**務必實測回傳的 `close` 數列是否為合理的加權指數點數（萬點量級），不是空值或某支個股的誤植**（比照 opt17 修過的 TWSE MIS 假陽性 bug 心態）。若 `TAIEX` 這個 code 行不通，退路是改抓 `/data/market`（yfinance `^TWII`）看是否能給歷史序列，或直接請使用者確認 FinMind 帳號在這個 data_id 上的存取層級。這一步驗證結果請在 PR/commit 訊息附上（哪個 code 真的有效）。

兩個頁面（`Rebalance.tsx`／`CrashBacktest.tsx`）各自呼叫 `api.ohlcv('TAIEX', {start: ...})`，不需要新的共用 helper，也不需要新後端端點。

---

## 3. Part A — `/rebalance` 市場狀態面板

### 3.1 純函式（`lib/rebalance.ts` 新增）

```ts
export interface MarketStatusInput {
  closes: { date: string; close: number }[]; // 升冪排序；建議至少抓 3~5 年歷史以取得有意義的高點
  tier1_dd: number; // 第一警戒門檻，預設 0.10
  tier2_dd: number; // 小股災門檻，預設 0.15
  tier3_dd: number; // 股災來臨門檻，預設 0.20
}

export interface MarketStatus {
  latest_date: string;
  latest_close: number;
  peak_date: string;   // 提供序列中最高收盤發生的日期
  peak_close: number;
  drawdown: number;    // (peak_close − latest_close) / peak_close，恆 ≥ 0
  tier: 0 | 1 | 2 | 3;  // 0=正常 1=第一警戒 2=小股災 3=股災來臨
  tier_label: '正常' | '第一警戒' | '小股災' | '股災來臨';
}

export function computeMarketStatus(input: MarketStatusInput): MarketStatus | null
```

邏輯：

1. `closes` 為空或全部非正數 → 回傳 `null`。
2. `peak_close` = 整段序列（不是只看到目前為止）的最大 `close`；`peak_date` = 該筆日期。**這不是「歷史全時期最高點」，是呼叫端提供的視窗裡的最高點**——視窗夠長（3~5 年）通常就是實際上最近一次全時期新高，這點在函式註解講清楚即可，不用另外處理「更早以前的紀錄」。
3. `latest_close` / `latest_date` = 序列最後一筆（假設呼叫端已依日期升冪排序；此函式不重新排序，防禦性地找 `closes` 陣列最後一筆即可，不用另外用日期比大小，因為呼叫端 `ohlcv` 回傳本來就是升冪）。
4. `drawdown = Math.max(0, (peak_close − latest_close) / peak_close)`。
5. `tier`：`drawdown >= tier3_dd → 3`；否則 `drawdown >= tier2_dd → 2`；否則 `drawdown >= tier1_dd → 1`；否則 `0`。（門檻用 `>=`，邊界值算已達標，比照本站 opt11/增修J 既有慣例。）
6. 全路徑防 NaN（`tier1_dd/tier2_dd/tier3_dd` 用既有 `safeNum` 守衛並 `clamp(0,1)`）。

### 3.2 `RebalanceConfig` 新欄位（`lib/rebalanceStore.ts`）

```ts
tier1_dd: number; // 預設 0.10
tier2_dd: number; // 預設 0.15
tier3_dd: number; // 預設 0.20
beta_mid: number; // 小股災中繼目標 β，預設 1.75
```

`SEED_CONFIG` 補上對應預設值；`normalizeConfig` 比照既有數值欄位（`threshold_abs` 那幾行的寫法）用 `safeNumber` 守衛＋`clamp(0,1)`（三個 `_dd` 欄位）／`Math.max(0.1, ...)`（`beta_mid`，避免 0 或負值），**KEY 仍是 `review:rebalance:v1`，不要改版本號**（缺欄位補預設值即可，非破壞性遷移，比照 opt19 §5.1 的做法）。

### 3.3 UI（`pages/Rebalance.tsx`）

**新增一個 hook**（元件內，`useEffect` 掛載時抓一次，不用輪詢）：抓 `api.ohlcv('TAIEX', {start: 三年前日期})` → 轉成 `{date, close}[]` → `computeMarketStatus({closes, tier1_dd: config.tier1_dd, tier2_dd: config.tier2_dd, tier3_dd: config.tier3_dd})` → `useState<MarketStatus|null>`。抓取失敗（502/例外）比照既有自動抓價的降級慣例：不擋頁面渲染，面板顯示「市場狀態暫時無法取得」灰態，其餘功能不受影響。

**面板放置位置**：標題區塊（約行 552-563）與主要雙欄 grid（約行 565）之間，插入一個橫跨全寬的「市場狀態」卡片（沿用左卡 `bg-card border border-border rounded-xl` 的樣式慣例）：

- 燈號徽章（三色沿用報告已用過的色票：第一警戒 `background:#fab21933` 黃底深字；小股災 `background:#e3494822` 淡紅底、紅字；股災來臨純紅底白字）＋文字「TAIEX 自 {peak_date} 高點 {peak_close} 回撤 {drawdown*100}%」。
- `tier===0`：無額外操作提示。
- `tier===1`：一行提醒文字「已達第一警戒，純觀察，不需操作」。
- `tier===2`：提醒文字＋按鈕「套用中繼 β {config.beta_mid.toFixed(2)}」，`onClick` 呼叫既有 `updateConfig({ target_beta: config.beta_mid })`（跟現有 `target_beta` 滑桿共用同一個 state，不需要新的計算路徑）。
- `tier===3`：提醒文字＋按鈕「套用股災滿倉 β {config.etf_beta.toFixed(2)}」，`onClick` 呼叫 `updateConfig({ target_beta: config.etf_beta })`；下方加一個 `.rule-list` 風格（或沿用既有 `lock_note` 的 amber 提示框樣式，見行 901-910）的**靜態提醒清單**，文字取自增修K已實作的原設計，**不是新邏輯、純提醒**：
  1. 防守端立即全數轉進 00631L（已按上方按鈕套用滿倉 β 即完成）
  2. 交易順序沿用增修K美債優先變現 waterfall（自動）
  3. 尊重 opt19 資產鎖定設定（若有鎖定，`lock_note` 會照常顯示）
  4. 需要的話可用「現金注入模式」補足（`cash_injection_needed` 照常顯示）
  5. 停止手動再平衡，抱到 TAIEX 創新高再回到平常的目標 β
  6. 創新高後依 `bond_split` 重建防守端（把 `target_beta` 滑桿改回平常數值即可觸發）

**進階設定區塊**（約行 583-621，`showAdvanced` 展開區）新增三層門檻與中繼 β 的數字輸入（沿用 `etf_beta` 那組 `input type="number"` 的樣式），非必要不用做成滑桿。

---

## 4. Part B — `/backtest` 崩盤實驗室：`mode='tiered'`

比照增修J 加 `mode='ladder'` 的方式，新增第三種模式，**不改動 `mode==='oneshot'` 與 `mode==='ladder'` 既有分支的任何一行**（回歸測試見 §5）。

### 4.1 `BacktestParams` 擴充（`lib/crashBacktest.ts`）

```ts
mode: 'oneshot' | 'ladder' | 'tiered';
tier2_dd: number; // 小股災門檻（僅 mode='tiered' 使用；預設 0.15）
beta_mid: number; // 小股災中繼目標 β（僅 mode='tiered' 使用；預設 1.75）
```

`crash_dd`（既有欄位，預設 0.28）在 `mode='tiered'` 時**繼續代表股災來臨／tier3 門檻**，語意不變，只是頁面在 tiered 模式下把它的 label 換成「股災確認（tier3）」並把該模式的**頁面層級預設值**改成 0.20（不是改引擎的 fallback 常數——引擎 `safeNum(rawParams?.crash_dd, 0.28)` 那行不要動，0.28 這個 fallback 只有在 `crash_dd` 完全未傳時才生效；tiered 模式的 0.20 預設是頁面 `review:backtest:v1` 的 localStorage 初始值管的，兩者職責分離，不要把 mode 判斷塞進純函式的預設值邏輯）。`beta_mid` clamp 到 `[0, etf_beta]`（沿用 `target_beta` 的 clamp 慣例），頁面 UI 可再自行限制滑桿範圍在 `target_beta ~ etf_beta` 之間給使用者引導，但**引擎本身不需要強制 `target_beta < beta_mid < etf_beta`**（防禦性寫法，不是本案重點）。

### 4.2 `Trade`／`CrashEvent` 型別擴充

```ts
export interface Trade {
  date: string;
  type: 'rebalance' | 'crash_enter' | 'crash_exit' | 'ladder_buy' | 'tier2_enter' | 'tier2_exit';
  from_beta: number;
  to_beta: number;
  traded_value: number;
  cost: number;
}

export interface CrashEvent {
  enter: string;
  exit: string | null;
  max_dd: number;
  tier3_date?: string | null; // 僅 mode='tiered'：從 tier2 惡化為 tier3 的日期；未惡化則為 null；oneshot/ladder 恆為 undefined
}
```

### 4.3 狀態機邏輯（插入位置比照 §4 現有 `if (mode === 'ladder' ...)` `else if (mode === 'oneshot' ...)` 那串 if/else 鏈，新增 `mode === 'tiered'` 的分支，不要重寫既有分支）

新增一個狀態變數 `let inTier2 = false;`（與既有 `inCrash`／`curCrash` 並列）。邏輯順序（依優先權由上到下）：

1. **`mode==='tiered' && !inCrash && dd >= crash_dd`**（不論是否經過 tier2，直接跳空重挫也會命中）：全力衝滿槓桿，比照既有 `crash_enter` 的交易邏輯（`desiredValue = 1.0*total`）；`trades.push({...type:'crash_enter'})`；`inCrash=true; inTier2=false`；若 `curCrash` 已存在（代表是從 tier2 惡化上來）→ `curCrash.tier3_date = bar.date`；否則新建 `curCrash = {enter: bar.date, exit:null, max_dd:dd, tier3_date: bar.date}`（代表跳空直接進 tier3，enter 與 tier3_date 同一天）。
2. **`mode==='tiered' && !inCrash && !inTier2 && dd >= tier2_dd`**（且未命中第 1 點，即 `dd < crash_dd`）：加碼到中繼 β，`desiredValue = (beta_mid/etf_beta)*total`；`trades.push({...type:'tier2_enter'})`；`inTier2=true`；`curCrash = {enter: bar.date, exit:null, max_dd:dd, tier3_date:null}`。
3. **`inCrash && dd <= 1e-9`**（創新高退出——**沿用既有 oneshot/ladder 共用的這一段，tiered 模式的滿倉狀態也要走同一段退出邏輯，不要另外複製一份**）：退回 `targetWeight`，`crash_exit`；`inCrash=false`；`curCrash.exit=bar.date` 後 push 進 `crashEvents`。
4. **`mode==='tiered' && inTier2 && dd < tier2_dd`**（小股災回落、未惡化）：退回 `targetWeight`，`trades.push({...type:'tier2_exit'})`；`inTier2=false`；`curCrash.exit=bar.date` 後 push 進 `crashEvents`。
5. **`inCrash`**（持續滿倉中，含 tiered 模式從 tier2 惡化上來的滿倉狀態）：沿用既有「更新 `curCrash.max_dd`」與 ladder 模式分批邏輯的那段——**tiered 模式不需要 ladder 的分批加碼，維持既有 `oneshot`/`ladder` 分支的排他性，`mode==='tiered'` 時這段只做「更新 max_dd」，不觸發任何 ladder 專屬買進**。
6. **`mode==='tiered' && inTier2`**（持續小股災中，尚未惡化也未回落）：更新 `curCrash.max_dd`，不做任何交易（持有中繼 β）。
7. 其餘（`curBeta>upper||curBeta<lower`）：既有正常再平衡分支，`mode==='tiered'` 且不在 tier2/tier3 狀態時完全比照 `oneshot` 走這段，不需要特別分支。

> 這段是邏輯順序的規格說明，不是逐字要貼的程式碼——實作時請確保每個分支的判斷條件互斥、不會有兩個分支在同一天都觸發（尤其是「跳空直接進 tier3」與「先進 tier2 同一天內又惡化」這兩種情況，同一天只會執行其中一個分支，因為 `!inCrash` 與 `!inTier2` 的條件會讓判斷順序自然排他）。

### 4.4 UI（`pages/CrashBacktest.tsx`）

- 模式切換三選一（oneshot／ladder／tiered），tiered 選中時顯示：`tier2_dd` 滑桿（5%~20%）、`beta_mid` 滑桿（範圍可綁定 `target_beta`~`etf_beta`）、`crash_dd` 沿用既有滑桿但 label 改「股災確認門檻（tier3）」。
- **訊號來源下拉**（新增，影響抓取哪條序列餵進 `alignSeries`/`alignSeries4` 的 `mktRows`）：`0050`／`TAIEX（加權指數）`，**預設 `TAIEX`**（因為這是三層系統的設計初衷；比照 §0 的決定，`oneshot`/`ladder` 模式選 TAIEX 時的行為只是把回撤訊號換掉，交易邏輯不受影響，這是預期且合理的行為變化，不算破壞既有功能——只是同一個 `crash_dd` 數字套在不同訊號上意義不同，UI 上顯示清楚訊號來源即可）。
- 交易紀錄表新增 `tier2_enter`（琥珀色）／`tier2_exit`（灰色）著色，比照既有 `crash_enter`（紅）／`crash_exit`（綠）／`ladder_buy` 的顏色慣例。
- 崩盤事件表新增「是否惡化為股災」欄：`tier3_date` 非 null → 紅字「是（{tier3_date}）」；否則綠字「否（虛驚一場）」。
- 回撤圖加一條 10%（`tier1_dd`，純視覺參考線，不用做成可調參數，因為 tier1 對回測引擎完全沒有機械動作，只在 §3 的即時面板才有意義）虛線參考線，跟既有的 `crash_dd` 觸發線區隔開（不同虛線樣式或顏色）。

---

## 5. 測試（vitest）

**Part A**（`computeMarketStatus`，加進 `rebalance.test.ts` 或新檔 `marketStatus.test.ts`）：
1. `closes` 為空陣列／全部非正數 → 回傳 `null`。
2. 單筆資料 → `drawdown=0`、`tier=0`。
3. 最後一筆就是全序列最高點 → `drawdown=0`、`tier=0`。
4. 峰值在序列中段（非最後一筆）、之後一路下跌 → `peak_date`/`peak_close` 正確抓到中段那筆，不是誤抓最後一筆。
5. `drawdown` 剛好等於 `tier1_dd`（邊界值）→ 算作已達 tier1（`>=` 判斷）。
6. `drawdown` 12% → `tier=1`；17% → `tier=2`；25% → `tier=3`。
7. 全程單調上漲（無回撤）→ `drawdown=0`、`tier=0`。

**Part B**（`crashBacktest.test.ts` 加案例，皆用合成的簡單日線資料）：
1. **回歸測試（最重要）**：任取既有 `oneshot`/`ladder` 測試案例，額外跑一次 `mode:'tiered'` 但資料整段回撤都 <10%（從未觸發任何 tier）→ 策略曲線與 `mode:'oneshot'` 逐日逐位元相同（因為兩者在未觸發任何崩盤邏輯時走的是同一段「正常再平衡」分支）。
2. 回撤到 16%（觸發 tier2、未達 20%）後回升到 13%（< tier2_dd）→ 交易紀錄恰有一筆 `tier2_enter`、一筆 `tier2_exit`，中間 β 曲線維持在 `beta_mid` 對應水準，`crash_events` 該筆 `tier3_date` 為 `null`。
3. 回撤 16%（tier2）續跌到 22%（惡化 tier3）→ 創新高退出：交易紀錄依序 `tier2_enter` → `crash_enter` → `crash_exit`；`crash_events` 該筆 `tier3_date` 有值且 `enter` ≠ `tier3_date`。
4. 單日跳空直接由 0% 跌破 20%（未經過 tier2 區間）→ 只有一筆 `crash_enter`，無 `tier2_enter`；`crash_events` 該筆 `tier3_date === enter`。
5. `mode:'oneshot'` 與 `mode:'ladder'` 既有測試案例全數維持通過，不因新增 `tiered` 分支而改變行為（`git diff` 確認這兩段 if/else 沒有被觸碰）。

---

## 6. 驗收標準

1. `npx tsc --project tsconfig.app.json` 與 `vite build` 乾淨；vitest 全綠（含新增案例）。
2. Part A 手動驗收：`/rebalance` 頁能抓到 TAIEX 歷史資料並顯示正確的市場狀態燈號（拿目前實際 TAIEX 點位手算一次回撤驗證數字正確）；`tier===2`／`tier===3` 時對應按鈕能正確把 `target_beta` 改成 `beta_mid`／`etf_beta` 並觸發既有再平衡計算（沿用既有邏輯，非新公式）。
3. Part B 手動驗收：`/backtest` 選 `tiered` 模式＋訊號來源 `TAIEX`，跑一次近年資料（含 2025 關稅那次回撤），確認交易紀錄與崩盤事件的 tier2/tier3 進出場日期與本規格 §0 引用的歷史分析大致吻合（2025-03-31 附近應出現 tier2、2025-04-07/08 附近惡化 tier3）。
4. `git diff` 只碰：`lib/rebalance.ts`、`lib/rebalanceStore.ts`、`pages/Rebalance.tsx`、`lib/crashBacktest.ts`、`pages/CrashBacktest.tsx`，及對應測試檔。**不動** `routes/rebalance.js`、`scripts/rebalance_alert.cjs`、engine 後端、`lib/api.ts`（`ohlcv` 本來就是通用 code 參數，不需要改介面）。
5. 手機窄螢幕（375px）新增的市場狀態面板與 tiered 模式參數區不破版。

---

## 7. 不做／備註

- **不做「分批進場」**（§0 已附回測結論：不穩定、平均變差）。
- **不做「提前出場／trailing stop」**（§0 已附回測結論：四次事件無一例外變差）。
- **tier1（第一警戒）在兩個部分都沒有機械動作**：Part A 純顯示提醒；Part B 完全不進狀態機（只在圖表當視覺參考線）。不要為了「完整」而畫蛇添足加操作邏輯。
- **不開放鎖定 00631L**（沿用 opt19 既有規則，本案不變動鎖定範圍）。
- **不動 `scripts/rebalance_alert.cjs`**：告警腳本沿用既有邏輯（視同沒有三層系統），比照 opt19 的既有決定，市場狀態純粹是網頁上的即時參考，不接進背景排程。
- **不要求兩個部分共用 config 或 code**：Part A 的 `tier1_dd/tier2_dd/tier3_dd/beta_mid` 存在 `review:rebalance:v1`，Part B 的 `tier2_dd/beta_mid`（tier3 沿用 `crash_dd`）存在 `review:backtest:v1`，兩者是不同頁面的獨立設定，各自預設值相同但不是同一份資料、不需要同步。
- **TAIEX 資料源若驗證失敗**（§2 的 curl 測試），先回報實際錯誤訊息再決定退路，不要悄悄 fallback 到 0050 掩蓋掉「訊號源其實沒換成功」這件事。
