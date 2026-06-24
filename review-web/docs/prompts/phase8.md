# Phase 8 — 整合・RWD 打磨・PWA・部署（收官階段）

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase8.md`，然後根據裡面的說明進行」。
> ⚠️ 這是**最後一個 Phase**。Phase 1–7 已把盤勢總覽 + 個股六大面板（籌碼/基本面/技術/新聞/AI 審視）做齊；本階段只做**整合收尾、體驗打磨、可安裝化、上線到既有 Oracle VM**，**不再新增資料面板/新端點**（唯一例外＝gateway 純靜態 serve，見 §3）。

## 1. 本階段目標

把 `review-web` 從「各 Phase 拼出來的功能集合」收斂成一個**可日常使用、能裝成 APP、跑在雲端**的完整產品：

1. **全頁整合**：導覽串接（盤勢總覽 ⇄ 個股）、深連結、空/載/錯三態一致、清掉開發殘留（`?mock=1`、`/rwd-verify` dev 頁）。
2. **RWD 打磨**：桌面多欄 → 手機單欄/收合，逐頁逐區塊驗證（這是本專案相對舊 `web/` 的招牌差異）。
3. **PWA 可安裝**：正規 icon、manifest 收斂、standalone 驗證、離線殼、`/api` 快取策略（不可供應過期行情）。
4. **效能**：處理 build 單檔 >500kB 警告（路由級 code-splitting / 抽 vendor chunk）。
5. **部署上既有 Oracle VM**：gateway **同源 serve** `review-web/dist`（**子路徑並存、不動既有 `web/`**），systemd 重啟、`ssh -L` 驗收。

## 2. 互動與架構鐵律（務必遵守）

- 🚨 **不動既有 `web/` 與其線上部署**：review-web 與 `web/` **並存**。`web/` 仍掛在 gateway 根路徑 `/`；review-web 掛**子路徑**（建議 `/review/`，見 §3）。
- 🚨 **不改壞 `puhui_daily.cjs`、不碰 VM 13:00 老王 cron、不重接資料源、不動 engine 計算**。
- 前端**只打 gateway `/api`**（同源服務後即同網域、免 CORS）、不直連 engine、不重算數字。
- 本階段**唯一**後端改動＝`server.cjs` 增加 **純靜態 serve `review-web/dist` + SPA fallback**；**不得**新增/改 `/api` 邏輯、不重算、不動 `routes/`。
- 🚨 **著色台股慣例維持**：BUY/做多/bullish=紅、SELL/做空/bearish=綠、HOLD/中性=灰（全案一致，勿在打磨時改回西方慣例）。
- 欄位/型別一律 `snake_case`；沿用各 Phase 既有 client，**不重構打散** `lib/api.ts` 契約。
- 打磨**不得回歸**前面 Phase 已修的坑（見 §7）；任何視覺調整都要保持 Phase 1–7 的資料正確性。

## 3. 後端規格（唯一改動：gateway 同源 serve `review-web/dist`）

現況（`server.cjs:30-40`）：已在**根路徑 `/`** serve `web/dist`，並有 catch-all SPA fallback `app.get(/^(?!\/api(?:\/|$)).*/, …) → web/index.html`。

**本階段要做**：在**不動 `web/` 根路徑行為**的前提下，新增 `review-web/dist` 的子路徑供應。建議 mount `/review/`：

```
1. 先註冊 review-web（順序在 web/ catch-all 之前）：
   const reviewDist = path.join(__dirname, 'review-web', 'dist');
   if (fs.existsSync(reviewDist)) {
     app.use('/review', express.static(reviewDist));
     app.get(/^\/review(?:\/|$).*/, (req,res,next) => {   // 子路徑 SPA fallback
       if (req.method !== 'GET') return next();
       res.sendFile(path.join(reviewDist, 'index.html'));
     });
   }
2. 既有 web/ static + catch-all 維持不變（仍服務 / 根路徑）。
```

> 🚨 **順序陷阱**：既有 web/ 的 catch-all `/^(?!\/api).*/ ` **也會吃到 `/review/*`** → 必須把 review-web 的 static + fallback **註冊在 web/ catch-all 之前**（或在 web/ catch-all 排除 `/review`）。否則 `/review/…` 會回成 `web/` 的 index.html。
> 🚨 **mount 路徑＝決策點**：預設建議 `/review/`（最安全、不動 web/）。若你想讓 review-web 當主站佔根路徑、把 web/ 降到子路徑，請先確認可接受「動到既有 web/ 入口」再做——預設**不建議**（違反並存鐵律）。

**前端配合 `/review/` 子路徑（三處務必對齊，少一個就白頁/路由壞）**：
- `vite.config.ts`：`base: '/review/'`。
- `App.tsx`：`<BrowserRouter basename="/review">`（深連結 `/review/stock/2330` 才正確）。
- PWA：manifest `start_url: '/review/'`、`scope: '/review/'`；vite-plugin-pwa 的 workbox `navigateFallback` 對齊 `/review/index.html`（SW scope 也會落在 `/review/`）。

> dev 模式不變：`npm run dev`（5173）+ vite proxy `/api`→3000；子路徑 base 在 dev 下 vite 會自動處理。

## 4. 希望看到的內容（前端）

### 4.1 全頁整合
- **導覽串接**：盤勢總覽（首頁）的自選/焦點股、類股、三大法人榜單 → 點擊可進 `/stock/:code`；個股頁可返回首頁。確認 `react-router` 深連結（`/review/stock/2330` 直接開）與返回行為正常。
- **三態一致**：所有頁/區塊的「載入中 / 空資料 / 失敗」呈現風格統一（沿用各 Phase 既有樣式，不要每塊長不一樣）。
- **清開發殘留**：`?mock=1` 僅限 dev、prod build 不外露入口；`/rwd-verify` 這類 dev 頁從正式導覽移除（保留檔案無妨，但別讓使用者點得到）；未知路由 → 友善 404 / 導回首頁。
- **header/layout 一致**：`Layout` 在桌面/手機都正確包裹各頁。

### 4.2 RWD 打磨（招牌差異）
- **桌面多欄 → 手機單欄/收合**逐頁驗證：
  - 首頁盤勢總覽：指數卡 grid、廣度/熱力圖、三大法人趨勢 → 手機收成單欄、表格可橫向捲動或卡片化。
  - 個股頁：多欄殼 + 報價頭部 + K線 + 五檔 + 籌碼/基本面/技術/新聞/AI 各區 → 手機單欄堆疊；分頁/Tab（若有）在手機可用。
  - **lightweight-charts** 在斷點切換時要 `resize`（容器寬變化不破圖、不溢出）。
- 可沿用既有 `/rwd-verify` 頁做斷點巡檢；驗證主流斷點（手機 375、平板 768、桌面 1280+）。
- 觸控目標夠大、不水平溢出、字級可讀。

### 4.3 PWA 可安裝
- **正規 icon**：補 `192x192`、`512x512` PNG 與**至少一張 `maskable`**（目前只有 favicon.ico → Chrome 不會正常提供「安裝」）。
- **manifest 收斂**：`name`/`short_name` 對齊本專案（目前還是舊「台股籌碼審查網站」→ 建議改「個股全面審視網」之類）；`theme_color`/`background_color` 維持 `#09090b`；`display: standalone`；`start_url`/`scope` 對齊 mount 路徑（§3）。
- **離線殼**：build 資產 precache（vite-plugin-pwa generateSW 已做）。
- 🚨 **`/api` 快取策略**：行情/籌碼/AI 等**動態資料不可供應過期值**。預設讓 `/api/*` **走網路（不被 SW 快取）**；若要離線可看舊資料，最多對特定 GET 用 `NetworkFirst`＋短 TTL 並標示「離線快取」——預設從嚴（網路優先 / 不快取 API），避免使用者看到舊行情誤判。
- `registerType: 'autoUpdate'` 已設：確認新版部署後使用者能自動更新（必要時加更新提示）。
- 驗收：Chrome 能「安裝/加到主畫面」、Lighthouse PWA 檢查綠燈、standalone 開啟無瀏覽器網址列。

### 4.4 效能
- 處理 build **單檔 >500kB**警告（目前約 527kB）：路由級 **`React.lazy` + `Suspense`**（個股頁/AI 區較重者懶載），或 `lightweight-charts`／vendor 抽獨立 chunk（rolldown `output` 分塊）。
- 目標：初始載入 chunk 明顯下降、首頁不必載入個股頁全部程式碼。
- 內網自用，效能屬打磨非阻斷；但 build 不應再噴 >500kB 警告（或明確調 `chunkSizeWarningLimit` 並說明理由）。

## 5. 工作清單
- **前端**：導覽串接 + 三態一致 + 清 dev 殘留 + 404；RWD 逐頁打磨（含 charts resize）；PWA icon/manifest/快取策略；code-splitting/分塊；`vite.config` base + Router basename + PWA scope 對齊子路徑。
- **後端**：`server.cjs` 純靜態 serve `review-web/dist`（子路徑 + SPA fallback，**註冊於 web/ catch-all 之前**）；**無 `/api` 改動、無重算**。
- **部署（Oracle VM `140.238.48.197`，repo `/home/ubuntu/Stock_recommendations`）**：
  1. `git pull`（拉本階段 + Phase 7）；**勿動 13:00 老王 cron / `puhui_daily.cjs`**。
  2. `cd review-web && npm ci && npm run build`（aarch64 / node20，純前端 build 應可；dist 預設 gitignore → 在 VM build）。
  3. 重啟 gateway systemd（engine 不必動）；確認 `web build` 與 review serve 都 log 正常。
  4. `ssh -L 3000:localhost:3000` → 本機開 `http://localhost:3000/review/` 驗收（含安裝 PWA、深連結、AI 審視按鈕觸發）。
  5. healthcheck（既有 `*/15` restart + Telegram）涵蓋 gateway，確認重啟後 `/api/health` 綠。
- **文件**：更新 `review-web/docs/ROADMAP.md`（Phase 8 ✅ + 部署位址/路徑）；補一頁 `docs/deploy.md`（review-web build + gateway serve + VM 步驟）；同步 Obsidian vault 與 `.claude` 記憶。
- **測試**：前端 `tsc -b && vite build` 乾淨、無 >500kB 警告；手動 RWD 巡檢三斷點；Lighthouse PWA；VM 上 `curl localhost:3000/review/`（200 + index.html）、`curl localhost:3000/api/health`（綠）、`curl localhost:3000/`（web/ 仍正常）。

## 6. 驗收標準
- [ ] **gateway 同源 serve**：`/review/` 開出 review-web、`/review/stock/2330` 深連結直開；**`/` 根路徑 web/ 完全不受影響**；`/api/*` 正常（未被 SPA fallback 吃）。
- [ ] vite `base`、Router `basename`、PWA `scope`/`start_url` **三者對齊子路徑**，無白頁/資產 404。
- [ ] **RWD**：首頁 + 個股頁在 375/768/1280 三斷點皆無水平溢出、charts 正確 resize、手機單欄可用。
- [ ] **PWA**：有 192/512(+maskable) icon、manifest 名稱收斂、Chrome 可安裝、standalone 無網址列、Lighthouse PWA 綠。
- [ ] **`/api` 不供應過期值**（SW 預設不快取 API 或網路優先＋明示）。
- [ ] **效能**：`vite build` 無 >500kB 警告（或已分塊/明確調限並說明）；首頁不載入個股頁全部程式碼。
- [ ] **整合**：導覽串接順、三態一致、無 prod 可達的 `?mock=1`/`/rwd-verify`、未知路由有 404。
- [ ] **部署**：VM `git pull` + review-web build + gateway 重啟成功；`ssh -L` 驗收通過；**老王 cron / puhui_daily.cjs / engine 未受影響**；`/api/health` 綠。
- [ ] **零破壞**：未動既有 `web/` 部署、未重接資料源、未改 engine 計算；著色台股慣例維持；`snake_case`。
- [ ] `tsc -b && vite build` 乾淨。

## 7. 沿用既有坑（帶進 review）
- 🚨 **catch-all 順序**：web/ 的 `/^(?!\/api).*/ ` 會吃 `/review/*` → review-web static+fallback 必須註冊在前（或排除 `/review`）。
- 🚨 **子路徑三件套**：vite `base` ＋ Router `basename` ＋ PWA `scope`/`navigateFallback` 任一沒對齊 → 白頁或資產 404。
- 🚨 **SW 快取行情**：`/api` 動態資料別被 SW 當靜態快取 → 預設網路優先/不快取；舊資料會害使用者誤判盤勢。
- 🚨 **著色反直覺**：BUY/bull=紅、SELL/bear=綠、HOLD=灰；老王報告 emoji 與股市相反（🔴看多/🟢看空）——打磨時勿動到既有正確上色。
- 🚨 **VM 部署界線**：只 `git pull` + 在 `review-web/` build + 重啟 gateway；**別碰 `# >>> puhui phase8 >>>` 以外的 crontab、別動 13:00 老王行、別動 engine `.env`**（見記憶 oracle-cloud-access / phase9-vm-deploy）。
- 🚨 **ARM/aarch64**：review-web 純前端 build（vite/rolldown）應零原生編譯；若某依賴卡 ARM wheel/binary，回報再處理（沿用 phase9 ARM 經驗）。
- **`agents/decide` 很貴**：整合打磨時**絕不**把 AI 審視改成自動載入/進首頁；維持按鈕觸發 + localStorage 硬快取 + 單股 `{codes:[code]}`（Phase 7 鐵律）。
- **分K/五檔**需 `FUGLE_API_KEY`（VM 已設）；未設要優雅降級不破圖——部署後確認 VM 仍有金鑰。
- engine 掛掉要 graceful degradation（沿用既有降級語意），前端不假裝成功。

---
> **收官提醒**：Phase 8 通過後即全案完成。Phase 3–8 全在 `phase3-chips` 分支——屆時與使用者確認是否將 `phase3-chips → master` 併版、打 tag、最終同步 ROADMAP/Obsidian/記憶。
