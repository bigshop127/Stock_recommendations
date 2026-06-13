# 階段 3：多因子量化引擎 + 回測核心

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase3.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、`docs/data-layer.md`（階段 2 數據層）、
> `docs/contracts/{StockSignal,FactorScore,BacktestResult}.md`，再依本檔執行；完成後務必做「完成收尾清單」。
> 本檔已對齊階段 2 的實際交付（免費官方源、`/data/*` 8 端點、`app/data/service.py` 編排），請以本檔為準。

## 你的角色
資深量化策略工程師。這是整個專案最硬核的一階段——產出「能回測的策略」這個核心資產。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1（契約、多因子定案）、階段 2（engine 台股數據層）已完成。
- 既有量化雛形（描述於 `scripts/puhui_synthesize.js`）：RSI+MA+三陽開泰，6 條件：
  1.趨勢 Close>MA5>MA10>MA20>MA60 2.動能 RSI14>=50 3.量能 Vol>1.2×VolMA20
  4.型態 三陽開泰回檔≤3天 5.乖離 (Close/MA10-1)<8% 6.大盤 0050>MA60
  （0050 日線直接走 `/data/ohlcv?code=0050`，0050 是個股代號，FinMind 有，免另接源。）
- 多因子模型見 `docs/scoring-model.md`（階段 1 定案：方案 C 雙引擎）。終局見 `docs/ROADMAP.md`。

### 階段 2 已交付、本階段直接吃的數據（重要：用 service 層，不要重打 client）
所有取數一律走 **`app/data/service.py`** 的函式（內含 parquet 快取，免重複打 API）：

| service 函式 | 端點 | 給哪個因子 | 可回測 |
|---|---|---|---|
| `get_ohlcv(code,start,end)` | `/data/ohlcv` | F_technical（日 OHLCV） | ✅ |
| `get_chips(code,start,end)` | `/data/chips` | F_chips（三大法人＋融資券） | ✅ |
| `get_futures(start,end,product)` | `/data/futures` | **regime**（三大法人期貨未平倉＋P/C ratio） | ✅ |
| `get_macro(series,start,end)` | `/data/macro` | **regime**（FRED 美國總經：yield_curve/vix…） | ✅ |
| `get_market(on_date)` | `/data/market` | **regime**（yfinance 美股四大/費半/VIX/^TWII） | ✅ |
| `get_news(keyword,limit)` | `/data/news` | F_sentiment（鉅亨/Google News） | ❌ 時效 |
| `get_book(code)` | `/data/book` | F_orderbook（**預設 MIS**，富果可選） | ❌ live-only |
| `get_intraday(code,date,tf)` | `/data/intraday` | F_intraday_tech（富果分K，可選） | ❌ live-only |

## 前置條件（動手前先確認，否則回測會卡）
1. **FinMind token**：回測完全靠 `/data/ohlcv`＋`/data/chips`。`engine/.env` 的 `FINMIND_TOKEN` 若為空，這兩個端點會回 **502**。請先確認已填（沒填就先請使用者填，再跑真實回測）。
2. **regime 進階源（選填但建議）**：`FRED_API_KEY` 填了才有 `/data/macro`（yield_curve/VIX）；沒填時 regime 退用 `/data/futures`＋`/data/market`，並降該環境子訊號信心。
3. **技術指標相依**：`requirements.txt` 目前**未裝** `pandas-ta`。為延續階段 2「不裝重 SDK、降相依」取向，**RSI/MA/乖離/量能等請以 pandas 自寫**（純向量化、好控未來函數），不要新增 `pandas-ta`。

## 本階段目標（重點：本層「確定性、可回測」，禁用 LLM）

1. 實作確定性訊號引擎，支援**兩種模式**（程式放 `engine/app/factors/`）：
   - **波段（swing，可回測）**：6 條件 + 三因子加權（技術 0.40＋籌碼 0.40＋情緒 0.20）× 大盤環境閘門 → `StockSignal`（action/score/各因子分/理由）。
   - **短線當沖（daytrade，live-only，不回測）**：吃 `get_book`（**預設 MIS**）＋ `get_intraday`（富果，可選），產當沖候選分數。
2. **各因子逐一實作可計算公式**（依 `docs/scoring-model.md`），並嚴守以下三條與階段 2 現況對齊的規則：
   - **盤口因子 source-aware 降級**：`/data/book` 預設是 **TWSE MIS**，**MIS 無內外盤**（`inner_outer=None`）。`F_orderbook` 的「內外盤比」子訊號在 MIS 路徑算不出 → 該子訊號**退出加權、對剩餘子訊號重新正規化、`confidence` 下降並在 `note` 標註**；唯有 `BOOK_SOURCE=fugle` 且有富果 key 時才納入內外盤。**不可用預設值硬填**（`scoring-model §0.5`）。
   - **F_sentiment 用現有源**：情緒因子 = 老王 `mentioned_stocks[].signal`／`strategy_insights`（確定性，主）＋ **輕量新聞情緒**（`get_news` 標題/摘要做關鍵字或簡易詞典極性，次）。完整情緒模型/語料庫仍留階段 4——本階段只做輕量版並標信心。
   - **數據缺口降信心不亂補**：因子算不出來時 `confidence` 下降、必要時退出加權並重正規化（`scoring-model §0.5`）。
3. **大盤環境閘門（regime gate）要用上階段 2 的新源**：除了既有「大盤趨勢＋VIX」，把 **TAIFEX 三大法人期貨未平倉（外資淨多空，`get_futures`）、P/C ratio、FRED 殖利率倒掛 `yield_curve`／`vix`（`get_macro`）、yfinance 美股隔夜（`get_market`）** 一併納入 regime 綜合判定（`risk_off/neutral/risk_on` → gate 0.5~1.1）。
   - **漲跌家數 A/D 缺口**：`data-layer §10` 已標 A/D 無乾淨單一 dataset → **用 proxy**（外資期貨淨未平倉方向、P/C ratio、VIX、融資增減）替代，**不要假設有乾淨 A/D**，並在 regime 輸出標註用了 proxy。
4. **實作向量化回測器**（純 pandas，**不呼叫任何 LLM**），且必須滿足：
   - **只回測 swing 引擎**；`live_only=true` 因子（盤口/分K/大盤當日）**不得進回測輸入**（`BacktestResult` 契約）。
   - **無未來函數**：指標只能用「當日收盤前已知」資訊。**執行時點約定：T 日收盤計分 → T+1 開盤成交**（出場同規則）；若採 T 收盤成交須在報告明確註記。
   - **要扣台股交易成本**：手續費 **0.1425%×折數**（買、賣各一次）＋ **賣出證交稅 0.3%**（round-trip ≈ 0.45%，折數可設參數，預設不打折）。成本不可省略，否則績效灌水。
   - 輸出嚴格對齊 `BacktestResult`：`metrics` 含 `cum_return / annual_return / sharpe / max_drawdown / win_rate / trades / avg_holding_days`，並附 `equity_curve`（1.0 起）與 **`benchmark`（0050 同期 buy&hold 累積報酬）**。
5. **加「權重調整」掛勾**：可掃不同因子權重看回測績效（簡單 grid 即可，先別上重型最佳化）。**權重集中存在 `engine/app/factors/` 的設定物件/設定檔**，回測挑出最佳後回填；**禁止把權重散落在計算邏輯裡**（`scoring-model §4`）。
6. **engine API**（沿用階段 2 慣例：獨立 router、取數走 `service`、數據源錯誤 `DataSourceError→HTTP 502`、日期 Query 帶預設區間）：
   - `GET /signal?code=2330&date=&mode=swing|daytrade` → 一筆 `StockSignal`（含各因子拆解與人話理由）。
   - `POST /backtest`（body: `codes[]`, `start`, `end`, `rules`/`weights`/`entry_score`/`exit_score`/`cost`）→ `BacktestResult`（績效 + 權益曲線 + benchmark）。

## 限制與原則
- **回測層禁用 LLM**（成本/速度）；LLM 是階段 5 的疊加層。
- 不要動 `puhui_daily.cjs` 與既有 Node 內容線；engine 只透過 HTTP/讀檔取用，不回寫。
- **當沖模式回測受富果歷史限制**：盤口/分K 皆 `live_only` → 明確標示「只能 forward 驗證、不進回測」；回測模組只跑波段引擎。
- 盤口來源差異要顯性化：MIS（預設、無內外盤、近即時延遲數秒）vs 富果（需 key、有內外盤），訊號 `note`/`confidence` 要反映。

## 驗收標準
- 對 2330 產出當日 **swing** 訊號 + 各因子拆解與解釋（並示範一次 **daytrade** 訊號，標明 live-only 與盤口源）。
- 對一籃子台股跑 1–2 年波段回測，輸出**含交易成本**的完整績效 + 權益曲線 + 0050 benchmark 對照。
- 有簡短報告（`docs/` 或 `engine/reports/`）示範回測結果，並標明：哪些因子因數據缺口被近似/排除（內外盤、A/D proxy、情緒輕量版）、用了什麼交易成本與執行時點假設。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 3 標 ✅，記錄因子實作狀態與回測結果摘要（含成本假設）。
2. 更新 Obsidian：`C:\obsidian\儲存庫\財經APP開發\階段3-完成紀錄.md` + `開發進度.md`（附回測績效）。
3. 更新記憶 `.claude\projects\C--CC-AI-Agent\memory\` + `MEMORY.md`。
4. 程式放 `engine/`（因子 `app/factors/`、回測 `app/backtest/`、API `app/api/`），回測報告放 `docs/` 或 `engine/reports/`。
5. **git commit & push**（`phase3: 多因子引擎與回測`）：commit 後直接 `git push origin master`（2026-06-13 定案：每階段完成自動 push）。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、`docs/data-layer.md`、契約三件，**提出引擎與回測的模組設計**讓我確認，再動手。設計需明確交代：
- swing 三因子各自的子訊號 → 0~100 正規化方法（z-score vs 分位數）與權重設定物件位置；
- regime gate 怎麼把「期貨未平倉 / P/C / FRED / 美股隔夜 / A/D proxy」綜合成 0.5~1.1 乘數；
- 盤口 live-only 在 MIS 預設下如何降級（內外盤缺失）、daytrade 能 forward 驗證到哪；
- 回測的執行時點、交易成本、benchmark、避免未來函數的具體作法。
