# 開發收尾規範（dev-conventions）

> 定案 2026-06-13（階段 1）。每階段都依此收尾，避免地基走鐘。全局見 `../ROADMAP.md`。

## 1. Repo 目錄結構

| 目錄 | 放什麼 |
|---|---|
| `engine/` | Python FastAPI 引擎（分層 package，見 `engine/README.md`）：`app/{api,core,data,factors,backtest,agents}` |
| `web/` | 前端（階段7，Vite+React+TS+Tailwind+lightweight-charts） |
| `docs/` | 規格文件：`ROADMAP.md`、`scoring-model.md`、`contracts/*.md`、`prompts/phaseN.md` |
| `docs/contracts/` | 全系統共用 JSON 契約 + 本規範 |
| `scripts/` | 既有 Node 內容線（**不動**）+ 新增串接工具（如 `engine_healthcheck.cjs`） |
| `data/` | 既有 Node 產物（gitignored 的快取/分析）+ 引擎快取 `data/engine_cache/`（gitignored） |
| `reports/` | 既有每日報告 markdown（不動） |
| `server.cjs` | 既有 Express gateway（階段6 擴充對接 engine，先不大改） |

## 2. 不可破壞的既有資產

- **絕對不改** `scripts/puhui_daily.cjs` 的每日流程。
- 不改 `data/puhui_analysis/*.json`、`data/puhui_cache.json`、`reports/**/*.md` 的產生方式；引擎**唯讀**取用。
- Node ↔ Python 一律走 HTTP，不共用程序、不互相 import。

## 3. 編碼/平台

- Windows / PowerShell；檔案一律 **UTF-8**（中文路徑常見，注意編碼）。
- Python ≥ 3.11；引擎相依放 `engine/requirements.txt`（與 `pyproject.toml`）。
- 機密（FinMind token、富果 key、Google/Telegram 等）走環境變數 / `.env`，**不進 repo**。

## 4. 模型/契約紀律

- 因子權重**不寫死**，集中於 `engine/app/factors` 設定物件，回測輸出後回填（見 `scoring-model.md` §4）。
- `live_only` 因子（富果盤口等）**不得進回測**。
- 對外型別以 `docs/contracts/*.md` 為單一事實來源；改欄位要同步契約 + 範例。

## 5. 每階段 DoD（完成定義 — 必做）

1. **驗收**：跑該階段「驗收標準」，把結果貼給使用者。
2. **更新 ROADMAP**：`docs/ROADMAP.md` 對應階段標 ✅、記錄關鍵決策與未盡事項。
3. **更新 Obsidian**：`C:\obsidian\儲存庫\財經APP開發\` 內更新 `開發進度.md` 與 `階段N-完成紀錄.md`（做了什麼、關鍵決策、怎麼用）。
4. **更新記憶**：`C:\CC AI Agent\.claude\projects\C--CC-AI-Agent\memory\` 內相關 `.md` + `MEMORY.md` 索引。
5. **程式/文件放對位置**（engine/ 程式、docs/ 規格、scripts/ 串接）。
6. **git commit + push**（訊息 `phaseN: <摘要>`）：每階段完成即 commit 並 `git push origin master` 上 GitHub 備份。`.env` 已 gitignored、不會外洩金鑰。（2026-06-13 使用者定案：改為自動 push，不再等確認。）

### 關鍵位置速查
- Obsidian 開發筆記：`C:\obsidian\儲存庫\財經APP開發\`
- 記憶檔：`C:\CC AI Agent\.claude\projects\C--CC-AI-Agent\memory\`
- 階段提示詞：`docs/prompts/phaseN.md`
