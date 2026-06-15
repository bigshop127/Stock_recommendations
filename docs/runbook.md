# Runbook — 雲端部署與每日排程（階段8／9 实机落地）

> 目標：使用者不開電腦也能每天自動產訊號/報告。本檔是維運手冊：怎麼部署、怎麼救、怎麼重授權。
> **現況（2026-06-15 实机落地）：全 8 階段完成。VM 已上線並部署完整堆疊、無人值守驗收通過。**
> ⚠️ 本檔保留「搶機（§2）」「初次部署（§3）」段落作**歷史/重建參考**——VM 早於 2026-05-28 上線，**不需再搶機**。

---

## 实机現況速覽（2026-06-15，⭐先讀這段）

| 項目 | 值 |
|---|---|
| VM | Oracle `VM.Standard.A1.Flex` 2 OCPU/12GB、Ubuntu 22.04.5 **aarch64**、TZ Asia/Taipei |
| 連線 | `ssh -i C:\Users\bigsh\.ssh\oracle_puhui.key ubuntu@140.238.48.197` |
| repo 路徑 | `/home/ubuntu/Stock_recommendations`（**非 "CC AI Agent"**；bootstrap 要帶 `APP_DIR`） |
| 常駐服務 | systemd `puhui-engine`(127.0.0.1:8000) + `puhui-gateway`(:3000)，**enabled 重開機自起** |
| cron | `0 13` 老王 B1（`RUN_TARGET=vm`）／`0 14` `refresh.sh`／`*/15` `healthcheck.sh`（皆週一~五，台北時間） |
| 老王 wrapper | `/home/ubuntu/puhui_daily_cron.sh`（**VM-local 非 repo 檔**，已加 `export RUN_TARGET=vm` + `CLAUDE_BIN=/usr/bin/claude`；舊版備份 `.bak.pre-phase9-*`） |
| LLM | 老王＝VM `/usr/bin/claude` 無頭（**B1 已生產運作 ~18 天**）；`/agents/decide`＝前端按鈕，VM 上 gemini 未裝→一律 claude fallback |
| 前端 | 走 `ssh -L 3000:localhost:3000` tunnel 看；只開 SSH(22) 對外 |
| 帳單 | PAYG 但用量在 Always-Free 內、月費 $0；**勿多開 instance/LB/volume** |

**实机踩到 / 要知道的事：**
- ARM(aarch64)：pandas/pyarrow/numpy 全有 aarch64 wheel，bootstrap 零編譯即裝好。`INSTALL_PLAYWRIGHT=0` 即可（老王沿用既有 `~/.cache/ms-playwright` chromium，`npm ci` 不會清掉）。
- VM 根 `.env` 早含 `CLAUDE_BIN=/usr/bin/claude`、`OBSIDIAN_DIR=/home/ubuntu/obsidian_reports`、`PLAYWRIGHT_CHROMIUM_PATH`（這就是 local 模式也能在 Linux 跑的原因）。`engine/.env` 在 VM **不存在**、需 scp。
- **VM Google OAuth refresh token 已過期/撤銷（`invalid_grant`）** → Gmail 路徑失效、自動走 Playwright fallback 抓文（報告不受影響，每次會 Telegram 預警）。要修：本機重跑 `node scripts/oauth_reauth.cjs` 後把新 token scp 上 VM。
- **與既有 13:00 老王 cron 共存**：`bootstrap.sh` 只增刪 `# >>> puhui phase8 >>>` 標記區塊（refresh+healthcheck），**不碰** `0 13` 老王行；動前已備份 `~/crontab.backup.pre-phase9-*`。三方（老王/refresh/本機）寫同 repo 都 `git pull --rebase`、排程時間錯開。
- 老王 B1 遷移：只改 VM-local wrapper 加 `RUN_TARGET=vm`（不寫 Obsidian、以 repo `reports/` 判斷已產出、不雙跑）。**勿啟用 `crontab.example` 裡 18:30 的 B1 行**（會與 13:00 雙跑）。

---

## 0. 架構：誰跑在哪

| 工作 | 位置 | LLM | 常駐方式 |
|---|---|---|---|
| engine（FastAPI :8000，綁 127.0.0.1） | Oracle VM | 否 | systemd `puhui-engine` |
| gateway + 前端（Node :3000，serve `web/dist`） | Oracle VM | 否 | systemd `puhui-gateway` |
| 盤後數據/訊號刷新 + push `reports/signals/` | Oracle VM | 否 | cron `refresh.sh`（14:00 週一~五） |
| 健康檢查 + 自動 restart + 告警 | Oracle VM | 否 | cron `healthcheck.sh`（每 15 分） |
| 老王每日摘要（`puhui_daily.cjs`） | **Oracle VM cron（B1，預設，已生產運作）**；本機（B2）為離線備援 | 是 | VM cron 13:00（`RUN_TARGET=vm`）／本機 Task Scheduler 備援 |
| `/agents/decide` 多 agent | 前端按鈕觸發（打 VM gateway） | 是 | 手動（很貴） |
| 數據層回歸/健康備援 | GitHub Actions `data_refresh.yml` | 否 | 排程（VM 掛掉的 backstop） |
| LLM 版老王 `puhui_daily.yml` | **停用** | 是 | Gemini free key quota=0 |

**LLM 決策點（階段9 实机修正 2026-06-15）**：老王摘要＝**B1（VM cron `RUN_TARGET=vm`）為預設且已生產運作**——SSH 盤點+cron log 證實 VM 自 2026-05-28 起每工作日用 `/usr/bin/claude` 無頭跑老王、至今成功，「headless CLI token 續命」已被 ~18 天生產實測證實（不再是未知風險）。本機 B2 退為離線備援。`/agents/decide` 維持前端按鈕觸發（VM 上 gemini 未裝→claude fallback）。

---

## 1. 祕密檔配置（一律不進 git）

| 檔案 | 位置 | 內容 | 誰要用 |
|---|---|---|---|
| 根 `.env` | repo 根 | `OCI_*`（搶機）、`TELEGRAM_*`、（B1 才需）`GOOGLE_*`/`GEMINI_*` | 搶機腳本、老王、refresh/healthcheck 告警 |
| `engine/.env` | `engine/` | `FINMIND_TOKEN`、`FUGLE_API_KEY`、`FRED_API_KEY` | engine（pydantic 讀） |
| OCI 憑證 | `~/.oci/config` + `oci_api_key.pem` | tenancy/user OCID、fingerprint、region、🔐私鑰 | OCI CLI 搶機（Windows） |
| PressPlay cookies | `data/pressplay_cookies.json` | 老王抓文登入態 | `puhui_daily.cjs` |

- **VM 上的根 `.env`** 只需放 `TELEGRAM_*`（+B1 的 `GOOGLE_*`/`GEMINI_*`）；**不需** `OCI_*`（搶機在 Windows 跑）。
- **VM 上的 `engine/.env`** 記得帶 `FUGLE_API_KEY`（2026-06-14 已接，host=`api.fugle.tw`），否則盤中分K/五檔內外盤走降級。
- 2026-06-15 已用 `~/.oci/config` + Downloads ORM log 重建 Windows 根 `.env`（`OCI_*` + `TELEGRAM_*`）。

---

## 2. 第 0 步：搶到 VM（只有你本人能做，在 Windows）

東京（home region，無法換）免費 A1 長期 **`Out of host capacity`**——這是缺貨、不是設定錯。

1. 確認根 `.env` 有 `OCI_*` + `TELEGRAM_*`（已重建）。需要 OCI CLI 在 PATH（或設 `OCI_EXE`）。
2. 跑搶機迴圈（搶到會 Telegram 通知 + 寫 `data/oracle_grab_state.json`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\CC AI Agent\scripts\oracle_capacity_grab.ps1"
   ```
3. **持續搶不到的最有效解（建議）**：到 Oracle Console 把帳號升級 **Pay-As-You-Go（PAYG）**——仍保留 Always-Free 額度，但容量優先權大增，搶機成功率高很多。或接受 grab 迴圈長時間重試（可把 `ORACLE_GRAB_INTERVAL` 調到 30）。
4. 搶到後記下 **public IP**；SSH 私鑰對應公鑰 `ssh-key-2026-05-26`（私鑰由你保管，執行者不碰）。
5. **VM 開埠**：Oracle Security List + VM 防火牆**只開 SSH（22）**最安全；前端走 SSH tunnel（見 §4）。要對外公開前端再評估鎖來源 IP。

---

## 3. 部署到 VM（搶到後）

```bash
# SSH 進 VM 後：
git clone <你的 repo> ~/cc-ai-agent
cd ~/cc-ai-agent/deploy
chmod +x *.sh
sudo ./bootstrap.sh          # 冪等：裝 Node20/Python venv/相依 → build 前端 → systemd → cron → 時區
```
`bootstrap.sh` 完成後會提示缺哪些祕密。從 Windows scp 上去：
```bash
scp engine/.env       <user>@<VM_IP>:~/cc-ai-agent/engine/.env
scp .env.vm           <user>@<VM_IP>:~/cc-ai-agent/.env     # VM 版根 .env：只放 TELEGRAM_*（+B1 的 GOOGLE_/GEMINI_）
# 然後在 VM：
sudo systemctl restart puhui-engine puhui-gateway
curl -s http://127.0.0.1:3000/api/health    # 應回 {"engine":"up",...}
```

**git push 認證（cron 要 push `reports/signals/`）**：在 VM 設 deploy key 或 PAT：
```bash
# 方法 A：deploy key（建議）
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""   # 把 .pub 加到 GitHub repo 的 Deploy keys（勾 write）
git -C ~/cc-ai-agent remote set-url origin git@github.com:<owner>/<repo>.git
# 方法 B：PAT → git remote 用 https 帶 token
```

---

## 4. 看前端（最安全：SSH tunnel，不開對外埠）

```bash
ssh -L 3000:localhost:3000 <user>@<VM_IP>
# 然後本機瀏覽器開 http://localhost:3000
```
手機讀報告維持 `reports/` git pull（不需開埠）。若真要對外公開前端：Oracle Security List 開 3000 並**鎖來源 IP**，避免免費 VM 被掃。

---

## 5. 日常運作（cron 在做什麼）

| 時間（台北） | 動作 | log |
|---|---|---|
| 14:00 週一~五 | `refresh.sh`：`git pull --rebase` → 暖快取（/api/dashboard、/api/watchlist）→ 存 `reports/signals/<date>.json` → push | `data/cron_refresh.log` |
| 每 15 分 | `healthcheck.sh`：`/api/health` 失敗→`systemctl restart`+Telegram（去抖動，連續失敗才發一次） | `data/cron_health.log` |
| 18:30 週一~五（**B1 才啟用**） | `RUN_TARGET=vm node scripts/puhui_daily.cjs`：抓老王文→Claude CLI 摘要→寫 `reports/`→push | `data/cron_puhui.log` |

- **B2（預設）**：老王摘要仍在**本機 Task Scheduler**（`PuhuiDaily_Summary` 18:30）跑、push `reports/`；VM 的 `refresh.sh` 會 `git pull` 收進來。
- 時區由 `bootstrap.sh` 設 `Asia/Taipei`；確認：`timedatectl`。

---

## 6. LLM 在雲端（B1，**已生產運作**；下列為重新登入/排錯用）

> 2026-06-15 实机確認：VM `/usr/bin/claude` 無頭登入態自 05-28 起每工作日跑老王成功，B1 已是既成事實。
> 老王 wrapper `~/puhui_daily_cron.sh` 已設 `RUN_TARGET=vm` + `CLAUDE_BIN=/usr/bin/claude`。下列步驟供**登入態失效時重新授權**。
> 注意：VM 上 **未裝 gemini**，`/agents/decide` 一律走 claude（fallback），無需 gemini 登入。

當 CLI 登入態失效（claude 報未授權）時：
1. SSH 進 VM，登入 CLI（可能需瀏覽器 OAuth；claude 吃 Pro/Max 訂閱、gemini 吃 Google 登入）：
   ```bash
   claude            # 依指示完成登入；登入態存 ~/.claude
   gemini            # 同上；存 ~/.gemini
   ```
2. 手動驗證無頭可用（整段 prompt 走 **stdin**；gemini 臨時 cwd 要 `--skip-trust`）：
   ```bash
   echo "說個五字以內的台股問候" | claude -p
   cd /tmp && echo "hi" | gemini --skip-trust -p
   ```
3. 設 `CLAUDE_BIN`（Linux `which claude`，**非** `.cmd`——那是 Windows-only 坑）。
4. 啟用老王 cron：`crontab -e` 取消 `crontab.example` 老王那行註解。
5. 跑一次實測：`cd ~/cc-ai-agent && RUN_TARGET=vm node scripts/puhui_daily.cjs 2026-06-XX --force`。
6. **若 token 幾天後失效**：誠實回退 B2（老王留本機），VM 只做無 LLM 層；失效時 healthcheck/老王崩潰會 Telegram 告警。

> `/agents/decide`（每股 7×LLM、很貴）維持**前端按鈕觸發**——誰開著前端就用 VM 上登入的 CLI。

---

## 7. 故障排除

| 症狀 | 處置 |
|---|---|
| 前端/API 打不開 | `sudo systemctl status puhui-gateway puhui-engine`；`journalctl -u puhui-engine -u puhui-gateway -n 100`；`sudo systemctl restart …` |
| `/api/health` engine:down | engine 掛了：`journalctl -u puhui-engine -n 100`（多半是 `engine/.env` 缺金鑰或 ARM 套件問題）；`sudo systemctl restart puhui-engine` |
| ARM 套件裝不起來 | `cd engine && ./.venv/bin/pip install -r requirements.txt`（pandas/pyarrow 有 aarch64 wheel；若 pip 太舊先 `pip install -U pip wheel`） |
| cron 沒 push | 看 `data/cron_refresh.log`；多半 git 認證（§3 deploy key/PAT）或分岔（腳本已 `pull --rebase` 重試一次） |
| PressPlay cookies 失效 | 老王會 Telegram 預警（≤5 天）/ 失效告警。更新：本機 `node scripts/refresh_pressplay_cookies.cjs`（或 `export_pressplay_cookies.js`）重存 `data/pressplay_cookies.json`，B1 再 scp 上 VM |
| CLI 授權失效（B1） | 重跑 §6 步驟 1-2 重新登入；長期不穩就回退 B2 |
| VM 重開機後 | systemd 已 `enable`，engine/gateway 開機自啟；驗證 `systemctl is-active puhui-engine puhui-gateway` + `curl /api/health`。cron 由 crond 自動恢復 |
| 想重跑部署 | `bootstrap.sh` 冪等，可直接重跑（更新碼後 `git pull` 再 `sudo ./bootstrap.sh`） |
| 更新前端 | `git pull && cd web && npm ci && npm run build && sudo systemctl restart puhui-gateway` |

---

## 8. Telegram 告警一覽（都走根 `.env` 的 `TELEGRAM_*`）

| 來源 | 訊息 | 意義 |
|---|---|---|
| `oracle_capacity_grab.ps1` | grab heartbeat / RUNNING / quota | 搶機進度/成功/額度 |
| `healthcheck.sh` | ⚠️ 健康檢查失敗 / ✅ 恢復正常 | VM 服務掛/復原 |
| `refresh.sh` | ⚠️ 盤後刷新失敗 | engine/gateway 異常或 push 失敗 |
| `puhui_daily.cjs` | cookies 過期預警 / OAuth 異常 / 崩潰 | 老王安全網（本機 B2 或 VM B1） |
| `data_refresh.yml` | ⚠️ 數據層備援檢查失敗 | engine 回歸測試掛（程式回歸） |

---

## 9. 指令速查

```bash
# 服務
sudo systemctl {status,restart,stop,start} puhui-engine puhui-gateway
journalctl -u puhui-engine -f
systemctl is-active puhui-engine puhui-gateway

# 健康 / 手動刷新
curl -s http://127.0.0.1:3000/api/health
~/cc-ai-agent/deploy/refresh.sh
~/cc-ai-agent/deploy/healthcheck.sh

# cron
crontab -l

# 搶機（Windows）
powershell -ExecutionPolicy Bypass -File scripts\oracle_capacity_grab.ps1

# §A 回歸測試（任何機器）
node scripts/test_puhui_run_target.cjs

# 數據層 smoke（VM/本機）
cd engine && ./.venv/bin/python scripts/smoke_data.py
```
