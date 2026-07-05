# 優化專案 12 — 個股頁分頁化骨架（aistockmap 式 tab 版面，純前端重構）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt12-stock-tabs-shell.md`，然後根據裡面的說明進行」。
> 參考範本：aistockmap 個股頁（`aistockmap.com/c/3450`）八個分頁的**資訊架構**（基本資料／產業分析／財務分析／籌碼分析／ETF 持倉／技術分析／相關新聞／研究圖表）。**只借版面骨架，資料一律走我們自家引擎/TWSE。**
> **相依：無。本案零新後端、零新請求、零新資料源、零 LLM——只把 `StockDetail.tsx` 現有區塊重新編排進 tab 容器。**

---

## 0. 這批（opt12–16）的總方針（先讀，只寫一次）

使用者想把個股頁做成 aistockmap 那種「頂部固定報價＋下方分頁」的豐富版面。**決策已定，別踩回頭路**：

1. **不爬 aistockmap。** 它的題材 basket（高速光模組／矽光子與 CPO）、AI 智能摘要、市場定位、技術重心、主要產品/客戶皆為其**策展/AI/付費牆內容（IP）**，且站點有 Cloudflare（直接抓回 403）。我們**只仿它的資訊架構與視覺**，任何欄位資料都從**自家 engine（FinMind）或公開原始來源（TWSE/MOPS OpenAPI）**取得。
2. **拆成多份計劃書**，可獨立驗收、風險由低到高：
   - **opt12（本檔）**：純前端把現有長捲軸重排成 tab 骨架。**零風險、先做、先驗收。**
   - opt13：`基本資料` tab 的公司基本檔＋財務概況卡（需補公司 profile 資料源）。
   - opt14：`籌碼分析` tab 強化＝股權分散（大戶/散戶）＋三大法人/融資融券子頁。
   - opt15：`產業分析` tab＝**同產業同儕比較**（走自家 TWSE 產業別，不碰 aistockmap basket）。
   - opt16：`ETF 持倉` tab（資料源需調查，**選配、最低優先**）。
3. **本案（opt12）不新增任何資料**。缺資料的分頁（基本資料的 profile、產業分析、ETF 持倉）本階段先放**「敬請期待」佔位**，等 opt13–16 逐塊補。

---

## 1. 本案目標

把 `review-web/src/pages/StockDetail.tsx` 目前這串**長捲軸**：

```
頂部代號列/整理鈕 → renderHeader()（報價 header）→ <StockBriefCard>（opt8 摘要卡）
→ 【K線 + AI決策訊號 + 五檔】→ 【籌碼 ChipsCharts + 基本面 renderFundamentals】
→ 【新聞】→ renderAiReviewSection()（AI 全面審視）
```

重排成 **aistockmap 式版面**：

```
┌───────────────────────────────────────────────┐
│ 固定頂部：renderHeader()（報價）+ <StockBriefCard>（摘要卡）│  ← 永遠顯示，不進 tab
├───────────────────────────────────────────────┤
│ Tab 列：基本資料│產業分析│財務分析│籌碼分析│ETF持倉│技術分析│相關新聞│AI審視 │
├───────────────────────────────────────────────┤
│ Tab 內容區（只 render 當前 tab）                              │
└───────────────────────────────────────────────┘
```

**分頁對應現有區塊（本案只搬，不改內容邏輯）**：

| Tab | 內容來源（現有） | 本案動作 |
|---|---|---|
| 基本資料 | —（opt13 才補） | 佔位「基本資料整理中，敬請期待」 |
| 產業分析 | —（opt15 才補） | 佔位 |
| 財務分析 | `renderFundamentals()`（已有 估值/月營收/獲利能力/股利政策 子 tab） | 原封搬入 |
| 籌碼分析 | `<ChipsCharts>`（多天期法人/融資/外資） | 原封搬入 |
| ETF 持倉 | —（opt16 才補） | 佔位 |
| 技術分析 | K 線卡（`<PriceChart>` + 還原日K/分K 切換）＋ AI 交易決策訊號卡 ＋ 即時最佳五檔卡 | 原封搬入（三張卡） |
| 相關新聞 | 現有 News 區塊 | 原封搬入 |
| AI 審視 | `renderAiReviewSection()` | 原封搬入 |

> 報價 header 與摘要卡**不放進 tab**——它們是全頁摘要，任何分頁都該看得到（等同 aistockmap 頁頂「聯鈞 (3450)＋營收新高」恆常區）。

---

## 2. 規格（本案核心）

### 2.1 Tab 狀態與 URL 同步

- 新增 `const [tab, setTab] = useState<StockTab>(...)`，型別：
  ```ts
  type StockTab = 'basic' | 'industry' | 'financials' | 'chips' | 'etf' | 'technical' | 'news' | 'ai';
  ```
- **預設 tab = `'technical'`**（K線最常看；aistockmap 預設『基本資料』，但我們基本資料本階段還沒資料，故先落在技術面）。opt13 完成後可改預設為 `'basic'`。
- **與網址 query 同步**（沿用 SectorHeatmap 的 `useSearchParams` 手法）：`?tab=technical`。進頁讀 query 初始化、切 tab 用 `setSearchParams({ tab }, { replace: true })`。非法值 fallback 到預設。
- 換股（`activeCode` 改變）時 tab **不重置**（使用者常想跨股比同一面向）。

### 2.2 Tab 列 UI（沿用全站樣式）

- 一列可捲動的 tab bar：桌面平鋪、手機 `overflow-x-auto` 橫向捲動（**禁止**把整頁擠壞）。
- 樣式沿用站上既有 pill/underline 慣例（參考 `renderFundamentals()` 內既有子 tab 的 class：選中 `bg-primary text-white`／未選 `text-zinc-400 hover:text-zinc-200`，或 aistockmap 式底線 active）。二選一，做出來乾淨即可。
- 每個 tab 標籤：`基本資料 / 產業分析 / 財務分析 / 籌碼分析 / ETF 持倉 / 技術分析 / 相關新聞 / AI 審視`。
- **佔位分頁（basic/industry/etf）** 的 tab 標籤右上角加一顆小 `soon` 徽章（灰字小圓點或 `即將推出`），點進去顯示置中佔位卡：圖示＋「〔分頁名〕整理中，敬請期待」＋一句「資料將走自家 TWSE/FinMind，非爬取他站」。

### 2.3 內容區渲染

- **只 render 當前 tab 的內容**（`{tab === 'technical' && (...)}`），避免八區塊全掛在 DOM。
- **但資料抓取（各 `fetchXxx`）維持現有 mount 即抓的行為不變**——tab 只控制「顯示」，不控制「抓取」。理由：摘要卡（opt8）本就依賴 blended/日K/籌碼/基本面/新聞五個 state，若改成「切到該 tab 才抓」會讓頂部摘要卡缺料變灰態。**這是本案最重要的坑，務必保留現有 useEffect 抓取時機。**
- 例外可延後抓的：`renderAiReviewSection()` 內的 AI 全面審視本就是**按鈕觸發**（非自動抓），維持原狀。
- 「即時最佳五檔」的 `autoPoll`（5s 輪詢）**只在技術分析 tab 掛載時才有意義**——可選優化：`autoPoll && tab === 'technical'` 才輪詢，切走自動停（省請求）。非必要，但做了更好。

### 2.4 版面細節

- 技術分析 tab 內維持現有「K線 2/3 ＋ 右欄(AI決策+五檔) 1/3」的 `xl:grid-cols-3` 格局，原封不動。
- 財務分析／籌碼分析搬進 tab 後，因為單 tab 只顯示一塊，**可從原本的 `lg:grid-cols-2` 併排改成單欄滿版**（給圖表更多寬度，讀起來更像 aistockmap）。你決定；滿版通常較佳。
- 頂部原本那條「代號輸入 + 整理鈕」保留在最上方（tab 列之上或與報價 header 同排皆可）。

---

## 3. 驗收標準

1. `tsc -b && vite build` 乾淨、無 >500kB 新警告（本案不應顯著增肥，StockDetail chunk 變動 < 5kB）。
2. 八個 tab 可切換；`?tab=` 可深連結、重整後停在同一 tab；非法值回預設。
3. **頂部報價 header ＋ opt8 摘要卡在所有 tab 都在**，且摘要卡五軸/加扣分/觀察點**與改版前完全一致**（回歸：隨手抽 2330 對一次五軸分數）。
4. 財務/籌碼/技術/新聞/AI 五個既有分頁內容與改版前**逐項一致**（沒有掉圖、掉 tooltip、掉子 tab）。
5. 三個佔位分頁顯示「敬請期待」佔位卡、不報錯。
6. 手機寬度下 tab 列可橫向捲動、頁面不爆版。
7. 換股（改網址 `/stock/2454`）後 tab 保持不變、各區資料正常重抓。

---

## 4. 本案不做（交給後續）

- 任何新資料源 / 新端點 / 新後端（opt13–16）。
- 佔位分頁的實際內容（opt13 基本資料、opt15 產業分析、opt16 ETF）。
- 研究圖表分頁（aistockmap 的『研究圖表』——先不列入，未定義清楚前不做）。
- 動摘要卡與各既有卡的內部邏輯（純搬運，不重寫）。

---

## 5. 實作提示（避免踩雷）

- **抓取時機是最大地雷**：現有多個 `useEffect` 在 mount／換股時抓 header/kline/signal/chips/fundamentals/news。tab 化只改「顯示」層（在 return 的 JSX 包 `tab === ...`），**別把 fetch 移進 tab 切換**。改完務必回頭確認摘要卡不會因此變灰。
- 佔位卡抽一個小 `<ComingSoon label="基本資料" />` 元件，opt13/15/16 完成後逐一替換。
- tab 型別、預設值、URL key 抽成檔頂常數，opt13 要改預設時只改一處。
- 這 2600 行檔案很長：搬運時**用剪下貼上、不要重寫**既有 JSX，降低 review 對帳成本。可考慮把每個 tab 內容抽成 `renderTechnicalTab()` / `renderNewsTab()` 等小函式，讓主 return 變成一串 `renderXxxTab()`，可讀性大升（選做但推薦）。
