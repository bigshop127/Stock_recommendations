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
* **Description**: 取得本益比、股價淨值比、殖利率及營收年增率。
* **Response Schema (200 OK)**:
```json
{
  "code": "2330",
  "metrics": [
    {
      "date": "2026-Q1",
      "pe_ratio": 24.5,
      "pb_ratio": 6.8,
      "dividend_yield": 2.45,
      "revenue_yoy": 15.4,
      "eps": 8.7,
      "source": "TWSE"
    }
  ]
}
```

### 2.7 取得個股即時新聞與輿情 `/api/stocks/:code/news`
* **Method**: `GET`
* **Description**: 整合各大財經媒體之新聞，並進行情緒評分。
* **Response Schema (200 OK)**:
```json
{
  "code": "2330",
  "news": [
    {
      "id": "1",
      "title": "台積電 3 奈米產能供不應求，傳蘋果與超微包下產能",
      "date": "2026-06-20",
      "url": "#",
      "summary": "半導體供應鏈指出，台積電 3 奈米製程持續滿載，訂單已排至明年。",
      "sentiment": "positive",
      "sentiment_score": 92,
      "source": "Anue 鉅亨"
    }
  ]
}
```
