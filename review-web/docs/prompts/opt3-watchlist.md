# 優化專案 3 — 自選與焦點審查清單（Watchlist）可手動新增／刪除

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt3-watchlist.md`，然後根據裡面的說明進行」。
> **相依**：複用 **專案 2 的 `<SymbolSearch>` 元件**與 **專案 1 的 `lib/userStore.ts`**。建議專案 1→2 完成後再做本案。

## 1. 本案目標

Dashboard 首頁那張「自選與焦點審查清單 (Watchlist)」目前是**唯讀**（純顯示後端 `/api/watchlist` 算出的焦點股）。本案讓我能**自己手動新增／刪除**個股到「我的自選」，並與後端焦點股**並存顯示**、互不污染。

## 2. 關鍵設計：自選 vs 焦點，兩條清單分開

- **焦點股（焦點/系統）**：來自既有 `GET /api/watchlist`（engine 用老王＋多因子算的排行）。**唯讀**，使用者不可刪（刪了下次又被算回來，沒意義）。
- **我的自選（自選/使用者）**：使用者手動加的，存 **localStorage**（專案 1 的 `lib/userStore.ts`，新增 watchlist 區）。可任意增刪。
- 兩者在同一張卡**合併呈現**，但**來源標籤區分**（如徽章「焦點」紅/灰、「自選」藍）。同一檔同時在兩邊 → 顯示一列、兩個徽章都掛。
- 既有後端 `/api/watchlist` **不改**；不要把使用者自選寫回後端。

## 3. 現況（實查）

- `review-web/src/pages/Dashboard.tsx:205-223`：`fetchWatchlist()` 打 `api.watchlist()` 取 `res.items`，存 `watchlistState`。
- `Dashboard.tsx:630-697`：Watchlist 卡（`lg:col-span-2`），表格欄位＝代號/股名/波段評分/當沖機率/波段排名/當沖排名/標籤/操作（「進入審查」連 `/stock/:code`）。
- `WatchItem` 型別在 `lib/api.ts:68-79`（`code/name/source/swing_score/daytrade_prob/rank_swing/rank_daytrade/tags…`）。
- 自選股**沒有**這些後端評分（swing_score 等）——本案要處理「自選列缺評分欄」的呈現（見 5.3）。

## 4. store 擴充（`lib/userStore.ts`）

在專案 1 的 store 加「自選 watchlist」區（與資料夾平行，獨立 key）：
```ts
const WATCHLIST_KEY = `review:watchlist:${VERSION}`;   // UserStock[]
export function getUserWatchlist(): UserStock[] { /* 讀 localStorage，缺鍵回 [] */ }
export function addToWatchlist(stock: UserStock): void { /* 去重 by code、emit */ }
export function removeFromWatchlist(code: string): void { /* emit */ }
export function subscribeWatchlist(cb: () => void): () => void { /* 同資料夾的事件機制 */ }
```
- 自選**不種子**（預設空陣列），跟資料夾的種子分開。
- emit 機制沿用專案 1（CustomEvent + 原生 `storage` 事件）。

## 5. 前端規格（Dashboard Watchlist 卡）

### 5.1 加入區
- 卡片標題列右側放「＋ 加入自選」鈕 → 開 **專案 2 的 `<SymbolSearch>`**（彈窗或就地展開），選股 → `addToWatchlist({ code, name, added_at })`。

### 5.2 合併與呈現
- 載入時：`api.watchlist()`（焦點，沿用現有 fetch＋降級）＋ `getUserWatchlist()`（自選，本地）。
- 合併規則：以 `code` 為鍵 union；同 code 合併成一列，標籤集合含「焦點」「自選」對應徽章。
- 自選列加一顆「移除」鈕（垃圾桶 icon）→ `removeFromWatchlist(code)`；**焦點列不給移除**（或移除鈕 disabled＋tooltip「系統焦點股」）。
- subscribe 自選變更 → 即時重繪（不必重打 `/api/watchlist`）。

### 5.3 自選列缺後端評分欄的處理
自選股沒有 `swing_score`/`daytrade_prob`/排名。**不要**為此去逐檔打貴的 `/api/stocks/:code`（那會在首頁自動跑、違反鐵律）。做法二擇一：
- (A)【建議・省事】自選列這些數值欄顯示「—」，並提供「進入審查」連結讓使用者自己點進 `/stock/:code` 看完整分析。
- (B)【進階・可選】自選列「進入審查」旁加一顆**手動**「載入評分」小鈕，點了才打 `api.stock(code)` 回填該列 score（仍是使用者觸發、非自動）。預設不做。

### 5.4 既有焦點列維持原樣
焦點列的評分/排名/標籤/「進入審查」全照舊；只是多掛一個「焦點」徽章與（若也在自選）「自選」徽章。

## 6. 工作清單
- `lib/userStore.ts` 加自選 watchlist 區（get/add/remove/subscribe）。
- `Dashboard.tsx`：Watchlist 卡加「＋加入自選」（接 `<SymbolSearch>`）、合併焦點＋自選、自選列移除鈕、徽章區分、subscribe 即時更新、自選缺評分欄以「—」呈現。
- 型別：自選列可沿用 `WatchItem` 的子集或新增輕量型別；數值欄允許 `null/—`。

## 7. 驗收標準
- [ ] 可從首頁 Watchlist 卡搜尋並加入任一檔到「我的自選」，重新整理後保留（localStorage）。
- [ ] 可移除自選股；**焦點股不可被移除**。
- [ ] 焦點與自選**並存、來源徽章區分**；同 code 合併成一列掛兩徽章。
- [ ] 加/刪自選**不重打** `/api/watchlist`、**不**逐檔自動打 `/api/stocks/:code`（不違反「貴端點只手動觸發」鐵律）。
- [ ] 自選列缺評分欄以「—」呈現、不破表格；「進入審查」可正常進 `/stock/:code`。
- [ ] 既有後端 `/api/watchlist` 未改、`web/` 未動、`puhui_daily.cjs` 未動。
- [ ] subscribe 生效：在別處（如資料夾搜尋）加股不影響本卡；本卡加自選即時更新。
- [ ] `tsc -b && vite build` 乾淨。

## 8. 坑（帶進 review）
- 🚨 **別在首頁自動打貴端點**：`/api/stocks/:code`（含多因子）與 `/api/agents/decide` 都不可為了補自選評分而在 `useEffect` 自動逐檔跑。自選列預設顯示「—」。
- 自選 vs 焦點**語意別混**：焦點是後端算的、唯讀；自選是本地的、可刪。徽章與可刪性要對。
- 合併去重以 `code` 為準；同股兩來源只一列。
- localStorage try/catch 防壞資料白屏（沿用 `aiReview` 快取模式）。
- 著色沿用台股慣例（漲紅跌綠／BUY 紅），與全站一致。
</content>
