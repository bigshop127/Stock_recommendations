# 階段 9：實機上雲（完成階段8 Track 2）+ 全案收尾

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase9.md 然後按照裡面的說明進行。」
> 執行者請**先讀本檔「⚠️ 對齊現況」**，再讀 `docs/runbook.md`（**本階段主依據**）、`deploy/`（全部）、`docs/ROADMAP.md` §13、`scripts/puhui_daily.cjs`（看 `RUN_TARGET` 解耦）、`docs/prompts/phase8.md`、`data/oracle_grab_state.json`（**搶到 VM 後才有**）。
> **第一件事＝確認 VM 是否已搶到**（`data/oracle_grab_state.json` 存在＝有；否則第 0 步是搶機，別假設能 SSH）。提出部署/驗收計畫讓使用者確認，**先單獨交付第一層（無 LLM）再碰 LLM 層**。

---

## ⚠️ 對齊現況（執行前必讀；2026-06-15 階段8 Track1 完成後核對）

階段 1-7 完成且可端到端跑；**階段8 Track 1（不需 VM 的部署資產）已完成、本機驗收、push**。Track 2＝把它**真正跑在 VM 上**並驗收 + 解 LLM-on-cloud + 全案收尾。**很多東西已就緒，請勿重做。**

**已就緒（階段8 Track1，務必先讀、不要重寫）**
- **§A 解耦完成**：`scripts/puhui_daily.cjs` 已用 `RUN_TARGET=local|vm|ci`（＋衍生 `IS_CI`/`WRITE_OBSIDIAN`/`EXISTING_OUTPUT_PATH`）。**VM 跑老王＝`RUN_TARGET=vm node scripts/puhui_daily.cjs [日期] [--force]`**（用 Claude CLI + 寫 `reports/` + git push + 告警，**不寫 Obsidian**）。本機/CI 行為**完全不變**（回歸測試 `scripts/test_puhui_run_target.cjs`：15 passed，VM 上可再跑一次）。
- **`deploy/` 全套（冪等）**：`bootstrap.sh`（偵測 apt/dnf → Node20/Python venv/相依 → `npm ci`+playwright → build 前端 → 安裝 systemd → 裝 cron → 設 TZ=Asia/Taipei）、`puhui-engine.service`/`puhui-gateway.service`、`refresh.sh`、`healthcheck.sh`、`crontab.example`、`README.md`。
- **systemd 刻意不用 `EnvironmentFile`**：engine 由 pydantic 讀 `engine/.env`、gateway 由 `lib/loadEnv` 讀根 `.env`；`PORT`/`ENGINE_BASE_URL` 由 unit 的 `Environment=` 設。**別改成 EnvironmentFile**——根 `.env` 的 ssh 公鑰含空白會害 systemd 解析爆。
- **GitHub Actions 無 LLM 備援**：`.github/workflows/data_refresh.yml` + `engine/scripts/smoke_data.py`（已本機驗：engine pytest **57 passed**、live smoke `/health`+`/data/book`(MIS)+`/data/market`(yfinance) 全 200）。**但 GitHub repo secrets 尚未設**（要使用者設，見下）。
- **`docs/runbook.md`**：完整維運手冊（架構/祕密配置/搶機+PAYG/部署/SSH tunnel/日常 cron/B1 步驟/故障排除/Telegram 告警一覽/指令速查）——**本階段照它做**。
- **Windows 根 `.env` 已重建**（`OCI_*` + `TELEGRAM_*` + `OCI_OCPUS/MEMORY_GB/DISPLAY_NAME`，gitignored）→ **搶機已解鎖**。
- **`.gitattributes`** 已強制 `deploy/` 的 `.sh`/`.service`/`crontab` 用 LF（防 Windows CRLF 害 Linux bash/systemd）。
- **決策已定（使用者 2026-06-15）**：LLM 預設 **B2**（老王留本機 Task Scheduler）、**備好 B1**（VM）。

**尚未發生 / 待辦的真相**
- **VM 還沒搶到**：東京免費 A1 `Out of host capacity`（缺貨非設定錯）。`data/oracle_grab_state.json` 不存在＝還沒搶到 → **第 0 步＝搶機**（升 **PAYG** 最有效，只有使用者本人能做），不是部署。
- **B1 的 headless CLI token 能否續命＝全案唯一未驗證高風險**。必須在**真 VM 上實測數天**，別當已知事實。
- VM 的 **OS（Ubuntu/Oracle Linux）與預設使用者（ubuntu/opc）取決於實際搶到的 image**；`bootstrap.sh` 會自動偵測 apt/dnf，但仍需在真 ARM 機**實裝確認** pandas/pyarrow（aarch64 wheel）與 playwright chromium（`--with-deps`）。
- **VM 版根 `.env` 只放 `TELEGRAM_*`（+B1 才需 `GOOGLE_*`/`GEMINI_*`）**，**不要放 `OCI_*`**（搶機在 Windows 跑、ssh key 含空白）。
- `refresh.sh` 會 commit/push **新路徑 `reports/signals/<date>.json`**（無 LLM 當日量化訊號快照，手機可離線讀）；首次 push 需 VM 有 git 認證。
- `smoke_data.py` 測 `/data/ohlcv` 需 **`FINMIND_TOKEN` 為真實環境變數**（pydantic 讀 `engine/.env` 不會塞進 `os.environ`）；CI 走 secrets、VM 手動測可 `export`。

---

## 你的角色
資深 DevOps / 平台工程師。把階段8 已備好的部署資產**真正落到 VM 上跑起來、無人值守驗收**，誠實處理 LLM-on-cloud 風險點，並把 runbook 補上實機發現、完成全案收尾。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1-7 完成（engine FastAPI / gateway Node+同源前端 / web 前端 / 多 agent / 老王融合）；階段8 Track1 完成（部署資產、§A 解耦、runbook、根 .env、GH Actions 備援）。
- 內容線鐵則：**別改壞 `scripts/puhui_daily.cjs` 既有產出與 `reports/` git push 模式**（手機在 pull）。
- 痛點：使用者無法 24h 開電腦；本階段就是讓 VM 接手 24h。
- 終局與全貌見 `docs/ROADMAP.md`（§13 是階段8 紀錄）。

---

## 本階段目標
1. **第一層（無 LLM 常駐）真正跑在 VM 上並無人值守驗收**：engine + gateway + 前端常駐（**重開機自起**）；cron 盤後刷新數據/訊號並 push `reports/signals/`；健康檢查失敗自動 restart + 告警。**先單獨交付並驗收這層。**
2. **解 LLM 層（決策點）**：B1 在 VM **實測 token 續命數天**；穩 → 老王摘要 + `/agents/decide` 上 VM；不穩 → **誠實落 B2**（老王留本機、agents 前端按鈕）。
3. **韌性實測**：cookies 過期預警、CLI 授權失效告警、健康檢查告警，**實際觸發確認**（全走既有 Telegram）。
4. **全案收尾**：runbook 補實機發現與 B1/B2 結論；ROADMAP 標全案完成 + 總結；Obsidian/記憶同步；commit & push。

### 🔑 決策點：B1 vs B2 最終定案（**在真 VM 實測後**決定，不是猜）
- **B1（VM 跑老王 + agents）**：VM 一次性登入 `claude`/`gemini`，cron 跑老王（`RUN_TARGET=vm`）、agents 前端按鈕打 VM CLI。**前提＝實測 headless token 數天不失效**。
- **B2（保底，預設）**：老王留**本機 Task Scheduler**（Claude 訂閱最穩），VM 只做無 LLM 24h 服務 + 數據刷新；`/agents/decide` 維持前端按鈕（誰開著用誰的 CLI）。
- **建議**：先把第一層獨立交付驗收；再花數天觀察 B1 token，**穩才切 B1，否則 B2 並誠實記錄**。

### 🔑 決策點：前端對外暴露
- **預設（最安全）**：只開 SSH（22），前端走 `ssh -L 3000:localhost:3000` tunnel。
- 若要對外公開：Oracle Security List 開 3000 並**鎖來源 IP**（或加簡單驗證），避免免費 VM 被掃。

---

## 需要使用者本人做的事（寫成清楚編號步驟，不要假設你能代登入）
1. **搶到 VM**（根 `.env` 已備）：跑 `powershell -ExecutionPolicy Bypass -File scripts\oracle_capacity_grab.ps1`；長期缺貨 → **Console 升 Pay-As-You-Go**（保留免費額度、容量優先權大增）。搶到記下 **public IP**（也寫在 `data/oracle_grab_state.json`）＋確認 **SSH 私鑰**（對應公鑰 `ssh-key-2026-05-26`）。
2. **開埠/安全**：Oracle Security List + VM 防火牆**只開 SSH（22）**；前端走 tunnel。
3. **scp 祕密上 VM**：`engine/.env`（FINMIND_TOKEN、**FUGLE_API_KEY** host=`api.fugle.tw`、FRED_API_KEY）、**VM 版根 `.env`**（只 `TELEGRAM_*`，+B1 才加 `GOOGLE_*`/`GEMINI_*`、PressPlay cookies）。
4. **git push 認證**：VM 設 deploy key（勾 write）或 PAT，讓 cron 能 push `reports/signals/`。
5. **（B1）CLI 登入**：SSH 進 VM 登入 `claude`、`gemini`，回報是否需瀏覽器 OAuth。
6. **設 GitHub repo secrets**（給 `data_refresh.yml` 備援）：`FINMIND_TOKEN`、`FRED_API_KEY`、`FUGLE_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。

---

## 具體工作項（含已知坑）
- **§1 部署（照 runbook §3）**：協助跑 `cd <repo>/deploy && sudo ./bootstrap.sh`（冪等；可用 `APP_DIR`/`RUN_USER`/`INSTALL_PLAYWRIGHT`/`NODE_MAJOR`/`TZ_NAME` 覆寫）。完成後 `curl -s http://127.0.0.1:3000/api/health` 應 `engine:up`；缺祕密→scp 後 `sudo systemctl restart puhui-engine puhui-gateway`。**ARM 實裝確認**（pandas/pyarrow wheel、playwright chromium）。
- **§2 第一層無人值守驗收**：
  - **重開機**：`sudo reboot` → 回來 `systemctl is-active puhui-engine puhui-gateway` 皆 active + `curl /api/health`。
  - **盤後刷新**：手動跑 `deploy/refresh.sh`，確認 `reports/signals/<date>.json` 產出 + push（看 `data/cron_refresh.log`）；確認 cron 已裝（`crontab -l`）。
  - **健康檢查**：手動 `deploy/healthcheck.sh`；停 engine（`sudo systemctl stop puhui-engine`）模擬故障 → 確認自動 restart + Telegram 告警（去抖動：連續失敗才發）。
  - **前端**：`ssh -L 3000:localhost:3000` 開 `http://localhost:3000` 確認 5 頁與 `/api/*`。
  - **手機**：pull repo 看 `reports/` + `reports/signals/`。
- **§3 LLM 層（B1 試，照 runbook §6）**：
  - 無頭可用測試：`echo "說個五字內台股問候" | claude -p`；`cd /tmp && echo hi | gemini --skip-trust -p`（**整段 prompt 走 stdin**；gemini 臨時 cwd 須 `--skip-trust`）。設 `CLAUDE_BIN`（Linux `which claude`，**非 .cmd**）。
  - 跑一次 `RUN_TARGET=vm node scripts/puhui_daily.cjs <date> --force` → 確認寫 `reports/`、push、**沒寫 Obsidian**。
  - 啟用老王 cron（取消 `crontab.example` 老王那行註解，18:30 週一~五）。
  - **數天觀察 token**：失效就 Telegram 告警 → **落 B2**（誠實記錄）。
  - **`/agents/decide` 在 VM 實測**：單一 code（很貴，每股 7×LLM ≈187s），確認 CLI 登入態可用。
- **§4 韌性**：實際觸發確認 cookies 過期預警（`puhui_daily.cjs` 內建 ≤5 天預警；更新走本機 `refresh_pressplay_cookies.cjs` 再 scp）、CLI 授權失效告警、健康檢查告警。
- **§5 runbook 補實機發現**：實際 OS/user、ARM 踩到的坑、B1/B2 最終結論、VM IP/SSH 慣例。

---

## 限制與原則
- **不破壞 `reports/` git push**（手機在用）；VM 與本機雙寫同 repo → `pull --rebase` 防分岔（`refresh.sh`、`puhui_daily.cjs` 已內建，沿用）。
- **ARM 相容**：pyarrow/playwright chromium 在 ARM64 要有 wheel/build，VM 上實裝驗證。
- 金鑰/cookies **絕不進 git**（`.env`、`data/*cookies*` 已 gitignored）。
- 安全：預設只開 SSH、tunnel 看前端；對外公開鎖來源 IP。
- 需使用者本人操作的（搶機、SSH、CLI 登入、貼祕密、設 GH secrets）**寫成步驟讓他自己做**。

## 驗收標準
- **第一層（必達）**：VM engine + gateway 常駐、**重開機自起**；手機/瀏覽器能開到前端與 `/api/*`；cron 盤後無人值守刷新並 push `reports/signals/`；健康檢查失敗自動 restart + 告警實測通過。
- **第二層（視決策點）**：老王（B1 在 VM 或 B2 本機）無人值守產出並 push；`/agents/decide` 在 VM 實測可用。B1 token 不穩 → 誠實記錄並落 B2。
- `data_refresh.yml` 設好 GH secrets 後跑一次綠燈；`docs/runbook.md` 補完實機發現。

## 完成收尾清單（DoD）
1. `docs/runbook.md` 補實機發現 + **B1/B2 最終結論**。
2. `docs/ROADMAP.md`：階段 8 改 **✅ 完成**（Track2 落地）+ **全案完成總結**（8 階段回顧、終局架構圖、維運入口）。
3. Obsidian：新增 `C:\obsidian\儲存庫\財經APP開發\階段9-完成紀錄.md` + `開發進度.md` 標**全案完成**。
4. 記憶 + `MEMORY.md`：更新 [[phase8-cloud-deploy]]（標實機完成）、寫入 **CLI-on-cloud 實測結論**（B1 token 續命到底行不行）與踩到的坑。
5. **git commit & push**（`phase9: 實機上雲 + 全案收尾`）。

## 開始方式
1. **先確認 VM 狀態**（`data/oracle_grab_state.json` 有無 + `curl` 得到 IP 否）。**沒搶到 → 引導使用者搶機（runbook §2，建議升 PAYG），本階段其餘等 VM**。
2. 搶到 → 讀 `docs/runbook.md`，提部署/驗收計畫讓使用者確認；協助 `bootstrap.sh` + scp 祕密 + **單獨驗收第一層（無 LLM）**。
3. 再處理 LLM 層（B1 數天觀察 / B2 定案）。
4. 全案收尾（DoD）。
