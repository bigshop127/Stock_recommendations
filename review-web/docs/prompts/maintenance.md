# 個股全面審視網（review-web）— 後續維修・改良 啟動提示詞

> 把本檔內容整段貼進新對話即可。先讓我（Claude）讀完 SSOT 與記憶再動手；互動模式＝**你出需求 → 我給規格 → 你寫 code → 我 review**（沿用整個專案的協作方式，除非你當次明說要我直接改）。

---

## 0. 角色與第一步（請先做）

你是這個專案的延續維護者。動任何 code 前，**先讀以下來源建立脈絡，不要憑記憶猜**：

1. 記憶索引 `C:\CC AI Agent\.claude\projects\C--CC-AI-Agent\memory\MEMORY.md`，重點開：
   - `stock-review-web-plan.md`（本專案 SSOT 級進度與所有坑）
   - `finmind-token-location.md`（FinMind 多 token 輪替、金鑰位置）
   - `oracle-cloud-access.md`（VM 連線資產）
   - `engine-nan-json-500.md`（NaN→500 易碎點）
2. 專案文件：`review-web/docs/ROADMAP.md`（SSOT）、`review-web/docs/contracts.md`（端點契約）、`review-web/docs/deploy.md`（部署與排錯）。
3. Obsidian 儲存庫：`C:\obsidian\儲存庫\個股全面審視網`（開發進度同步）。

讀完先用 2–3 句話跟我確認你掌握的現況，再開始我這次要做的事。

---

## 1. 專案是什麼 / 現況

- **個股全面審視網**：以**個股深度審視**為主、**完整盤勢總覽**為輔的桌面優先 RWD + PWA 前端，與既有「財經 APP」(`web/`) **並存**。
- **進度：Phase 0–8 全部完工，已打 tag `review-web-v1.0`，並部署在 Oracle VM 上線。** 後續只做**維修與改良**，不是再跑新 Phase。
- 功能面板：盤勢總覽（4 區塊：期現貨指數+分時、三大法人現金流、多空寬度、產業熱力）、個股殼（報價/五檔/日K+分K）、籌碼面、基本面財報、技術面指標疊圖、新聞輿情情緒、AI 全面審視（多 agent 決策）。

## 2. 架構（一定要記住的邊界）

```
review-web/ (Vite8+Rolldown / React / TS / Tailwind / lightweight-charts v4.2.3 / PWA)
   │  只打 gateway /api/*，絕不直連 engine、絕不自己重算
   ▼
gateway = server.cjs + routes/*  (Express，Node v22 內建 fetch；只組合/轉發/降級，不重算)
   ▼
engine = FastAPI (Python)  端口 8000；review-web 用到的端點：
   /market/{indices,breadth,institutional,sectors}（盤勢總覽）
   /data/{chips,fundamentals,stock_news,ohlcv,ohlcv_adj,intraday,book,...}
   /agents/decide（多 agent 決策，很貴）
```

- gateway 同源 serve：`web/` 佔 `/`，**review-web 佔 `/review/`**（靜態＋SPA fallback 註冊在 web/ catch-all 之前）。
- 子路徑三件套必須對齊：vite `base:'/review/'` + Router `basename="/review"` + PWA `scope/start_url '/review/'`。

## 3. 🚨 鐵律（違反就是事故，務必遵守）

1. **不動 `web/` 及其部署**；**不破 `puhui_daily.cjs`**；**不碰 VM 13:00 老王 cron**（`0 13 * * 1-5`）與 `# >>> puhui phase8 >>>` cron 區塊邊界。
2. **不重接資料源、不改 engine 既有因子/計算邏輯**。新增聚合請放 `service` 層，**不要塞進 `fetch_*`**（會與快取 gap-based dedup 衝突 → 跨期數值被增量片段覆蓋；Phase 3/4 踩過兩次）。動到聚合一律補**不 mock fetch 的回歸測試**。
3. **台股色慣例**：看多/BUY=**紅**（`text-bull` `#ef4444`）、看空/SELL=**綠**（`text-bear` `#22c55e`）、HOLD/中性=灰。買紅賣綠。
4. **API 欄位一律 `snake_case`**。
5. **`/api/agents/decide` 很貴**（~187s、7×LLM/股）：只能**按鈕觸發 + localStorage 硬快取**，嚴禁 `useEffect` 自動載入；單股 body 必為 `{codes:[code]}`，**絕不送 `codes:[]` 或省略**（會跑整 watchlist 燒 token/額度）。
6. **lightweight-charts 鎖 v4.2.3**（用 `addCandlestickSeries/addLineSeries/addHistogramSeries`）；**嚴禁升 v5**（v5 移除這些 API、K 線會爆）。根 `package.json` 別被塞回 v5。
7. **vite-plugin-pwa × Vite8/Rolldown 不相容**：manifest 走**手動維護** `public/manifest.webmanifest`；SW 走 `main.tsx` 手動 `serviceWorker.register('/review/sw.js',{scope:'/review/'})`＋`vite.config.ts` `injectRegister:false`。別改回 plugin 自動注入（registerSW.js 不會被 emit）。
8. engine 掛掉要 **graceful degradation**（逐區塊真實降級，mock 僅 DEV `?mock=1`，不可全域 mock 遮蔽真 500/NaN）。
9. **不印任何金鑰明文**到對話；**不多開 VM instance / LB / volume**（會扣費）。

## 4. 其他已知坑（出現症狀時對照）

- **engine 回應夾 NaN → Starlette `allow_nan=False` 整端點 500**：已有全域 `NaNResponse` sanitizer，但新因子再生 NaN 仍可能復發（見 `engine-nan-json-500`）。
- **老王報告 emoji 色碼與股市相反**：🔴=看多、🟢=看空（engine 端已處理，前端照原樣渲染）。
- 型別分歧：`water_level` 0~1、`sentiment` 0~100。
- K 線**預設還原價**（`ohlcv?adjust=1`）；盤中分K需富果金鑰（無則優雅降級佔位）。
- **FinMind 免費級每小時請求上限**：撞牆回 `HTTP 402 "Requests reach the upper limit"` → engine 502。**已實作多 token 輪替**（`engine/.env` 的 `FINMIND_TOKENS` 逗號分隔多顆，撞額度自動換顆）。再撞牆就加 token。
- TWSE MIS 的 `ch` 無 `tse_/otc_` 前綴，join 前要 strip（否則靜默落 0/null）。
- `/market/{breadth,institutional}` 冷啟 ~15–20s、`/market/sectors` 高並發冷載偶發 502（TWSE MIS 限流，retry/warm 即 200，非程式錯）。
- **部署規則**：本次 `git pull` 若含 **engine 端點變動**，必須**連 engine 一起重啟**（`sudo systemctl restart puhui-engine`），否則舊程序不載新端點 → 404。純前端更新才可只重啟 gateway。

## 5. 環境・指令・部署

- 開發機 repo：`C:\CC AI Agent`；GitHub：`bigshop127/Stock_recommendations`。
- **部署分支＝`phase3-chips`**（VM 與 refresh cron 都追這支）；**release 分支＝`master`**（tag `review-web-v1.0`）。
- VM：`140.238.48.197` / `ubuntu` / key `C:\Users\bigsh\.ssh\oracle_puhui.key` / repo `/home/ubuntu/Stock_recommendations` / aarch64。
  - 服務：`puhui-engine`(8000)、`puhui-gateway`(3000)；review 在 `http://<host>:3000/review/`。
  - 本機驗收：`ssh -L 3000:localhost:3000 -i <key> ubuntu@140.238.48.197` → 開 `http://localhost:3000/review/`。
- 測試 / build：
  - engine：`cd "C:\CC AI Agent\engine"; .\.venv\Scripts\python.exe -m pytest -q`（目前 68 passed）。
  - 前端：`cd review-web; npm run build`（`tsc -b && vite build`，VM 用 `npm ci --legacy-peer-deps`）；單元測試 `npm run test`（Vitest）。
- **每完成一項維修/改良：commit & push `phase3-chips`，並同步 ROADMAP / Obsidian / 記憶**（沿用本專案慣例）。是否併進 `master`/補 tag 由我（使用者）決定，先問再做。

## 6. 目前待辦 / 候選改良（開場可問我要做哪個）

- **（使用者端）PWA 人工驗收**：Chrome DevTools→Application 看 `/review/sw.js` activated、斷網重整出殼、Lighthouse PWA、安裝 standalone、375/768/1280 三斷點。
- **未決小事**：FinMind hotfix 是否併 `master`＋補 tag `review-web-v1.0.1`；清 VM 備份分支 `vm-backup-pre-realign-20260625`（`.env.bak` 建議留）。
- **改良方向（待我指定）**：例如效能/快取微調、UI/RWD 細修、新增審視維度、錯誤可觀測性、預載/骨架屏、行情輪詢策略等——等我這次明確說要做什麼。

---

**這次我要做的事：**
<在這行下面寫你這次的維修或改良需求>
