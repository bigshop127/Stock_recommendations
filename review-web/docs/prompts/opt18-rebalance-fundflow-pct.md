# 優化專案 18 — 再平衡計算機：資金流向百分比註記（增修 opt10／承接增修K）

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt18-rebalance-fundflow-pct.md`，然後根據裡面的說明進行」。
> 範圍：只動 `/rebalance` 頁既有的「執行建議」面板，**不新增後端、不新增 `/api` 請求、不動資料模型**。

---

## 1. 背景

使用者看著目前 `/rebalance` 頁「偏離分析 & 再平衡建議」面板反映：除了「買/賣 00631L」，應該同時看到「閒置資金要補多少」、以及「花的錢各自多少比例在 00631L／美債上」。

實際上 `computeRebalance`（`lib/rebalance.ts`）**已經**算好且顯示這些金額——`result.cash_adjust_delta`（現金要調整多少）、`result.bond_plans[].value_delta`（每檔債券要買賣多少）都已存在，UI 也已用三張卡片＋下方「若要精確重置」條列顯示（見增修I/K）。**缺的不是數字，是「百分比」呈現**：使用者要的是像「應賣出 00687B $278,305，其中 64% 拿去買 00631L、36% 拿去補現金儲備」這種一眼看懂資金去向比例的註記，而不是只看三個各自獨立的金額，自己心算比例。

已用 preview 跟使用者對過並選定的目標文案格式：

```
應賣出 00687B：$278,305
└ 其中 64% 買00631L、36% 補現金儲備
```

---

## 2. 為什麼這個計算是合理的（先建立共識，避免規格失真）

`computeRebalance` 對 00631L／現金／每檔債券分別算「目標值 − 現值」＝ `value_delta`。因為目標配置只是把同一筆 `total_value` 重新切割（沒有外部資金流入流出），**四個（或以上）bucket 的 `value_delta` 加總理論上為 0**（浮點誤差除外）：

```
etf_value_delta + cash_adjust_delta + Σ bond_plans[i].value_delta ≈ 0
```

所以可以把所有 `value_delta < 0` 的 bucket 視為「資金來源」、`value_delta > 0` 的 bucket 視為「資金用途」，來源總額 ≈ 用途總額。這讓「來源 A 佔用途 X 的百分比」有意義。

**誠實揭露前提**：這是**比例分配**，不是真的追蹤「這一塊錢從哪個帳戶流到哪個帳戶」（現金本來就是同一池子，見增修H）。多來源時，同一個「用途」對每個「來源」按金額比例分攤（即：來源 j 分給用途 i 的錢 = 來源 j 金額 × (用途 i 金額 / 用途總額)）。這代表：**若同時有兩個以上來源，每個來源卡片上顯示的「% 去向」會是相同的百分比拆分**（因為都是照同一組用途比例分攤），這是預期行為、不是 bug——文案上不用特別解釋這麼細，但 code 內部注解要講清楚（避免日後被誤認是算錯）。

---

## 3. 純函式規格（放 `lib/rebalance.ts`，比照既有 `allocateDefensive` 風格）

```ts
export interface FundFlowNode {
  key: string;       // 'etf' | 'cash' | 債券 code
  label: string;     // 顯示名稱：'00631L'｜'現金儲備'｜'00687B 國泰20年美債'
  amount: number;     // 絕對金額（>0）
  breakdown: { key: string; label: string; amount: number; pct: number }[];
  // ↑ 只在「對面清單（用途 for 來源／來源 for 用途）」筆數 ≥ 2 時才非空；
  //   否則回傳 []（1 對 1 搬錢時 100% 是廢話，不顯示）
}

export interface FundFlowBreakdown {
  sources: FundFlowNode[]; // value_delta < 0（且 |value_delta| ≥ 1）的 bucket，依金額大到小排序
  uses: FundFlowNode[];    // value_delta > 0（且 value_delta ≥ 1）的 bucket，依金額大到小排序
}

export function computeFundFlows(result: RebalanceResult): FundFlowBreakdown
```

邏輯：

1. 組出候選 bucket 清單：`{ key:'etf', label:'00631L', delta: result.etf_value_delta }`、`{ key:'cash', label:'現金儲備', delta: result.cash_adjust_delta }`、以及 `result.bond_plans` 逐檔 `{ key: p.code, label: \`${p.code} ${資產全名}\`, delta: p.value_delta }`（資產全名可用既有 `ASSETS`/`assetName` 對照表，或直接傳入 `bondNames: Record<string,string>` 參數）。
2. 過濾 `delta === null` 或 `|delta| < 1` 的 bucket（噪音門檻沿用既有 `hasDefensiveMoves` 的 `>= 1`）。
3. `delta < 0` → 進 `sources`（`amount = |delta|`）；`delta > 0` → 進 `uses`（`amount = delta`）。
4. `total_use = Σ uses.amount`；`total_source = Σ sources.amount`。
5. 若 `uses.length >= 2`：每個 source 的 `breakdown` = `uses.map(u => ({ key:u.key, label:u.label, amount: u.amount, pct: u.amount / total_use }))`。若 `uses.length < 2`（0 或 1 筆），`breakdown = []`。
6. 對稱處理 `uses` 的 `breakdown`（來源側，`sources.length >= 2` 才非空，比例 = `s.amount / total_source`）。
7. 全路徑防 NaN／除以零（`total_use<=0` 或 `total_source<=0` 時對應 breakdown 一律 `[]`）；`status==='empty'` 或 `'normal'`（沒有偏離）時回傳 `{ sources: [], uses: [] }`。
8. pct 存 0~1 小數（不在 lib 內轉字串／百分號），UI 端自行 `(pct*100).toFixed(0)` — 不用強求加總剛好 100（四捨五入誤差 ±1% 可接受，比照本站其他地方的務實作法，不做 largest-remainder 校正）。

---

## 4. UI 規格（`pages/Rebalance.tsx`）

- 在既有「防守端配置：固定現金 + 債券池」三張卡片（約行 845–892）與 00631L 顯眼行動數字卡片（約行 819–843）上，各自呼叫 `computeFundFlows(result)`，若該卡片對應的 bucket 有非空 `breakdown`，在卡片內既有金額下方加一行小字：

  ```
  └ 其中 {pct1}% {買/補/賣} {label1}、{pct2}% {買/補/賣} {label2}...
  ```

  動詞規則：對方 bucket 是 `etf` 或 bond 且其 `delta>0` → 「買」；`delta<0` → 「賣」；對方是 `cash` 且 `delta>0` → 「補」；`delta<0` → 「提領」。
- 只有 2 個以上 breakdown 項目時才顯示這行（單一對單一時 lib 已回空陣列，UI 不用另外判斷）。
- 字級比照現有卡片內 `text-[10px] text-zinc-500` 次要文字，不要搶過主金額。
- 「若要精確重置至目標…」條列區塊（約行 894 起）維持現狀不用重複加註（避免同頁資訊三重複，卡片加註即可）。

---

## 5. 測試（vitest，放 `rebalance.test.ts` 或新檔 `fundFlow.test.ts`）

至少涵蓋：

1. **單來源雙用途**（本案例原型）：賣 00687B $278,305、買 00631L $178,305、補現金 $100,000 → `computeFundFlows` 回 source 00687B 的 breakdown 含兩筆，`pct` 分別 ≈0.6407／≈0.3593，加總 ≈1。
2. **雙來源單用途**：例如賣 00631L 部分＋現金同時減少，全部拿去買某檔債券 → 該用途（債券）的 breakdown 有兩筆來源比例，source 側每個來源卡片各自的 use-breakdown 應相同（因為只有一個 use，1:1 直接跳過 breakdown＝空陣列，驗證第 3 條規則生效）。
3. **1 對 1 直接搬錢**（例如只有 00631L 與現金兩個 bucket、沒有債券，經典 opt10 舊模型）→ source 與 use 的 `breakdown` 皆為 `[]`。
4. **`status==='normal'`（無偏離）**→ `sources`/`uses` 皆為 `[]`。
5. 邊界：`total_use<=0` 或某 bucket `delta` 為 `null`（例如債券 `price<=0` 導致 `trade_shares` 為 null，但 `value_delta` 本身不依賴 price 應仍有值——確認這條路徑不會誤傳 null 進計算）。

---

## 6. 驗收標準

1. `npx tsc --project tsconfig.app.json` 與 `vite build` 乾淨；vitest 全綠（含新增案例）。
2. 用截圖裡的真實數字（00631L 10,000股@36.88、00687B 10,000股@27.89、00953B 20,000股@9.7、閒置現金0、保留10萬、target β1.3±0.1、破下限）跑一次：00687B 卡片應多出一行「其中 64% 買00631L、36% 補現金儲備」（現金卡片可選擇性同步顯示反向「來源：100% 賣00687B」，但因只有 1 個來源，依規則 4 應為空陣列——**驗收時確認這個「不顯示」是預期行為**，不是漏做）。
3. 零後端改動、零新 `/api` 請求、`git diff` 只碰 `lib/rebalance.ts`（或新增 `lib/fundFlow.ts`）＋`Rebalance.tsx`＋對應測試檔。
4. 手機窄螢幕（模擬 375px）卡片加這行文字不破版、不橫向溢出。

---

## 7. 不做 / 備註

- 不做「真實資金流水帳」（哪一筆交易的錢實際轉去哪裡）——本來現金就是同一池子（增修H），比例分配是說明性質，非會計追蹤。
- 不影響 `rebalance_alert.cjs` 告警腳本（它讀的是頂層 `value_delta` 等既有欄位，這次只加純前端顯示用的衍生計算，未改動任何既有欄位的意義）。
