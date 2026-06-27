# 優化專案 1 — 個股多維度審查「資料夾化」（我的持股／有潛力的／其他）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt1-folders.md`，然後根據裡面的說明進行」。
> 本案是 Phase 0–8 全案完工後的**優化專案**，與專案 2/3/4 並行；建議順序 **1 → 2 → 3**（2 用本案資料夾、3 複用 2 的搜尋元件），4 獨立。

## 1. 本案目標

把側邊欄「個股多維度審查 (TSMC)」這個單一寫死入口，改成**可展開的資料夾結構**：點開後下面顯示三個分類資料夾，各資料夾再展開列出裡面的個股，點個股 → 進 `/stock/:code` 審查頁。

三個固定分類：
- **我的持股**（`holdings`）— 我現在手中有的部位
- **有潛力的**（`potential`）— 觀察中、看好的
- **其他**（`others`）— 其餘

⚠️ 本案**只做資料夾骨架＋顯示＋移除＋持久化**。「搜尋並加入個股」是專案 2 的事；本案先把資料模型與 UI 立起來，並把目前寫死的 2330/2454/2317 收進資料夾當種子資料。

## 2. 架構鐵律（務必遵守）

- 🚨 **無後端、無登入、無 DB**：使用者自管清單一律存 **`localStorage`**（與既有 `aiReview:{code}:{date}` 快取同模式）。本案**零後端改動**。
- 前端只打既有 `/api`、不直連 engine、不重算數字。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源。
- 既有「自選與焦點審查清單 (Watchlist)」（Dashboard 那張、來自 `/api/watchlist`）**本案不要動**——那是後端算的焦點清單，使用者自管的「自選」是專案 3 的事，兩者分開。
- TS 嚴格：`tsc -b && vite build` 必須乾淨。

## 3. 現況（實查）

- `review-web/src/components/Layout.tsx:34-37`：`navItems` 寫死兩項，第二項 `{ path: '/stock/2330', label: '個股多維度審查 (TSMC)' }`。
- `review-web/src/pages/StockDetail.tsx:11`：`const activeCode = code || '2330'`（URL `:code` 驅動，**真實模式股名來自 API**，可吃任意代號）。
- `StockDetail.tsx:2266-2276`：頁內「2330/2454/2317」**寫死的切換 tab**（本案可先不動，專案 2 會改成資料夾驅動；若你想本案順手改成讀資料夾也可，但非必做）。
- `StockDetail.tsx` 內 `c === '2330' ? '台積電' : …` 之類**只在 DEV mock 產生器**（`useMock`）出現，真實模式不影響任意代號 → 本案不必處理。

## 4. 規格

### 4.1 新增共用 store：`review-web/src/lib/userStore.ts`（本案建立，專案 2/3 會擴充）

```ts
// 使用者自管清單：純前端 localStorage，無後端。專案 1 建資料夾，專案 3 會在此加自選 watchlist。
const VERSION = 'v1';
const FOLDERS_KEY = `review:folders:${VERSION}`;

export interface UserStock {
  code: string;        // 台股代號，如 '2330'
  name: string;        // 加入當下解析到的股名（顯示用；空字串可接受）
  added_at: string;    // ISO 時間
  note?: string;
}

export type FolderId = 'holdings' | 'potential' | 'others';

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'holdings',  label: '我的持股' },
  { id: 'potential', label: '有潛力的' },
  { id: 'others',    label: '其他' },
];

export type FolderMap = Record<FolderId, UserStock[]>;

// 讀取（含遷移/種子）、寫入、加入、移除、跨資料夾移動、訂閱變更
export function getFolders(): FolderMap { /* 讀 localStorage，缺鍵回種子（見 4.3） */ }
export function addToFolder(folder: FolderId, stock: UserStock): void { /* 去重（同 code 不重覆）、寫回、emit */ }
export function removeFromFolder(folder: FolderId, code: string): void { /* 寫回、emit */ }
export function moveStock(from: FolderId, to: FolderId, code: string): void { /* 專案 2 會用；本案可先實作 */ }
export function subscribeFolders(cb: () => void): () => void { /* 見 4.4 跨元件同步 */ }
```

- **去重規則**：同一 `code` 在「同一資料夾」不重覆；跨資料夾是否允許同股，本案**允許**（例：我的持股也可同時在有潛力的）。專案 2 加入時若已在該資料夾則忽略。
- 寫入一律經由上述函式（不要在元件裡直接 `localStorage.setItem`），確保 emit 變更事件。

### 4.2 側邊欄資料夾 UI（`Layout.tsx`）

把第二個 nav 項從單一連結，換成**可展開的「個股多維度審查」群組**：

```
📊 個股多維度審查            ▸/▾   ← 點整列展開/收合（記住展開狀態於 localStorage，可選）
   ├ 📁 我的持股 (n)         ▸/▾
   │    • 台積電 2330        ← 點 → /stock/2330；hover 顯示「移除」小鈕
   │    • …
   ├ 📁 有潛力的 (n)         ▸/▾
   └ 📁 其他 (n)             ▸/▾
```

- 每個資料夾標題顯示**該夾檔數 `(n)`**；展開後列出 `UserStock`（股名＋代號）。
- 點個股 → `<Link to={'/stock/'+code}>`；目前 `activeCode` 對應的那檔要 highlight（沿用既有 active 樣式邏輯）。
- 每筆 hover 顯示「移除」鈕（`removeFromFolder`）；移除要有 `window.confirm` 或就地 undo（你拍板，至少別誤刪無回饋）。
- 空資料夾顯示淡色「尚無個股（用搜尋加入）」佔位（搜尋是專案 2，本案文案先放著）。
- **手機 RWD**：側欄在 `md` 以下會橫向收合（現況 `aside` 為 `w-full md:w-64`）——資料夾樹在窄寬度也要能展開不破版（可在小螢幕預設收合）。
- 圖示沿用 `lucide-react`（如 `Folder`/`FolderOpen`/`ChevronRight`/`ChevronDown`），與現有風格一致。

### 4.3 種子資料（首次無 localStorage 時）

首次（或鍵不存在）回傳種子，**保留現有三檔不消失**：
```
holdings:  []
potential: []
others:    [ {2330 台積電}, {2454 聯發科}, {2317 鴻海} ]   // added_at 用當下時間
```
> 之後使用者可在專案 2 把它們搬到「我的持股／有潛力的」。種子只在「鍵完全不存在」時寫入一次，別每次覆蓋使用者編輯。

### 4.4 跨元件同步（側欄即時更新）

專案 2/3 會在別的頁面加股，側欄要即時反映。用**輕量無依賴**做法：
- store 內部用一個 `EventTarget` 或 `window.dispatchEvent(new CustomEvent('userstore:folders'))`；`subscribeFolders` 內 `addEventListener` 對應事件＋同源跨分頁的原生 `storage` 事件。
- 側欄元件 `useEffect` 訂閱 → 變更時 `setState` 重讀 `getFolders()`。
- **不要**為此引入 Redux/Zustand 等新依賴（沿用全案零多餘依賴原則）。

## 5. 工作清單

- 新增 `review-web/src/lib/userStore.ts`（資料夾 store＋種子＋訂閱）。
- 改 `review-web/src/components/Layout.tsx`：第二 nav 項換成可展開資料夾樹，串 store，含展開/收合、檔數、移除、active highlight、RWD。
- （可選）`StockDetail.tsx:2266-2276` 頁內切換 tab 改讀資料夾；非必做，可留給專案 2。
- （可選）展開狀態記憶於 localStorage。

## 6. 驗收標準

- [ ] 側欄「個股多維度審查」可展開，下面顯示三個資料夾：我的持股／有潛力的／其他，各顯檔數。
- [ ] 首次開站，「其他」內含 2330/2454/2317（種子），點任一檔正確進 `/stock/:code`。
- [ ] 可在側欄移除某檔，重新整理後狀態保留（localStorage 持久化）。
- [ ] 所有寫入經 store 函式、無元件直接操作 localStorage；變更後側欄即時更新（subscribe 生效）。
- [ ] 種子只在鍵不存在時寫入一次，不覆蓋使用者後續編輯。
- [ ] 零後端改動；未動 Dashboard 的 `/api/watchlist` 卡；未動 `web/`；`snake_case`/既有風格一致。
- [ ] 手機寬度資料夾樹不破版。
- [ ] `tsc -b && vite build` 乾淨。

## 7. 坑（帶進 review）

- localStorage 是**字串**：寫入 `JSON.stringify`、讀出 `try/catch JSON.parse`，壞資料要能回種子不白屏（沿用 `StockDetail` 讀 `aiReview` 快取的 try/catch 模式）。
- 種子覆蓋陷阱：別在每次 `getFolders()` 都寫種子，只有「鍵不存在」才種一次。
- `activeCode` highlight 要用 `useLocation`/`useParams` 對齊現有 active 樣式，別只比字串前綴誤判。
- 任意代號進 `/stock/:code` 在**真實模式**股名來自 API；DEV `?mock=1` 下非 2330/2454/2317 會顯示 mock 預設名，屬已知、本案不處理。
</content>
</invoke>
