# Contract: `StockNews`

> 個股新聞輿情及情緒標記的 API 契約型別。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 台股代號，例 `"2330"` |
| `name` | string | ✓ | 股名，例 `"台積電"` |
| `as_of` | string (ISO8601) | ✓ | 數據產生時間 |
| `summary` | `SentimentSummary` | ✓ | 整體輿情情緒摘要 |
| `items` | `NewsItem[]` | ✓ | 個股相關新聞清單 |

### `SentimentSummary`

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `overall_label` | enum | ✓ | 整體傾向：`"positive"` \| `"negative"` \| `"neutral"` |
| `overall_score` | number | ✓ | 整體平均分數（0-100） |
| `positive` | number | ✓ | 利多新聞則數 |
| `negative` | number | ✓ | 利空新聞則數 |
| `neutral` | number | ✓ | 中性新聞則數 |
| `total` | number | ✓ | 總新聞數 |

### `NewsItem`

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `title` | string | ✓ | 新聞標題 |
| `summary` | string \| null | ✓ | 新聞摘要 |
| `url` | string | ✓ | 新聞連結 |
| `source` | string | ✓ | 媒體來源（如 `"經濟日報"`、`"鉅亨網"`） |
| `published` | string (ISO8601) | ✓ | 新聞發布時間 |
| `sentiment` | `NewsSentiment` | ✓ | 該則新聞的情緒分析結果 |

### `NewsSentiment`

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `label` | enum | ✓ | 情緒標籤：`"positive"` \| `"negative"` \| `"neutral"` |
| `score` | number | ✓ | 情緒得分（0-100） |
| `hits` | string[] | ✓ | 命中的情緒極性詞 |

## 範例

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
