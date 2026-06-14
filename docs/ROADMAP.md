# 財經 APP 整合藍圖（老王情報 + 多因子量化 + 多 agent LLM + 前端 + 雲端）

> 建立 2026-06-13。目標：把現有「浦惠投顧老王每日盤勢自動化」（內容工具）升級成
> **會出台股買賣訊號（波段＋短線當沖）、可回測、有前端、能雲端每日自動運作**的策略系統。
> 整合：(1) 多因子量化引擎 (2) TradingAgents 式多 agent 決策 (3) APP 前端 (4) 雲端化。

---

## 0. 既有資產（任何階段都不可破壞）

- `scripts/puhui_daily.cjs`：每天抓老王盤勢文 → AI 摘要 → 產 `reports/YYYY-MM/Wn/*.md`，天天在跑。
- **`reports/**/*.md`（✅ git 追蹤、真實獨家資產）**：每日老王報告原文，固定模板（操作水位 / 大盤美股 / 個股區塊 / 老王提醒）。**階段4 確定性解析器（`engine/app/puhui/`）的解析對象。**
- `data/puhui_cache.json`：⚠️ 由 `puhui_daily.cjs` 每日**覆寫**、**gitignored**、可能不在；**淺層** regex 萃取（股名＋emoji，無代號/無 BUY/SELL）。階段4 不依賴它。
- `server.cjs`（Express 骨架）。

> 🚨 **修正舊前提（2026-06-14 階段4 實查）**：舊版本這裡寫的 **`data/puhui_analysis/*.json`
> （market_regime / mentioned_stocks[code/name/signal/reason] / entry_exit / strategy_insights）
> 從未被產生、且 gitignored**，repo 與舊專案都沒有。那份「結構化 JSON」的**真正產生者是階段4 的
> `engine/app/puhui` 解析器**（讀 `reports/**/*.md`），產出可選落地 `data/puhui_analysis/{date}.json` 當快取（仍 gitignored）。
> 另一坑：報告 **emoji 色碼語意與股市相反**（🔴=看多 / 🟢=看空），見 `docs/blend-rules.md`。

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
   - 盤口/主力（五檔委買賣、大單；內外盤需富果）← **TWSE MIS 預設（免金鑰）／富果可選** **（live-only，不進回測）**（階段2 改版，詳 §7）
   - 消息情緒面（新聞情緒 + 老王 strategy_insights）
   - 大盤環境（0050/大盤 regime、漲跌家數/恐懼貪婪 proxy）
3. **數據源**：
   - **FinMind**（免費）：歷史 OHLCV + 三大法人 + 融資融券 → **回測主力**。
   - **TWSE MIS**（官方、免金鑰，階段2 改版起為即時五檔**預設**）：近即時報價＋最佳五檔（無內外盤）。
   - **富果 Fugle**（API key，玉山，**可選**）：即時報價 + 五檔盤口（含內外盤）+ 盤中分K/tick → **live 訊號 + 當沖**。歷史盤口拿不到。
   - **TAIFEX**（官方、免金鑰）：三大法人期貨未平倉＋P/C ratio → **regime**。**FRED**（免費 key）：美國總經。
   - **yfinance**：美股四大指數 / 費半 / VIX（大盤環境）。
4. **訊號兩模式**：波段（swing，可回測）、短線當沖（daytrade，吃富果盤中，回測受歷史資料限制）。
5. **觀察清單**：自動從老王 `mentioned_stocks` 帶入，依「潛力(波段分) + 短線當沖機率」排序成重點關注。
6. **LLM 政策**：**Gemini CLI 主 → 當天額度用完切 Claude CLI**；多 agent 只在每日盤後對觀察清單（≤10 檔）跑，不進回測。需可在無頭雲端 VM 跑。
7. **雲端**：**Oracle Cloud Always-Free ARM VM 為主**（24h 常開、保留 CLI 訂閱登入態），**GitHub Actions** 跑無 LLM 的數據/回測刷新。解決「不能 24h 開機」+ 既有 puhui_daily 本機單點故障。
8. **TradingAgents**：沿用其 agent 架構與提示詞設計，數據層換台股（不直接用其美股數據層）。
9. **每階段收尾規範（DoD）**：完成後必須同步 (a) `docs/ROADMAP.md` 進度 (b) Obsidian `C:\obsidian\儲存庫\財經APP開發\` (c) 記憶 `.claude\projects\C--CC-AI-Agent\memory\` (d) 程式/文件放對位置 (e) **git commit & push** 上 GitHub。（2026-06-13 起每階段完成自動 commit & push，不再等確認；`.env` gitignored。）

---

## 2. 8 階段總覽與進度

| # | 階段 | 產出 | 依賴 | 狀態 |
|---|---|---|---|---|
| 1 | 架構地基 + 資料契約 | FastAPI 骨架、Node↔Python、**多因子模型定案（方案C 雙引擎）**、共用 schema、收尾規範 | — | ✅ 完成 2026-06-13 |
| 2 | 台股數據層 | FinMind + TWSE MIS + TAIFEX + 鉅亨/Google News + FRED + yfinance（富果可選）+ 快取 | 1 | ✅ 完成 2026-06-13 |
| 3 | 多因子引擎 + 回測核心 | 確定性訊號（波段＋當沖）+ 向量化回測 | 1,2 | ✅ 完成 2026-06-13 |
| 4 | 老王整合 + 觀察清單 | 老王融合訊號 + 自動觀察清單（潛力/當沖排序） | 3 | ✅ 完成 2026-06-14 |
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

---

## 8. 階段 3 完成紀錄（2026-06-13）

詳見 `engine/reports/backtest_swing_v1.md`。重點：

**交付**：確定性多因子引擎（無 LLM）＋向量化回測核心。程式 `engine/app/{factors,backtest,api}`：
- `factors/`：`config`（唯一權重設定物件，禁散落）、`normalize`（**滾動分位數**為主，使用者定案）、
  `technical`/`chips`/`sentiment`/`regime`/`swing`/`daytrade`。
- `backtest/`：`engine`（向量化、**T 收盤計分→T+1 開盤成交**、扣台股成本 round-trip 0.585%、0050 benchmark）、`grid`（權重網格）。
- `api/`：`GET /signal?mode=swing|daytrade`、`POST /backtest`＋`/backtest/grid`。pytest **28 passed**。

**關鍵決策（階段3 定案）**：
- 子訊號→0~100 用**滾動分位數**（無未來函數）＋門檻映射；regime gate 用**非對稱分段線性**（逆風重罰 0.5~1.0、順風緩獎 1.0~1.1）。
- 情緒因子**只進 live `/signal`、不進回測**（無歷史語料）；回測 technical/chips 重正規化。盤口/分K live_only 不回測。
- 權重 v1 回填（網格最佳 tech0.6/chips0.4、entry70/exit40）入 `config.py`，標注單期可能過擬合。

**重大數據修正（影響回測可信度）**：
- FinMind 免費級無還原股價（`TaiwanStockPriceAdj` 需付費）→ 0050 因 2025 分割價格斷點害 benchmark 假 −40%。
  **回測/benchmark/regime 趨勢改用 yfinance `auto_adjust` 還原價**（新增 `service.get_ohlcv_adj`，走快取）；籌碼仍 FinMind。
- TAIFEX 下載端點查詢窗有上限（跨數月回 HTML）→ `taifex_client` 內部**分段查詢串接**（期貨 100 日窗、P/C 20 日窗）。

**回測結果（8 檔大型權值股、2024-06~2026-06、還原價）**：策略 **+63.2%／年化 +28.6%／Sharpe 2.12／MaxDD −7.6%／勝率 53%／60 筆** vs 0050 buy&hold **+150%**。
誠實揭露：大多頭裡 regime gate＋出場偏保守 → 絕對報酬輸 buy&hold、但回撤波動遠低。FRED 未填 key → regime 少殖利率/VIX、信心 0.75。

**未盡（階段4+）**：趨勢盤吃不滿需多期/樣本外調參；老王 watchlist/情緒語料整合（階段4）；當沖只能 forward 驗證；FRED key 可補強 regime。

---

## 9. 階段 4 完成紀錄（2026-06-14）

詳見 `docs/blend-rules.md`。重點：

**Step 0 實查修正前提**：`data/puhui_analysis/*.json` **從未存在**（見 §0 修正框）。真實獨家資產＝
git 追蹤的 **`reports/**/*.md`（18 篇，2026-05-14→06-12）**。另發現報告有**兩種模板**：
rich（16 篇，`### <span>🔴 股名（代號）</span>`＋表格）、legacy（2 篇，單表格、無 emoji、含佔位假資料）。

**交付**：確定性老王解析器（無 LLM）＋融合訊號＋自動觀察清單。程式 `engine/app/puhui/`：
- `mapping`：emoji 色碼（**🔴看多/🟢看空，語意與股市相反**）＋操作建議關鍵詞 → `signal/score`；
  **否定詞守門**（「不賣出」「減碼都不需要做」不被反向）；**條件式停損不判 SELL**。
- `parser`：純函式雙模板解析 → `PuhuiDaily`（water_level、market_sentiment、stocks[{code,name,emoji,signal,reason}]）。
- `repo`：日期索引、**落地快取** `data/puhui_analysis/{date}.json`（gitignored）、**name→code 反查**（FinMind TaiwanStockInfo）、
  **缺當日報告 fallback ≤7 天降信心**。
- `blend`：量化×老王融合（**同向加信心/背離標 conflict 降信心、不蓋量化分**；water_level×regime gate **取較嚴 min**）。
- `watchlist`：候選＝老王 ∪ factor 宇宙，雙分數雙排序（**純量化排序、老王當 tag**），盤後 daytrade 無盤口→null 排末。
- API：`GET /signal/blended`、`GET /watchlist`、`GET /puhui/view`。`sentiment.py` 改由本層供 `puhui` 子訊號（廢除讀不存在 JSON 的舊路徑）。

**關鍵決策（階段4 定案，使用者 2026-06-14）**：見 `docs/blend-rules.md` 決策1–5
（落地快取 / emoji×關鍵詞映射表 / water×regime 取較嚴 / 純量化排序 / 缺日沿用降信心）。

**驗收**：pytest **44 passed**（28 既有＋16 新，mock 不打網路）；含 **emoji 語意相反專測**、條件式停損非 SELL、
否定詞不反向、雙模板解析、背離降信心、fallback、name→code。18 篇報告離線解析全數通過；
`/puhui/view` TestClient 200（鴻海 2317 🟢→REDUCE，未被紅綠反向）。

**限制/未盡（階段5+）**：仍**無 LLM、不新增回測**（老王為 live/近期導向，與階段3 可回測核心分流）；
否定詞守門為輕量啟發式（非完整 NLP）；factor 自選宇宙先用少量權值股佔位；`/watchlist`、`/signal/blended`
需 FinMind/yfinance 取數（線上）；多 agent 深度辯論留階段5。
