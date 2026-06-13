# 階段 8：雲端部署 + 每日排程（解決「不能 24h 開機」）

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase8.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`.github/workflows/puhui_daily.yml`、`scripts/puhui_daily.cjs`，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深 DevOps / 平台工程師。把整套系統搬上雲，做到「使用者不開電腦也能每天自動產訊號與報告」。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1-7 已完成：engine（Python）、gateway（Node）、前端（web/）、多 agent。
- 現況痛點（要解）：
  - 使用者**無法 24h 開電腦**。
  - 既有 `puhui_daily.cjs` 目前靠**本機 Windows Task Scheduler**（單點故障），雲端排程 `puhui_daily.yml` 已停用（註解說明：雲端跑不了需登入態的 Claude CLI、Gemini free quota 歸零）。
  - LLM 政策：Gemini CLI 主 → Claude CLI 接力，**兩者都需登入態**。
- 終局見 `docs/ROADMAP.md`。

## 本階段目標
1. **Oracle Cloud Always-Free ARM VM 為主**（24h 常開、免費）：
   - 部署 Python engine + Node gateway（+ 選擇性前端 build）。
   - 在 VM 上**一次性登入** Gemini CLI 與 Claude CLI（SSH 進去手動授權），讓 cron 之後能直接用訂閱、不需每天重登。
   - 設 cron：每交易日盤後跑「數據更新 → 多因子訊號 → 老王融合 → 多 agent 決策 → 產報告 → git push」。
   - 把既有 `puhui_daily` 流程也搬上 VM，擺脫本機 Task Scheduler 單點故障。
2. **GitHub Actions 跑無 LLM 的部分**（數據刷新、回測），當作備援/輔助；恢復可行的 `puhui_daily.yml` 排程（用 Gemini API key 那條路，與 VM 互補）。
3. 手機讀取：報告/訊號 push 到 GitHub（沿用現有手機 pull 模式），或前端部署成可手機開的網址。
4. 韌性：PressPlay cookies 過期預警、CLI 授權失效告警（沿用既有 Telegram 安全網）；寫 `docs/runbook.md`（每天怎麼運作、出錯怎麼修、如何重新授權 CLI）。

## 限制與原則
- 先確認 Oracle Always-Free 規格（ARM Ampere）夠跑（Python+Node+前端）；若資源吃緊，前端改靜態部署。
- 金鑰/cookies 走環境變數或 secret，不可進 git。
- 不要破壞既有 `reports/` git push 模式（手機在用）。
- 涉及需要使用者本人操作的步驟（Oracle 開帳號、SSH 授權 CLI），**寫成清楚步驟讓我自己做**，不要假設你能代為登入。

## 驗收標準
- VM 上 cron 能在無人值守下跑完整每日流程並 push 報告/訊號。
- Gemini→Claude CLI 接力在 VM 上實測可用。
- `docs/runbook.md` 完整：日常運作、故障排除、CLI 重新授權、cookies 更新。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 8 標 ✅、全案完成總結。
2. 更新 Obsidian：`...\財經APP開發\階段8-完成紀錄.md` + `開發進度.md`（標全案完成）。
3. 更新記憶 + `MEMORY.md`。
4. 部署腳本/設定放 `deploy/`，runbook 放 `docs/runbook.md`。
5. git commit（`phase8: 雲端部署與排程`）。

## 開始方式
先讀 `docs/ROADMAP.md`、`.github/workflows/puhui_daily.yml`、`scripts/puhui_daily.cjs`，提出部署架構（哪段跑 Oracle VM、哪段跑 GitHub Actions）+ 我需要自己手動做的步驟清單，讓我確認，再動手。
