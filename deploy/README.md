# deploy/ — Oracle Cloud VM 部署資產（階段8）

完整操作見 **`docs/runbook.md`**。這裡是檔案清單與一行速記。

| 檔案 | 用途 |
|---|---|
| `bootstrap.sh` | VM 一鍵部署（冪等）：裝 Node/Python venv/相依 → build 前端 → systemd → cron → 時區。`sudo ./bootstrap.sh` |
| `puhui-engine.service` | systemd 範本：FastAPI 引擎（127.0.0.1:8000，pydantic 讀 `engine/.env`） |
| `puhui-gateway.service` | systemd 範本：Node gateway + 同源前端（:3000，loadEnv 讀根 `.env`） |
| `refresh.sh` | cron：盤後**無 LLM**刷新（pull → 暖快取 → 存 `reports/signals/<date>.json` → push） |
| `healthcheck.sh` | cron：`/api/health` 監控，異常自動 restart + Telegram（去抖動） |
| `crontab.example` | cron 範本（refresh + healthcheck；老王 B1 預設註解＝B2 留本機） |

## 最短路徑
```bash
# 0) 在 Windows 先搶到 VM：powershell -File scripts/oracle_capacity_grab.ps1（讀根 .env）
# 1) VM 上：
git clone <repo> ~/cc-ai-agent && cd ~/cc-ai-agent/deploy
sudo ./bootstrap.sh
# 2) scp 祕密上來（engine/.env、根 .env），再 restart：
sudo systemctl restart puhui-engine puhui-gateway
# 3) SSH tunnel 看前端（最安全）：
ssh -L 3000:localhost:3000 <user>@<VM_IP>   # 瀏覽器開 http://localhost:3000
```

## 架構（誰跑在哪）
- **VM 常駐（無 LLM，第一層必達）**：engine + gateway + 前端 + 盤後 refresh + healthcheck。
- **LLM 層（第二層，視決策點）**：老王摘要預設 **B2 留本機 Task Scheduler**；B1（VM cron）需 CLI 登入態，屬加值。`/agents/decide` 維持前端按鈕觸發。
- **GitHub Actions**：`data_refresh.yml` 無 LLM 健康/回歸備援；`puhui_daily.yml` 維持停用（Gemini free key quota=0）。
