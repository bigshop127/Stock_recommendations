# 台股數據層（階段 2）— 數據源、欄位與限制

> 建立 2026-06-13（階段 2）。程式在 `engine/app/data/`，快取在 `engine/data_cache/`。
> 全局見 `ROADMAP.md`；因子需求見 `scoring-model.md`；對外型別見 `contracts/`。
>
> **設計取向**：優先用「官方開放資料 / 官方公開 JSON / 免費金鑰官方 API」，
> 盡量避開第三方網站 HTML 爬蟲（易碎且多違反 ToS）。第三方加工站（Goodinfo、
> WantGoo…）本身也只是再加工官方資料，我們直接打官方源頭。

## 0. 來源分級與總覽

| 級別 | 類型 | 本層採用 | 金鑰 | 可回測 |
|---|---|---|---|---|
| T1 | 官方開放資料 | **FinMind**（=TWSE/TPEx 包裝）、**TAIFEX** 期貨/選擇權 CSV | FinMind 需免費 token / TAIFEX 免 | ✅ |
| T2 | 官方公開即時 JSON | **TWSE MIS** 即時報價＋最佳五檔 | 免 | ❌ live-only |
| T3 | 免費金鑰官方 API | **FRED** 美國總經 | 免費註冊 key | ✅ |
| T4 | 公開 JSON / RSS | **鉅亨 Anue** newslist、**Google News RSS** | 免 | ❌（時效） |
| T5 | 第三方 HTML 爬蟲 | **不採用**（Goodinfo/WantGoo/HiStock/Yahoo 僅供人工參考） | — | — |
| — | 指數 | **yfinance**（美股四大＋費半＋VIX＋台股加權） | 免 | ✅ |
| — | 可選 | **富果 Fugle**（live 五檔/分K；MIS 之外的選項） | 玉山 key | ❌ |

對映 engine 端點：

| 端點 | 來源 | 角色 | live_only |
|---|---|---|---|
| `/data/ohlcv` | FinMind | 日K（F_technical） | 否 |
| `/data/chips` | FinMind | 三大法人＋融資券（F_chips） | 否 |
| `/data/book` | **TWSE MIS**（預設）/ 富果（可選） | 即時最佳五檔（F_orderbook） | **是** |
| `/data/intraday` | 富果（可選） | 盤中分K（F_intraday_tech） | 今日=是 |
| `/data/market` | yfinance | 大盤/美股指數環境 | 否 |
| `/data/futures` | TAIFEX | 三大法人期貨未平倉＋P/C ratio（regime） | 否 |
| `/data/news` | 鉅亨 / Google News | 新聞情緒源（F_sentiment） | 是（時效） |
| `/data/macro` | FRED | 美國總經（環境） | 否 |

金鑰走 `engine/.env`（gitignored，見 `engine/.env.example`）：`FINMIND_TOKEN`（建議必填）、
`FUGLE_API_KEY`（可選）、`FRED_API_KEY`（/data/macro 才需要）、`BOOK_SOURCE`（auto/mis/fugle）。

---

## 1. FinMind（`finmind_client.py`，T1，可回測）

REST v4：`GET https://api.finmindtrade.com/api/v4/data`，參數 `dataset/data_id/start_date/end_date/token`。

| 用途 | dataset | 取用欄位 → 乾淨輸出 | 因子 |
|---|---|---|---|
| 日K OHLCV | `TaiwanStockPrice` | date, open, max→high, min→low, close, Trading_Volume→volume, Trading_money→turnover | F_technical |
| 三大法人 | `TaiwanStockInstitutionalInvestorsBuySell` | (buy−sell) 聚合 → foreign_net / trust_net / dealer_net | F_chips |
| 融資融券 | `TaiwanStockMarginPurchaseShortSale` | margin_balance, margin_change, short_balance, short_change | F_chips |
| 股名 | `TaiwanStockInfo` | stock_name | — |

- 法人聚合：外資=`Foreign_Investor`+`Foreign_Dealer_Self`；投信=`Investment_Trust`；自營=`Dealer_self`+`Dealer_Hedging`。
- 免費 token 有頻率上限 → parquet 快取大幅降低呼叫。

---

## 2. TWSE MIS（`twse_mis_client.py`，T2，**免金鑰**，live-only）

公開 JSON：`GET https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0`
（首次呼叫先取站台 cookie，帶 Referer/User-Agent）。**這是富果/永豐之外的免費即時五檔源頭。**

| msgArray 欄位 | 意義 → 乾淨輸出 |
|---|---|
| `z` | 最近成交價 → last_price（無成交時退 `o`/`y`） |
| `b` / `g` | 委買價×5 / 委買量×5 → bids[]（{price,size}） |
| `a` / `f` | 委賣價×5 / 委賣量×5 → asks[] |
| `o/h/l/y` | 開/高/低/昨收 → day{} |
| `v` | 累計成交量（張） |

- 市場別自動判：先試 `tse_`，無則 `otc_`，結果以代號記憶體快取。
- 輸出結構與 `fugle_client.get_quote` 對齊，`/data/book` 兩源共用同一格式，`live_only=True`。

### ⚠️ 限制（與 scoring-model §2.1 一致）
1. **近即時**（延遲約 5–20s），非 tick 級 → 適合「訊號評分」，非下單執行。
2. **無歷史盤口** → 盤口因子 `live_only`、**不可回測**、只進當沖引擎。
3. MIS 無內外盤分量（`inner_outer` 為 None）；非交易時段五檔可能為空或上一盤快照。

### ✅ 2026-06-13 免金鑰實測（盤後 13:30 快照）
`2330 台積電`：last=2310、bid1=2305(64)、ask1=2310(348)，五檔完整、channel=`tse_2330.tw`。→ MIS 路徑可用。

---

## 3. 富果 Fugle（`fugle_client.py`，可選，live-only）

REST v1.0：`https://api.fugle.com.tw/marketdata/v1.0/stock`，header `X-API-KEY`。
**非必填**：不設 `FUGLE_API_KEY` 時 `/data/book` 自動走 MIS。要用富果把 `BOOK_SOURCE=fugle`（或 auto+填 key）。

| 用途 | endpoint | engine API |
|---|---|---|
| 即時報價＋五檔 | `intraday/quote/{code}` | `/data/book`（BOOK_SOURCE=fugle 時） |
| 當日盤中分K | `intraday/candles/{code}` | `/data/intraday`（今日） |
| 歷史分K | `historical/candles/{code}` | `/data/intraday`（過去日） |

- 歷史盤口/tick 拿不到（同 MIS）；分鐘級 `historical/candles` 回溯範圍有限。
- 最早可取 1 分K 日期：**需富果 key 後由 smoke 第 8 段實測**（本機未設富果 key，暫未量測）。

---

## 4. TAIFEX 期交所（`taifex_client.py`，T1，**免金鑰**，可回測）

官方每日 CSV（Big5，POST 表單下載），供階段3 regime gate：

| 用途 | endpoint | 乾淨輸出 |
|---|---|---|
| 三大法人期貨未平倉 | `cht/3/futContractsDateDown`（commodityId=**TXF**） | date, foreign_oi_net, trust_oi_net, dealer_oi_net（多空未平倉口數淨額） |
| Put/Call Ratio | `cht/3/pcRatioDown` | date, pc_volume_ratio, pc_oi_ratio |

- **解析坑（已處理）**：P/C CSV 資料列有尾端逗號（欄數比表頭多 1），pandas 會誤把首欄當索引 → 用 `index_col=False` 修正；契約代號用 `TXF`（`TX`/`TAIEX` 自動轉）；身分欄為「身份別」。
- 欄名/版面期交所偶調 → client 以關鍵字容錯抓欄，回 HTML（代號錯）時拋 502。

### ✅ 2026-06-13 免金鑰實測（近一週）
P/C ratio 5 筆日期/比率正確；三大法人期貨未平倉 6/12：外資 −65,039 口（偏空）、投信 +57,111、自營 +3,568。→ 兩 feed 可用。

---

## 5. 新聞（`news_client.py`，T4，**免金鑰**，時效）

| 情境 | 來源 | 輸出 |
|---|---|---|
| 無關鍵字（最新台股） | 鉅亨 Anue `media/api/v1/newslist/category/tw_stock`（公開 JSON） | title, summary, published(ISO), url, source_feed |
| 帶關鍵字（個股輿情） | Google News RSS（`news.google.com/rss/search?q=…when:7d`，stdlib xml 解析） | title, published(RFC822), url, source_feed |

- 鉅亨節點未文件化 → 失敗自動退回 Google News RSS。
- 僅取標題/摘要供情緒分析，不轉載全文；**情緒歷史回測需另建語料庫（階段4）**，本層不長期快取。
- ✅ 2026-06-13 實測：鉅亨最新 3 則、Google News「2330」3 則（Yahoo/BBC/自由財經）皆正常返回。

---

## 6. FRED 美國總經（`fred_client.py`，T3，免費 key，可回測）

`GET https://api.stlouisfed.org/fred/series/observations?series_id=&api_key=&file_type=json&observation_start=&observation_end=`
免費註冊金鑰：<https://fred.stlouisfed.org/docs/api/api_key.html>。缺 key → 502 明確訊息。

| 別名 | series_id | 意義 |
|---|---|---|
| us10y / us2y | DGS10 / DGS2 | 美債 10Y / 2Y 殖利率 |
| yield_curve | T10Y2Y | 10Y−2Y 利差（衰退領先） |
| cpi / unemployment / fed_funds | CPIAUCSL / UNRATE / FEDFUNDS | CPI / 失業率 / 聯邦基金利率 |
| vix | VIXCLS | VIX 收盤 |

別名或原生 series_id 皆可；缺值 `.` 自動剔除。走 parquet 快取。

---

## 7. yfinance（`yfinance_client.py`）

`/data/market` 每指數回 `{close, prev_close, change_pct}`：`^TWII`(台股加權)、`^GSPC`/`^IXIC`/`^DJI`(美股四大)、`^SOX`(費半)、`^VIX`。

---

## 8. 快取（`cache.py`，parquet）

- 路徑 `engine/data_cache/{dataset}/{key}.parquet` + 同名 `.meta.json`（涵蓋區間浮水印）。
- **gap-based 補抓**：只對「已抓涵蓋區間」外缺口打 API；已涵蓋 → 0 次 API。
- **浮水印 vs 資料 min/max**：用「已抓涵蓋區間」判缺口，週末/假日/今日未收盤尾端不重複打 API。
- live 資料（MIS 五檔、今日盤中分K、新聞）**不快取**；歷史不可變者（某日分K、FinMind/TAIFEX/FRED 時序）才快取。

---

## 9. 端點錯誤約定

金鑰缺失或數據源錯誤 → **HTTP 502 + 明確訊息**（不靜默回空，符合 phase2「拿不到要明確標示」）。
例：缺 `FINMIND_TOKEN`→ `/data/ohlcv` 502；缺 `FRED_API_KEY`→ `/data/macro` 502；TAIFEX 代號錯回 HTML → 502。

---

## 10. 已知缺口 / 待補（依 phase2「拿不到要明確標示並提替代方案」）

| 項目 | 狀態 | 替代/計畫 |
|---|---|---|
| 分點主力進出 | 乾淨自動化困難（官方分點檔量大、有延遲反爬；爬 Goodinfo 易碎踩 ToS） | **暫緩**；籌碼先用三大法人＋融資券；階段3+ 再評估官方分點檔 |
| 漲跌家數 A/D（regime 輸入） | FinMind 無乾淨單一 dataset | 階段3 用 TWSE 每日市場統計或自算 proxy；現以 `/data/market`+`/data/futures` 先供環境 |
| 富果歷史盤口/tick | 來源端不提供 | 當沖盤口因子標 `live_only`、不回測（既定） |
| 富果分K 回溯範圍 | 未量測（本機無富果 key） | 設 key 後 smoke 第 8 段實測回填 §3 |
| 新聞情緒歷史 | 新聞為時效資料 | 階段4 建語料庫/逐日存檔 |

---

## 11. 驗收 / 重現

```powershell
cd "C:\CC AI Agent\engine"
# 1) 單元測試（mock，不打網路）— 16 passed
.\.venv\Scripts\python.exe -m pytest -q
# 2) 真實 smoke：免金鑰源（MIS/TAIFEX/news/yfinance）直接可見；
#    FinMind/FRED 需在 engine/.env 填對應金鑰
.\.venv\Scripts\python.exe scripts\smoke_2330.py        # 或 ... scripts\smoke_2330.py 2317
```
