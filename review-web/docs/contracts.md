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


