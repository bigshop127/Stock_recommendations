# 財經 APP 整合藍圖（老王情報 + 多因子量化 + 多 agent LLM + 前端 + 雲端）

> 建立 2026-06-13。目標：把現有「浦惠投顧老王每日盤勢自動化」（內容工具）升級成
> **會出台股買賣訊號（波段＋短線當沖）、可回測、有前端、能雲端每日自動運作**的策略系統。
> 整合：(1) 多因子量化引擎 (2) TradingAgents 式多 agent 決策 (3) APP 前端 (4) 雲端化。

---

## 0. 既有資產（任何階段都不可破壞）

- `scripts/puhui_daily.cjs`：每天抓老王盤勢文 → AI 摘要 → 產 `reports/YYYY-MM/Wn/*.md`，天天在跑。
- `data/puhui_analysis/*.json`：歷史文章結構化分析（market_regime、mentioned_stocks[code/name/signal/reason]、entry/exit_conditions、strategy_insights）。
- `data/puhui_cache.json`：當日水位、個股、market_sentiment、confidence_level。
- `reports/**/*.md`、`server.cjs`（Express 骨架）。

---

## 1. 已定案的關鍵決策

1. **架構**：Node 內容線保留不動；新增 **Python FastAPI 引擎**（`engine/`）做數據/因子/回測/agent；Node 當 gateway；前端獨立。三者走 HTTP。
2. **「七維度」作廢** → 改 **多因子評分模型**（`docs/scoring-model.md`，第 1 階段**已定案：方案 C 雙引擎分離**）。因子用真實台股數據，權重不寫死、用回測調：
   - **波段引擎（可回測）**：技術 0.40 + 籌碼 0.40 + 情緒 0.20，再 × 大盤環境閘門 0.5~1.1（避免逆風接刀）。
   - **當沖引擎（live-only，不回測）**：盤口 0.45 + 當日技術 0.35 + 大盤當日 0.20；籌碼僅作「能否當沖」過濾、不計分。
   - watchlist 對每檔同時給 `swing_score` 與 `daytrade_prob`，各自排序。
   - 五大資料維度：
   - 技術面（RSI/MA/三陽開泰/乖離/量能）← OHLCV
   - 籌碼面（三大法人買賣超、融資融券）← FinMind
   - 盤口/主力（內外盤、五檔委買賣、大單）← 富果 Fugle **（live-only，不進回測）**
   - 消息情緒面（新聞情緒 + 老王 strategy_insights）
   - 大盤環境（0050/大盤 regime、漲跌家數/恐懼貪婪 proxy）
3. **數據源**：
   - **FinMind**（免費）：歷史 OHLCV + 三大法人 + 融資融券 → **回測主力**。
   - **富果 Fugle**（API key，玉山）：即時報價 + 五檔盤口 + 盤中分K/tick → **live 訊號 + 當沖**。歷史盤口拿不到。
   - **yfinance**：美股四大指數 / 費半（大盤環境）。
4. **訊號兩模式**：波段（swing，可回測）、短線當沖（daytrade，吃富果盤中，回測受歷史資料限制）。
5. **觀察清單**：自動從老王 `mentioned_stocks` 帶入，依「潛力(波段分) + 短線當沖機率」排序成重點關注。
6. **LLM 政策**：**Gemini CLI 主 → 當天額度用完切 Claude CLI**；多 agent 只在每日盤後對觀察清單（≤10 檔）跑，不進回測。需可在無頭雲端 VM 跑。
7. **雲端**：**Oracle Cloud Always-Free ARM VM 為主**（24h 常開、保留 CLI 訂閱登入態），**GitHub Actions** 跑無 LLM 的數據/回測刷新。解決「不能 24h 開機」+ 既有 puhui_daily 本機單點故障。
8. **TradingAgents**：沿用其 agent 架構與提示詞設計，數據層換台股（不直接用其美股數據層）。
9. **每階段收尾規範（DoD）**：完成後必須同步 (a) `docs/ROADMAP.md` 進度 (b) Obsidian `C:\obsidian\儲存庫\財經APP開發\` (c) 記憶 `.claude\projects\C--CC-AI-Agent\memory\` (d) 程式/文件放對位置。

---

## 2. 8 階段總覽與進度

| # | 階段 | 產出 | 依賴 | 狀態 |
|---|---|---|---|---|
| 1 | 架構地基 + 資料契約 | FastAPI 骨架、Node↔Python、**多因子模型定案（方案C 雙引擎）**、共用 schema、收尾規範 | — | ✅ 完成 2026-06-13 |
| 2 | 台股數據層 | FinMind + TWSE MIS + TAIFEX + 鉅亨/Google News + FRED + yfinance（富果可選）+ 快取 | 1 | ✅ 完成 2026-06-13 |
| 3 | 多因子引擎 + 回測核心 | 確定性訊號（波段＋當沖）+ 向量化回測 | 1,2 | ⬜ |
| 4 | 老王整合 + 觀察清單 | 老王融合訊號 + 自動觀察清單（潛力/當沖排序） | 3 | ⬜ |
| 5 | 多 agent LLM 決策層 | 分析師→多空辯論→交易員→風控 | 3,4 | ⬜ |
| 6 | 統一 API 層 | Node gateway，吐 報告/訊號/水位/回測/agent決策 | 3,4,5 | ⬜ |
| 7 | APP 前端 + 端到端整合 | Vite+React 儀表板 + 當沖候選 | 6 | ⬜ |
| 8 | 雲端部署 + 每日排程 | Oracle VM（主）+ GitHub Actions；runbook | 7 | ⬜ |

執行節奏：第 1 定契約最關鍵；第 3 完成＝有可回測策略硬核；第 5 才上 LLM；第 7 接前端；第 8 上雲。

---

## 3. 技術選型（建議）

- 引擎：Python 3.11+ / FastAPI / uvicorn；TA：pandas + pandas-ta；回測：純 pandas 向量化（避免未來函數）
- 數據：FinMind、fugle-marketdata（富果）、yfinance；快取 parquet 或 sqlite
- 多 agent：LangGraph + langchain；LLM 走 Gemini CLI → Claude CLI
- Gateway：Node Express（server.cjs）
- 前端：Vite + React + TypeScript + Tailwind + lightweight-charts（行動友善）
- 雲端：Oracle Cloud Always-Free（ARM Ampere）+ GitHub Actions

---

## 4. 各階段提示詞檔案

放在 `docs/prompts/phase1.md … phase8.md`。
使用方式：開新對話 →「請幫我閱讀 docs/prompts/phaseN.md 然後按照裡面的說明進行。」

---

## 5. 仍待定案（執行到對應階段時決定）

- [x] 多因子最終因子組合與初始權重 → **階段1定案：方案 C 雙引擎**（見 `docs/scoring-model.md`）
- [ ] 各子訊號 → 0~100 的正規化細節、regime gate 連續/分段（第 3 階段回測決定）
- [~] 新聞情緒數據來源 → 階段2 已預接免費源（鉅亨 Anue JSON + Google News RSS，`/data/news`）；情緒模型/語料庫留階段4
- [ ] 當沖訊號的具體進出規則與風控（第 3 階段）
- [ ] Oracle VM vs GitHub Actions 各跑哪一段（第 8 階段細分）

---

## 6. 階段 1 完成紀錄（2026-06-13）

- `engine/` FastAPI 分層 package 骨架，`GET /health` 回 200；pytest 2 passed。
- `scripts/engine_healthcheck.cjs`：Node 呼叫 engine /health 成功（HTTP 200，✅ 串接）。
- 多因子定案 **方案 C 雙引擎**（`docs/scoring-model.md`）。
- 共用契約：`docs/contracts/{StockSignal,FactorScore,DailySnapshot,Watchlist,BacktestResult}.md` + `dev-conventions.md`。
- 收尾規範與目錄結構入檔（`dev-conventions.md`）。

---

## 7. 階段 2 完成紀錄（2026-06-13）

詳見 `docs/data-layer.md`。重點：

**架構升級（取代部分付費 API 的免費替代方案，使用者確認）**：原訂「富果為唯一即時源」
改為 **TWSE MIS（官方公開 JSON，免金鑰）為 `/data/book` 預設**、富果降為可選 adapter
（`BOOK_SOURCE=auto`：有富果 key 才用，否則 MIS）。並把後續階段要用的免費官方源**先建好骨架**：
TAIFEX 期貨（regime）、鉅亨/Google News（情緒）、FRED（總經）。原則：優先官方開放資料/公開 JSON，
不做第三方網站 HTML 爬蟲。

**8 個 `/data/*` 端點**（FastAPI，`engine/app/api/data.py`）：
- 可回測：`/data/ohlcv`、`/data/chips`（FinMind）、`/data/futures`（TAIFEX）、`/data/macro`（FRED）
- live-only：`/data/book`（MIS 預設/富果可選）、`/data/intraday`（富果）、`/data/news`（鉅亨/Google）
- 環境：`/data/market`（yfinance）

**資料源 client**（`engine/app/data/`）：`finmind_client`、`twse_mis_client`、`taifex_client`、
`news_client`、`fred_client`、`fugle_client`、`yfinance_client` + `cache`（parquet, gap-based 浮水印）+
`http`（retry/get_json/get_text/post_text）+ `service`（編排）。

**測試/驗收**：pytest **16 passed**（mock，不打網路）。免金鑰源 2026-06-13 實測通過：
MIS 2330 五檔（last 2310、bid 2305/ask 2310）、TAIFEX 三大法人期貨未平倉＋P/C、
鉅亨＋Google News、yfinance 六指數。需金鑰源（FinMind OHLCV/籌碼、FRED 總經）待填 `engine/.env` 後 smoke 驗。

**金鑰**：`FINMIND_TOKEN`（建議必填）、`FUGLE_API_KEY`（可選）、`FRED_API_KEY`（/data/macro 才需）；
皆走 `engine/.env`（gitignored）。`engine/data_cache/` 已加 .gitignore。`puhui_daily.cjs` 未更動。

**已知缺口**：分點主力（乾淨自動化難，暫緩）、漲跌家數 A/D（階段3 proxy）、富果分K 回溯範圍（無富果 key 未量測）、新聞情緒歷史語料（階段4）。
