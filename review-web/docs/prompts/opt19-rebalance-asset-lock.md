# 優化專案 19 — 再平衡計算機：防守端資產鎖定＋條件式再平衡（增修 opt10／承接增修I/K/opt18）

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt19-rebalance-asset-lock.md`，然後根據裡面的說明進行」。
> 範圍：`/rebalance` 頁＋`lib/rebalance.ts`＋`lib/rebalanceStore.ts`＋`routes/rebalance.js`（僅新增一個透傳欄位）。**`rebalance_alert.cjs` 每日 Email 告警腳本本次不動**（見 §6）。

---

## 1. 背景

使用者情境：今天想加碼／減碼 00631L，但某項防守端資產今天不想動（例：「我今天持倉不想更動美債」）。按下鎖定後，計算機要重新算「美債不能動的話，其他資產要怎麼調整才能盡量貼近目標 β」，而不是像現在一樣假裝美債也會照原本比例被賣/買。

**鎖定範圍（已與使用者確認）**：只開放**防守端 3 項**——現金、00687B、00953B。**00631L 不開放鎖定**：00631L 是投組中唯一有槓桿（β≠0）的資產，整個投組 β 完全由它的市值佔比決定；防守端三項彼此都是 β=0，鎖住其中一項只是把「該搬去哪」換個對象，數學上恆有解（頂多把某項壓到 0）。但鎖住 00631L 會讓 β 完全鎖死、無法再靠任何資產調整達成目標——工具會變成純顯示「無法調整」，沒有實質建議可給，所以不開放。

**告警腳本範圍（已與使用者確認）**：這次**不**把鎖定狀態接進 `scripts/rebalance_alert.cjs`（每日 Email 告警）。鎖定是「網頁上臨時的操作意圖」，告警腳本維持背景排程、沿用現有邏輯計算（視同沒有鎖定）。但鎖定狀態**仍要**存進雲端持倉檔（`data/rebalance_holdings.json`）並在下次載入時還原——否則使用者鎖了之後重新整理網頁，鎖定會消失（見 §5 的 gateway 透傳）。告警腳本讀同一份檔案時，多出來的 `locked` 欄位它不會去讀，不影響其現有行為。

---

## 2. 數學模型（先建立共識）

現有 `computeRebalance` 的核心公式（無鎖定時）：

```
target_etf_value = target_etf_weight × total_value        // 只看 total_value，與防守端內部怎麼分無關
target_defensive_value = total_value − target_etf_value
（防守端內部：cash = min(cash_reserve, target_defensive_value)，債券池依 bond_split／waterfall 分配，見 allocateDefensive）
```

因為 `total_value` 不變（投組內部搬錢、無外部資金進出），鎖定一項防守端資產（β=0）**不會改變「00631L 該佔多少」這個理想目標值**——除非那項被鎖定的資產「現值」本身就大到超過理想防守端目標值（例：加碼 00631L 需要把防守端縮小，但鎖住的 00687B 現值比縮小後的防守端目標還大，賣不動它，其他資產也補不了這個洞）。這種情況下，投組**無法精確達成目標 β**，只能盡量貼近（少買一點 00631L），必須誠實顯示「因鎖定而打折」。

**推導出的統一公式**（此為本案核心，務必照這個實作，不要另外發明公式）：

```
locked_defensive_sum = （現金鎖定 ? 現金現值 : 0） + Σ（該債券鎖定 ? 該債券現值 : 0）
naive_target_etf_value = target_etf_weight × total_value        // 完全比照原公式，不受鎖定影響
target_etf_value_actual = min(naive_target_etf_value, total_value − locked_defensive_sum)
```

- 沒有任何鎖定時，`locked_defensive_sum = 0` ⇒ `target_etf_value_actual = min(naive, total_value)`，因為 `naive ≤ total_value` 恆成立，`min` 恆取 `naive` ⇒ **與現有行為逐位元相同**（這是最重要的回歸測試）。
- 只有在「鎖定資產現值加總」大於「00631L 想要有的那個理想防守端剩額」時，`min` 才會咬下去，把 00631L 的目標值往下修（因為鎖住的資產佔掉了太多防守端空間，00631L 買不了那麼多）；此時要設一個旗標告知使用者「因鎖定打折」，不能悄悄算出一個和使用者直覺目標 β 不符的數字卻不說明。
- 這個 `min` 只會在「00631L 要加碼、防守端要縮小」的方向咬下去；「00631L 要減碼、防守端要擴大」的方向不會被鎖定卡住（防守端擴大只是把賣 00631L 的錢塞進沒被鎖的現金/債券，永遠有地方塞，不會不夠）。不需要另外分方向討論，上面這條 `min` 公式本身就自動處理好了兩個方向（可以自行手算 1–2 個例子驗證，不要另外加 if-else 分支）。

**全部防守端三項都鎖定**是上述公式的極端特例：`locked_defensive_sum = defensive_value`（現值全額），`target_etf_value_actual = min(naive, total_value − defensive_value) = min(naive, etf_value) `。如果 `naive > etf_value`（原本該加碼）會被壓回 `etf_value`（不變）；如果 `naive < etf_value`（原本該減碼）… 注意這裡公式在「減碼方向」不會被鎖定卡住是指「有未鎖定資產可以承接」的情況；三項全鎖時没有未鎖定資產可承接，這個特例必須額外處理，見下方步驟 4。**務必寫成一個獨立分支，不要指望上面那條 `min` 公式在「三項全鎖」時自動生效**（它在“擴大”方向沒有卡住是因為假設有未鎖定資產可以接收，三項全鎖時這個假設不成立）。

---

## 3. 純函式規格（`lib/rebalance.ts`）

### 3.1 型別擴充

```ts
// RebalanceInput 新增（可選，缺省＝都不鎖，與現有行為 100% 相容）
locked?: {
  cash?: boolean;
  bonds?: Record<string, boolean>; // key＝債券 code；缺的 code 視為 false
};
```

```ts
// RebalanceResult 新增
lock_capped: boolean;      // true＝因鎖定導致無法精確達成目標 β（target_etf_value_actual !== naive）
lock_note: string | null;  // 說明文字；未鎖定或鎖定未造成影響時為 null
achieved_beta: number | null; // 依 lock_capped 後實際能達到的 β（= target_etf_value_actual/total_value × etf_beta）；
                                // lock_capped=false 時 = target_beta（其實就是同一個數，UI 可直接判斷要不要多顯示這欄）
```

### 3.2 邏輯（放進 `computeRebalance`，`target_etf_weight !== null` 分支內，取代原本直接算 `target_etf_value` 那幾行）

```
1. naive_target_etf_value = target_etf_weight × total_value   // 原公式不變

2. lockedCash = input.locked?.cash === true
   lockedBonds = bonds.map(b => input.locked?.bonds?.[b.code] === true)
   allDefensiveLocked = lockedCash && lockedBonds.every(Boolean) && bonds.length > 0
     （bonds.length === 0 時退回舊「純現金」模型，allDefensiveLocked 只需看 lockedCash）
   若 bonds.length === 0： allDefensiveLocked = lockedCash

3. 若 allDefensiveLocked：
     target_etf_value_actual = etf_value   // 完全不動，見 §2 極端特例
     lock_capped = naive_target_etf_value !== etf_value（用 Math.abs(diff) >= 1 判斷避免浮點雜訊）
     lock_note = lock_capped
       ? '現金／債券皆已鎖定，投組曝險無法調整（等同鎖死整體配置）'
       : null
   否則：
     locked_defensive_sum = (lockedCash ? cash : 0) + bonds.reduce((s,b,i)=> s + (lockedBonds[i]? b.value : 0), 0)
     target_etf_value_actual = Math.min(naive_target_etf_value, total_value - locked_defensive_sum)
     lock_capped = Math.abs(target_etf_value_actual - naive_target_etf_value) >= 1
     lock_note = lock_capped
       ? `已鎖定資產現值合計 $${Math.round(locked_defensive_sum).toLocaleString()} 超過目標防守端可用空間，00631L 僅能達成部分調整`
       : null

4. etf_value_delta = target_etf_value_actual − etf_value（沿用既有下游：trade_shares、post_* 全部不變公式，只是吃到不同的 target_etf_value）

5. target_defensive_value_actual = total_value − target_etf_value_actual
   （這個值餵給下面 §3.3 的鎖定版防守端分配函式，取代原本直接餵給 allocateDefensive 的 target_defensive_value）

6. achieved_beta = total_value > 0 ? (target_etf_value_actual / total_value) × etf_beta : null
```

### 3.3 防守端鎖定分配（新函式，取代原本直接呼叫 `allocateDefensive` 那一段；**`allocateDefensive` 本體不要改**，`crashBacktest.ts` 還在用它）

```ts
export interface DefensiveAllocationLockedInput {
  targetDefensiveValue: number;
  cash: { value: number; reserve: number; locked: boolean };
  bonds: { code: string; value: number; locked: boolean }[]; // 順序＝優先變現順序，同 allocateDefensive
  bondSplit: number;
}

export interface DefensiveAllocationLockedResult {
  cash_value: number;
  bond_values: number[]; // 與輸入 bonds 同順序
}

export function allocateDefensiveWithLocks(
  input: DefensiveAllocationLockedInput,
): DefensiveAllocationLockedResult
```

邏輯：

```
1. 鎖定的 bucket：target = 現值（不變）。
2. 未鎖定 bucket 要分配的錢：
   unlocked_pool = targetDefensiveValue
                   − (cash.locked ? cash.value : 0)
                   − Σ(該債券鎖定 ? 該債券現值 : 0)
   （因為 §3.2 步驟 5 已經用 min() 保證 target_etf_value_actual 不會小到讓 unlocked_pool 算出負數，
   這裡仍加 Math.max(0, ·) 防禦浮點誤差，但正常路徑不應該真的夾到）

3. 未鎖定的現金／未鎖定的債券，依「現金保留優先、剩下依 bondSplit／waterfall」分配 unlocked_pool：
   - 若現金未鎖定：cash_target = clamp(cash.reserve, 0, unlocked_pool)；bondPool = unlocked_pool − cash_target
     若現金已鎖定：cash_target = cash.value（維持）；bondPool = unlocked_pool（全部留給未鎖定的債券）
   - 未鎖定債券有 2 檔（沒有債券被鎖）：完全比照既有 allocateDefensive 的 waterfall／bondSplit 邏輯
     （直接內部呼叫既有 allocateDefensive(targetDefensiveValue=cash_target+bondPool 的等效值, ...)
      或複製其瀑布/比例判斷式皆可，但兩者對「無鎖定」情境的輸出必須逐位元相同——這是最重要的回歸點）
   - 未鎖定債券只有 1 檔：該檔 target = bondPool（全拿，無需 waterfall/split 判斷）
   - 未鎖定債券有 0 檔：
       若現金未鎖定，bondPool 併回現金（cash_target += bondPool，因為沒有其他地方可放）
       若現金也鎖定，理論上不會進到這裡（bonds.length===0 或已被 §3.2 的 allDefensiveLocked 分支攔截）
4. 全路徑防 NaN、cash_reserve/bondSplit 沿用既有 clamp 慣例。
```

### 3.4 `computeRebalance` 接線

- `bond_plans[i].target_value` 改吃 `allocateDefensiveWithLocks` 回傳的 `bond_values[i]`；`target_cash_value` 改吃 `cash_value`。其餘（`value_delta`、`trade_shares`、`post_shares`……）公式完全不變。
- `cash_adjust_delta = target_cash_value − cash`（不變）。
- 無任何鎖定（`locked` 未傳或全 false）時，`allocateDefensiveWithLocks` 的輸出必須與現有 `allocateDefensive` 逐一相同——寫測試明確驗證這件事（見 §4 第 1 條）。

---

## 4. 測試（vitest，加進 `rebalance.test.ts` 或新檔 `rebalanceLock.test.ts`）

1. **回歸測試（最重要）**：任取 2–3 組既有 `rebalance.test.ts` 案例，補上 `locked: undefined` 與 `locked: {cash:false, bonds:{'00687B':false,'00953B':false}}` 兩種寫法各跑一次，結果需與不傳 `locked` 完全相同（`toEqual`）。
2. **鎖定單一債券、鎖定值不足以卡住目標**（例：加碼 00631L 需要防守端縮小 $50 萬，鎖定 00687B 現值只有 $10 萬）：00687B `value_delta≈0`，00953B／現金吸收剩下的縮小量（現金保留優先），`lock_capped=false`，`lock_note=null`，`etf_value_delta` 與未鎖定時相同。
3. **鎖定單一債券、鎖定值卡住目標**（例：縮小需求 $30 萬，但鎖定 00687B 現值 $50 萬）：`target_etf_value_actual < naive`、`lock_capped=true`、`lock_note` 非 null 且含金額；00687B 仍 `value_delta=0`；00953B/現金吸收到 0 為止（不會被要求「倒貼」變負值）。
4. **鎖定現金＋防守端擴大**（減碼 00631L 獲利了結）：現金 `value_delta=0`，全部盈餘依 `bond_split` 分進兩檔未鎖定債券。
5. **鎖定唯一一檔未鎖債券的情境**（鎖 00687B，剩現金與 00953B 未鎖）：驗證 00953B 拿到全部 `bondPool`（不套用 waterfall/split，因為只有它一個目的地）。
6. **三項防守端全鎖定**：`etf_value_delta` 視情況為 0 或（`naive<etf_value` 時）等於「防守端全鎖定」分支公式算出的值；`lock_capped` 與 `lock_note`（"現金／債券皆已鎖定…"）正確；所有 `bond_plans[].value_delta` 與 `cash_adjust_delta` 皆為 0。
7. **邊界**：`bonds` 為空陣列（舊模型純現金）時只需处理 `lockedCash`，`allDefensiveLocked = lockedCash`，其餘邏輯自然退化，不應報錯。

---

## 5. UI 規格（`pages/Rebalance.tsx` ＋ `lib/rebalanceStore.ts`）

### 5.1 狀態與持久化

- `RebalanceConfig` 新增：
  ```ts
  locked: { cash: boolean; bonds: Record<string, boolean> };
  ```
  預設 `{ cash: false, bonds: { '00687B': false, '00953B': false } }`。
- `rebalanceStore.ts` 的 `normalizeConfig` 補上這欄的 sanitize（缺欄位／型別錯誤 → 全部預設 false，比照其他欄位的守衛寫法），**KEY 仍是 `review:rebalance:v1`，不要改版本號**（舊資料本來就沒這欄，補預設值即可，不算破壞性遷移）。
- 呼叫 `computeRebalance(config)` 時把 `config.locked` 一併傳入。

### 5.2 鎖定按鈕放置位置

放在**持倉現況面板**（約 `Rebalance.tsx` 行 1078 起，`ASSETS.map` 那個區塊）每一列的標題列——現金沒有獨立一列（現金是下面另一個輸入框，行 1166 起），所以：

- **00687B／00953B 兩列**：在既有「抓最新價」按鈕左邊，加一個鎖頭圖示按鈕（`lucide-react` 的 `Lock`/`Unlock`），`onClick` 呼叫 `applyConfig({ locked: { ...config.locked, bonds: { ...config.locked.bonds, [a.code]: !config.locked.bonds[a.code] } } })`。鎖定時圖示變 `Lock`（實心/主色高亮），未鎖時 `Unlock`（灰階）。00631L 那一列**不加這顆按鈕**（§1 已定案不開放）。
- **現金保留額輸入框**那一區（行 1189 起「現金保留額」旁）加同款鎖頭按鈕，切換 `config.locked.cash`。

### 5.3 建議面板顯示（約行 881–930 的防守端三張卡）

- 卡片標題列（現金卡／各債券卡）如果對應鎖定為 true，在既有文字後面加一個小鎖頭圖示＋「已鎖定」灰字標籤（例如 `<Lock className="w-3 h-3" /> 已鎖定`），不需要額外改動金額顯示邏輯——因為鎖定的 bucket 其 `value_delta` 已經是 0，既有的「維持」文案會自動正確顯示。
- 在 00631L 顯眼行動數字卡片（行 855–879）下方，若 `result.lock_capped` 為 true，加一行 amber 警示文字：`⚠ {result.lock_note}`（複用既有 `text-amber-400` 樣式，參考行 936 `result.note` 的寫法）。
- 「若要精確重置至目標 β…」條列區塊（行 933 起）維持現狀，不用另外註記鎖定（避免同頁三重複資訊，比照 opt18 §4 最後一條的做法）。

### 5.4 手機窄螢幕

鎖頭按鈕使用既有「抓最新價」按鈕的尺寸/間距慣例（`text-[11px]`／`w-3 h-3` icon），確保 375px 寬不換行溢出。

---

## 6. 雲端同步（`routes/rebalance.js` ＋ `lib/api.ts`）— 僅新增透傳欄位

`routes/rebalance.js` 的 `sanitizeHoldings()` 是**白名單**式（只回傳明列的欄位，其餘一律丟棄）。目前**沒有**把 `locked` 列進白名單，代表：使用者按鎖定 → 存雲端 → 下次開啟網頁時 `getRebalanceHoldings()` 回傳的資料會**遺失鎖定狀態**（因為伺服端往返時被吃掉了）。這是必須修的透傳缺口，即使本案不動告警腳本的計算邏輯：

```js
// sanitizeHoldings() 新增（緊鄰 bond_split 那行附近）：
locked: {
  cash: b.locked && b.locked.cash === true,
  bonds: BOND_ETFS.reduce((acc, bd) => {
    acc[bd.code] = !!(b.locked && b.locked.bonds && b.locked.bonds[bd.code] === true);
    return acc;
  }, {}),
},
```

- 純粹白名單透傳，**不參與 `aggregatePortfolio` 或任何金額計算**，伺服端也不需要理解它的語意。
- `lib/api.ts` 的 `RebalanceHoldingsPayload` 型別加上同樣的 `locked` 欄位。
- `contracts.md §2.13` 的範例 JSON 補上 `"locked": { "cash": false, "bonds": { "00687B": false, "00953B": false } }` 這一行，並在說明文字加一句「`locked` 純供前端顯示鎖定狀態用，告警腳本 `rebalance_alert.cjs` 不讀取此欄位、其每日試算不受鎖定影響」。

**再次強調：`scripts/rebalance_alert.cjs` 本身完全不用改。**

---

## 7. 驗收標準

1. `npx tsc --project tsconfig.app.json` 與 `vite build` 乾淨；vitest 全綠（含新增案例，§4 全部 7 條）。
2. 手動情境驗收（沿用增修I/K 的真實持倉數字：00631L 10,000股@36.88、00687B 10,000股@27.89、00953B 20,000股@9.7、閒置現金0、保留10萬、target β1.3±0.1、目前已破下限建議買進）：
   - 鎖定 00687B 後重新計算，00687B 卡片顯示「已鎖定」且金額維持不變；00631L 應買進金額、00953B／現金調整金額應自動改變（比未鎖定時的原方案不同）以彌補 00687B 不能動的缺口。
   - 若刻意把要縮小的防守端目標值設得比 00687B 現值還小（可調高目標 β 滑桿製造更大加碼需求），驗證 00631L 大字卡片下方出現 `lock_note` 警示文字，且顯示的應買進金額確實小於未鎖定時的理論值。
3. 重新整理瀏覽器（或重新從雲端載入）後，鎖定狀態要還原（驗證 §6 的透傳有生效，不是只存在 React state 裡）。
4. `git diff` 只碰：`lib/rebalance.ts`、`lib/rebalanceStore.ts`、`pages/Rebalance.tsx`、`lib/api.ts`、`routes/rebalance.js`、`docs/contracts.md`、對應測試檔。**不動 `scripts/rebalance_alert.cjs`**。
5. 手機窄螢幕（模擬 375px）鎖頭按鈕不破版、不橫向溢出。

---

## 8. 不做 / 備註

- **不開放鎖定 00631L**（§1 已定案原因：鎖住它會讓 β 完全鎖死，工具無事可做）。若未來真的有需求，屬於另一個獨立提示詞，不在本案範圍。
- **不動 `rebalance_alert.cjs`**（§1／§6 已定案）：告警腳本每日試算視同無鎖定，維持現有行為。鎖定狀態雖存進雲端持倉檔，但只供網頁顯示用。
- **不做「鎖定並記錄鎖定原因/到期時間」之類的延伸功能**——單純布林開關，按一次切一次，沒有時效性。
- `allocateDefensive`（原函式）本體不動，`crashBacktest.ts` 仍呼叫它、不受本案影響。
