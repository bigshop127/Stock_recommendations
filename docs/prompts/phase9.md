# 階段 9：把新堆疊部署到「已上線的」Oracle VM + 全案收尾

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase9.md 然後按照裡面的說明進行。」
> 執行者請**先讀本檔「⚠️ 對齊現況」整段**，再讀 `docs/runbook.md`（部署主依據）、`deploy/`（全部）、`scripts/puhui_daily.cjs`（看 `RUN_TARGET` 解耦）。
> **第一件事＝SSH 唯讀盤點 VM 現況**（VM 早已上線、不是搶機），對齊後提部署/驗收計畫讓使用者確認，**先單獨交付第一層（無 LLM 常駐服務）再碰 LLM 層**。

---

## ⚠️ 對齊現況（執行前必讀；2026-06-15 SSH 實機盤點後重寫）

**🚨 舊版 phase9 的「要搶機」前提是錯的，已作廢。真相如下：**

使用者 **2026-05-27 已升 Oracle PAYG、05-28 已搶到 VM 並 bootstrap 完成**，這台 VM **至今 24h 在跑老王每日報告**。之前 phase8/9 agent 寫「東京免費 A1 缺貨要搶機」，是因為 VM 上線紀錄寫在另兩個 Obsidian 資料夾沒被讀到（見下「權威來源」），agent 又去搶「新的免費機」才撞 `Out of host capacity`。**不需要搶機、不需要升 PAYG（已升）。phase9 的真正工作＝把階段1-8 的新堆疊（engine + gateway + 前端 + 盤後刷新）部署到這台既有 VM 上，並與已在跑的老王 cron 共存不衝突。**

### VM 實機現況（2026-06-15 SSH 唯讀盤點）
- **連線**：Public IP `140.238.48.197`、`ssh -i C:\Users\bigsh\.ssh\oracle_puhui.key ubuntu@140.238.48.197`
- **規格**：Ubuntu 22.04.5 LTS **aarch64**、2 OCPU/12GB、TZ Asia/Taipei、預設使用者 `ubuntu`；uptime 11 天、load 0、磁碟 45G 用 13%、記憶體幾乎全空 → 跑新堆疊綽綽有餘
- **已裝環境**：`node v20.20.2`、`/usr/bin/claude` 2.1.152（登入 bigshop127）、`python3 3.10.12`、Playwright chromium-1217
- **VM repo**：`/home/ubuntu/Stock_recommendations`（**不是 "CC AI Agent"** → `bootstrap.sh` 必須 `APP_DIR=/home/ubuntu/Stock_recommendations RUN_USER=ubuntu`）
- **git push 認證已備**：VM `/home/ubuntu/.ssh/id_ed25519` 已是 GitHub deploy key（「Oracle Tokyo VM (puhui-daily)」）→ **refresh.sh push 不必再設 key**
- **舊老王 cron 在跑且健康**：`0 13 * * 1-5 /home/ubuntu/puhui_daily_cron.sh`，**今天 13:05 成功產報告並 push GitHub**（手機在 pull，**絕不可弄壞它**）
- **新堆疊尚未部署**：`puhui-engine`/`puhui-gateway` systemd 未安裝、port 3000 對外關 ← **這就是 phase9 要補的**
- ⚠️ **PAYG 但用量在 Always-Free 內、月費 $0**；**不要多開 instance / 加 LB / 加 volume，超出立刻扣費**

### 🔑 B1 token 續命＝已被生產實測證實（不再是高風險未知）
舊 phase8/9 把「headless Claude CLI token 能否續命」列為「全案唯一未驗證高風險」。**SSH 盤點推翻它**：VM 自 05-28 起每工作日用 `/usr/bin/claude` 無頭跑老王、**今天仍成功**（`~/.claude.json` 當天更新）。也就是**老王摘要其實早就是 B1（在 VM 跑 Claude CLI）在運作**。→ **B1 對老王已是既成事實、可放心沿用；不必再「觀察數天才敢切」。** B2（本機 Task Scheduler）保留為離線備援即可（VM 上的舊 wrapper 仍是預設 local 模式，見步驟 §2）。

### 權威來源（VM 真相寫在這兩處，務必先讀）
- `C:\obsidian\儲存庫\CC\待辦計畫\puhui_oracle_migration.md`（✅ 完成 2026-05-28，含 grab/bootstrap/cron/停本機排程全紀錄）
- `C:\obsidian\儲存庫\財經APP\台股回測系統文檔\4_自動化部署\Oracle_VM_運維參考.md`（**運維聖經**：SSH/路徑/cookies 更新/push 認證/帳單）
- 記憶 [[oracle-cloud-access]]（已修正成 VM 上線版）、[[phase8-cloud-deploy]]

### 已就緒（階段8 Track1，務必先讀、不要重寫）
- **§A 解耦完成**：`scripts/puhui_daily.cjs` 用 `RUN_TARGET=local|vm|ci`（衍生 `IS_CI`/`WRITE_OBSIDIAN`/`EXISTING_OUTPUT_PATH`）。**VM 跑老王＝`RUN_TARGET=vm`**（Claude CLI + 寫 `reports/` + push + 告警、**不寫 Obsidian**）。本機/CI 行為完全不變（回歸 `scripts/test_puhui_run_target.cjs` 15 passed）。
- **`deploy/` 全套（冪等）**：`bootstrap.sh`、`puhui-engine.service`/`puhui-gateway.service`、`refresh.sh`、`healthcheck.sh`、`crontab.example`、`README.md`。
- **systemd 刻意不用 `EnvironmentFile`**（engine 由 pydantic 讀 `engine/.env`、gateway 由 `lib/loadEnv` 讀根 `.env`；`PORT`/`ENGINE_BASE_URL` 用 unit 的 `Environment=`）。**別改成 EnvironmentFile**（根 `.env` 的 ssh 公鑰含空白會害 systemd 解析爆）。
- **GitHub Actions 無 LLM 備援**：`.github/workflows/data_refresh.yml` + `engine/scripts/smoke_data.py`（已本機驗 engine pytest 57、live smoke 全 200）。**GitHub repo secrets 尚未設**（要使用者設，見 §需使用者做的事）。
- **`docs/runbook.md`**、**`.gitattributes`**（強制 `deploy/` 用 LF）已備。

---

## 你的角色
資深 DevOps / 平台工程師。把階段8 已備好的部署資產**真正落到這台既有 VM 上跑起來、無人值守驗收**，與既有老王 cron **安全共存**，完成全案收尾。**這台 VM 是生產機（手機在用），所有操作先 SSH 唯讀確認、改動前說清楚、單步驗收。**

## 專案背景（共用）
- 本機路徑：`C:\CC AI Agent`。階段 1-7 完成（engine FastAPI / gateway Node+同源前端 / web 前端 / 多 agent / 老王融合）；階段8 Track1 完成（部署資產、§A 解耦、runbook、GH Actions 備援）。
- 內容線鐵則：**別改壞 `scripts/puhui_daily.cjs` 既有產出與 `reports/` git push 模式**（手機在 pull）。VM 與本機/cron 多方寫同一 repo → 一律 `git pull --rebase` 防分岔。
- 終局與全貌見 `docs/ROADMAP.md`。

---

## 本階段目標
1. **第一層（無 LLM 常駐）部署到既有 VM 並無人值守驗收**：engine(127.0.0.1) + gateway/前端(:3000) 常駐（**重開機自起**）；盤後 cron 刷新數據/訊號並 push `reports/signals/`；健康檢查失敗自動 restart + Telegram 告警。**先單獨交付並驗收這層。**
2. **老王 cron 遷移到新解耦路徑（謹慎）**：把既有 `13:00` wrapper 從預設 local 模式切到 **`RUN_TARGET=vm`**（不寫 Obsidian、查 repo reports、push、告警），**保留原排程時間、確保不雙跑、不破壞手機在 pull 的 `reports/`**。B1 已是既成事實，重點是**乾淨遷移**不是「驗證能不能」。
3. **agents/decide 在 VM 實測**：前端按鈕打 VM 的 Claude CLI，確認登入態可用（單一 code、很貴）。
4. **韌性實測**：健康檢查告警、cookies 過期預警、CLI 失效告警，實際觸發確認（走既有 Telegram）。
5. **全案收尾**：runbook 補實機發現；ROADMAP 標全案完成 + 總結；Obsidian/記憶同步；commit & push。

---

## ⚠️ 與既有老王 cron 共存的關鍵地雷（最重要、先想清楚再動手）
1. **`bootstrap.sh` 裝 cron 時不可清掉既有的 `0 13 * * 1-5 puhui_daily_cron.sh`**。動前先 `crontab -l` 存檔；若 bootstrap 用 `crontab <file>` 會覆蓋 → 改成**附加合併**或**裝完立刻把舊行補回**，並 `crontab -l` 核對 13:00 那行還在。
2. **不要同時跑兩份老王**：不要啟用 `deploy/crontab.example` 裡的老王 B1 行（18:30）。老王維持既有 13:00 wrapper，只把它**改成 `RUN_TARGET=vm`**（步驟 §2）。
3. **多方寫同 repo 的 git 衝突**：13:00 老王、盤後 `refresh.sh`、本機/手機都會 pull/push 同一 repo。錯開排程時間（refresh 設在收盤後、與 13:00 拉開），三方都 `git pull --rebase`（既有腳本已內建，沿用）。
4. **VM repo 版本**：VM 每日 `git pull --rebase`，新堆疊程式碼**應已在 VM 樹上**——但**部署第一步先 `cd /home/ubuntu/Stock_recommendations && git log --oneline -3 && ls deploy engine web`** 確認 HEAD 含 `deploy/`/`engine/`/`web/`；若落後就先 `git pull --rebase`。本機這端可能落後 VM 一個「當天報告」commit，push 前先在本機 `git pull --rebase`。
5. **`engine/.env` 在 VM 不存在**（VM 現有的是舊 puhui 流程用的根 `.env`）→ 新 engine 要的 `FINMIND_TOKEN`/`FUGLE_API_KEY`/`FRED_API_KEY` 必須**另外 scp `engine/.env` 上去**。

---

## 需要使用者本人做的事（寫成清楚編號步驟）
> ❌ **不需要**：搶機、升 PAYG（皆已完成）。
1. **確認可 SSH**：`ssh -i C:\Users\bigsh\.ssh\oracle_puhui.key ubuntu@140.238.48.197` 能進。
2. **scp 祕密上 VM**：
   - `engine/.env`（`FINMIND_TOKEN`、`FUGLE_API_KEY` host=`api.fugle.tw`、`FRED_API_KEY`）→ `~/Stock_recommendations/engine/.env`
   - 根 `.env` 確認已含 `TELEGRAM_*`（gateway healthcheck 告警用，VM 多半已有；B1 老王沿用既有 `GOOGLE_*`/`GEMINI_*`/PressPlay cookies）
3. **開埠/安全**：預設**只開 SSH（22）**，前端走 `ssh -L 3000:localhost:3000` tunnel；若要對外開 3000 必須**鎖來源 IP**（免費 VM 怕被掃）。
4. **設 GitHub repo secrets**（給 `data_refresh.yml` 備援）：`FINMIND_TOKEN`、`FRED_API_KEY`、`FUGLE_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。

---

## 具體工作項（含已知坑）
- **§1 部署第一層（照 runbook §3）**：
  - 先 SSH 唯讀盤點（git log、`crontab -l` 存檔、確認 node/claude/python、`systemctl is-active` 兩個新服務）。
  - `cd ~/Stock_recommendations/deploy && sudo APP_DIR=/home/ubuntu/Stock_recommendations RUN_USER=ubuntu ./bootstrap.sh`（冪等；視需要 `INSTALL_PLAYWRIGHT`/`NODE_MAJOR`/`TZ_NAME`）。**裝 cron 段落特別留意地雷 §1**。
  - 完成後 scp `engine/.env` → `sudo systemctl restart puhui-engine puhui-gateway` → `curl -s http://127.0.0.1:3000/api/health` 應 `engine:up`。
  - **ARM 實裝確認**：pandas/pyarrow（aarch64 wheel）、playwright chromium（已有 1217，確認 engine 用得到）。
- **§2 老王 cron 遷移到 `RUN_TARGET=vm`（謹慎、單步驗收）**：
  - 編輯 VM 本地的 `~/puhui_daily_cron.sh`（**這是 VM-local wrapper、非 repo 檔，可改**）：在 `node scripts/puhui_daily.cjs` 前 `export RUN_TARGET=vm`。
  - 先手動跑一次 `RUN_TARGET=vm node scripts/puhui_daily.cjs <今天> --force` → 確認：寫 `reports/`、push 成功、**沒寫 Obsidian**、**沒有雙重產出**。看 `~/puhui_daily.cron.log`。
  - 可在 VM 跑 `node scripts/test_puhui_run_target.cjs`（15 passed）再確認解耦旗標。
- **§3 第一層無人值守驗收**：
  - **重開機**：`sudo reboot` → 回來 `systemctl is-active puhui-engine puhui-gateway` 皆 active + `curl /api/health`。
  - **盤後刷新**：手動 `deploy/refresh.sh` → 確認 `reports/signals/<date>.json` 產出 + push（看 `data/cron_refresh.log`）、`crontab -l` 有 refresh 行且**時間與 13:00 老王錯開**。
  - **健康檢查**：手動 `deploy/healthcheck.sh`；`sudo systemctl stop puhui-engine` 模擬故障 → 確認自動 restart + Telegram 告警（去抖動）。
  - **前端**：`ssh -L 3000:localhost:3000` 開 `http://localhost:3000` 確認 5 頁與 `/api/*`。
  - **手機**：pull repo 看 `reports/` + `reports/signals/` 都在更新、未被弄亂。
- **§4 LLM 層（B1 已是既成事實，只做收尾驗證）**：
  - 無頭可用測試：`echo "說個五字內台股問候" | claude -p`。設 `CLAUDE_BIN=/usr/bin/claude`（Linux `which claude`，**非 .cmd**）。
  - `/agents/decide` 在 VM 實測：單一 code（很貴，每股 7×LLM ≈187s），確認 CLI 登入態可用。
  - cookies 過期預警：PressPlay `JAccessToken` 約 2026-06-28 到期（運維參考有更新流程）→ 確認 `puhui_daily.cjs` 內建 ≤5 天預警會發 Telegram。
- **§5 runbook 補實機發現**：VM IP/SSH 慣例、repo 路徑 `Stock_recommendations`、與既有 13:00 老王 cron 的共存方式、ARM 踩到的坑、**B1 已在生產運作的事實**。

---

## 限制與原則
- **不破壞 `reports/` git push**（手機在用）；多方寫同 repo → `pull --rebase` 防分岔。
- **ARM 相容**：pyarrow/playwright 在 aarch64 要有 wheel/binary，VM 上實裝驗證。
- 金鑰/cookies **絕不進 git**（`.env`、`data/*cookies*` 已 gitignored）。
- 安全：預設只開 SSH、tunnel 看前端；對外公開鎖來源 IP。**不要多開 instance/LB/volume（會扣費）**。
- 需使用者本人操作的（SSH、scp 祕密、設 GH secrets）**寫成步驟讓他自己做**。

## 驗收標準
- **第一層（必達）**：VM engine + gateway 常駐、**重開機自起**；手機/瀏覽器能開到前端與 `/api/*`；盤後 cron 無人值守刷新並 push `reports/signals/`；健康檢查失敗自動 restart + 告警實測通過；**既有 13:00 老王報告照常產出、手機 pull 不受影響**。
- **第二層**：老王 cron 切 `RUN_TARGET=vm` 後無人值守產出並 push（不寫 Obsidian、不雙跑）；`/agents/decide` 在 VM 實測可用。
- `data_refresh.yml` 設好 GH secrets 後跑一次綠燈；`docs/runbook.md` 補完實機發現。

## 完成收尾清單（DoD）
1. `docs/runbook.md` 補實機發現 +「老王 B1 已在生產運作」結論 + 與 13:00 cron 共存方式。
2. `docs/ROADMAP.md`：階段 8 改 **✅ 完成**（實機落地）+ **全案完成總結**（8 階段回顧、終局架構圖、維運入口）。
3. Obsidian：新增 `C:\obsidian\儲存庫\財經APP開發\階段9-完成紀錄.md` + `開發進度.md` 標**全案完成**；並同步 `Oracle_VM_運維參考.md`（補新 engine/gateway 服務、refresh/healthcheck cron）。
4. 記憶 + `MEMORY.md`：更新 [[phase8-cloud-deploy]]、[[oracle-cloud-access]]（標實機部署完成、B1 生產運作）。
5. **git commit & push**（`phase9: 新堆疊上既有 VM + 全案收尾`）。本機 push 前先 `git pull --rebase`（本機可能落後 VM 的當天報告 commit）。

## 開始方式
1. **先 SSH 唯讀盤點 VM**（git log/`crontab -l`/`systemctl is-active`/`curl 127.0.0.1:3000/api/health`），對齊「已就緒 vs 待補」。
2. 讀 `docs/runbook.md` + `deploy/`，提部署/驗收計畫讓使用者確認；協助 `bootstrap.sh`（帶 `APP_DIR`）+ scp `engine/.env` + **單獨驗收第一層（無 LLM）**，全程守住共存地雷 §1。
3. 老王 cron 遷移 `RUN_TARGET=vm`（單步驗收、不雙跑）；`/agents/decide` VM 實測。
4. 全案收尾（DoD）。
