# 階段 8：雲端部署 + 每日排程（解決「不能 24h 開機」）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase8.md 然後按照裡面的說明進行。」
> 執行者請**先讀本檔「⚠️ 對齊現況」**，再讀 `docs/ROADMAP.md`、`.github/workflows/puhui_daily.yml`、`scripts/puhui_daily.cjs`、`server.cjs`、`lib/engine.js`、`scripts/oracle_capacity_grab.ps1`，提出部署架構與手動步驟清單讓使用者確認，**再動手**；完成後務必做「完成收尾清單」。

---

## ⚠️ 對齊現況（執行前必讀；2026-06-14 核對程式碼）
階段 1-7 已完成並可端到端跑。**很多「以為要做」的雲端前置其實已就緒**，請勿重做；同時有幾個**原提示詞的錯誤假設**已在此更正。

**已就緒（不要重做）**
- **gateway / engine 早就 env 可配，天生可同機部署**：
  - `server.cjs`：埠走 `PORT`（預設 3000）；**已偵測 `web/dist` → `express.static` + SPA fallback 同源 serve**（階段7 做好，雲端只要 `npm run build` 後 `node server.cjs`，**不需另跑前端 server、免 CORS**）。
  - `lib/engine.js`：engine 位址走 `ENGINE_BASE_URL`（預設 `http://127.0.0.1:8000`）。同機部署用預設即可。
  - engine：`ENGINE_HOST/PORT`（`engine/app/core/config.py`），uvicorn `app.main:app`。
  - → **同機部署不需改任何轉發碼**，只要起 engine(8000) + `node server.cjs`(3000)。
- **多 agent CLI 串接已跨平台**：`engine/app/agents/llm_cli.py` 用 `shutil.which` 解析 `gemini`/`claude`，Windows 取 `.CMD`、**Linux 取無副檔名執行檔同段碼通用**；多行 prompt 走 **stdin**、gemini 臨時 cwd 須 `--skip-trust`（見 [[phase5-agents-layer]]）。雲端只要 CLI 有登入態即可。
- **富果 Marketdata 金鑰已接上**（2026-06-14）：`engine/.env` 的 `FUGLE_API_KEY` 已填、host 修正為 `api.fugle.tw`，盤中分K/五檔內外盤可用。**VM 上的 `engine/.env` 記得帶這顆**（見「需使用者本人做的事」）。
- **Telegram 安全網已存在**：`scripts/puhui_daily.cjs` 內 `sendTelegram()`、`.env` 有 `TELEGRAM_BOT_TOKEN/CHAT_ID`，且 `oracle_capacity_grab.ps1` 也用同組。**重用、不要重造**。
- **Oracle 帳號 / OCI CLI / 網路已設定好**：`scripts/oracle_capacity_grab.ps1` 正在輪詢搶 **A1.Flex（ARM Ampere）2 OCPU / 12 GB**、display name `puhui-daily` 的 Always-Free 機。compartment / subnet / image / SSH key 都已配在 `.env`。→ **「開帳號」這步免了**。

**尚未發生 / 待辦的真相**
- **VM 還沒搶到**：`data/oracle_grab_state.json`、`data/oracle_metadata.json` 都還不存在 → 容量還沒到手。**部署的第 0 步是「把 VM 搶到並拿到對外 IP/SSH」**（使用者跑 grab script），不是建帳號。
- **原提示詞「在 VM 上一次性登入 Gemini/Claude CLI 就能 cron 直接用」是最大未驗證假設**，務必當「決策點」處理，別當已知事實（見下「LLM 在雲端」）。

**更正原提示詞的錯誤假設**
- `puhui_daily.cjs` 的**實際 LLM 順序＝本機 Claude CLI 主力 → Gemini fallback**（`!IS_CI` 分支，約 line 1109-1124），**不是**檔頭註解寫的「用 Gemini 摘要」（註解過時）。
- `puhui_daily.yml` 停用的真因：**CI 路徑只走 Gemini API key，而那 3 顆 free key 已 quota=0（全死）**；CI 又沒有 `claude` CLI。所以雲端 LLM 這條目前是斷的。
- **`IS_CI` 旗標把兩件事綁在一起**：`!IS_CI` 同時代表「用 Claude CLI」**且**「寫進 Obsidian vault（Windows 路徑）」；`IS_CI` 同時代表「只用 Gemini」**且**「寫進 `reports/`」。**Oracle VM 兩者都不符**（要 Claude CLI、但沒有 Obsidian vault、要寫 `reports/` 並 git push）→ **需要小重構**（見「具體工作項 §A」），不能單純設 `CI=true` 或 `false`。
- `puhui_daily.cjs` 有 **Windows 硬路徑**：`CLAUDE_BIN`（預設 `C:\Users\bigsh\.local\bin\claude.exe`，且註解「不可用 claude.cmd」是 **Windows-only 坑**）、Playwright chromium fallback 路徑。兩者都有 env 覆寫（`CLAUDE_BIN`、`PLAYWRIGHT_CHROMIUM_PATH`），Linux 設好即可。

---

## 你的角色
資深 DevOps / 平台工程師。把整套系統搬上雲，做到「使用者不開電腦也能每天自動產訊號與報告」，並寫清楚 runbook 讓使用者自己維運。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1-7 已完成：engine（Python FastAPI）、gateway（Node Express，含同源前端）、前端（`web/`）、多 agent、老王融合。
- 內容線鐵則：**別改壞 `scripts/puhui_daily.cjs` 的既有產出與 `reports/` git push 模式**（手機在 pull）。改它只能加分支/env，不能動既有路徑語意。
- 痛點（要解）：使用者**無法 24h 開電腦**；老王自動化目前靠**本機 Windows Task Scheduler**（`scripts/setup_scheduler.ps1` 的 `PuhuiDaily_*`，單點故障）；雲端排程 `puhui_daily.yml` 已停用。
- 終局見 `docs/ROADMAP.md`。

## 本階段目標
1. **Oracle Cloud Always-Free ARM VM 為主**（24h 常開、免費）：部署 engine + gateway（含 `web/dist` 同源前端）；設 cron 跑每交易日盤後流程並 git push；把老王流程也搬上 VM，擺脫本機 Task Scheduler 單點故障。
2. **先把「無 LLM 的常駐服務」穩穩跑起來**（engine + gateway + 數據/訊號刷新 + git push）——這部分**零 LLM 依賴、最穩**，應優先落地、單獨驗收。
3. **再解「LLM 在雲端」這個風險點**（老王摘要、`/agents/decide`），當**決策點**處理（見下）。
4. **GitHub Actions 跑無 LLM 的部分**（數據刷新、回測）當備援；LLM 版 `puhui_daily.yml` 維持停用，除非有可行的 API key 路徑可恢復。
5. 手機讀取：沿用 `reports/` git push（手機 pull）；前端可選擇開對外網址（注意鎖 IP/驗證，見原則）。
6. 韌性：PressPlay cookies 過期預警、CLI 授權失效告警（沿用既有 Telegram）；寫 `docs/runbook.md`。

### 🔑 決策點：LLM 在雲端怎麼跑（務必先與使用者確認，附建議）
這是本階段唯一高風險未知，**先驗證再承諾**：
- **問題**：老王摘要與 `/agents/decide` 都需要**有登入態的 CLI**（Claude CLI 吃 Pro/Max 訂閱、Gemini CLI 吃 Google 登入）。在 headless Linux VM 上能否穩定保留登入態，**尚未驗證**。
- **要查清**：`claude` / `gemini` 在 Linux 的**非互動登入機制**（長效 token？複製本機 `~/.claude`、`~/.gemini` 憑證？token 會不會定期失效？），並實測 cron 無人值守時可用。
- **建議方案（推薦，分層降風險）**：
  - **A. VM 跑「無 LLM 常駐」**：engine + gateway + 盤後數據/訊號刷新 + git push。**先單獨完成並驗收這層**。
  - **B. LLM 層擇一**（待 A 穩定後）：
    - **B1（首選試）**：在 VM 一次性登入 `gemini`/`claude` CLI，cron 跑老王摘要 + 訊號當下的 agents 快取；**實測 token 續命**，失效就 Telegram 告警。
    - **B2（保底）**：老王摘要**留在本機 Task Scheduler（現狀，Claude CLI 訂閱最穩）**，VM 只負責 24h 服務 + 數據刷新；`/agents/decide` 維持前端按鈕觸發（誰開著用誰的 CLI）。
  - → 不要假設 B1 一定成功；**A 必須能獨立交付**，B 是加值。

## 架構切分（誰跑在哪 — 提案，請與使用者定案）
| 工作 | 位置 | LLM？ | 備註 |
|---|---|---|---|
| engine（FastAPI 8000） | Oracle VM 24h | 否 | systemd 常駐；`engine/.env` 帶 FinMind/Fugle/FRED |
| gateway + 前端（`node server.cjs` 3000，serve `web/dist`） | Oracle VM 24h | 否 | `ENGINE_BASE_URL` 用預設；`PORT` 可調 |
| 盤後數據/訊號刷新 + git push（`reports/`、快取） | Oracle VM cron | 否 | 收盤 13:30 後；TZ 見下 |
| 老王每日摘要（`puhui_daily.cjs`） | VM cron(B1) 或 本機 Task Scheduler(B2) | **是** | 視決策點；VM 需 §A 重構 + CLI 登入 |
| `/agents/decide` 多 agent | 前端按鈕觸發（打 VM gateway，用 VM 上登入的 CLI） | **是** | 很貴，維持手動觸發（[[phase6-api-gateway]]） |
| 數據刷新 / 回測備援 | GitHub Actions | 否 | 無 LLM，當 VM 掛掉的備援 |
| LLM 版 puhui（`puhui_daily.yml`） | 停用 | 是 | Gemini free key quota=0；除非有付費 key 否則別恢復 |

> **時區坑**：`puhui_daily.cjs` 的 `TARGET_DATE` 已用 `Asia/Taipei` 算日期（OK），但 **cron 觸發時間**仍受 VM 系統 TZ 影響（Oracle 預設多為 UTC）。請**設 VM TZ=Asia/Taipei** 或在 cron 換算（盤後刷新對齊收盤後、老王摘要對齊文章發布傍晚時段；可參考本機 `setup_scheduler.ps1` 的時間，但以該檔為準勿臆測）。

## 需要使用者本人做的事（請寫成清楚的編號步驟清單讓他自己做，不要假設你能代登入）
1. **搶到 VM**：跑 `scripts/oracle_capacity_grab.ps1` 直到成功（拿到 public IP + SSH）；把 IP/連線資訊給執行者。
2. **VM 開埠 / 安全**：Oracle Security List + VM 防火牆只開必要埠（建議只開 SSH；前端對外再評估，見原則）。
3. **CLI 登入**（若採 B1）：SSH 進 VM，依執行者寫的步驟登入 `gemini`、`claude`，並回報是否需要瀏覽器 OAuth。
4. **提供祕密**：把 `engine/.env`（FINMIND_TOKEN、**FUGLE_API_KEY**、FRED_API_KEY）與根 `.env`（GOOGLE_*、GEMINI_*、TELEGRAM_*、PressPlay cookies）安全帶上 VM（scp/手貼，**不進 git**）。
5. **git push 認證**：在 VM 設好 deploy key / PAT，讓 cron 能 push `reports/`。

## 具體工作項（含已知坑 / 需改的碼）
- **§A `puhui_daily.cjs` 解耦 `IS_CI`（必做才能上 VM）**：新增一個環境維度（例如 `RUN_TARGET=local|vm|ci` 或拆成 `USE_CLAUDE_CLI` + `WRITE_TARGET`），讓 **VM = 用 Claude CLI + 寫 `reports/` + git push（不碰 Obsidian）**。**保持本機與 CI 既有行為不變**（回歸測試：本機仍寫 Obsidian、CI 仍走 Gemini→reports）。
- **§B Linux 路徑/執行檔**：VM 上設 `CLAUDE_BIN`（Linux `claude` 路徑）、`PLAYWRIGHT_CHROMIUM_PATH`（或裝 `playwright install chromium`）、`OBSIDIAN_DIR` 視 §A 處理。確認「claude.cmd stdin 坑」是 Windows-only、Linux 無此問題。
- **§C 常駐化**：engine 與 gateway 寫成 **systemd unit**（開機自啟、crash 自重啟、日誌）；前端 `npm run build` 進 `web/dist` 後由 gateway 同源 serve。
- **§D cron**：盤後數據/訊號刷新流程（呼叫 engine 端點刷快取 → git push）；視 B1 再加老王摘要 cron。設好 VM TZ。
- **§E 韌性/告警**：PressPlay cookies 過期預警（沿用 `refresh_pressplay_cookies.cjs` / `export_pressplay_cookies.js` + Telegram）、CLI 授權失效告警、engine/gateway 健康檢查（`/api/health`）失敗告警。全部走既有 Telegram。
- **§F 部署腳本**：放 `deploy/`（VM bootstrap：裝 Node/Python、建 venv、`pip install -r`、`npm ci`、build、systemd、cron 一鍵化），冪等可重跑。

## 限制與原則
- 先確認 A1.Flex（2 OCPU/12GB ARM）跑得動 engine(pandas/pyarrow/yfinance) + Node；吃緊則前端改純靜態、engine 降併發。
- **ARM 相容性**：pyarrow / playwright chromium 等在 ARM64 要確認有 wheel/build；先在 VM 實裝驗證。
- 金鑰/cookies 走環境變數或 secret，**絕不進 git**（`.env`、`data/*cookies*` 已 gitignored，維持）。
- **不要破壞 `reports/` git push 模式**（手機在用）；VM 與本機若都會 push 同 repo，注意 `pull --rebase` 防分岔（`puhui_daily.cjs` 已有此邏輯，沿用）。
- 前端若對外公開：至少鎖來源 IP 或加簡單驗證（避免免費 VM 被掃）；預設**只開 SSH、用 SSH tunnel 看前端**最安全。
- 需要使用者本人操作的步驟（搶 VM、SSH、CLI 登入、貼祕密）**寫成清楚步驟讓他自己做**，不要假設你能代登入。

## 驗收標準
- **第一層（無 LLM，必達）**：VM 上 engine + gateway 常駐（重開機自起）；手機/瀏覽器能開到前端與 `/api/*`；cron 能盤後無人值守刷新數據/訊號並 push `reports/`。
- **第二層（LLM，視決策點）**：老王摘要（B1 在 VM 或 B2 在本機）能無人值守產出並 push；`/agents/decide` 在 VM 上實測可用（CLI 登入態 OK）。若 B1 token 續命不穩，誠實記錄並落 B2。
- `docs/runbook.md` 完整：日常運作、故障排除、CLI 重新授權、cookies 更新、VM 重開機後復原。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 8 標 ✅、**全案完成總結**。
2. 更新 Obsidian：`C:\obsidian\儲存庫\財經APP開發\階段8-完成紀錄.md` + `開發進度.md`（標全案完成）。
3. 更新記憶 + `MEMORY.md`（含雲端架構、CLI-on-cloud 實測結論、踩到的坑）。
4. 部署腳本/設定放 `deploy/`，runbook 放 `docs/runbook.md`。
5. **git commit & push**（`phase8: 雲端部署與排程`）。

## 開始方式
1. 先讀「⚠️ 對齊現況」+ `docs/ROADMAP.md`、`.github/workflows/puhui_daily.yml`、`scripts/puhui_daily.cjs`、`server.cjs`、`lib/engine.js`、`scripts/oracle_capacity_grab.ps1`、`scripts/setup_scheduler.ps1`。
2. 提出**部署架構**（對照上面「架構切分」表，定哪段跑 VM、哪段跑 Actions/本機）+ **LLM 決策點建議**（A 必達、B1/B2 擇一）+ **使用者手動步驟清單**。
3. 讓使用者確認後，**先做第一層（無 LLM 常駐）並單獨驗收**，再處理 LLM 層。
