# API 規格與契約合約 (Phase 1 snake_case)

本文件定義台股籌碼審查網站（`review-web`）所需之 API 端點規格，包含既有端點之適配以及 Phase 1 重新梳理為 snake_case 的大盤與個股端點。

## 1. 模組劃分與前端需求端點

| 模組 | 前端端點 | 類型 | 狀態 | 資料來源 | Live-only |
| --- | --- | --- | --- | --- | --- |
| **系統** | `/api/health` | GET | 既有 | Gateway & Engine | 否 |
| **大盤** | `/api/dashboard` | GET | 既有 | Engine | 否 |
| **大盤** | `/api/market/indices` | GET | **新增** | TWSE MIS / TAIFEX | **是** (盤中) |
| **大盤** | `/api/market/breadth` | GET | **新增** | TWSE | 否 |
| **大盤** | `/api/market/sectors` | GET | **新增** | TWSE | 否 |
| **大盤** | `/api/market/institutional` | GET | **新增** | TWSE | 否 |
| **大盤** | `/api/market/capital-tide` | GET | **新增** | FinMind / yfinance | 否（每日快取） |
| **個股** | `/api/stocks/:code` | GET | 既有 | Engine | 否 |
| **個股** | `/api/stocks/:code/ohlcv` | GET | 既有 | yfinance / 富果 | 否 |
| **個股** | `/api/stocks/:code/book` | GET | 既有 | 富果 / TWSE | **是** (五檔) |
| **個股** | `/api/stocks/:code/intraday` | GET | 既有 | 富果 / TWSE | **是** (即時) |
| **個股** | `/api/stocks/:code/chips` | GET | **新增** | TWSE / 櫃買中心 | 否 |
| **個股** | `/api/stocks/:code/fundamentals`| GET | **新增** | FinMind / 富果 | 否 |
| **個股** | `/api/stocks/:code/news` | GET | **新增** | 鉅亨網 / 經濟日報 | 否 |
| **再平衡** | `/api/rebalance/holdings` | GET/POST | **新增** | Gateway 檔案（`data/rebalance_holdings.json`） | 否 |
| **再平衡** | `/api/rebalance/sync-holdings-trigger` | POST | **新增** | VM 本機執行同步腳本（玉山證券） | 否 |
| **再平衡** | `/api/rebalance/sync-holdings-status` | GET | **新增** | Gateway 檔案（`data/sync_holdings_status.json`） | 否 |
| **期貨** | `/api/futures/positions` | GET/POST | **新增** | Gateway 檔案（`data/futures_positions.json`） | 否 |
| **期貨** | `/api/futures/quote` | GET | **新增** | 期交所 OpenAPI（`DailyMarketReportFut`） | 否 |

---

## 2. 端點合約 Schema

### 2.1 取得大盤與主要指數 `/api/market/indices?range=1d|5d|1m`
* **Method**: `GET`
* **Description**: 取得加權指數、櫃買指數及台指期即時報價，並提供對應區間的走勢數據。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-19",
  "as_of": "2026-06-19T05:30:00Z",
  "indices": [
    {
      "key": "TWSE",
      "name": "加權指數",
      "price": 22845.81,
      "change": 182.42,
      "change_pct": 0.81,
      "volume": 382400000000,
      "intraday": [
        { "t": "09:05", "v": 22810.2 }
      ],
      "history": [],
      "source": "TWSE MIS"
    },
    {
      "key": "TX",
      "name": "台指期",
      "price": 22860.00,
      "change": 195.00,
      "change_pct": 0.86,
      "volume": 120000,
      "intraday": [
        { "t": "09:05", "v": 22820.0 }
      ],
      "history": [],
      "source": "TAIFEX"
    }
  ]
}
```

### 2.2 取得市場多空寬度 `/api/market/breadth?date=`
* **Method**: `GET`
* **Description**: 取得全市場（依 watchlist 聯集 0050 成分股）站上均線比例及上漲下跌家數分布。當日無資料時，自動往前尋找最近一個有效交易日。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-19",
  "advancing": 582,
  "declining": 324,
  "unchanged": 92,
  "limit_up": 12,
  "limit_down": 3,
  "total": 998,
  "advancing_pct": 0.583,
  "above_ma20_ratio": 0.625,
  "above_ma50_ratio": 0.584,
  "universe": "watchlist_union_0050",
  "sample_size": 95,
  "source": "TWSE"
}
```

### 2.3 取得產業類股表現排行 `/api/market/sectors?date=`
* **Method**: `GET`
* **Description**: 取得當日各細分產業類股的即時漲跌幅與成交金額排行。當日無資料時，自動往前尋找最近一個有效交易日。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-19",
  "sectors": [
    {
      "name": "半導體",
      "change_pct": 1.45,
      "turnover": 12450000000,
      "source": "TWSE"
    },
    {
      "name": "航運",
      "change_pct": -1.82,
      "turnover": 3200000000,
      "source": "TWSE"
    }
  ]
}
```

### 2.4 取得三大法人大盤買賣超 `/api/market/institutional?date=&days=20`
* **Method**: `GET`
* **Description**: 取得外資、投信、自營商在加權市場現貨之合計買賣超金額，並提供近 N 日歷史趨勢。當日無資料時，自動往前尋找最近一個有效交易日。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-19",
  "unit": "元",
  "latest": {
    "foreign": 8520000000,
    "investment_trust": 2410000000,
    "dealer": -1540000000,
    "total": 9390000000
  },
  "trend": [
    {
      "date": "2026-06-19",
      "foreign": 8520000000,
      "investment_trust": 2410000000,
      "dealer": -1540000000,
      "total": 9390000000
    }
  ],
  "source": "TWSE"
}
```

### 2.5 取得個股籌碼流向 `/api/stocks/:code/chips`
* **Method**: `GET`
* **Description**: 取得特定個股的外資、投信、自營商買賣超張數與信用交易餘額變動。
* **Response Schema (200 OK)**:
```json
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-19",
  "unit": { "net_buy_qty": "張", "balance": "張", "holding_ratio": "%" },
  "data": [
    {
      "date": "2026-06-19",
      "foreign_net_buy_qty": 3500,
      "investment_trust_net_buy_qty": 1200,
      "dealer_net_buy_qty": -450,
      "total_net_buy_qty": 4250,
      "margin_balance": 12500,
      "margin_change": 320,
      "short_balance": 820,
      "short_change": -45,
      "foreign_holding_ratio": 74.2
    }
  ],
  "source": "FinMind"
}
```

### 2.6 取得個股基本面診斷 `/api/stocks/:code/fundamentals`
* **Method**: `GET`
* **Description**: 取得個股估值（日頻）、月營收（月頻）、獲利 EPS（季頻）、股利（年頻）與最新 summary 快照。
* **Response Schema (200 OK)**:
```json
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-19",
  "summary": {
    "pe_ratio": 24.5,
    "pb_ratio": 6.8,
    "dividend_yield": 2.45,
    "market_cap": 18250000000000,
    "eps_ttm": 42.1
  },
  "valuation": [
    { "date": "2026-06-19", "pe_ratio": 24.5, "pb_ratio": 6.8, "dividend_yield": 2.45 }
  ],
  "revenue": [
    { "month": "2026-05", "revenue": 250000000000, "yoy": 15.4, "mom": -2.1 }
  ],
  "financials": [
    { "quarter": "2026-Q1", "eps": 8.7, "gross_margin": 56.2, "operating_margin": 42.1, "net_margin": 38.5 }
  ],
  "dividend": [
    { "year": "2025", "cash_dividend": 13.5, "stock_dividend": 0.0 }
  ],
  "unit": { "revenue": "元", "market_cap": "元", "dividend": "元/股", "ratio": "%" },
  "source": "FinMind"
}
```


### 2.7 取得個股即時新聞與輿情 `/api/stocks/:code/news`
* **Method**: `GET`
* **Description**: 整合各大財經媒體之新聞，並進行情緒評分與輿情統計。
* **Response Schema (200 OK)**:
```json
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-23T12:00:00+08:00",
  "summary": {
    "overall_label": "positive",
    "overall_score": 63.2,
    "positive": 12,
    "negative": 5,
    "neutral": 13,
    "total": 30
  },
  "items": [
    {
      "title": "台積電 3 奈米產能大暢旺 訂單利多頻傳",
      "summary": "台積電 3 奈米產能持續暢旺，市場看好 AI 晶片需求，受惠大客戶擴大訂單...",
      "url": "https://news.cnyes.com/news/id/5283912",
      "source": "鉅亨網",
      "published": "2026-06-22T09:15:00+08:00",
      "sentiment": {
        "label": "positive",
        "score": 75.0,
        "hits": ["利多", "訂單", "暢旺", "看好", "受惠"]
      }
    }
  ]
}
```

### 2.8 啟動 AI 全面審視 (多 Agent 決策) `/api/agents/decide`
* **Method**: `POST`
* **Description**: 啟動多 agent LLM 決策流程，融合量化 facts、三個分析師（技術籌碼、消息情緒、老王在地專家）、多空辯論、交易員決策、風控審核。
* **Request Body**:
```json
{
  "codes": ["2330"],
  "date": "2026-06-24"
}
```
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-24",
  "count": 1,
  "decisions": [
    {
      "code": "2330",
      "name": "台積電",
      "date": "2026-06-24",
      "fact_base": {
        "blended_score": 62.1,
        "blended_action": "BUY",
        "conflict": false
      },
      "analysts": {
        "technical": {
          "stance": "bull",
          "confidence": 0.7,
          "summary": "技術面呈現偏多整理...",
          "key_points": ["站穩季線", "成交量放大"],
          "llm_failed": false,
          "_llm": {
            "provider": "gemini",
            "switched": false,
            "elapsed_s": 21.3,
            "est_tokens": 700,
            "error": null
          },
          "role": "technical_analyst"
        },
        "news_sentiment": {
          "stance": "neutral",
          "confidence": 0.5,
          "summary": "市場輿論中規中矩...",
          "key_points": ["產業前景佳但估值偏高"],
          "_llm": {
            "provider": "gemini",
            "switched": false,
            "elapsed_s": 15.2,
            "est_tokens": 500,
            "error": null
          },
          "role": "news_sentiment_analyst"
        },
        "puhui": {
          "stance": "bull",
          "confidence": 0.6,
          "summary": "普惠觀點表示主力偏多吸籌...",
          "key_points": ["老王指標轉強"],
          "_llm": {
            "provider": "gemini",
            "switched": false,
            "elapsed_s": 18.1,
            "est_tokens": 600,
            "error": null
          },
          "role": "puhui_expert"
        }
      },
      "debate": [
        {
          "side": "bull",
          "stance": "bull",
          "confidence": 0.7,
          "summary": "多方論點認為基本面強勁且技術指標向上...",
          "key_points": ["營收創高"]
        },
        {
          "side": "bear",
          "stance": "bear",
          "confidence": 0.6,
          "summary": "空方論點認為目前評價偏高且外資有調節跡象...",
          "key_points": ["本益比接近區間上緣"]
        }
      ],
      "trader": {
        "decision": "BUY",
        "confidence": 0.65,
        "rationale": "考量多方論點較具說服力且量化基本面良好，建議偏多操作。",
        "_llm": {
          "provider": "gemini",
          "switched": false,
          "elapsed_s": 25.4,
          "est_tokens": 800,
          "error": null
        },
        "role": "trader"
      },
      "risk": {
        "final_decision": "HOLD",
        "confidence": 0.6,
        "risk_notes": "大盤近期水位相對偏高，且個股背離技術支撐，建議暫時觀望。",
        "conflict_acknowledged": true,
        "_llm": {
          "provider": "gemini",
          "switched": false,
          "elapsed_s": 22.1,
          "est_tokens": 900,
          "error": null
        },
        "role": "risk_manager"
      },
      "final_decision": "HOLD",
      "confidence": 0.6,
      "consistency": {
        "blended_direction": "bull",
        "agent_direction": "neutral",
        "blended_conflict_quant_vs_puhui": false,
        "divergent_from_quant": false,
        "divergence_flagged": true,
        "warning": "最終決策背離量化 blended 方向，卻沒被風控/交易員點名"
      },
      "degraded": []
    }
  ],
  "errors": [],
  "usage": {
    "llm_calls": 7,
    "by_provider": { "gemini": 7, "claude": 0 },
    "est_total_tokens": 4900,
    "total_elapsed_s": 187
  },
  "config": {
    "analysts": ["technical", "news_sentiment", "puhui"],
    "debate_rounds": 1,
    "primary_provider": "gemini",
    "fallback_provider": "claude"
  }
}
```

### 2.10 搜尋台股代號與股名 `/api/symbols/search?q=&limit=`
* **Method**: `GET`
* **Description**: 搜尋一般上市櫃個股，排除權證。結果長效快取 6 小時。
* **Response Schema (200 OK)**:
```json
{
  "query": "2330",
  "count": 1,
  "results": [
    {
      "code": "2330",
      "name": "台積電"
    }
  ],
  "source": "FinMind TaiwanStockInfo",
  "degraded": false
}
```

### 2.11 資金潮汐（資金流向 × 動能泡泡圖）`/api/market/capital-tide?date=&universe=`
* **Method**: `GET`
* **Description**: 有界 universe（預設 `watchlist_union_0050`，沿用 breadth 同一份取得邏輯）逐檔算「近 5 日三大法人淨買賣超」與「近 5 日平均每日漲幅（**還原價**）」，z-score 正規化到 `[-1, 1]` 當泡泡座標。**engine 端每日整批快取**（`cache_path/capital_tide/{date}_{universe}.json`），gateway 轉發（120s timeout）。
* **降級**：個別股缺資料 → 略過並記入 `errors[]`，不整批 500；engine down → gateway 走統一錯誤格式。
* **座標語意**：`flow_x`/`momentum_y` 為**相對 universe 的 z-score**（中線＝當日 universe 平均，非絕對 0）；原始值見 `flow_raw`（張）/`momentum_raw`（%/日）。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-06-28",
  "window_days": 5,
  "universe": "watchlist_union_0050",
  "axes": {
    "x": { "label": "資金流向", "unit": "近5日法人淨買賣超(張)" },
    "y": { "label": "進入慣性", "unit": "近5日平均漲幅(%/日)" }
  },
  "stocks": [
    {
      "code": "2330", "name": "台積電", "sector": "半導體",
      "flow_x": 0.82, "flow_raw": 125000.0,
      "momentum_y": 0.6, "momentum_raw": 1.2,
      "size": 0.9, "size_raw": 1.85e12,
      "strength": 78,
      "quadrant": "inflow_up"
    }
  ],
  "source": "FinMind/yfinance",
  "degraded": false,
  "errors": []
}
```
* `quadrant` ∈ `inflow_up | inflow_down | outflow_up | outflow_down`（依 `flow_x`/`momentum_y` 正負分象限）。


### 2.12 全市場個股熱力圖（含日/週/月） `/api/market/stock-heatmap?period=day|week|month&date=`
* **Method**: `GET`
* **Description**: 取得上市全市場個股收盤行情與漲跌幅資訊（支援單日/單週/單月切換）。單請求抓取 TWSE `MI_INDEX` (ALLBUT0999)，並具備日檔快取與非交易日自動回溯機制。
* **Response Schema (200 OK)**:
```json
{
  "date": "2026-07-02",
  "period": "week",
  "base_date": "2026-06-25",
  "market": "twse",
  "stocks": [
    {
      "code": "2330",
      "name": "台積電",
      "sector": "半導體業",
      "close": 1080.0,
      "change_pct": 2.35,
      "turnover": 51234567890.0
    }
  ],
  "source": "twse_mi_index"
}
```

### 2.13 再平衡持倉雲端同步 `/api/rebalance/holdings`
* **Method**: `GET` / `POST`
* **Description**: 個人「00631L 正2＋防守端」再平衡持倉的雲端持久化。gateway 純檔案讀寫 `data/rebalance_holdings.json`（不經 engine），**與背景告警腳本 `scripts/rebalance_alert.cjs` 讀的是同一份檔**。POST 一律伺服端 sanitize＋重算衍生 `shares`/`avg_cost`/`cash`/`bonds[].shares`/`bonds[].avg_cost`（＝`aggregatePortfolio`：期初部位＋trades 全域按日累算——均價各檔加權平均；**【增修H/I】現金為全資產共用池＝期初現金 − 買進金額 ＋ 賣出金額**（任一標的買扣賣加、未計手續費，負值 clamp 0），並以原子寫入（`.tmp`→rename）避免告警腳本讀到寫一半的檔。**【增修I】防守端**：固定保留現金 `cash_reserve`（預設 100,000）＋剩餘依 `bond_split` 分配債券池（00687B 佔比，預設 0.6 → 00687B:00953B＝6:4）；β 計算時現金與債券市值皆視為 β=0。**遷移**：`opening` 無 `cash` 欄位的舊檔以頂層 `cash` 作為期初現金；無 `bonds` 欄位補零持倉；trades 缺 `code` 視為 `00631L`。免登入個人自用、僅走內網/`ssh -L`；持倉檔已 gitignore（含財務數字不進版控）。`locked` 純供前端顯示鎖定狀態用，告警腳本 `rebalance_alert.cjs` 不讀取此欄位、其每日試算不受鎖定影響。
* **GET Response (200 OK)**：
```json
{
  "exists": true,
  "holdings": {
    "shares": 20000, "avg_cost": 34.8, "price": 38.8, "cash": 961200,
    "bonds": [
      { "code": "00687B", "shares": 5000, "avg_cost": 28.1, "price": 28.07 },
      { "code": "00953B", "shares": 6000, "avg_cost": 9.6, "price": 9.63 }
    ],
    "cash_reserve": 100000, "bond_split": 0.6,
    "locked": { "cash": false, "bonds": { "00687B": false, "00953B": false } },
    "target_beta": 1.3, "tolerance_mode": "abs", "threshold_abs": 0.1,
    "threshold_pct": 10, "etf_beta": 2.0,
    "opening": {
      "shares": 19000, "avg_cost": 35.37, "cash": 1000000,
      "bonds": [
        { "code": "00687B", "shares": 0, "avg_cost": 0 },
        { "code": "00953B", "shares": 0, "avg_cost": 0 }
      ]
    },
    "trades": [ { "id": "t1", "date": "2026-07-05", "side": "buy", "shares": 1000, "price": 38.8, "code": "00631L" } ]
  }
}
```
（檔不存在時 `{ "exists": false, "holdings": null }`。）
* **POST Body**：同 `holdings` 物件（頂層 `shares`/`avg_cost`/`cash` 與 `bonds[].shares`/`avg_cost` 會被伺服端依 `opening`+`trades` 重算覆蓋；`bonds[].price` 沿用前端輸入＝最後同步價，供告警腳本抓不到 ohlcv 時退用）。**Response**：`{ "ok": true, "holdings": {...清洗後...}, "saved_at": "ISO時間" }`。


### 2.14 個股公司基本檔 `/api/stocks/:code/profile`
* **Method**: `GET`
* **Description**: 個股公司靜態基本檔（成立年份、董事長、總部地址、官方網站、產業別、實收資本額）。資料源＝**TWSE OpenAPI `t187ap03_L`（上市公司基本資料）**，engine `twse_openapi_client` 於首次請求抓全市場一次、**依日期記憶體快取**（同一天不重打 TWSE）；gateway 薄轉發（`T.profile` 30s timeout，無獨立 TTL 層、靠 engine 日快取）。**降級**：查無代號（上櫃/興櫃/ETF 未涵蓋或 TWSE 端斷線）→ 回傳同結構但欄位多為 `null`、`name` 退回 FinMind 股名、`source` 標 `"TWSE OpenAPI (Degraded)"`；前端各欄顯示「—」、財務概況卡走既有 fundamentals 不受影響。
* **Query**：`code`（必填，台股代號，例 `2330`）。
* **Response (200 OK)**：`CompanyProfile`
```json
{
  "code": "2330",
  "name": "台積電",
  "full_name": "台灣積體電路製造股份有限公司",
  "industry": "半導體業",
  "founded": "1987",
  "chairman": "魏哲家",
  "address": "新竹科學園區力行六路8號",
  "website": "https://www.tsmc.com",
  "capital": 259303804580,
  "source": "TWSE OpenAPI t187ap03_L",
  "as_of": "2026-07-05"
}
```
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 台股代號 |
| `name` | string \| null | ✓ | 公司簡稱（降級時退回 FinMind 股名，仍可能 null） |
| `full_name` | string \| null | — | 公司全名 |
| `industry` | string \| null | — | 產業分類（TWSE 產業別代碼對照名） |
| `founded` | string \| null | — | 成立年份（`成立日期` 取前 4 碼西元年） |
| `chairman` | string \| null | — | 董事長姓名 |
| `address` | string \| null | — | 總部地址 |
| `website` | string \| null | — | 官方網站（自動補 `https://`） |
| `capital` | number \| null | — | 實收資本額（元） |
| `source` | string | ✓ | `"TWSE OpenAPI t187ap03_L"` 或 `"TWSE OpenAPI (Degraded)"` |
| `as_of` | string | ✓ | 抓取日期 YYYY-MM-DD |

### 2.15 個股集保戶股權分散 `/api/stocks/:code/shareholding`
* **Method**: `GET`
* **Description**: 個股集保戶股權分散（大戶／中實戶／散戶結構）週頻趨勢。資料源＝**TDCC 集保結算所開放資料 `id=1-5`**（免費官方，`opendata.tdcc.com.tw`；即 FinMind 付費資料集 `TaiwanStockHoldingSharesPer` 的原始來源）。engine `tdcc_client` 於請求時惰性抓最新一週全市場快照落地 `engine/data_cache/tdcc_shareholding/{date}.parquet`（冪等，已存在秒跳），再 `load_history` 讀近 N 週、`aggregate_dispersion` 歸併。**級距歸併**：TDCC 持股分級 1–17，Level 1–8＝散戶（≤50 張）、9–11＝中實戶（50–400 張）、12–15＝大戶（>400 張）；**Level 16（差異數調整）、17（合計）排除**（否則大戶人數與佔比會被合計列污染）。gateway 薄轉發（`T.shareholding` 30s timeout）。**限制**：TDCC 僅提供最新一週，歷史靠每週快照累積 → 上線初期 `weekly` 週數可能 < 16。**空態**：查無資料（新股/純 ETF/尚無快照）→ 回 `weekly: []`（不捏造資料），前端走「資料累積中」空態卡。
* **Query**：`code`（必填，台股代號，例 `3450`）、`weeks`（選填，預設 16，回傳週數上限）。
* **Response (200 OK)**：`ShareholdingDispersion`
```json
{
  "code": "3450",
  "name": "聯鈞",
  "levels": { "retail": "≤50 張", "mid": "50–400 張", "large": ">400 張" },
  "weekly": [
    {
      "date": "2026-07-03",
      "retail": { "people": 71047, "people_delta": 1047, "shares_pct": 39.75 },
      "mid":    { "people": 145,   "people_delta": 0,    "shares_pct": 12.59 },
      "large":  { "people": 49,    "people_delta": 0,    "shares_pct": 47.57 }
    }
  ],
  "source": "TDCC 集保戶股權分散表 (id=1-5)",
  "as_of": "2026-07-03"
}
```
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 台股代號 |
| `name` | string | ✓ | 股名（查無退回 `"個股"`） |
| `levels` | object | ✓ | 三組級距門檻標籤 |
| `weekly` | array | ✓ | 週頻紀錄（日期升冪；空態時 `[]`） |
| `weekly[].date` | string | ✓ | 資料日期 YYYY-MM-DD |
| `weekly[].{retail,mid,large}.people` | number | ✓ | 該組總人數 |
| `weekly[].{retail,mid,large}.people_delta` | number \| null | ✓ | 對前一週人數增減（首週 null） |
| `weekly[].{retail,mid,large}.shares_pct` | number | ✓ | 該組持股佔集保庫存比例（%） |
| `source` | string | ✓ | `"TDCC 集保戶股權分散表 (id=1-5)"` |
| `as_of` | string | ✓ | 最新一週資料日期（空態時為今日） |

---

### 2.16 期貨部位雲端同步 `/api/futures/positions`

* **Description**: 期貨損益總覽（opt23）的雲端持久化。gateway 純檔案讀寫 `data/futures_positions.json`（不經 engine），POST 一律伺服端 sanitize：月份正規化成 `YYYYMM`（`'2026-08'` 這類輸入也接受）、缺月份的部位直接丟棄（沒有到期月份就算不出轉倉）、`lots`/`entry_price` clamp ≥ 0、`stop_loss` 只保留仍存在的部位 id（避免刪了部位留下孤兒設定）。`cash`（保證金專戶現金餘額）**刻意不 clamp ≥ 0**——穿價時權益數可以是負的。原子寫入（`.tmp`→rename）。持倉檔已 gitignore（含財務數字不進版控）。
* **Method**: `GET` / `POST`

```jsonc
// GET 回應
{
  "exists": true,
  "futures": {
    "contract": "SRF",
    "price": 102.05,               // 現在價格
    "price_month": "202608",       // price 對應的到期月份
    "price_as_of": "2026-07-27",   // 報價日期
    "cash": 60000,                 // 保證金專戶現金餘額（入金 ± 已實現損益）
    "spec": {                      // 契約規格與費用（期交所 2026-06-18 公告值為預設）
      "contract_size": 1000, "tick_size": 0.05,
      "initial_margin": 7900, "maintenance_margin": 6100,
      "fee_per_lot": 30, "tax_rate": 0.00002,
      "rollover_days": 7, "liquidation_ratio": 0.25
    },
    "positions": [
      { "id": "f_…", "month": "202608", "side": "long", "lots": 2,
        "entry_price": 100, "entry_date": "2026-07-01" }
    ],
    "closed": [
      { "id": "c_…", "month": "202607", "side": "long", "lots": 1,
        "entry_price": 100, "exit_price": 105, "exit_date": "2026-07-10" }
    ],
    "stop_loss": { "f_…": 98 }
  },
  "saved_at": "2026-07-29T01:32:44.793Z"
}
```

### 2.17 期貨每日行情 `/api/futures/quote?contract=SRF`

* **Description**: 代抓臺灣期貨交易所 OpenAPI `DailyMarketReportFut`（公開資料、免金鑰），回傳該商品**所有到期月份**的每日行情。gateway 端 10 分鐘快取（每日行情一天只變一次，快取是為了擋連點）。
* **兩個解析規則**（改動時別拆掉）：①同一月份有「一般交易時段」與「盤後（夜盤）」兩列，**只有日盤有結算價**（夜盤那列 `SettlementPrice` 是字串 `'NULL'`），以此判定並優先取日盤，無日盤資料時才用夜盤墊底；②**價差契約**的月份欄位長成 `'202608/202609'`，用 `/^\d{6}$/` 濾掉，否則會被當成一個到期月份。
* **限制**：這是**每日行情（收盤/結算價）不是即時報價**。盤中即時價要看期貨商軟體，或在頁面手動改「現在價格」。
* **Method**: `GET`

```jsonc
{
  "contract": "SRF",
  "date": "2026-07-27",
  "months": [
    { "month": "202608", "date": "20260727",
      "last": 102, "settlement": 102.05,
      "open": 101.7, "high": 102.3, "low": 100.3, "change": 0.2,
      "volume": 6344, "open_interest": 17585,
      "best_bid": 102, "best_ask": 102.1 }
  ],
  "fetched_at": "2026-07-29T01:32:00.000Z",
  "cached": false   // 命中 gateway 快取時為 true
}
```

### 2.18 真實持倉同步觸發／狀態 `/api/rebalance/sync-holdings-{trigger,status}`

* **Description**: 玉山證券真實持倉同步。**2026-07-29 起**由 gateway 直接在 VM 上 spawn `deploy/sync_holdings_vm.sh`（amd64 容器 + qemu；玉山 SDK 沒有 linux-aarch64 版），不再經 GitHub `workflow_dispatch` → 本機 self-hosted runner，因此**電腦關機也能同步**。詳見 `docs/deploy.md` §4.6。
* **POST `/sync-holdings-trigger`**: 立刻回 `202 {ok, triggered_at}`；同時只允許一個同步在跑（重複觸發回 `409 BUSY`）。
* **GET `/sync-holdings-status`**: 最近一次執行結果。`message` 已把玉山錯誤碼翻成人話（`AGA0002`＝VM IP 不在金鑰白名單、`AWA0005`＝時鐘偏移、憑證檔不見、docker 沒跑），前端直接顯示，不再只能顯示一句「逾時」。

```jsonc
{
  "state": "ok",            // idle | running | ok | error
  "started_at": "2026-07-28T17:23:59.303Z",
  "finished_at": "2026-07-28T17:24:23.280Z",
  "exit_code": 0,
  "message": null,          // 失敗時為人話說明
  "log_tail": "…"           // 腳本輸出末段（除錯用）
}
```

### 2.19 個股／ETF 已實現損益雲端同步 `/api/stock-realized`

* **Description**: 「已實現損益總覽」頁（opt36）個股／ETF 已實現交易的雲端持久化。gateway 純檔案讀寫 `data/stock_realized_trades.json`（不經 engine），POST 一律伺服端 sanitize：代號正規化成大寫英數、缺 `sell_date` 或 `symbol` 的列直接丟棄（沒有賣出日就沒辦法歸到月份/區間篩選）、`fee`/`tax` 非負有限數才留否則存 `null`（前端用費率設定推估）。原子寫入（`.tmp`→rename）。交易明細已 gitignore（含財務數字不進版控）。跟期貨的 `/api/futures/positions` 是完全獨立的兩份檔案——這頁唯讀彙總期貨的 `closed`，不會把兩者的資料混寫進同一個檔案。
* **Method**: `GET` / `POST`

```jsonc
// GET 回應
{
  "exists": true,
  "data": {
    "trades": [
      {
        "id": "s_2330_2026-08-10_long_...", "symbol": "2330", "name": "台積電",
        "kind": "stock",       // stock | etf，預設用代號規則（'00' 開頭＝etf）判斷
        "side": "long",        // long＝現股買進後賣出；short＝融券賣出後買進回補
        "qty": 1000, "buy_price": 500, "sell_price": 550,
        "buy_date": "2026-08-01", "sell_date": "2026-08-10",
        "fee": null, "tax": null   // null＝用 fee_rates 推估；有值＝券商實收
      }
    ],
    "fee_rates": {
      "fee_rate": 0.001425, "fee_discount": 1,
      "stock_tax_rate": 0.003, "etf_tax_rate": 0.001
    },
    "imported_refs": ["s|2330|2026-08-10|1000|500|550"]
  },
  "saved_at": "2026-08-27T14:12:57.501Z"
}
```
（檔不存在時 `{ "exists": false, "data": null, "saved_at": null }`。）
* **POST Body**：同 `data` 物件。**Response**：`{ "ok": true, "data": {...清洗後...}, "saved_at": "ISO時間" }`。

### 2.20 個股／ETF券商截圖辨識 `/api/stocks/realized-ocr`

* **Description**: 比照期貨的 `/api/futures/ocr`（§opt30），辨識台股券商 App 的「已實現損益查詢」截圖。跟期貨截圖不同，這種畫面**每一列本來就是一筆結算完成的完整交易**（買賣雙腿、手續費、證交稅、損益都在同一列），不需要拆兩腿再湊，所以只有一種畫面 kind（`realized`），辨識結果直接對應 `StockRealizedTrade`（缺 `id`）。模型與 key 輪換沿用 `futures_ocr.js` 同一套（3 把 `GEMINI_API_KEY*` × `gemini-2.5-flash`/`gemini-2.5-flash-lite`）。圖片不落地也不記 log；單張上限約 6MB、一次最多 4 張。
* **Method**: `POST`
* **Request Body**: `{ "images": [{ "mime": "image/jpeg", "data": "<base64，不含 data URL 前綴>" }] }`
* **Response (200 OK)**:
```jsonc
{
  "ok": true,
  "screens": [
    {
      "title": "已實現損益查詢",
      "rows": [
        {
          "symbol": "2330", "name": "台積電", "kind": "stock", "side": "long",
          "qty": 1000, "buy_price": 500, "sell_price": 550,
          "buy_date": "2026-08-01", "sell_date": "2026-08-10",
          "fee": 21, "tax": 165, "net_pnl": 49814,
          "ref": "s|2330|2026-08-10|1000|500|550"
        }
      ],
      "totals": { "pnl": 49814, "count": 1 },
      "warnings": []
    }
  ],
  "warnings": [],
  "model": "gemini-2.5-flash",
  "scanned_at": "2026-08-27T14:14:03.668Z"
}
```
* **去重**：`ref` 指紋（代號＋賣出日＋股數＋買賣均價）跟前端 `imported_refs` 帳本比對，同一張截圖重複匯入不會重複計帳（見 `src/lib/stockRealizedImport.ts`）。
