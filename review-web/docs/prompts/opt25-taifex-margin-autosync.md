# 優化專案 25 — 期交所保證金自動同步（指數類走 OpenAPI，股票／ETF 類維持手動）

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt25-taifex-margin-autosync.md`，然後根據裡面的說明進行」。
> **相依**：opt23 已完工；建議排在 opt24 之後（同一支排程可以順便帶）。
> **範圍**：🟡 gateway 一個新端點 ＋ 前端設定頁一顆按鈕。零 engine 改動、零新依賴。

---

## 0. 為什麼要做

保證金**直接決定追繳價與斷頭價**，是這整頁最敏感的參數。而期交所會依市場風險調整——通常在波動放大時**調高**，那正是你最需要正確數字的時候，也正是你最不會想起要手動去改設定的時候。

> 這不是假設性風險。本案規格撰寫當下（2026-07-29）核對期交所 OpenAPI，就發現專案內建的預設值已經過時：小型臺指原本寫 79,500 / 61,000，期交所 2026-07-28 的公告值是 **159,000 / 122,000**（差了一倍）。用舊值算出來的追繳價會嚴重樂觀。

---

## 1. 資料源調查結論（**已查證，不用重查**）

Claude 已於 2026-07-29 實測，結論如下：

### ✅ 指數類：有 OpenAPI，免爬蟲

```
GET https://openapi.taifex.com.tw/v1/IndexFuturesAndOptionsMargining
```

- 公開、免金鑰、回 JSON，實測 31 列。
- 欄位：`Contract`（**中文名稱**）、`ClearingMargin`、`MaintenanceMargin`、`InitialMargin`、`Date`（民國 `YYYYMMDD`）。
- 實際樣本（2026-07-28）：

| Contract | InitialMargin | MaintenanceMargin |
|---|---|---|
| 臺股期貨 | 636000 | 488000 |
| 小型臺指 | 159000 | 122000 |
| 微型臺指期貨 | 31800 | 24400 |

> ⚠️ **`Contract` 是中文名稱，不是代碼**。要自己做「中文名 → 代碼」的對照表。而且名稱不完全一致（`小型臺指` 沒有「期貨」兩字、`微型臺指期貨` 有）——**不要用模糊比對**，用明確的對照表，對不到就當作沒有這筆而不是猜一個。

### ❌ 股票／ETF 類：**沒有** OpenAPI 端點

已逐一探測過 `SingleStockFuturesAndOptionsMargining`、`StockFuturesAndOptionsMargining`、`EquityFuturesMargining`、`SingleStockMargining`、`StockMargining`、`MarginingStock` — **全部回 swagger 的 SPA 殼（1793 bytes），不存在**。

唯一來源是 `https://www.taifex.com.tw/cht/5/stockMargining` 的 HTML 表格（490KB，含下載連結）。

**決策：SRF / NYF 維持手動維護，本案不做爬蟲。** 理由：
1. 為了兩檔商品寫 HTML parser，維護成本大於收益（版面一改就壞，而且壞的時候是靜默的）。
2. 這與 opt14b 的立場一致——那次是「有免費官方源就走官方源」，這次是**沒有**官方結構化源，硬爬他站 HTML 不是同一件事。
3. 頁面本來就允許手動覆寫，且 UI 會標示資料來源與時間（見 §3.3），使用者知道哪些是自動、哪些要自己顧。

---

## 2. 後端：`GET /api/futures/margins`（`routes/futures.js`）

放在 `routes/futures.js`（不是 `routes/market.js`）——後者整支是 Python engine 的代理，而期貨頁刻意不依賴 engine。這點檔案開頭的註解已有先例（`/api/market/holidays` 就是這樣處理的），照做。

### 2.1 行為

比照同檔案裡 `/api/futures/quote` 與 `/api/market/holidays` 的既有寫法：

- 記憶體快取（保證金一天最多變一次，TTL 給 6 小時）
- **磁碟快取** `data/taifex_margins.json`，原子寫入（`.tmp` → rename）
- 期交所掛掉 → 回磁碟快取並標 `stale: true` + `stale_reason`；連磁碟都沒有才回 502

### 2.2 回應形狀

```jsonc
{
  "date": "2026-07-28",        // 民國轉西元後的 'YYYY-MM-DD'
  "source": "taifex-openapi",
  "fetched_at": "2026-07-29T...",
  "margins": {
    "TX":  { "initial": 636000, "maintenance": 122000, "clearing": 471000, "contract_name": "臺股期貨" },
    "MTX": { "initial": 159000, "maintenance": 122000, "clearing": 117750, "contract_name": "小型臺指" },
    "TMF": { "initial": 31800,  "maintenance": 24400,  "clearing": 23550,  "contract_name": "微型臺指期貨" }
  },
  "unmapped": ["臺指選擇權風險保證金(A)值", "..."],   // 對照表沒收錄的，回出來方便日後補
  "cached": false,
  "stale": false
}
```

### 2.3 中文名 → 代碼對照表

寫在 `routes/futures.js` 裡的常數。**只收錄期貨頁的 SYMBOL_PRESETS 有的指數類商品**：

```js
const MARGIN_NAME_TO_CODE = {
  '臺股期貨': 'TX',
  '小型臺指': 'MTX',
  '微型臺指期貨': 'TMF',
};
```

對不到的名稱**不要猜**，全部丟進 `unmapped` 陣列回出來。選擇權那幾筆（`臺指選擇權風險保證金(A)值` 之類）本來就不該對到期貨商品。

### 2.4 數值 sanitize

期交所回的是**字串**（`"636000"`）。要 `parseFloat` 並檢查：
- 非有限數 → 該商品整筆跳過（不要塞 0，0 會讓風險指標變成 Infinity）
- `initial < maintenance` → 該商品整筆跳過並記進 `unmapped`（這是明顯的資料異常，寧可不給也不要給錯的）
- 全部商品都跳過 → 當作抓取失敗，走 stale 路徑

---

## 3. 前端

### 3.1 API client（`lib/api.ts`）

```ts
getFuturesMargins: () => req<FuturesMarginsResp>('/futures/margins'),
```

### 3.2 「契約規格 & 設定」分頁加一顆「同步保證金」按鈕

放在既有的「還原成 XXX 的公告預設值」旁邊。行為：

1. 打 `/api/futures/margins`
2. 用 `config.contract` 去 `margins` 裡找
   - **找得到** → 比對目前設定值：
     - 相同 → 顯示「已是最新（期交所 YYYY-MM-DD 公告）」，不寫入、不打雲端
     - 不同 → **先顯示差異，要按第二次才套用**（見下方警語，這個確認步驟是必要的）
   - **找不到**（SRF / NYF 或自訂代碼）→ 顯示「這個商品期交所沒有提供 API，保證金請依期貨商通知手動維護」，不要當成錯誤
3. 套用後照既有 `saveToCloud(patch(...))` 的路徑寫回 `spec.initial_margin` / `spec.maintenance_margin`

**為什麼要兩段確認**：改保證金會**同時改掉追繳價與斷頭價**。如果你正好在追繳邊緣，一次點擊就讓危險價位跳動、卻沒讓你看到跳動的幅度，是很糟的體驗。差異畫面要明講：

> 原始保證金 79,500 → **159,000**（＋79,500／口）
> 這會讓你目前 8 口的所需原始保證金從 636,000 變成 1,272,000，
> 追繳價從 98.81 變成 XX.XX。

（追繳價的重算直接呼叫既有的 `summarizeAccount`，用新的 spec 跑一次即可，不需要新公式。）

### 3.3 資料來源標示

「契約規格與費用」卡的說明文字改成動態的：

- 有自動同步過 → 「保證金＝期交所 **2026-07-28** 公告（OpenAPI 自動同步）」
- SRF / NYF → 「保證金＝期交所 2026-06-18 公告，**這個商品沒有 API，需手動維護**」

不要繼續寫死「2026-06-18」——那個日期已經是過去式，寫死會讓人以為是最新的。

---

## 4. 選配：讓排程順便檢查（建議做，但可以晚一步）

`scripts/futures_alert.cjs` 每天都會跑，順便打一次 `/api/futures/margins`，發現**期交所公告值與 `data/futures_positions.json` 裡的 spec 不一致**時，在既有的告警信裡多一段：

```
── 保證金異動 ──
● 期交所 2026-07-28 公告：原始 159,000 / 維持 122,000
● 你目前設定：原始 79,500 / 維持 61,000
● 依新值重算，你的追繳價會從 98.81 變成 XX.XX
● 到「契約規格 & 設定」按「同步保證金」更新
```

**只通知、不自動改**。腳本自動改設定檔會讓網頁上的數字在你沒動它的時候變動，那比數字舊還糟。

去重：把「已通知過的公告日期」記進 `data/futures_alert_state.json`（`last_margin_notice_date`），同一個公告日只講一次。

---

## 5. 測試

### 5.1 後端手動驗收

```powershell
# 1. 正常抓
curl http://localhost:3000/api/futures/margins

# 2. 磁碟快取有寫進去
cat data/taifex_margins.json

# 3. 斷網／改壞 URL 後重打，應回 stale:true 而不是 502
```

核對三個數字是否等於 §1 表格（**這是驗收基準**）：TX 636000/488000、MTX 159000/122000、TMF 31800/24400。

> ⚠️ 沿用 opt14 的教訓：**換資料源後即使 HTTP 200 也要檢查數值合理性，不能只看狀態碼。** 這次尤其重要——保證金抓錯不會報錯，只會讓追繳價安靜地算錯。

### 5.2 前端

- 切到 MTX → 按「同步保證金」→ 應出現差異確認畫面且數字對得上
- 切到 SRF → 按「同步保證金」→ 應出現「沒有 API，手動維護」而不是紅字錯誤
- 期交所端點打不通時，按鈕不能讓整頁壞掉

---

## 6. 驗收標準

- [ ] `/api/futures/margins` 可用，有記憶體＋磁碟雙層快取，期交所掛掉回 stale 而非 502
- [ ] 中文名 → 代碼用明確對照表，對不到的進 `unmapped` **不猜**
- [ ] `initial < maintenance` 或非數字的資料整筆跳過，不會塞 0
- [ ] 三個商品的數字與 §1 表格一致
- [ ] 前端按鈕：找得到／已是最新／找不到 三種狀態各自有正確文案
- [ ] 差異需**兩段確認**，且確認畫面有顯示追繳價會變成多少
- [ ] 「契約規格與費用」的來源日期改成動態，SRF/NYF 標明需手動維護
- [ ] `npm run build` 與 `npx vitest run` 全綠

---

## 7. 不做／備註

- ❌ **不爬 `taifex.com.tw/cht/5/stockMargining` 的 HTML**（理由見 §1）。SRF / NYF 維持手動。
- ❌ **不自動改設定檔**。排程只通知，改動一律由使用者在網頁上按下確認。
- ❌ 不處理選擇權的風險保證金 A/B 值——這頁沒有選擇權。
- 📌 期交所這個端點回的是「**明日生效**」還是「今日適用」的公告值，規格撰寫時未逐字確認。實作時如果發現 `Date` 欄位與期貨商通知的生效日有一天落差，以期貨商通知為準，並把這個發現補回本文件。
- 📌 `ClearingMargin`（結算保證金）是給結算會員用的，跟散戶無關，收進回應只是備查，UI 不用顯示。
