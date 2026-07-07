# 優化專案 11 — 崩盤策略回測實驗室（單一標的 00631L＋現金）

> **2026-07-04 完工定稿**：使用者「直接搞定」授權，本案由 Claude 直接實作（非「Claude 寫規格→使用者寫 code」流程）。本檔記錄**已實作**的最終設計，與 code 同步。
> 來源：「正二實驗室 #03 — 崩盤策略最佳 Beta 1.0~1.8 全面回測」研究文（JJ 投資研究所，11 張截圖）＋ opt10 §9 立案。
> **相依：無**——只讀既有 `/api/stocks/:code/ohlcv?adjust=1`（還原價），**零新後端、零新端點、零 LLM**。
> **範疇順序**：計算機（opt10）優先、回測（opt11）隨後（使用者 2026-07-04 定），opt10 完工後接做。

> **【增修J 2026-07-07】新增「分批加碼」模式（mode='ladder'）**：`BacktestParams` 加 `mode:'oneshot'|'ladder'`（預設 'oneshot' 舊行為不變）＋`ladder_step`（每跌一階買一筆，預設 0.05）＋`ladder_full_at`（買滿深度，預設 0.30；筆數＝full_at/step，等分「進入回撤 regime 時的現金」）。regime 內暫停容忍區間再平衡、跳空跌多階一筆補多 tranche、創新高退出與 oneshot 共用；`Trade.type` 加 `'ladder_buy'`。UI 加模式 toggle＋雙滑桿，回撤圖改雙觸發線（首筆/買滿）。稽核紀錄與真實資料策略比較見 ROADMAP §8 增修J。

## 0. 這套系統在做什麼

研究文的核心：正2（00631L, β≈2）+ 現金的配置，平時維持目標投組 β；**崩盤時把現金當「子彈」全數加碼進正2 拉滿槓桿抄底，等大盤創新高再平衡回目標 β 鎖利**。研究文用歷史回測比較不同目標 Beta（1.0~1.8）與基準，結論：所有崩盤策略都贏全倉正二、Beta 1.4 報酬最高、**1.2 風險報酬比最佳**、現金是「留到崩盤超車」的子彈。

本案把這套做成前端可玩的回測：吃 00631L + 0050 歷史還原價，跑策略 vs 基準，出績效表 + 權益/β/回撤曲線 + 交易紀錄。

## 1. 🚨 單一標的簡化假設（誠實記軌）

研究文原為**多標的、含第二階 −50% 再加碼**。使用者「只買 00631L」→ 本案塌縮為**單一標的（00631L＋現金）**：

- 投組 β = 00631L 佔比 × 2.0（現金 β=0），與 opt10 同一模型。
- 崩盤偵測用 **0050**（大盤代理）自歷史高點的回撤。
- **只實作「一階崩盤加碼 ＋ 創新高退出」**：單一標的下滿槓桿即 100%/2x，已無可再加碼空間，故研究文的第二階 −50% 加碼在此模型無意義、**不實作**。
- 此假設於本規格與頁面底部聲明**明列**，避免誤解為完整複製研究文。

## 2. 計算模型（`review-web/src/lib/crashBacktest.ts`，純函式＋vitest）

### 2.1 型別

```ts
export interface AlignedBar { date: string; etf: number; mkt: number; } // etf=00631L 還原收盤, mkt=0050 還原收盤
export interface BacktestParams {
  initial_capital: number;        // 期初資金（預設 1,000,000）
  target_beta: number;            // 目標投組 β（預設 1.2）
  etf_beta: number;               // 標的 β（00631L 預設 2.0）
  tolerance_mode: 'pct' | 'abs';  // 容忍口徑（沿用 opt10；預設 'abs'）
  threshold_pct: number;          // pct 模式 ±%（預設 10）
  threshold_abs: number;          // abs 模式 ±β（預設 0.1）
  crash_dd: number;               // 崩盤觸發：0050 自高點回撤（預設 0.28 = −28%）
  cost_bps: number;               // 單邊交易成本 bps（套成交金額；預設 0）
}
export function alignSeries(etfRows: OhlcvRow[], mktRows: OhlcvRow[]): AlignedBar[];
export function runBacktest(bars: AlignedBar[], params: Partial<BacktestParams>): BacktestResult;
```

`BacktestResult`：`{ aligned_days, start_date, end_date, strategy: EquityCurve, beta_curve: CurvePoint[], mkt_drawdown: CurvePoint[], benchmarks: EquityCurve[], trades: Trade[], crash_events: CrashEvent[], note? }`。`EquityCurve = { key, name, points: {date,value}[], metrics }`；`Metrics = { final_value, total_return, cagr, max_drawdown }`；`Trade = { date, type: 'rebalance'|'crash_enter'|'crash_exit', from_beta, to_beta, traded_value(+買/−賣), cost }`；`CrashEvent = { enter, exit|null, max_dd }`。

### 2.2 `alignSeries`

依日期 inner-join 兩條收盤序列，只保留**兩邊都有、價格為有限正數**的交易日，升冪排序。（0050 建 Map 快取，00631L 逐列比對。）

### 2.3 `runBacktest` 逐日狀態機

- 參數全 `Number.isFinite`＋範圍夾（β 0~3、crash_dd 0.05~0.95、etf_beta≥0.1、初始資金≥1、成本≥0）；`bars.length < 2` → 回 `note`。
- `targetWeight = clamp(target_beta/etf_beta, 0, 1)`；容忍上下限沿用 opt10（abs：`target±abs` 下限 `max(·,0)`；pct：`target×(1±%)` 亦 clamp≥0）。
- **期初（i=0）**：以 `targetWeight` 建倉（`etfUnits = targetWeight×capital/etf[0]`、`cash = (1−targetWeight)×capital`）；此為起始部位，**不計為交易**。
- **每日**：更新 0050 高點與回撤 `dd`；算當日 `etfValue/total/curBeta`。i>0 依序判定：
  1. `!inCrash && dd ≥ crash_dd` → **crash_enter**：買到滿槓桿（desiredValue = total），記交易、開 `CrashEvent`。
  2. `inCrash && dd ≤ ~0`（0050 創新高）→ **crash_exit**：再平衡回 `targetWeight`，記交易、關 `CrashEvent`。
  3. `inCrash`（持續）：維持滿槓桿，更新該次崩盤最大回撤。
  4. 正常且 `curBeta` 破容忍區間 → **rebalance**：搬回 `targetWeight`。
- 交易：`traded = desiredValue − etfValue`、`cost = |traded|×cost_bps/1e4`、`etfUnits = desiredValue/price`、`cash -= traded + cost`。
- 每日記錄交易後權益（`stratPoints`）與投組 β（`beta_curve`）；收尾把仍未平倉的 `CrashEvent`（exit=null）補進 `crash_events`。
- **基準**：全倉0050、全倉00631L（各 `buyHold`）、初始配置不再平衡（期初目標權重建倉後放著）。
- **Metrics**：`total_return=final/initial−1`；`cagr` 以起訖日期年數（365.25 天/年）計；`max_drawdown` 走權益曲線峰值回撤（正值）。

## 3. 頁面（`review-web/src/pages/CrashBacktest.tsx`）

- 抓 `api.ohlcv('00631L',{start:'2020-01-01',adjust:true})` 與 `'0050'` → `useMemo(alignSeries→runBacktest)`。
- **參數面板**：目標 β 滑桿（0~2 step0.05，顯 00631L%/現金%）、崩盤觸發 −%（0.1~0.5）、容忍模式 ±β/±% 切換＋各自 range（沿用 opt10）、期初資金、單邊成本 bps；全存 localStorage `review:backtest:v1`。
- **績效比較表**：策略＋3 基準 × 期末資產/總報酬/年化/最大回撤；台股慣例（報酬正紅負綠、回撤綠）。
- **三張圖**（內建 `MultiLineChart`，沿用 K 線暗色調＋ResizeObserver＋cleanup）：權益曲線（策略粗線強調＋3 基準）、投組 β 曲線（目標 β 參考線）、0050 回撤（觸發線）。
- **崩盤事件**清單＋**交易紀錄**表（動作紅[加碼]/綠[退出]、β 變化、金額買紅賣綠）。
- 底部**聲明**：單一標的簡化模型、β 假設、還原價來源、不含滑價稅費（除非填成本）、非投資建議、明列不實作第二階 −50%。

## 4. 架構鐵律（沿用全案）

- **零後端、零新端點、零 LLM**：只讀既有 `ohlcv?adjust=1`；`contracts.md` 不動。
- 台股色慣例：漲/報酬正=紅、跌/報酬負=綠；回撤顯綠。
- 不動 `web/`、engine、gateway；`snake_case`；`tsc -b && vite build` 乾淨、vitest 綠。
- 全路徑防 NaN/Infinity/除零。

## 5. 驗收標準

- [x] `alignSeries` inner-join＋丟單邊/非正價＋升冪排序。
- [x] `runBacktest`：平盤零交易且 β 恆為目標；漲多破上限觸發再平衡賣回目標；0050 回撤≥觸發值進崩盤（β→2）、創新高退出回目標；回撤未達不觸發；未平倉崩盤事件 exit=null。
- [x] 三基準與策略曲線等長；buyHold 報酬/最大回撤數值正確；static 不再平衡。
- [x] 全路徑無 NaN/Infinity；<2 bar 回 note。
- [x] vitest **12/12**；`tsc -b` 與 `vite build` 乾淨（`CrashBacktest` lazy chunk、全庫 **44/44**）。
- [x] **VM 實機驗收（2026-07-04 通過）**：commit `322cc21` 部署 VM，`/backtest` 完整渲染零回歸。回測區間 `2020-01-02~2026-07-02`（1576 交易日）確認 ohlcv 涵蓋 2020 起、00631L/0050 皆回傳。績效表：崩盤策略 +1009.8%/回撤 −37.1% vs 全倉正二 +1472.4%/回撤 −55.1% vs 初始不再平衡 +883.4%/回撤 −48.9%（策略回撤明顯優於全倉正二，符合預期）。β 曲線兩次崩盤拉滿 2.0 再收回 1.2；崩盤事件 2 次（2020-03 COVID −28.2%、2022-09→2024-02 −33.8%）；交易紀錄型別/方向/顏色正確。

## 6. 坑（帶進驗收）

- 🚨 **ohlcv 涵蓋度**：需確認 VM `ohlcv?adjust=1` 對 00631L/0050 都能回傳 2020 起還原價；若某標的資料短，`alignSeries` 會取交集（回測區間縮短），頁面顯示實際起訖日與交易日數。
- 崩盤退出條件「創新高」＝ 0050 回到歷史高點（`dd ≤ ~0`）；若回測期末仍在崩盤中，事件 `exit=null` 且策略持有滿槓桿到底（頁面會標示）。
- `cost_bps` 預設 0（純機械回測）；填入才扣成本，聲明已標「不含滑價稅費除非自填」。
- lightweight-charts：`toTime(date,false)` 回 `YYYY-MM-DD` business-day time；每次重繪 `chart.remove()` cleanup 防洩漏（沿用 PriceChart）。
- PWA SW 快取：上版後看不到新頁先照 `deploy.md §4.4` 強制重整。
