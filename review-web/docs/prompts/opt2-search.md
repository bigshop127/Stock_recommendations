# 優化專案 2 — 個股搜尋 ＋ 手動加入／移除資料夾

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt2-search.md`，然後根據裡面的說明進行」。
> **相依**：本案接續 **專案 1（資料夾 store `lib/userStore.ts` 已存在）**。請先完成專案 1。本案產出的 `<SymbolSearch>` 元件，專案 3、4 會再複用。

## 1. 本案目標

讓我可以**自己搜尋任一檔台股**（用代號或股名），搜到後**手動加入**某個資料夾（我的持股／有潛力的／其他），或從資料夾**移除**。等於把「個股多維度審查」從寫死的 2330/2454/2317 解放成「任意個股、我自己管」。

## 2. 架構鐵律

- 前端**只打 gateway `/api`**，不直連 engine。
- 搜尋走**新後端端點**（engine + gateway），複用 engine 既有 `TaiwanStockInfo`（全市場代號/股名、已記憶體快取）——**不要**在前端塞靜態股票清單（會過時、肥 bundle）。
- 使用者清單仍只存 **localStorage**（專案 1 的 `lib/userStore.ts`），本案不為清單建任何後端儲存。
- `snake_case` 欄位；不動 `web/`、不改壞 `puhui_daily.cjs`。
- `tsc -b && vite build` 乾淨；engine `pytest` 綠。

## 3. 後端規格（新端點：股票搜尋）

### 3.1 engine：`GET /data/symbols/search?q=<關鍵字>&limit=20`

- 資料源：複用 `engine/app/data/finmind_client.py` 既有 `TaiwanStockInfo`（見 `get_stock_name`、`_load_name_code_map`，已記憶體快取整表）。建議在 `finmind_client.py` 補一個 `list_symbols() -> list[{stock_id, stock_name}]`（用同一份 `_finmind_get("TaiwanStockInfo", "", …)`、一次性快取），`service.py` 加 `search_symbols(q, limit)` 做比對。
- 比對規則：`q` 對 **代號前綴**（`stock_id.startswith(q)`）或 **股名子字串**（`q in stock_name`）皆命中；去重、依「代號數字小→大」或「代號前綴完全相符優先」排序；截斷 `limit`（預設 20、上限 50）。
- 只收一般上市櫃股票（沿用 `_load_name_code_map` 的篩選：4~6 碼、可帶尾字母），排除權證/期權雜訊。
- 回應契約（`snake_case`）：
```jsonc
{ "query": "台積", "count": 1,
  "results": [ { "code": "2330", "name": "台積電" } ],
  "source": "FinMind TaiwanStockInfo" }
```
- 降級：FinMind 取不到（`DataSourceError`）→ 回 `{ "query": q, "count": 0, "results": [], "source": "...", "degraded": true }`，**不要 500**。
- 測試：`engine/tests/` 加最小測試（mock TaiwanStockInfo dataframe → 代號前綴/股名子字串各一命中、空 q、limit 截斷）。

### 3.2 gateway：`GET /api/symbols/search?q=&limit=`

- 薄轉發 engine `/data/symbols/search`，**長 TTL 快取**（股票清單極少變，建議 ≥ 6 小時；可用既有 cache 工具，沿用 `/api/stocks/:code/news` 的 TTL 快取寫法）。
- engine down → graceful degradation：回 `{ results: [], degraded: true }` 或既有降級錯誤格式（沿用全案降級語意），**前端要能容忍空結果不破版**。
- 對齊 `docs/api.md` / `review-web/docs/contracts.md` 補本端點契約。

## 4. 前端規格

### 4.1 `lib/api.ts` 新增

```ts
export interface SymbolHit { code: string; name: string; }
export interface SymbolSearch { query: string; count: number; results: SymbolHit[]; source: string; degraded?: boolean; }
// api.symbolSearch(q, limit?) => req<SymbolSearch>(`/symbols/search${qs({ q, limit })}`)
```

### 4.2 共用元件 `review-web/src/components/SymbolSearch.tsx`（專案 3/4 會複用）

一個自帶搜尋框的下拉/彈窗元件：
- 輸入框（placeholder「搜尋代號或股名，如 2330 / 台積電」）＋ **debounce 約 300ms** 再打 `api.symbolSearch`。
- 結果清單：每列「股名 代號」＋一顆「加入」動作；點「加入」呼叫 `props.onPick(hit)`（由父層決定加去哪個資料夾）。
- 三態：載入中 spinner、無結果「查無符合個股」、錯誤/降級「搜尋暫時無法使用」皆不破版。
- 鍵盤可用（↑↓ 選、Enter 加入、Esc 關）為加分，不強制。
- Props 介面建議：`{ onPick: (hit: SymbolHit) => void; placeholder?: string; autoFocus?: boolean }`。
- **不自管「加去哪」**——把「選哪個資料夾」交給使用它的頁面（見 4.3）。

### 4.3 在「個股多維度審查」串起加入／移除

- **加入**：在側欄資料夾樹（專案 1）每個資料夾標題旁放「＋」鈕 → 開 `<SymbolSearch>`（彈窗或就地展開），選股後 `addToFolder(folderId, { code, name, added_at })`。
  - 或：放一顆全域「＋ 加入個股」鈕 → 彈窗內先選資料夾再搜尋加入。你拍板 UX，二擇一即可，但要能指定加去哪個資料夾。
- **移除**：沿用專案 1 的 `removeFromFolder`（資料夾樹每筆的移除鈕）。
- **跨資料夾移動**（例：把 2330 從「其他」搬到「我的持股」）：用 `moveStock(from, to, code)`；UI 可在每筆的「⋯」選單提供「移到 ▸ 我的持股/有潛力的/其他」。**建議做**（符合你「自己管理分類」的訴求）。
- 加入後股名以搜尋結果的 `name` 為準；side panel 即時更新（專案 1 的 subscribe 已就緒）。

### 4.4 （可選）頁內切換器改資料夾驅動

`StockDetail.tsx:2266-2276` 寫死的 2330/2454/2317 tab，可改成「讀目前資料夾全部個股」動態渲染，或改成一顆 `<SymbolSearch>` 快速跳轉。非必做，但能徹底去除最後的寫死三檔。

## 5. 工作清單

- 後端：`finmind_client.list_symbols()`＋`service.search_symbols()`＋engine route `GET /data/symbols/search`；gateway `GET /api/symbols/search`（長 TTL 快取＋降級）；engine 測試；契約文件。
- 前端：`api.ts` 加 `symbolSearch`＋型別；`components/SymbolSearch.tsx`；側欄/資料夾樹接「＋加入」「移除」「移動」；（可選）頁內切換器改資料夾驅動。

## 6. 驗收標準

- [ ] `GET /api/symbols/search?q=2330` 與 `?q=台積` 都能命中台積電；空 q 與無結果不報 500、回空陣列。
- [ ] 搜尋框 debounce、三態（載入/空/錯誤）皆不破版；engine down 時搜尋降級、頁面不崩。
- [ ] 可把任一搜到的個股加入指定資料夾，重新整理後保留；可移除；可跨資料夾移動。
- [ ] 加入/移除/移動後側欄資料夾樹即時更新（subscribe）。
- [ ] 後端清單來自 `TaiwanStockInfo`（非前端硬編清單）；gateway 對該端點長 TTL 快取。
- [ ] 前端只打 `/api`；未動 `web/`、`puhui_daily.cjs`；`snake_case`。
- [ ] engine `pytest` 綠；`tsc -b && vite build` 乾淨。

## 7. 坑（帶進 review）

- **TaiwanStockInfo 全表很大**：`list_symbols()` 一定要一次性記憶體快取（沿用 `_name_code_map` 的 lazy-cache 模式），別每次請求重抓。
- gateway 一定要**長 TTL 快取**搜尋結果，否則每次打字都打穿到 engine→FinMind。
- debounce 必做，否則逐字觸發 API。
- 去重：同 code 不重覆加入同資料夾；加入前檢查。
- 代號可能帶英文尾碼（如 ETF/特別股）；沿用 `_load_name_code_map` 既有 4~6 碼篩選，別讓權證灌進來。
- FinMind 額度：搜尋只讀 TaiwanStockInfo（一次抓全表後快取），正常不耗額度；但仍要 `DataSourceError` 降級不 500。
</content>
