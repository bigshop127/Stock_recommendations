# 優化專案 21 — 再平衡計算機：「持倉現況」＋「買賣報價單期初部位」合併為單一「期初 → 交易 → 現況」總覽表（增修 opt10／承接 opt18/19/20）

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt21-rebalance-holdings-merge.md`，然後根據裡面的說明進行」。
> 範圍：**只動 `review-web/src/pages/Rebalance.tsx` 一個檔（純 UI 重排）**。不動資料模型、不動 `lib/rebalance.ts` 純函式、不動 `lib/rebalanceStore.ts`、不動 `routes/rebalance.js`、不動 `scripts/rebalance_alert.cjs`、不動任何測試邏輯、不新增 `/api` 請求。

---

## 1. 背景

`/rebalance` 頁的 `holdings` 分頁（`activeTab === 'holdings'`）目前**上下疊了兩個面板**，兩者都逐一列出同樣 3 檔標的（00631L / 00687B / 00953B）各自的「股數 + 成本」：

1. **「持倉現況（00631L ＋ 防守端…）」面板**（約行 1714–1998）：每檔顯示「持有股數（衍生，唯讀）／平均成本（衍生，唯讀）／現價（可編輯、可抓價）／市值」＋債券鎖定鈕；下方是「閒置現金／現金保留額」兩個輸入框、4 張資產試算小結卡、一顆「送出並同步雲端」。
2. **「買賣報價單」面板**（約行 2001–2239）：最上面「期初／建倉部位」每檔顯示「期初股數（可編輯）／期初平均成本（可編輯）」＋「期初現金（可編輯）」，一顆「建倉完成，儲存並同步」；接著是「新增一筆交易」表單與「交易紀錄」列表。

**使用者實際感受到的問題**：這兩塊「感覺功能重疊」。原因是資料模型上 **`現況 = 期初部位 ＋ 交易累算`**（`rebalanceStore.ts` 的 `aggregatePortfolio`），而使用者的日常工作流是「在玉山證券下單 → 按『真實同步』」。`真實同步`（`scripts/sync_fugle_holdings.py`）帶回的 payload 是 `opening = 真實庫存`、`trades: []`。因此**交易紀錄幾乎永遠是空的**，於是 `現況 = 期初 ＋ 0 = 期初`，上下兩個面板列出的 3 檔數字**完全相同** → 這就是「重疊」的來源。

（附帶背景：使用者原本也困惑「交易紀錄為什麼 0 筆」。答案是——交易紀錄只記錄用「新增一筆交易」表單手動輸入的交易；玉山的真實成交不會逐筆流進來，真實同步只覆蓋一張持倉快照到「期初部位」，且每次同步會把 trades 重設為 `[]`。本案不改這個機制，但合併後版面會把「期初 → 交易 → 現況」的因果**攤在同一列**，讓「為什麼現況等於期初」一眼自明，順帶消解這個困惑。）

**本案目標**：把上述兩個面板**合併成單一面板**，每檔標的**只出現一次**，用一列（桌機三區、手機堆疊）呈現完整血緣 **期初（可編輯輸入）→ 交易累算（衍生唯讀）→ 現況（衍生唯讀 ＋ 現價輸入 ＋ 市值）**。刪除重複列出，同時保留既有全部功能（抓價、鎖定、記帳、雲端同步、4 張小結卡）。

---

## 2. 設計原則（先建立共識）

- **這是純顯示層重排，零計算改動。** 合併後要用到的每一個數字**都已經存在**，只是換個位置擺：
  - 期初：`config.opening.shares` / `config.opening.avg_cost` / `config.opening.bonds[]` / `config.opening.cash`（可編輯，既有 `handleOpenChange` / `handleOpenCashChange`）。
  - 現況（衍生唯讀）：`config.shares` / `config.avg_cost` / `config.bonds[].shares` / `config.bonds[].avg_cost` / `config.cash`。
  - 現價（可編輯／抓價）：`priceStrs[code]` ＋ `handlePriceChange` ＋ `fetchLatestPrice` ＋ `priceFetch[code]`。
  - 市值、防守端、未實現損益、總資產：`result.etf_value` / `result.defensive_value` / `totalPnl` / `result.total_value` 等（已算好）。
  - 交易累算、已實現損益、超賣提示：`agg`（既有 `aggregatePortfolio` 的 memo，約行 545–558）。
- **不新增任何 state、不改任何 handler 的計算內容**（唯一可能的小改見 §5 決策點：閒置現金若改唯讀，`handleCashChange` 可停用/移除，屬可選）。
- **資料模型、後端、告警腳本、純函式、測試檔一律不動。** `git diff` 只應出現 `Rebalance.tsx`（若採 §5 建議動到 `handleCashChange` 也僅此一檔內）。
- 既有的「Beta 儀表 & 偏離分析」分頁、「整體邏輯」分頁、頁面最上方「TAIEX 市場狀態燈號」卡（含真實同步／狀態同步鈕、在途交割款區塊）**完全不動**。本案只重排 `activeTab === 'holdings'` 的內容。

---

## 3. 合併後版面規格（`activeTab === 'holdings'` 區塊）

合併成**一個大面板**，標題建議：「持倉總覽（期初 → 交易 → 現況）」，`<h2>` 樣式沿用既有面板標題（`text-sm font-semibold`＋左側小圓點），右側保留既有的「全部抓最新價」按鈕（`fetchAllPrices`，約行 1720–1732）。面板內由上而下：

1. 每檔標的一張合併卡（§3.1）
2. 現金列（§3.2）
3. 資產試算小結 4 張卡（§3.3，原樣搬過來）
4. 新增交易表單 ＋ 交易紀錄列表（§3.4，原樣搬過來）
5. 單一「送出並同步雲端」頁尾按鈕（§3.5）

### 3.1 每檔標的合併卡（取代原「持倉現況每列」＋原「期初部位每列」）

桌機三區橫向、手機（<640px）三區縱向堆疊。ASCII 目標樣貌（桌機）：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 00631L 台灣50正2                                        [↻ 抓最新價]            │  ← 債券列在此再加 [🔓未鎖/🔒已鎖]
│ ┌─ 期初部位（可編輯）─┐  ┌─ 交易累算 ─┐  ┌──────── 現況（衍生，唯讀）────────┐ │
│ │ 期初股數 [ 30000 ]股 │  │  +2,000 股  │  │ 現況股數  32,000 股              │ │
│ │ 期初成本 [ 35.68 ]元 │  │  （共 4 筆）│  │ 平均成本  $35.42                │ │
│ └─────────────────────┘  └─────────────┘  │ 現價 [ 38.80 ]元   市值 $1,241,600│ │
│                                            └──────────────────────────────────┘ │
│ （抓價狀態列：已帶入即時報價 13:31:05 / 抓取失敗… ，沿用既有那行 h-3 小字）        │
└──────────────────────────────────────────────────────────────────────────────┘
```

規格：

- **迭代來源**：沿用既有 `ASSETS.map`（`ETF_CODE` ＋ `BOND_ETFS`）。判斷 `isEtf = a.code === ETF_CODE`。
- **卡片標題列**：`{code} {name}`；債券加既有「防守端 β≈0」小標籤；右側按鈕群沿用既有：債券顯示「鎖定/解鎖」鈕（`config.locked.bonds[code]` 切換，邏輯照原行 1752–1779 不變）＋「抓最新價」鈕（`fetchLatestPrice(a.code)`，照原行 1780–1788 不變）。00631L 不顯示鎖定鈕（沿用 opt19 決策）。
- **期初部位區（可編輯）**：兩個 input——期初股數、期初平均成本。value 綁 `openStrs[a.code].shares/avg`，onChange 呼叫既有 `handleOpenChange(a.code, 'shares'|'avg', val)`（**邏輯不變**）。樣式比照原「買賣報價單期初部位」的 input（`bg-zinc-950 border-zinc-800`）。此區可用略次要的視覺權重（例如區塊小標「期初部位」用 `text-[10px] text-zinc-500`），因為它是設定一次＋之後由真實同步覆蓋，日常焦點在「現況」區。
- **交易累算區（衍生，唯讀）**：
  - 淨股數變化 = `現況股數 − 期初股數`。ETF：`config.shares - config.opening.shares`；債券：`bond.shares - openingBond.shares`（`openingBond = config.opening.bonds.find(code)`）。顯示帶正負號：`+2,000 股` / `−1,000 股` / 無變化顯示 `—`。正用中性或紅色系、負用綠色系皆可，建議 `+` 用 `text-zinc-300`、`−` 也用 `text-zinc-300`（純資訊，不要跟買賣配色搶眼）。
  - 筆數 = 該標的交易筆數 `config.trades.filter(t => (t.code ?? ETF_CODE) === a.code).length`，顯示「（共 N 筆）」；N=0 時整區顯示 `—`（並可加灰字「無交易」），讓「現況＝期初」自明。
- **現況區（衍生 ＋ 現價）**：
  - 現況股數（唯讀）：ETF `config.shares`、債券 `bond.shares`。沿用原唯讀 input 樣式（`bg-zinc-900/60 cursor-not-allowed`）或改純文字皆可，但要標明「（衍生）」語意。
  - 平均成本（唯讀）：ETF `config.avg_cost`、債券 `bond.avg_cost`；0 顯示 `—`。
  - 現價（可編輯）：input value 綁 `priceStrs[a.code]`，onChange `handlePriceChange`（**不變**）。
  - 市值（唯讀）：`Math.round(shares * price)`（沿用原行 1833–1837 的算法與配色：ETF `text-blue-400`、債券 `text-cyan-400`）。
- **抓價狀態列**：沿用原行 1840–1848 的 `h-3` 小字（抓取失敗／已帶入即時報價時間），放卡片底部。

> 佈局實作提示：桌機三區可用 `grid`（例如 `sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]` 或 flex），手機 `grid-cols-1` 堆疊。務必讓「期初 → 交易 → 現況」由左至右的因果順序在桌機成立。

### 3.2 現金列（取代原「閒置現金／現金保留額」兩框 ＋ 原「期初現金」框）

現金比照標的卡的「期初 → 交易 → 現況」血緣，但終點另接「現金保留額」：

```
現金  期初現金 [ 804578 ]元  →  交易現金流 −$71,200  →  閒置現金 $733,378（衍生）   │  現金保留額 [ 100000 ]元 [🔒已鎖定]
```

- **期初現金（可編輯）**：input 綁 `openCashStr`，onChange `handleOpenCashChange`（**不變**）。這是現金的唯一真實輸入。
- **交易現金流（衍生，唯讀）**：`agg.cash - config.opening.cash`（沿用既有 `handleCashChange` 內 `tradesCashDelta` 同一算式）。帶正負號金額，`+` 綠、`−` 琥珀。
- **閒置現金（衍生，唯讀）**：`config.cash`（＝ `Math.max(0, agg.cash)`）。**改為唯讀顯示**（見 §5 決策點）。保留原「買進超過期初現金」的 amber 警示：`agg.cash < 0` 時顯示 `⚠ 買進金額已超過期初現金 $X，以 0 計算`（沿用原行 1870–1874 文案）。
- **現金保留額（可編輯）＋鎖定鈕**：input 綁 `cashReserveStr`，onChange `handleCashReserveChange`（**不變**）；鎖定鈕切換 `config.locked.cash`（照原行 1880–1902 不變）；下方保留額說明小字沿用原行 1916–1924。

### 3.3 資產試算小結（4 張卡，原樣保留）

原行 1929–1963 的四張卡（00631L 市值 / 防守端（現金＋債券）/ 未實現損益（含債券）/ 投組總資產現值）**原封不動搬進合併面板底部**，資料來源與配色全不變。

### 3.4 新增交易表單 ＋ 交易紀錄列表（原樣保留，移入合併面板）

- 「新增一筆交易」表單（原行 2108–2190）：標的下拉、方向、日期、股數、成交價、「新增一筆並同步」鈕，`addTrade` 邏輯與買賣配色（`tradeSideCls`）**全不變**。
- 「交易紀錄（N 筆）」列表（原行 2192–2238）：`tradesSorted`、已實現損益、超賣提示、刪除鈕（`deleteTrade`）**全不變**。標題的「（{config.trades.length} 筆）」保留——它現在跟 §3.1 各卡的「共 N 筆」呼應，使用者能看懂「0 筆 ⇒ 各標的現況＝期初」。
- 可加一行既有語氣的灰字說明（`text-[11px] text-zinc-500`），例如：「交易紀錄僅記錄此處手動新增的買賣；『真實同步』從玉山帶回的是持倉快照（覆蓋上方各標的期初部位），不會逐筆列進交易紀錄。」——把 §1 那個困惑就地解答。

### 3.5 單一「送出並同步雲端」頁尾按鈕

原本有兩顆同步鈕（持倉現況底部「送出並同步雲端」行 1989–1996、買賣報價單「建倉完成，儲存並同步」行 2092–2099）。合併後**只留一顆**放合併面板最底部，文案用「送出並同步雲端」，`onClick={() => void syncToCloud(config)}`、disabled/狀態列（`cloud.status`）沿用原行 1966–1997 那組。原「建倉完成，儲存並同步」整段刪除（含其上方那段「真實同步已移到頁面最上方」的灰字提示——真實同步鈕本來就已在頁頂，這段說明可移除或保留一句即可）。

---

## 4. 要沿用、不可更動的既有邏輯（清單）

以下全部**照舊呼叫、不改內容**，本案只搬動它們的 JSX 位置：

- `handleOpenChange` / `handleOpenCashChange` / `handlePriceChange` / `handleCashReserveChange`
- `fetchLatestPrice` / `fetchAllPrices` / `priceFetch` / `priceStrs` / `openStrs` / `openCashStr` / `cashReserveStr`
- 鎖定切換（`applyConfig({ locked: ... })`）—— 債券與現金
- `addTrade` / `deleteTrade` / `tradesSorted` / `tradeCode` / `tradeSide` / `tradeDateStr` / `tradeSharesStr` / `tradePriceStr`
- `agg`（`aggregatePortfolio` memo）、`result`（`computeRebalance` memo）、`totalPnl` / `hasPnl` / `totalPnlPct`
- `syncToCloud`、`cloud` 狀態
- 買賣配色 `tradeSideCls` / `tradeCodeCls`

---

## 5. 決策點（實作前確認，預設採建議做法）

**閒置現金：唯讀衍生（建議）vs 保留可編輯。**

- 現況：`持倉現況` 的「閒置現金」可手動覆寫（`handleCashChange` 會反解回 `opening.cash`），同時「買賣報價單」的「期初現金」也可編輯——兩個現金輸入框互相反解，正是本案要消除的重疊。
- **建議**：期初現金＝唯一可編輯輸入；閒置現金＝唯讀衍生（`config.cash`）。這樣「期初＋交易＝現況」對現金也成立、與各標的一致，心智模型統一。採此做法時 `handleCashChange` 與 `cashStr` state 可移除（或保留 state 僅供顯示）。
- 若你想保留「直接改閒置現金」的便利（例如懶得回頭改期初現金時快速修正），則閒置現金維持可編輯、`handleCashChange` 不動——但這樣現金列就不是純粹的「期初→交易→現況」唯讀終點，需接受這個小不一致。
- **預設按「建議」實作；若你要保留可編輯，開工時講一聲即可。**

---

## 6. 手機窄螢幕（RWD）

- 每檔合併卡在 <640px 時三區縱向堆疊（期初 → 交易 → 現況），輸入框全寬，不橫向溢出。
- 現金列在窄螢幕改為縱向：期初現金 / 交易現金流 / 閒置現金 / 現金保留額 逐塊堆疊。
- 按鈕（抓最新價、鎖定）沿用既有 `text-[11px]`／`w-3 h-3` icon 尺寸慣例，375px 寬不換行破版。
- 4 張小結卡沿用既有 `grid-cols-2 sm:grid-cols-4`。

---

## 7. 驗收標準

1. `npm run build`（＝`tsc -b` ＋ `vite build`）**乾淨無錯**。（注意：VM 上 `npm run build` 用的 `tsc -b` 比本機 `tsc --noEmit` 嚴格，請直接跑 `npm run build` 本身驗證，勿只跑 type-check。）現有 vitest 全綠（本案不新增/不改測試，但既有測試不能被牽動而紅）。
2. **數字對照改版前一致**（用截圖現況：00631L 期初 30000@35.68、00687B 10000@28.18、00953B 20000@9.7、期初現金 804578、保留 10 萬、交易紀錄 0 筆）：
   - 各標的卡「現況股數＝期初股數」、「交易累算＝—（共 0 筆）」；
   - 4 張小結卡數字與改版前相同：00631L 市值 ≈ $1,067,400、防守端 ≈ $1,276,678、未實現 ≈ −$6,700、總資產 ≈ $2,344,078（依當下現價會浮動，重點是與合併前同一時刻一致）。
3. **手動新增一筆交易**（例如買進 00631L 1,000 股 @ 38.8）後：該標的卡「交易累算」顯示 `+1,000 股（共 1 筆）`、現況股數 = 期初 + 1,000、平均成本與閒置現金隨之更新、交易紀錄列表出現該筆、雲端同步狀態變「已同步」。刪除後全部回復。
4. **鎖定/抓價功能不退化**：債券鎖定鈕、單檔「抓最新價」、標題「全部抓最新價」皆正常；抓價後現價與市值更新。
5. 只剩**一顆**「送出並同步雲端」按鈕，按下正常寫雲端（`data/rebalance_holdings.json`）。
6. `git diff` 只碰 `review-web/src/pages/Rebalance.tsx`（若採 §5 建議移除 `handleCashChange` 也在同檔內）。**未動** `lib/rebalance.ts`、`lib/rebalanceStore.ts`、`routes/rebalance.js`、`scripts/rebalance_alert.cjs`、任何測試檔、任何 `/api`。
7. 手機模擬 375px 寬：合併卡與現金列不破版、不橫向溢出。
8. 「Beta 儀表 & 偏離分析」「整體邏輯」兩分頁與頁頂市場狀態卡外觀行為不變。

---

## 8. 不做 / 備註

- **不改真實同步機制**：`sync_fugle_holdings.py` 仍寫 `opening=庫存, trades:[]`；本案只讓「期初→現況」在畫面上顯性化，不試圖把玉山成交還原成逐筆交易紀錄（那是另一個獨立、且需要券商成交明細 API 的大題目，不在本案範圍）。
- **不動資料模型與 KEY**：`rebalanceStore.ts` 的 `RebalanceConfig`、`normalizeConfig`、`review:rebalance:v1` 全不變——這是純顯示重排。
- **不改告警腳本**：`rebalance_alert.cjs` 讀同一份持倉檔的頂層衍生值，本案零後端改動，對它零影響。
- 若之後覺得合併面板太長，可再開獨立提示詞把「新增交易＋交易紀錄」做成可摺疊子區塊（本案先不做，保持單次改動聚焦於「消除重複列出」）。
