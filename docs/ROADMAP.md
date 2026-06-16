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
   - 消息情緒面（新聞情緒 + 老王報告解析：`market_sentiment` ＋ 個股 `signal`/`reason`，階段4。⚠️ 舊版誤寫 `strategy_insights`＝不存在的幻想 JSON 欄位）
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
| 5 | 多 agent LLM 決策層 | 分析師→多空辯論→交易員→風控 | 3,4 | ✅ 完成 2026-06-14 |
| 6 | 統一 API 層 | Node gateway，吐 報告/訊號/水位/回測/agent決策 | 3,4,5 | ✅ 完成 2026-06-14 |
| 7 | APP 前端 + 端到端整合 | Vite+React 儀表板 + 當沖候選 | 6 | ✅ 完成 2026-06-14 |
| 8 | 雲端部署 + 每日排程 | Oracle VM（主）+ GitHub Actions；runbook | 7 | ✅ **完成 2026-06-15（实机落地）**：engine/gateway/前端/盤後刷新/健康檢查已部署到既有 VM `140.238.48.197` 並無人值守驗收（重開機自起）；老王 cron 切 `RUN_TARGET=vm`；`/agents/decide` VM 實測。見 §14 |

執行節奏：第 1 定契約最關鍵；第 3 完成＝有可回測策略硬核；第 5 才上 LLM；第 7 接前端；第 8 上雲。

---

## 3. 技術選型（建議）

- 引擎：Python 3.11+ / FastAPI / uvicorn；TA：pandas + pandas-ta；回測：純 pandas 向量化（避免未來函數）
- 數據：FinMind、fugle-marketdata（富果）、yfinance；快取 parquet 或 sqlite
- 多 agent：**輕量自寫編排**（階段5 定案，棄 LangGraph：LLM 走 CLI subprocess 非 API key，自寫更省/好測）；LLM 走 Gemini CLI 主 → Claude CLI 備
- Gateway：Node Express（server.cjs）
- 前端：Vite + React + TypeScript + Tailwind + lightweight-charts（行動友善）
- 雲端：Oracle Cloud Always-Free（ARM Ampere）+ GitHub Actions

---

## 4. 各階段提示詞檔案

~~放在 `docs/prompts/phase1.md … phase9.md`~~ —— **全 9 階段已完成，提示詞檔已於 2026-06-16 收尾清理移除**（建置脈絡保留在本 ROADMAP 各階段段落與各 `docs/*.md` 規格文件）。如需回溯，可從 git 歷史取回。

---

## 5. 仍待定案（執行到對應階段時決定）

- [x] 多因子最終因子組合與初始權重 → **階段1定案：方案 C 雙引擎**（見 `docs/scoring-model.md`）
- [ ] 各子訊號 → 0~100 的正規化細節、regime gate 連續/分段（第 3 階段回測決定）
- [~] 新聞情緒數據來源 → 階段2 已預接免費源（鉅亨 Anue JSON + Google News RSS，`/data/news`）；情緒模型/語料庫留階段4
- [ ] 當沖訊號的具體進出規則與風控（第 3 階段）
- [x] Oracle VM vs GitHub Actions 各跑哪一段 → **階段8定案 ＋ 階段9实机修正（2026-06-15）**：VM 跑 engine/gateway/前端/盤後刷新/健康檢查（無 LLM 第一層，**已部署常駐、重開機自起**）；GitHub Actions 跑無 LLM 回歸+數據 smoke 備援；**老王摘要＝VM cron B1（`RUN_TARGET=vm`，已生產運作 ~18 天 + 2026-06-15 实机驗收，不寫 Obsidian、不雙跑）**，本機 Task Scheduler B2 退為離線備援。見 `docs/runbook.md`。

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

**已知缺口**：分點主力（乾淨自動化難，暫緩）、漲跌家數 A/D（階段3 proxy）、~~富果分K 回溯範圍（無富果 key 未量測）~~（**2026-06-14 已接富果 key**：盤中分K/五檔內外盤啟用、host 修正 `api.fugle.tw`）、新聞情緒歷史語料（階段4）。

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

---

## 10. 階段 5 完成紀錄（2026-06-14）

詳見 `docs/agents-layer.md`。重點：

**設計確認（使用者 2026-06-14）**：**輕量自寫編排 / 3 分析師 / 1 輪辯論**（三個設計分叉皆採建議案）。

**Step 0 實查對齊**：實打 `/puhui/view`（200，9 檔，confirm `signal/stance/reason` 而非 emoji）、
讀 `blend.py`/`swing.py`/`watchlist.py` 確認真實欄位（**沒有 `strategy_insights`**），`/signal/blended`
已做掉確定性融合 → **agent 吃這顆當不可變事實底座、不重做融合**。沿用 TradingAgents
（分析師→多空辯論→交易員→風控），數據改吃台股結構化輸出、不吃原始 K 線、不餵原始 emoji。

**交付**：`engine/app/agents/`：`llm_cli`（provider 切換＋遙測）、`inputs`（每股結構化精簡輸入，
in-process 呼叫階段3/4 builder）、`parsing`（LLM 輸出容錯）、`roles`（3 分析師＋多空研究員＋交易員＋風控）、
`orchestrator`（有向流程＋一致性守門＋`decide_one/decide_many`）、`prompts/*.md`（7 份繁中提示詞）。
API：`POST /agents/decide {codes?,date?}`（codes 省略→ /watchlist 前 N≤10）。

**LLM 切換模組（成本核心）**：Gemini CLI 主 → 額度/速率用盡自動切 Claude CLI。
- **無頭**：`gemini --skip-trust -p`、`claude -p`；**整段 prompt 走 stdin**（不放 argv）。
- 🚨 **兩個實戰坑**：(1) Windows npm `.CMD` 殼以 `%*` 轉發 → **多行 prompt 當命令列參數會被打爛**
  （實測 7 呼叫全失敗）→ 改 stdin 解決；(2) gemini 在臨時 cwd 需 `--skip-trust` 否則 **rc=55** trust 失敗。
- **額度偵測**：成功判定只掃 stderr（不掃 stdout 答案內容避免誤判）；非零 exit / 精確片語命中 → 切備援記事件。
- **遙測**：token 估算/耗時/provider → `UsageLog` 匯總（CLI 訂閱制 → 主軸用量＋耗時、金額粗估）。

**一致性守門（確定性）**：最終決策方向背離量化 blended 卻沒被點名 → 系統強制標 `warning`，
落實「背離有被點名、非被無視硬翻」。

**驗收**：pytest **57 passed**（44 既有＋13 新，mock/stub 不打網路、**不燒真實 LLM 額度**）；含
gemini 額度用盡→切 claude（注入假 runner）、兩者皆失敗降級不崩、遙測匯總、輸出容錯解析、一致性守門專測。
**真實實測**（單股 2330、canned inputs）：gemini 主 7 呼叫 / est ≈4,890 tokens / ≈187s / 0 切換；
備援路徑 gemini 全失敗→7 次自動切 claude / completion ≈1,261 tokens / ≈113s、流程不中斷；
決策與 blended_score 對照一致（trader rationale 明引 blended_score 72/agreement=aligned）。

**限制/未盡（階段6+）**：LLM 偶發不回 JSON → 容錯降中性占位；`/agents/decide` 線上需 FinMind/yfinance
＋CLI 登入態；portfolio manager 持倉層、多輪自適應辯論、agent 長期記憶留後；階段6 Node gateway 統一吐，
階段8 上 Oracle VM 無頭跑（CLI 預登入）。

---

## 11. 階段 6 完成紀錄（2026-06-14）

詳見 `docs/api.md`。重點：

**設計確認（使用者 2026-06-14）**：照提議設計開工 / **拆 `routes/` + `lib/engine.js`** / water_level 等**正規化成數值並更新契約**（三問皆採推薦案）。

**Step 0 實查對齊**（非照舊提示詞臆測）：
- engine 路由全掛 **root**（`/signal`/`/signal/blended`/`/watchlist`/`/puhui/view`/`/backtest*`/`/agents/decide`/`/data/*`）→ gateway 一律加 `/api` 前綴轉發。
- `server.cjs` 的 `cors` 已 require 但**沒 `app.use`** → 本階段補啟用。
- **Node v22 → 內建 global `fetch`**；`axios`/`dotenv`/`node-fetch` 其實**沒裝**（只有 `express`/`cors`）→ 改用 `fetch`+`AbortController` 做代理與 timeout、自寫極簡 `.env` loader，**零新依賴、免 npm install**。
- 🚨 **型別分歧**：engine `/puhui/view` 的 `water_level` 是 **float 0~1**、`market_sentiment.score` 是 **0~100**；degraded 的 `puhui_cache.json` 是**中文「五成」**＋score **1~10**。gateway 對外**正規化**（數值 0~1 + `water_level_text`、sentiment 0~100），同步更新 `DailySnapshot` 契約。

**交付**：
- `lib/engine.js`（代理：`ENGINE_BASE_URL` env、per-call timeout、503/504/502/404/400 統一轉譯、`engineHealthy` 探活）、`lib/errors.js`、`lib/reports.js`（純 FS 掃 `reports/**/*.md`）、`lib/puhui_cache.js`（degraded + 中文水位→數值）、`lib/loadEnv.js`。
- `routes/finance.js`（既有 3 端點原樣搬出，行為不變）、`routes/gateway.js`（新 `/api/*`）。`server.cjs` 改成 app 組裝：補 `cors`、`.env`、掛 router。
- `docs/api.md`（所有端點/參數/回傳/degradation/錯誤格式/emoji 語意）。

**端點**：`/api/{health,dashboard,stocks/:code,watchlist,reports,reports/list,backtest,backtest/grid,agents/decide}`。
- 🚨 `/api/agents/decide` 很貴（每股 7×LLM ≈187s）→ **只在前端明確 POST 時呼叫**，**絕不**在 dashboard/stocks 內自動觸發（timeout 放 1200s）。
- `/api/stocks/:code` 迷你回測預設**關**（`?backtest=1` 才跑）；`daytrade` 盤後無盤口 → `unavailable:true` 不拖垮整體；老王未提及該股 → `puhui:null`（404 容忍）。
- dashboard 的 `market_regime` 取代表股 swing 訊號的 `regime` 欄位（market-wide，**不重算**）。

**驗收（curl 實測，2026-06-14）**：
- **engine 開**：`/api/health`→engine:up；`/api/dashboard`→水位0.5/五成、情緒中性50、regime risk_on(gate1.1)、watchlist 10 檔；`/api/stocks/2330`→swing add 66 + daytrade + blended + regime；`/api/watchlist`→10 檔雙排序；`POST /api/backtest`→swing_v1 metrics+benchmark+72點；`/api/backtest/grid`→{best,grid}；`POST /api/agents/decide` 壞 body→400 轉譯（**不燒 LLM 額度**，真實 LLM 跑已於階段5 驗）。
- **engine 關**：`/api/reports*` 照常（18 篇）；`/api/dashboard`→`degraded:true`（有 cache 讀水位/情緒、無 cache 回空殼）；`/api/watchlist`、`/api/stocks/:code` 等→明確 **503**。
- **CORS** `Access-Control-Allow-Origin: *` 生效；既有 `/api/finance/status`、`/api/run-script`(403) 不破壞。

**限制/未盡（階段7+）**：CORS 先全開（上線需收斂 origin 白名單）；`/api/agents/decide` 長流程為同步阻塞（未做非同步/輪詢，階段7/8 視需要再上）；degraded dashboard 只有全域水位/情緒（cache 無個股代號/買賣）；前端儀表板（Vite+React）＝階段7；雲端無頭部署＝階段8。

---

## 12. 階段 7 完成紀錄（2026-06-14）

詳見 `docs/web-frontend.md`。重點：

**設計確認（使用者 2026-06-14）**：（a）**開還原價 K 線**＝在 engine 開 `GET /data/ohlcv_adj`（`service.get_ohlcv_adj` yfinance 還原已存在、本階段只補掛路由）＋ gateway `/api/stocks/:code/ohlcv?adjust=1` 轉發（仍只轉發不重算）；（b）**盤中分K 優雅降級**＝不補富果金鑰（遍尋 `engine/.env`、舊專案 `C:\財經APP\.env` 皆無 Marketdata `X-API-KEY`，只有失效的 trading SDK config path），前端對 502 顯示「需富果金鑰」佔位、不破圖。

**交付**：
- **engine**：`app/api/data.py` 新增 `GET /data/ohlcv_adj`（還原日K）。
- **gateway**：`routes/gateway.js` 的 `/api/stocks/:code/ohlcv` 支援 `?adjust=1` → 轉 `/data/ohlcv_adj`；`server.cjs` 偵測 `web/dist` → `express.static` + SPA fallback（同源 serve 前端，鋪路階段8）。
- **前端 `web/`**：Vite+React+TS+Tailwind+lightweight-charts。5 頁（儀表板/當沖候選/觀察清單/老王報告/個股詳情）＋底部 4 分頁、手機單欄。報告用 react-markdown+rehype-raw 渲染（內嵌 HTML + Obsidian callout 轉 emoji 標題）。**多 agent 決策只按鈕觸發 + `localStorage` 快取（重整不重算）**；K線預設還原價、另有原始/盤中分K 分頁；盤中分K 無金鑰優雅降級。

**驗收（curl + build 實測，2026-06-14，engine+gateway 同開）**：
- `npm run build` 通過、`tsc --noEmit` 零錯；gateway 偵測 `web/dist` → `/` 回 SPA（title「老王投資儀表板」）、deep-link `/stock/2330` fallback 回 index.html。
- `/api/stocks/2330/ohlcv?adjust=1`→yfinance 還原（30 列、6/12 close 2310）；`ohlcv`（未還原）→FinMind；`/intraday`→**502 `缺少 FUGLE_API_KEY`**（前端佔位）；`/book`→TWSE MIS（last 2310、五檔）；`/dashboard`→水位0.5/情緒50/regime risk_on/watchlist 10；`/stocks/2330`→swing add66/blended hold51。
- **engine 關**：`/health`→engine:down、`/dashboard`→`degraded:true`、`/reports/list`→18 照常、`/stocks/2330` 與 `/ohlcv`→**503**。

**限制/未盡（階段8）**：bundle 單檔 ~678KB（未 code-split，可後續 manualChunks）；`/api/health` 只開頁探一次（engine 中途復原不自動重探）；觀察清單手動增刪未做（需另建儲存層）；~~盤中分K 待富果金鑰~~（**2026-06-14 已接富果 key→盤中分K+五檔內外盤啟用**，修 host `api.fugle.com.tw`→`api.fugle.tw`）；雲端無頭部署（Oracle VM build+serve）＋每日排程＝階段8。

---

## 13. 階段 8 完成紀錄（雲端就緒，2026-06-15）

詳見 `docs/runbook.md`、`deploy/README.md`。

> **誠實狀態（2026-06-15 SSH 實機盤點修正）**：部署/排程**程式與資產 100% 就緒並本機驗收**。原寫「VM 尚未部署＝卡東京免費 A1 缺貨要搶機」**已作廢**——VM 其實 **2026-05-27 升 PAYG、05-28 就上線**，`140.238.48.197` 至今 24h 在跑老王每日報告（含 Claude CLI 無頭，B1 token 續命已被生產實測）。**Track2 的真正工作＝把新 engine/gateway 堆疊部署到這台既有 VM**（非搶機），且與既有 13:00 老王 cron 共存。故仍標「🟡」而非「全案完成」。

**決策點定案（使用者 2026-06-15）**：
- **LLM 在雲端＝預設 B2、同步備好 B1**：老王摘要留**本機 Task Scheduler**（Claude 訂閱最穩）；§A 解耦讓 VM **具備**跑老王能力（`RUN_TARGET=vm`），B1（VM cron 實測 CLI 登入態續命）等 VM 到手後選擇性開啟。`/agents/decide` 維持前端按鈕觸發。**A 必達、B 加值**。
- **立即範圍＝全部 Track 1（不需 VM、可本機驗收）＋重建根 `.env` 解鎖搶機**。

**架構切分（誰跑在哪）**：
- **VM 常駐（無 LLM，第一層必達）**：engine(127.0.0.1:8000, systemd) + gateway/前端(:3000, systemd, serve `web/dist`) + 盤後 `refresh.sh`(cron) + `healthcheck.sh`(cron)。
- **LLM 層（第二層）**：老王摘要本機 B2（預設）／VM B1（選用）；`/agents/decide` 前端按鈕。
- **GitHub Actions**：`data_refresh.yml` 無 LLM 回歸+數據 smoke 備援；`puhui_daily.yml` 維持停用（Gemini free key quota=0）。

**交付物**：
- **§A 解耦 `puhui_daily.cjs` 的 `IS_CI`**（上 VM 前提）：原本一個旗標綁四件事（用 Claude CLI／寫 Obsidian／git push／告警）→ 拆成 `RUN_TARGET=local|vm|ci` ＋衍生 `IS_CI`/`WRITE_OBSIDIAN`/`EXISTING_OUTPUT_PATH`。**相容性**：未設 `RUN_TARGET`→`CI=true`→ci、否則→local，**本機/CI 行為完全不變**。回歸測試 `scripts/test_puhui_run_target.cjs`：**15 passed**。
- **`deploy/`**（冪等一鍵化）：`bootstrap.sh`（apt/dnf 偵測→Node20/Python venv/相依→build→systemd→cron→TZ）、`puhui-engine.service`/`puhui-gateway.service`、`refresh.sh`、`healthcheck.sh`、`crontab.example`、`README.md`。
- **GitHub Actions 備援**：`.github/workflows/data_refresh.yml` + `engine/scripts/smoke_data.py`（免金鑰 live smoke）。
- **`docs/runbook.md`**：架構/祕密配置/搶機(PAYG)/部署/SSH tunnel/日常 cron/B1 步驟/故障排除/Telegram 告警一覽/指令速查。
- **重建 Windows 根 `.env`**（gitignored）：`OCI_*`(ORM log+`~/.oci`)＋`TELEGRAM_*`(舊專案)，解鎖 `oracle_capacity_grab.ps1`。

**本機驗收（2026-06-15）**：§A 回歸 15 passed；engine offline pytest **57 passed**；`smoke_data.py` live `/health`+`/data/book`(MIS)+`/data/market`(yfinance) 全 200；deploy `.sh` `bash -n` 全過；根 `.env` `git check-ignore` 通過；`npm install dotenv` 零 repo 足跡。

**未盡（Track 2／phase9，需使用者+VM；VM 已在、非搶機）**：VM＝`140.238.48.197`、repo `/home/ubuntu/Stock_recommendations`、git push deploy key 已備。工作＝`bootstrap.sh APP_DIR=/home/ubuntu/Stock_recommendations RUN_USER=ubuntu` → scp `engine/.env`（FINMIND/FUGLE/FRED，VM 上不存在）→ 驗收第一層常駐（重開機自起/盤後刷新/健康檢查）→ 把既有 13:00 老王 wrapper 改 `RUN_TARGET=vm`（不寫 Obsidian、不雙跑、不弄壞手機在 pull 的 reports/）。🚨 **bootstrap 裝 cron 別清掉既有 `0 13 * * 1-5 puhui_daily_cron.sh`**。B1 token 續命已被生產實測（老王早就在 VM 跑 Claude CLI）。ARM pandas/pyarrow wheel 仍需 VM 實裝確認。（續作提示詞 `docs/prompts/phase9.md` 已隨收尾清理移除。）

---

## 14. 階段 8/9 實機落地完成紀錄（2026-06-15）＝ 🎉 全案完成

詳見 `docs/runbook.md`（已補實機發現）、`deploy/`。階段 8 的部署資產（phase8 Track1 本機就緒）於本日**真正落到既有 Oracle VM 上跑起來並無人值守驗收**，全 8 階段藍圖至此收尾。

**部署環境（实机）**：Oracle `VM.Standard.A1.Flex` 2 OCPU/12GB、Ubuntu 22.04.5 **aarch64**、`140.238.48.197`、repo `/home/ubuntu/Stock_recommendations`、TZ Asia/Taipei、node v20 / `/usr/bin/claude` 2.1.152 / python3.10。**生產機**（手機在 pull `reports/`），全程先 SSH 唯讀確認再單步驗收。

**第一層（無 LLM 常駐，必達 ✅ 全數實測通過）**：
- `sudo APP_DIR=/home/ubuntu/Stock_recommendations RUN_USER=ubuntu INSTALL_PLAYWRIGHT=0 ./bootstrap.sh`：ARM 上 pandas 2.3.3 / pyarrow 24 / numpy 2.2（**全走 aarch64 wheel，零編譯**）；npm ci + vite build 出 `web/dist`；systemd `puhui-engine`(127.0.0.1:8000) + `puhui-gateway`(:3000) **active + enabled**。
- scp `engine/.env`（FINMIND/FUGLE/FRED）上 VM → `/api/health` 回 `engine:up`。
- **重開機自起**：`sudo reboot` → 兩服務自動 active、`engine:up`、**無需手動介入**。
- **盤後刷新**：`refresh.sh` → `reports/signals/2026-06-15.json`（1802B）push 成功（`a483c7b`）。
- **健康檢查失效切換**：停 engine → `healthcheck.sh` 偵測 → 自動 restart（~1s 回復）→ Telegram 失敗+恢復告警（去抖動）實測通過。
- **前端**：SPA（「老王投資儀表板」）+ client-route fallback + `/api/{health,dashboard,watchlist,reports/list}` 全 200。安全＝只開 SSH，前端走 `ssh -L 3000:localhost:3000` tunnel。
- **共存鐵則達成**：bootstrap 只動 `# >>> puhui phase8 >>>` 區塊，既有 `0 13 * * 1-5 puhui_daily_cron.sh` 老王行 bootstrap 後＋reboot 後皆**原樣保留**；refresh 14:00 / healthcheck */15 與老王 13:00 錯開。

**第二層（LLM，✅）**：
- **老王 B1 早已是生產事實**：VM 自 05-28 起每工作日用 `/usr/bin/claude` 無頭跑老王，cron log 證實 2026-06-15 13:05 由 **VM 自身**產報告（OAuth 過期→Playwright fallback→Claude 摘要 5856 字→push）。phase9 只把 VM-local wrapper `~/puhui_daily_cron.sh` 加 `export RUN_TARGET=vm`＋`CLAUDE_BIN=/usr/bin/claude`：`--force` 实测確認 Claude 摘要→寫 `reports/`→push、**不寫 Obsidian**（obsidian-copy mtime 不變為證）、**不雙跑**（單一 cron 行、已產出即 skip）。回歸 `test_puhui_run_target.cjs` 15 passed。
- **`/agents/decide` VM 实测**：前端路徑 `POST /api/agents/decide {codes:[2330]}` → 202s、7 次 LLM **全由 claude 接手**（gemini 未裝→fallback 觸發、符合設計）、決策 2330 HOLD@0.65 → 確認 VM Claude CLI 登入態端到端可用。

**实机發現（已補進 runbook）**：
- VM 根 `.env` 早含 `CLAUDE_BIN=/usr/bin/claude`、`OBSIDIAN_DIR=/home/ubuntu/obsidian_reports`、`PLAYWRIGHT_CHROMIUM_PATH` → 解釋為何 local 模式也能在 Linux 正常跑。
- **VM 的 Google OAuth refresh token 已過期/撤銷**（`invalid_grant`）→ Gmail 路徑失效、自動走 Playwright fallback（報告不受影響、會 Telegram 預警）；要修需重跑 `oauth_reauth`。
- `gemini` CLI 未裝在 VM → agents 一律 claude（成本/穩定皆可接受）。
- deploy `*.sh` 在 repo 補上可執行位（`git update-index --chmod=+x`），避免 VM 上 chmod 後工作樹變髒。

**終局架構（誰跑在哪）**：
```
手機 ──git pull──> GitHub repo <──push── Oracle VM（24h 常駐，生產機）
                      reports/**            ├─ systemd puhui-engine   (FastAPI 127.0.0.1:8000；多因子/回測/agents，無對外)
                      reports/signals/      ├─ systemd puhui-gateway  (Node :3000；/api/* + 同源 web/dist 前端)
瀏覽器 ─ssh -L 3000─> gateway              ├─ cron 13:00  老王 B1     (RUN_TARGET=vm：抓文→Claude CLI 摘要→reports/→push)
                                           ├─ cron 14:00  refresh.sh  (暖快取→reports/signals/<date>.json→push，無 LLM)
                                           └─ cron */15   healthcheck (/api/health 失敗→restart+Telegram 去抖動)
GitHub Actions data_refresh.yml ── 無 LLM 數據/回歸 smoke 備援（VM 掛掉的 backstop）
```

**全 8 階段回顧**：(1) FastAPI 地基+資料契約+多因子方案C定案 → (2) 台股數據層（FinMind/TWSE MIS/TAIFEX/News/FRED/yfinance+富果）→ (3) 確定性多因子引擎+向量化回測 → (4) 老王報告解析+融合+觀察清單 → (5) 多 agent LLM 決策層（分析師→辯論→交易員→風控）→ (6) Node 統一 API gateway → (7) Vite+React 手機前端 → (8/9) Oracle VM 雲端部署+無人值守排程。**內容線鐵則（不改壞 `puhui_daily.cjs` 既有產出與 `reports/` push）全程守住。**

**維運入口**：`docs/runbook.md`（部署/救援/重授權/cron/Telegram 告警/指令速查）。**未盡/後續**（非阻塞，視需要）：GitHub repo secrets 設好後 `data_refresh.yml` 跑綠燈（使用者操作）；VM Google OAuth 重授權；對外公開前端需鎖來源 IP；agent 持倉層/多輪辯論/長期記憶為未來增強。
