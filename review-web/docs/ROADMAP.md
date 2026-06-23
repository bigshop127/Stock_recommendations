# 個股全面審視網 — 專案總綱 ROADMAP

> 單一事實來源（SSOT）。任何進度／更新／優化都先改這份，再同步 Obsidian vault `C:\obsidian\儲存庫\個股全面審視網` 與 `.claude` 記憶。
> 建立日：2026-06-21。狀態：**Phase 0–5 ✅ 完工。Phase 5（技術面）2026-06-23 實作完成並通過 Claude review：`lib/indicators.ts`（SMA/EMA/MACD/KD/RSI/BBands 純函式 + Vitest 5 綠）+ `PriceChart.tsx` 升級為完整技術面板（主圖多均線 MA5/10/20/60＋布林(20,2)＋量能均線、MACD/KD/RSI 分離 chart 副圖＋時間軸/十字線同步、台股正紅負綠著色、指標開關 localStorage）；review 抓到並修掉副圖時間錯位（各副圖加 whitespace 脊柱撐齊時間軸）＋成交量開關＋BBands 配色＋Map 查表效能；零後端改動、未升 lightweight-charts v5、`tsc -b && vite build` 乾淨。下一步 Phase 6（新聞輿情・情緒，補 gateway `/api/stocks/:code/news`）。**

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
| **6** | 新聞輿情・情緒 | 新聞列表、情緒標記、事件時間線 | `/api/stocks/:code/news` | — |
| **7** | AI 全面審視（招牌） | 複用 `agents/decide` 多 agent 敘事+評分，分段（公司/基本面/技術/籌碼/新聞/風險），按鈕觸發+localStorage 快取 | 沿用既有（必要時加輕量摘要端點省 token） | — |
| **8** | 整合・RWD打磨・PWA・部署 | 全頁整合、手機收合驗證、PWA 可裝成 APP、效能、部署上既有 Oracle VM（gateway 同源 serve） | gateway serve `review-web/dist`、systemd/部署 | — |

各階段「希望看到的內容」細節寫在各自 `phaseN.md`，僅 Phase 0 先寫好；Phase 1+ 在前一階段完成後才定稿（依現況校正）。

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
