# 個股全面審視網 — 專案總綱 ROADMAP

> 單一事實來源（SSOT）。任何進度／更新／優化都先改這份，再同步 Obsidian vault `C:\obsidian\儲存庫\個股全面審視網` 與 `.claude` 記憶。
> 建立日：2026-06-21。狀態：**Phase 0–8 ✅ 全案完工。Phase 8（整合・RWD 打磨・PWA・部署上既有 Oracle VM，gateway 同源 serve `review-web/dist`）2026-06-25 實作並部署完成：① 後端 gateway 同源 serve `review-web/dist` 在子路徑 `/review`；② 前端 base、Router basename、PWA scope/start_url 對齊 `/review`，未知路由重定向；③ RWD 斷點打磨及 `ChipsCharts` SVG 縮放 tooltip 比例修正；④ PWA 包含 192/512 PNG/maskable 圖標、manifest 修改與 API 快取從嚴設定；⑤ 效能分塊與路由 lazy-loading，使 build size 無 >500kB 警告。VM 上 `git pull` + `npm ci` + build + gateway 重啟及本機 `ssh -L` 與端點驗收全綠。**

> 〔Phase 6 紀錄〕Phase 6（新聞輿情・情緒）2026-06-24 實作完成並通過 Claude review：engine `service.get_stock_news`（code→股名、逐則詞典情緒、`published` ISO 化、整體輿情摘要）+ `/data/stock_news` 端點 + 抽共用 `classify_polarity` helper（複用 `factors/sentiment.py` 同一份極性詞典、F_sentiment 因子分數不變、回歸綠）；gateway `/api/stocks/:code/news` 薄轉發＋300s 短 TTL 快取；前端 `StockDetail.tsx` 新聞區（逐則情緒徽章＋整體輿情摘要 chip＋F_sentiment 交叉佐證＋相對時間＋載入/空/失敗三態＋手動刷新、無 5s 輪詢、無逐則 LLM）；著色利多=紅/利空=綠/中性=灰（台股慣例）；review 修掉 `docs/contracts.md §2.7` 契約同步、Google News 標題去除「- 媒體」尾、TS `url/published` 可為 null 的 runtime 安全。engine pytest 66 綠、`tsc -b && vite build` 乾淨。下一步 Phase 7（AI 全面審視・招牌段，複用 `POST /api/agents/decide`，按鈕觸發+localStorage 快取）。**

---

## 0. 一句話

做一個 **個股深度審視為主、完整盤勢總覽為輔** 的個人用財經網站，參考 Fugle AI 個股頁（`fugle.tw/ai/2330`）與 futures-ai 盤勢總覽（`alpha.futures-ai.com/market-overview`）；桌面為主、手機可用（RWD + PWA）。**前端全新，資料/AI 沿用既有「財經APP」的 engine + gateway，缺口才補新端點。**

---

## 1. 定案決策（2026-06-21 鎖定）

| 項目 | 定案 | 備註 |
|---|---|---|
| 專案定位 | **獨立前端**，新增資料夾 `review-web/`，與既有 `web/` 並存 | 不動既有 `web/` 與線上部署 |
| 後端 | **沿用既有 `engine`(FastAPI 8000) + `gateway`(Node 3000) 的 `/api`**；缺口在既有 repo 補新端點 | 不重接 FinMind/富果/yfinance；不重算分數 |
| 涵蓋範圍 | 個股深度審視（主軸）＋ **完整盤勢總覽（升格、提前到 Phase 1）** | 三大法人為重點，個股層級＋市場層級都做 |
| 技術棧 | Vite + React + TS + Tailwind + lightweight-charts | 與既有 `web/` 一致，元件可借用 |
| 版面 | **桌面優先 RWD**（多欄 dashboard）→ 手機自動收合單欄/分頁 | 與舊 `web/`（手機單欄）最大差異 |
| 行動 | **PWA**（manifest + service worker）→ 手機「加到主畫面」像 APP；保留 Capacitor 上架後路 | 不寫原生、不上架商店（現階段） |
| 對象 | 個人自用、免登入；走內網 / `ssh -L` | 不需 SEO/SSR → 不採 Next.js |
| 文件 | 本檔（SSOT）＋ Obsidian vault `個股全面審視網`（沿用財經APP 整理法） | 每階段完成後更新 |
| **API 命名** | **新端點欄位一律 `snake_case`**（2026-06-21 定）| 與既有 API/Python 後端一致，前端 client 不分裂；Phase 0 誤用的 camelCase 於 Phase 1 一併遷移 |

---

## 2. 架構

```
瀏覽器 (review-web, Vite+React, PWA)
        │  只打 /api（絕不直連 engine）
        ▼
Node gateway  server.cjs + routes/   ← 既有，本案會新增 /api/market/* 等端點
        │  代理 / 組合 / 降級
        ▼
Python engine  FastAPI :8000         ← 既有，本案會新增 /data 或 /market 端點吐原始/聚合資料
        │
        ▼
資料源：FinMind / 富果 / yfinance / TWSE MIS / TAIFEX / FRED / 新聞   ← 全部沿用
```

原則沿用既有系統鐵律：
- 前端**只打 gateway `/api`**，不直連 engine、不重算數字。
- gateway **只組合/轉發/降級**，數字一律吃 engine 與 `reports/`。
- engine 掛掉要 **graceful degradation**，不假裝成功。

---

## 3. 既有 `/api` 盤點 vs 缺口（Phase 0 要產出正式版，此為初判）

來源：`C:\CC AI Agent\docs\api.md`、`web/src/lib/api.ts`。

**既有可直接用：**
`GET /api/health`、`/api/dashboard`、`/api/stocks/:code`、`/api/stocks/:code/ohlcv?adjust=`、`/api/stocks/:code/book`、`/api/stocks/:code/intraday`、`/api/watchlist`、`/api/reports`、`/api/reports/list`、`POST /api/backtest`、`/api/backtest/grid`、`POST /api/agents/decide`。

| 模組 | 需要資料 | 既有端點 | 狀態 | 缺口處理 |
|---|---|---|---|---|
| 個股 K線 | 日K還原價、分K | `ohlcv?adjust=1`、`intraday` | ✅ 齊 | — |
| 個股 多因子訊號 | swing/daytrade/blended | `stocks/:code` | ✅ | — |
| 個股 五檔 | 即時最佳五檔+內外盤 | `stocks/:code/book` | ✅ | — |
| AI 全面審視 | 多 agent 敘事+評分 | `agents/decide` | ✅（**貴**：~187s/股、7×LLM） | 只按鈕觸發+快取 |
| 老王報告 | 報告 markdown | `reports`、`reports/list` | ✅ | emoji 語意相反，沿用既有規則 |
| 個股 報價頭部 | 現價/漲跌/開高低/量/市值/PE | `book`+`ohlcv`(部分) | 🟡 市值/PE 缺 | 併入「基本面」新端點 |
| 個股 技術指標 | MA/MACD/KD/RSI/布林 序列 | 只有 technical 因子分 | 🟡 | 前端用 `ohlcv` 自算（lightweight-charts） |
| **個股 籌碼面** | 三大法人買賣超趨勢、融資券、借券、大戶 | 無（engine 內部有 FinMind 法人餵因子） | ❌ **重點缺口** | **新端點** `/api/stocks/:code/chips` |
| **個股 基本面/財報** | PE/PB/殖利率、營收 YoY/MoM、EPS、財報 | 無 | ❌ 缺口 | **新端點** `/api/stocks/:code/fundamentals` |
| **個股 新聞輿情** | 新聞列表+情緒標記 | 無（engine 內部有新聞餵情緒因子） | ❌ 缺口 | **新端點** `/api/stocks/:code/news` |
| **盤勢 指數** | 加權/櫃買/電子/金融 即時+歷史 | `dashboard` 只給 water_level/regime | ❌ 缺口 | **新端點** `/api/market/indices` |
| **盤勢 廣度** | 漲跌家數、漲跌停、上漲比 | 無 | ❌ 缺口 | **新端點** `/api/market/breadth` |
| **盤勢 類股熱力圖** | 各類股當日漲跌幅 | 無 | ❌ 缺口 | **新端點** `/api/market/sectors` |
| **盤勢 市場三大法人** | TWSE 三大法人買賣超日表 | 無 | ❌ **重點缺口** | **新端點** `/api/market/institutional` |

> 結論：本案需在既有 repo 補 **~7 個新端點**（engine `/data|/market/*` + gateway `/api/market/*`、`/api/stocks/:code/{chips,fundamentals,news}`）。每階段在「後端工」欄列出。

---

## 4. 階段藍圖（Phase 0–8）

> 互動模式：**我（Claude）給「本階段希望看到的內容＋驗收標準」，你寫 code，再給我 review。** 每階段一支提示詞 `review-web/docs/prompts/phaseN.md`，你開新對話輸入「請你幫我去閱讀 …\phaseN.md，然後根據裡面的說明進行」。
> 每階段完成後，我會 **回頭審視下一支提示詞與現況的落差** 再放行。

| Phase | 主題 | 前端交付 | 後端工（既有 repo） | 狀態 |
|---|---|---|---|---|
| **0** | 骨架與契約盤點 | Vite 腳手架、Tailwind/設計 token、RWD 斷點策略、路由（`/` 首頁 + `/stock/:code`）、`/api` client、PWA 殼、正式版契約盤點文件 | 無（純盤點） | ✅ 已完工 |
| **1** | 盤勢總覽（完整） | 首頁：指數卡(+sparkline)、大盤水位、廣度/強弱(+20/50MA)、**類股熱力圖**、**市場三大法人買賣超總覽(近N日趨勢)**、自選/焦點股入口；順手收 snake_case 遷移 + mock 降級債 | `engine` + `gateway`：`/api/market/{indices,breadth,sectors,institutional}`（snake_case、indices 含 intraday/history、institutional 含 trend、breadth 含 limit_up/down+total） | ✅ 已完工 (2026-06-22) |
| **2** | 個股殼＋報價頭部＋K線 | `/stock/:code` 多欄殼、報價頭部、K線（還原價/日K/分K切換、五檔） | 沿用既有（市值/PE 留 Phase 4） | ✅ 已完工 (2026-06-22) |
| **3** | 個股籌碼面（重點） | 三大法人買賣超日/累計趨勢、融資券、（可選借券/大戶持股） | `/api/stocks/:code/chips` | ✅ 已完工 (2026-06-23) |
| **4** | 基本面・財報 | 估值 PE/PB/殖利率、營收 YoY/MoM、EPS 趨勢、財報摘要；回填報價頭部市值/PE | `/api/stocks/:code/fundamentals` | ✅ 已完工 (2026-06-23) |
| **5** | 技術面 | MA/MACD/KD/RSI/布林疊圖、量價、型態標註、技術因子分呈現 | 多由前端用 `ohlcv` 自算（必要時補端點） | ✅ 已完工 (2026-06-23) |
| **6** | 新聞輿情・情緒 | 新聞列表、逐則情緒徽章、整體輿情摘要 chip、F_sentiment 交叉佐證、三態+刷新 | `/api/stocks/:code/news`（薄轉發+短 TTL；engine `service.get_stock_news`+共用 `classify_polarity`） | ✅ 已完工 (2026-06-24) |
| **7** | AI 全面審視（招牌） | 複用 `POST /api/agents/decide` 多 agent 敘事+評分，**分段對齊實際 agent graph**：量化事實底座(blended)→技術＋籌碼/消息情緒/老王在地專家三分析師→多空辯論→交易員決策→風控審核→最終決策+信心+一致性守門(背離 warning)；**按鈕觸發**(~187s/7×LLM/股、貴)+localStorage 快取、用量遙測 | 沿用既有（gateway `/api/agents/decide` 已存在；**必要時**加輕量摘要端點省 token，預設零後端改動） | ✅ 已完工 (2026-06-24) |
| **8** | 整合・RWD打磨・PWA・部署 | 全頁整合、手機收合驗證、PWA 可裝成 APP、效能、部署上既有 Oracle VM（gateway 同源 serve） | gateway serve `review-web/dist`、systemd/部署 | ✅ 已完工 (2026-06-25) |

各階段「希望看到的內容」細節原寫在各自 `phaseN.md`（Phase 0 先寫、Phase 1+ 前一階段完成後才定稿）。**Phase 0–8 全數完工後，`phaseN.md` 已於 2026-06-27 隨提示詞收斂移除（歷史可查 git）**；**§8 優化專案 `opt1–4-*.md` 亦於 2026-06-28 全數完工後移除（同例，歷史可查 git，內容已濃縮進 §8 完工紀錄）**。現存提示詞＝維修啟動 `maintenance.md`、已完工留檔的 `opt5-sector-heatmap.md`、待實作的 `opt6-stock-heatmap.md` 與 `opt7-market-overview.md`（2026-07-02 定稿，見 §8）。

---

## 5. 互動模式與流程（每階段）

1. 你開新對話：「請你幫我去閱讀 `review-web\docs\prompts\phaseN.md`，然後根據裡面的說明進行」。
2. 新對話的 Claude 讀提示詞 → **複述本階段希望看到的內容、澄清疑問**（不直接寫產品 code）。
3. **你寫 code / 架構。**
4. 寫完 → Claude review：對照驗收標準找問題與修改處。
5. 通過後 → 更新本 ROADMAP（狀態）＋ Obsidian ＋ 記憶；**回頭審視下一支 `phaseN+1.md` 與現況落差**再放行。

## 6. 文件維護規則

- **SSOT＝本檔**。狀態、決策變更、缺口先改這裡。
- Obsidian vault `C:\obsidian\儲存庫\個股全面審視網`（沿用財經APP 整理法）：
  - `README.md`（索引）、`開發進度.md`（時序日誌）、`階段提示詞索引.md`
  - `1_系統概覽` / `2_盤勢總覽` / `3_個股審視` / `4_AI分析` / `5_API與契約` / `6_部署與運維`
- `.claude` 記憶：建一則 project 記憶指向本檔與 vault，方便未來新 session 銜接。

## 7. 沿用既有系統的坑（務必帶進每階段 review）

- 老王報告 **emoji 與股市相反**：🔴=看多 / 🟢=看空 / 🟠=中性觀望（與股市紅漲綠跌相反）；`/api/reports` 是 raw markdown，前端勿反向上色。
- 型別分歧：`water_level` float 0~1（另有中文 `water_level_text`）、`puhui_sentiment.score` 0~100。
- K線**預設還原價**（`ohlcv?adjust=1`）；未還原源對除權息/分割股（如 0050）會斷點失真。
- 分K/內外盤需 `FUGLE_API_KEY`（已設）；未設要優雅降級不破圖。
- `agents/decide` **很貴**，只前端明確觸發、別放進首頁或個股自動載入。
- engine 掛掉要 graceful degradation（沿用既有降級語意）。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源。
- 電子/金融指數折衷：首頁表頭資料為官方指數即時值（`t13`/`t17`），但走勢圖（Sparkline）採用 ETF 還原線（`0053.TW`/`0055.TW`），漲跌幅與走勢形狀可能存在微幅背離。
- 台指期 (TX) 走勢圖：分時與歷史走勢圖由加權現貨 `^TWII` 按比例線性縮放 (Trend Scaling) 生成，具有 `intraday_proxy: true` 標記。
- 🚨 TWSE MIS 回傳的 `ch` **無 `tse_`/`otc_` 前綴**（`t13.tw`），但 `MIS_CHANNELS` 的查詢值**帶前綴**（`tse_t13.tw`）→ 任何拿 `MIS_CHANNELS` 值去 join MIS 回傳（如 sectors 漲跌幅）查表前**必須 strip 前綴**，否則永遠 miss 並靜默落 `0/null`（Phase 1 sectors 全平盤 bug 根因，已修）。

---

## 8. 優化專案（Phase 0–8 完工後・2026-06-27 起）

> 全案藍圖 Phase 0–8 已收尾；以下為使用者後續提出的功能優化，**各自獨立成小專案**，沿用同一互動模式（Claude 給提示詞 → 使用者寫 code → Claude review → 更新 SSOT/Obsidian/記憶）。提示詞置於 `review-web/docs/prompts/optN-*.md`。

| # | 專案 | 提示詞 | 重點 | 後端改動 | 狀態 |
|---|---|---|---|---|---|
| 1 | 個股多維度審查「資料夾化」 | `opt1-folders.md` | 側欄改可展開資料夾：我的持股／有潛力的／其他；新增共用 `lib/userStore.ts`（localStorage）；種子收進現有 2330/2454/2317 | 無 | ✅ 完工 (2026-06-27) |
| 2 | 個股搜尋＋手動增刪資料夾 | `opt2-search.md` | 新端點 `/api/symbols/search`（複用 engine `TaiwanStockInfo`）＋共用 `<SymbolSearch>`；加入/移除/跨夾移動 | engine+gateway `/symbols/search` | ✅ 完工 (2026-06-27) |
| 3 | Watchlist 手動增刪 | `opt3-watchlist.md` | Dashboard 自選卡：後端焦點（唯讀）＋使用者自選（localStorage 可增刪）並存、徽章區分；複用專案 2 搜尋 | 無 | ✅ 完工 (2026-06-28) |
| 4 | 資金潮汐（仿 tide-tw.app） | `opt4-capital-tide.md` | 新頁 `/tide`：資金流向×動能**泡泡圖**＋新端點 `/api/market/capital-tide`（有界 universe＝breadth 的 `watchlist_union_0050`、每日快取、還原價算 momentum）；左右面板列可選 | engine+gateway `/market/capital-tide` | ✅ 完工 (2026-06-28) |
| 5 | 產業熱力圖（仿 aistockmap.com） | `opt5-sector-heatmap.md` | 新頁 `/heatmap`：各 TWSE 類股 **treemap**，區塊大小＝`\|漲跌%\|`、紅漲綠跌發散色階±5% 飽和；複用既有 `/api/market/sectors`（**零後端**）＋自寫 squarified；**單日 MVP**，單週/單月 disabled「即將推出」 | 無（MVP） | ✅ 完工 (2026-06-28) |
| 6 | 熱力圖 2.0：週/月＋產業鑽取（仿 aistockmap） | `opt6-stock-heatmap.md` | 頂層 `/heatmap` 啟用**單日/單週/單月**（口徑改為成分股簡單平均）＋點產業進新頁 `/heatmap/sector/:name`「產業總覽」：關鍵指標卡＋**個股層級 treemap**（大小＝\|個股漲跌%\|）＋點個股跳 `/stock/:code`；增強A＝產業籌碼訊號（外資/投信/自營 X/6 連買，T86 日檔快取）；TWSE `MI_INDEX ALLBUT0999` 單請求全市場＋每日檔快取 | engine+gateway `/market/stock-heatmap`（增強A 另 `/market/sector-chips`） | ✅ MVP完工 (2026-07-02) |
| 7 | 盤勢總覽 2.0（仿 futures-ai 台股概況） | `opt7-market-overview.md` | Dashboard 資訊架構重整：指數狀態列＋**盤面分析卡**（關鍵數字格＋規則式氣氛儀表 −100~+100＋一句話總結，`lib/marketSummary.ts` 純函式+vitest）＋**漲跌家數分布直方圖**＋**強勢/弱勢/熱門 Top15**（複用 opt6 快照，零新後端）＋12-col 重排＋卡殼統一＋熱力/潮汐入口；**建議 opt6 後做** | 無（零新後端，吃 opt6 端點） | ✅ 完工 (2026-07-02) |
| 8 | 個股研究摘要卡（規則式五力雷達，仿 Danny Quant） | `opt8-research-brief.md` | `StockDetail` 頂部：五力雷達（技術/籌碼/情緒＝`blended.factors` 原分；**動能/基本面＝前端純函式合成**——factors 實際只有三因子）＋綜合分數＋規則式「加分/扣分因素」（引用籌碼/營收/均線真數字）＋「觀察點/失效訊號」（60MA/20MA/量比/法人5日 附具體門檻價）；`lib/stockBrief.ts` 純函式+vitest；零 LLM、零新請求 | 無 | ✅ 完工 (2026-07-03) |
| 9 | 合理價估算＋同業排名（仿 Danny Quant 個股頁） | `opt9-*.md`（opt8 完工後定稿） | 個股頁新卡：同業 PE 中位數 × trailing EPS ＝ 推估合理價＋與現價差距%；同業百分位條（PE/PB/殖利率/營收YoY/成交值）；FinMind `TaiwanStockPER` 按日全市場單請求＋日快取 | engine+gateway `/stocks/:code/peers` | ⬜ 構想已定 (2026-07-02) |

**共用基礎與相依**：
- 無使用者 DB／免登入 → 使用者自管清單（資料夾、持股、自選）一律 **localStorage**，共用 `review-web/src/lib/userStore.ts`（專案 1 建立、3 擴充）。同 `aiReview:{code}:{date}` 快取模式。
- 搜尋一律走後端 `/api/symbols/search`（複用 `finmind_client` 既有 `TaiwanStockInfo`／`_load_name_code_map`，記憶體快取），**不在前端硬編股票清單**。`<SymbolSearch>` 元件由專案 2 產出，3、4 複用。
- 建議順序 **1 → 2 → 3**（相依）；**4 獨立**（右側監控清單若做才複用 1/2）。
- 🚨 沿用全案鐵律：前端只打 `/api`、不重算、不在首頁/清單自動打貴端點（`/api/stocks/:code`、`/api/agents/decide`）；著色台股慣例（紅漲綠跌、BUY 紅）；不動 `web/`、不改壞 `puhui_daily.cjs`。

**完工紀錄：**
- **opt1 ✅ 2026-06-27**：新增 `review-web/src/lib/userStore.ts`（`UserStock`/`FolderId`/`FolderMap`＋種子 2330/2454/2317 置「其他」＋`getFolders`/`addToFolder`/`removeFromFolder`/`moveStock`/`subscribeFolders`、localStorage 持久化、CustomEvent＋原生 `storage` 跨分頁/跨元件同步）；`components/Layout.tsx` 側欄「個股多維度審查」改可折疊資料夾樹（三夾＋檔數＋active highlight＋hover 移除`window.confirm`＋空夾佔位＋展開狀態 localStorage＋RWD 行動端預設收合）；`activeCode` 改 regex 解析支援任意代號。零後端、未動 `web/`/Dashboard watchlist；`tsc -b && vite build` 綠（Claude review 通過）。
- **opt2 ✅ 2026-06-27**：後端 `finmind_client.list_symbols()`（重構 `_load_symbols_data` 一次建「全清單＋name→code 映射」雙記憶體快取、**保留 `nm not in m` 首見為準**不回歸 phase4 `get_code_by_name`）＋`service.search_symbols`（代號完全符＞前綴＞股名子字串排序、limit≤50）＋engine `GET /data/symbols/search`（`DataSourceError`/未知例外皆降級不 500）；gateway `GET /api/symbols/search`（Map 6h TTL 快取、engine down graceful degradation）；前端 `components/SymbolSearch.tsx`（300ms debounce＋loading/查無/降級三態）＋`api.ts` `symbolSearch`/`SymbolHit`/`SymbolSearch`；`Layout.tsx` 每夾「＋」就地展開搜尋→`addToFolder`、`MoreHorizontal` 下拉→`moveStock` 跨夾、全域 click 關下拉（toggle `stopPropagation` 防即關）。`docs/api.md`＋`contracts.md` 契約同步。engine pytest **69**、`tsc -b && vite build` 綠（Claude review 通過）。小觀察（非阻塞）：`list_symbols` 未對 `stock_id` 去重、gateway 快取不主動清除。
- **opt4 ✅ 2026-06-28（MVP＋可選面板一起交）**：engine `GET /market/capital-tide`（universe 重用 breadth 的 `watchlist_union_0050`＝`build_watchlist ∪ TW50_COMPONENTS`、逐檔近 5 日法人淨買賣超`/1000`→張＋還原價 `ohlcv_adj` 算近 5 日平均日漲幅%＋成交值 log 正規化 size；對「當日 universe 分布」算 z-score clip[-3,3]→[-1,1] 當座標、strength＝(0.5·flow+0.5·mom+1)·50、四象限 `inflow_up/…`；**每日整批檔快取** `cache_path/capital_tide/{date}_{universe}.json`；個股缺資料 `errors[]` 略過不 500、`_guard` 包 502；交易日用 `^TWII` `ohlcv_adj` 推 6 日，缺則跳週末 fallback）；gateway `GET /api/market/capital-tide`（轉發 120s timeout、`sendError` 降級）；前端 `pages/CapitalTide.tsx` 手刻 **SVG scatter**（600×600 viewBox、十字+四象限+網格、`cx=300+flow_x·250`/`cy=300−momentum_y·250`/`r=5+size·15`、quadrant 配色台股慣例[inflow_up 紅/outflow_down 綠/inflow_down 琥珀/outflow_up 青]、hover DOM tooltip[強弱/flow_raw 張/mom_raw %/日/sector]＋點選高亮環＋本地搜尋過濾 dim 非命中＋三態/RWD）＋右側可選面板（選定個股板/象限計數/法人買超前 5/動能前 5，皆前端由 `stocks[]` 彙總免新端點）；`App.tsx` 路由 `/tide`＋`Layout.tsx` nav「資金潮汐」(`Waves`)；`api.ts` `marketCapitalTide`＋`CapitalTideData/CapitalTideStock` 型別；`contracts.md` §1＋§2.11 契約同步。engine pytest **70**（含 `test_market_capital_tide_ok`、本檔沿既有 live-integration 風格）、`tsc -b && vite build` 綠 exit 0（Claude review 通過）。小觀察（非阻塞）：①gateway 未加建議的 TTL 層（僅靠 engine 每日檔快取，已足以不打爆 FinMind）；②象限座標是**相對 universe 的 z-score**（中線＝平均非絕對 0，全市場齊跌時「資金流入」可能其實仍是淨賣超、僅優於均值；tooltip 顯示 raw 張/% 可看真值）；③測試走 live 非 mock、未專測缺資料 skip 路徑（同檔既有慣例）。
- **opt3 ✅ 2026-06-28**：純前端零後端。`lib/userStore.ts` 加自選區（`WATCHLIST_KEY`＝`review:watchlist:v1`、不種子預設 `[]`＋`getUserWatchlist`/`addToWatchlist`(去重 by code)/`removeFromWatchlist`/`subscribeWatchlist`、`userstore:watchlist` CustomEvent＋原生 `storage` 同步、try/catch 防壞資料）；`Dashboard.tsx` Watchlist 卡＝`useMemo` 合併「焦點(`/api/watchlist`)＋自選(localStorage)」以 `code` union（焦點列在前、自選 only 依 `added_at` 倒序、同 code 一列掛雙徽章）、`MergedWatchItem` 評分欄全 `number|null`＋缺值顯「—」(8 欄不破表)、焦點徽章紅(`bull`)/自選徽章藍(`primary`)、自選列垃圾桶移除＋焦點列 disabled 移除鈕(tooltip「系統焦點股」)、卡右上「＋加入自選」開彈窗複用 `<SymbolSearch>`→`addToWatchlist`、`subscribeWatchlist` 即時重繪不重打後端。**未自動打 `/api/stocks/:code`/`/api/agents/decide`**（自選列評分留「—」）。未動 `/api/watchlist`/`web/`/`puhui_daily.cjs`；`tsc -b && vite build` 綠 exit 0（Claude review 通過）。小觀察（非阻塞）：`/api/watchlist` 報錯時整卡走錯誤畫面，本地自選清單會一併被遮（沿用現有降級，可後續讓自選獨立存活）。
- **opt5 ✅ 2026-06-28**：新增 `/heatmap`「產業熱力圖」頁。前端自定義 `review-web/src/lib/treemap.ts`（純函式 `squarify` 實作 squarified treemap 演算法 (Bruls 2000)、自動對 scaled area 由大到小排序，並撰寫 `treemap.test.ts` 以 vitest 測試通過）；`/pages/SectorHeatmap.tsx` 複用既有 `/api/market/sectors` 端點，對 `change_pct` 進行 runtime 防 null/NaN 保護、以 `Math.max(|change_pct|, 0.05)` 當 value 避免 0% 類股消失，並依 ±5% 飽和紅漲綠跌發散色階渲染 SVG 區塊（viewBox `0 0 1000 600` RWD 自適應）；文字分級避免小塊溢出，點擊區塊高亮（白描邊上層渲染），hover 手刻 DOM 浮動 tooltip（顯示類股名/漲跌幅/成交值億兆/資料來源）；時間切換鈕單日 active，單週/單月 disabled 並附 tooltip 提示「即將推出」；`App.tsx` lazy 路由 `/heatmap`，`Layout.tsx` 側欄 nav「產業熱力圖」(`LayoutGrid`) 與 header 標題分支；`api.ts` `SectorPerformance.change_pct` 型別誠實化為 `number | null`（Dashboard 無回歸）。零後端改動。**Claude review**：原 `SectorHeatmap.tsx` 有 2 個未使用 import（`SectorPerformance`/`TreemapTile`）觸發 `noUnusedLocals` → tsc 失敗，已移除（純機械、不動邏輯）→ `tsc -b && vite build` 綠 exit 0、`treemap.test.ts` vitest **3 passed**、VM live `/api/market/sectors` 實測 34 類股（30 有值/4 null 已正確過濾、06-26 當日全綠 −7.37~−0.82%）。通過。
- **opt6 ✅ 2026-07-02 (MVP)**：engine `twse_report_client.py` 新增 `fetch_mi_index_allbut0999_raw` / `get_mi_index_allbut0999`（單請求抓取 TWSE `MI_INDEX ALLBUT0999` 全市場個股收盤行情，具備日檔快取與非交易日回溯）、`market.py` 端點 `GET /market/stock-heatmap`（支援 day/week/month，基準日回溯與 null 保護）；gateway `routes/market.js` 新增 `GET /api/market/stock-heatmap` 薄轉發（120s timeout）；前端 `lib/api.ts` `marketStockHeatmap` 5 分鐘記憶體快取＋型別；`pages/SectorHeatmap.tsx` 啟用單日/單週/單月切換＋前端聚合產業平均與成交值，點區塊導頁至 `/heatmap/sector/:name`；新 `pages/SectorDetail.tsx`（關鍵指標卡×4 ＋ 個股層級 treemap ＋ 時間切換 ＋ hover tooltip ＋ 點個股直通 `/stock/:code`）；`App.tsx` lazy 路由 `/heatmap/sector/:name` ＋ `Layout.tsx` header 標題支援；`contracts.md` §2.12 與 `docs/api.md` 同步。**Claude Review 修正**：①移除 `review-web/package.json` 誤裝之 `"cc-ai-agent": "file:.."` 軟連結並更新 lockfile；②修復週/月基準日 off-by-one 計算（`n=5`→`6`、`n=21`→`22`）；③`fetch_mi_index_allbut0999_raw` 逐列加 `try/except` 防護、`_clean_num` 支援 `"--"` 並處理 `"X"` 除權息；④`get_sector_by_code` 失敗時重置快取（二輪 review 補 **10 分鐘失敗退避**——否則 FinMind 額度耗盡時 1082 檔迴圈逐檔重試＝「檔數×token 數」轟炸＋gateway 120s 逾時；退避後全失敗情境 2.6s 完成）；⑤前端手動點「重新整理」時傳遞 `force=true` 繞過快取、`decodeURIComponent` 加上 `try/catch` 容錯。`tsc -b && vite build` 乾淨，`pytest` 通過。**部署＋VM 驗收（2026-07-02，commit `9017d58`）**：VM pull→`npm ci`+build→重啟 engine+gateway 皆 active、`/api/health` ok、`/review/` 200；`stock-heatmap` day/week/month 皆 200（冷載 1.2s/4.6s/0.3s，日檔快取 `data_cache/stock_heatmap/` 三份落地）、基準日正確（week=06-25、month=06-03）；產業歸屬 36 個真實產業（其他僅 51/1082）；抽 2 產業手算印證：半導體業 +3.13%（24/25 有效、810.4 億）、金融保險 −0.28%（31/32、362.2 億）；engine venv pytest `test_market.py` **7/7 全綠**（含本機因無 token 跑不了的 capital-tide）。**小觀察（非阻塞，資料源特性）**：FinMind `industry_category` 粒度不一——部分大型股落粗分類「電子工業」（233 檔大傘，含台積電）而非細分類「半導體業」，且金融類名為「金融保險」（無「業」字）；treemap 呈現照實反映 FinMind 分類，未硬修。
- **opt7 ✅ 2026-07-02**：Dashboard 資訊架構重整完工。①`review-web/src/lib/marketSummary.ts` ＋ `marketSummary.test.ts`（純函式計算 mood −100～+100 儀表分數、多空/中性 stance 判定、規則式 headline ＋ 2-4 條 signals 模板，全路徑防 null/NaN 降級，vitest 4/4 通過）；②`components/OverviewCard.tsx` 統一卡殼組件（標題、caption、children、footer 時間標記）；③`pages/Dashboard.tsx` 資訊架構重整（市場狀態列：5 指數 chips + 時間 + 刷新鈕 + 平滑捲動；盤面分析卡：2×3 關鍵數字格 + 手刻 SVG 半圓氣氛儀表 −100~+100 + 規則式總結 + 警語小字；漲跌分布直方圖：-10%~+10% 21 桶 1% 直條圖 + 五段 跌停/下跌/平盤/上漲/漲停 strip + 註明上市個股口徑；強勢/弱勢/熱門 Top15：Tab 切換、點選直跳 `/stock/:code`；產業熱力 Top10 縮卡與資金潮汐入口卡）；12-col 響應式 Grid Layout（1280 12欄 / 768 2欄 / <768 單欄依 §1.6 順序）；複用 opt6 `/api/market/stock-heatmap` 快照一次 Fetch 不重覆發送，零新後端、未動 `web/`。**Claude Review 修正**：①「熱門」Top15 過濾條件改為只要求 `turnover`/`close` 非 null——原三 tab 共用 `change_pct !== null` 會讓除權息個股（X 方向，7/02 有 31 檔）整檔從成交值排行消失；②刷新鈕 `fetchAllData(true)` → `fetchHeatmap(force)` 傳遞 `force=true` 繞過 5 分鐘快照快取（對齊 opt6 SectorHeatmap 行為）；③口徑標注補齊——直方圖 footer 改顯示「有效個股 X 家」（僅計 `change_pct` 非 null）、補「漲跌停統計以 ±9.5% 概算」小字；④`index.css` 改用 `theme('colors.background')` 保住 tailwind.config token 連動；⑤產業熱力 Top10 磁磚補 `onClick` 導 `/heatmap`（不導鑽取頁——`marketSectors` 的 TWSE 指數分類名與 opt6 FinMind 產業名不同套）；⑥移除 `HistogramChart` 未使用之 `breadthData` prop；⑦（Claude 機械修正）本紀錄原誤插於 §8 表格中段致表格切斷，已搬移歸位。修正後 `tsc -b && vite build` 乾淨，vitest **12 passed**（Claude review 通過）。**小觀察（非阻塞）**：opt6 端點失效時直方圖/Top15 顯示錯誤卡＋重試而非規格所述「隱藏」（實務更佳，記錄偏差）；盤面分析卡 footer 資料時間取自 indices `as_of`（卡片實際資料源為 breadth/法人/dashboard）；Dashboard 掛載時 indices 端點打兩次為既有行為非本案回歸。**部署＋VM 驗收（2026-07-02，commit `11fbbd8`）**：VM pull→前端 build→重啟 gateway（零 engine 變動，依 deploy.md 免重啟 engine），服務 active、`/api/health` ok、`/review/` 200；儀表驗收＝以 VM 即時資料手算 mood **−17 中性**（breadth 649:323→bs=+0.335、法人 **−834.2 億** 飽和 −1、水位 0.5→0；當日多空訊號分歧，正好驗證權重平衡），與 `buildMarketSummary` 公式一致；直方圖有效個股 **1051/1082**（31 檔除權息 null）、五段 strip 加總＝1051（跌停2/下跌323/平盤75/上漲597/漲停54；±9.5% 概算 vs breadth 名單＝漲停 54:54 全中、跌停 2:1 即口徑差，footer 已標注）；Top15 抽查＝熱門 台積電 883.7億/國巨* 502.4億/聯發科 368.6億、強勢 +10% 宏遠/世芯-KY、弱勢 −9.92% 聯策。




**2026-07-02 規劃紀錄（概念圖統整 → opt6–9 定案）**：使用者提供 `C:\Users\bigsh\Downloads\概念圖`（8 張有效截圖：Danny Quant 產業地圖個股頁×2、五力雷達洞察卡、市場情緒看板、策略卡片牆「今日資料池」、條件篩選器、研究摘要卡、5888 股票戰情卡）＋兩個參考站（futures-ai 盤勢總覽、aistockmap 熱力圖）。統整決策：**優先做 opt6（個股層級熱力圖）→ opt7（盤勢總覽 2.0）**（兩者為使用者明示需求），其後 opt8（研究摘要卡）、opt9（合理價/同業排名）吃概念圖精華且成本低（opt8 零後端零 LLM）。規格提示詞 `opt6-stock-heatmap.md`、`opt7-market-overview.md` 已定稿；opt8/9 依慣例待前案完工後定稿。**同日補校準**：使用者補上 5 張參考站實際截圖（`熱力圖模板.jpg`＋鑽取樣式×2＝aistockmap、`個股審視網站 模板.jpg`×2＝期天資訊台股概況），兩支規格依此重寫——opt6 從「單畫面兩層 treemap」改為範本的「產業總覽鑽取頁」模式（個股方塊大小＝\|漲跌%\| 非成交值）、新增籌碼訊號增強A；opt7 對齊範本改為「盤面分析卡（氣氛儀表 −100~+100）＋漲跌分布直方圖＋強弱熱門 Top15」，並定為 opt6 之後做（複用其快照零新後端）。**Backlog（暫不立案）**：①市場情緒看板（需 universe 批次輿情端點，新聞/額度成本高）；②5888 風格戰情卡分享海報（依賴 opt8 規則式摘要，屆時做成 StockDetail 匯出視圖）；③策略選股卡片牆＋條件篩選器（等同完整 screener，工程量最大，待前述完工後評估）。

---

## 9. 維修紀錄

- **2026-07-02 桌面捷徑失效（重大事故復原）**：使用者回報桌面捷徑「個股全面審視網.lnk」點開沒反應。調查發現 **2026-06-28 16:21 左右 repo 工作樹 818 個已追蹤檔案被整批刪除**（含 `review-web/`、`engine/`、`web/`、`docs/` 全部；未 commit 所以 git HEAD 完好），且根目錄被一個全新 Vite React 範本覆蓋（`package.json`/`.gitignore`/`package-lock.json` 被改寫、新增 `src/`/`index.html` 等）。捷徑目標 `review-web\tools\open-review.ps1` 因此不存在 → 雙擊無反應。**處置**：範本檔案先移至 `_backup_vite_scaffold_20260702/` 備份，再 `git checkout` 還原全部 818 個刪除檔與 4 個被覆蓋檔；驗證 `open-review.ps1` UTF-8 BOM 完好（`239 187 191`）、SSH 通道實測全綠（`/api/health` 200、engine up、`/review/` 200）。**捷徑恢復可用**。備份資料夾確認無用後可刪。教訓：在 repo 根目錄跑 `npm create vite` 等腳手架會覆蓋專案檔；日後新實驗一律開獨立資料夾。
