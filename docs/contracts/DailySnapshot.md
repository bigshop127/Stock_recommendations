# Contract: `DailySnapshot`

> 每日盤後的「全局快照」：大盤環境 + 老王水位/情緒 + 觀察清單。
> 前端首頁與每日報告以此為主資料；gateway（階段6）對外吐這顆。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `date` | string (YYYY-MM-DD) | ✓ | 快照日期（Asia/Taipei） |
| `market_regime` | object | ✓ | 大盤環境，見下 |
| `water_level` | string | ✓ | 老王操作水位，例 `"七成"`（來自 `puhui_cache.json`） |
| `puhui_sentiment` | object |  | 老王情緒 `{ label, score(1–10) }`（來自 `puhui_cache.json`） |
| `watchlist` | `Watchlist[]` | ✓ | 觀察清單，見 `Watchlist.md` |
| `generated_at` | string (ISO8601) | ✓ | 產生時間 |

### `market_regime`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `label` | enum | `"risk_on"` \| `"neutral"` \| `"risk_off"` |
| `score` | number (−1..+1) | 環境分數 |
| `gate` | number (0.5–1.1) | 套用到 swing 核心分的乘數（見 scoring-model §1.2） |
| `inputs` | object | 判定依據（大盤 vs MA60、漲跌家數、恐懼貪婪 proxy、美股隔夜） |

## 範例

```json
{
  "date": "2026-06-13",
  "market_regime": {
    "label": "risk_on",
    "score": 0.62,
    "gate": 1.05,
    "inputs": {
      "twse_vs_ma60": "above",
      "adv_decline_ratio": 1.8,
      "fear_greed_proxy": 58,
      "us_overnight": "+0.9%"
    }
  },
  "water_level": "七成",
  "puhui_sentiment": { "label": "偏多", "score": 7 },
  "watchlist": [
    {
      "code": "2330", "name": "台積電",
      "source": ["puhui", "factor"],
      "swing_score": 78.5, "daytrade_prob": 0.41,
      "rank_swing": 1, "rank_daytrade": 5
    }
  ],
  "generated_at": "2026-06-13T15:00:00+08:00"
}
```

## 來源備註

`water_level` / `puhui_sentiment` 來自既有 Node 線產出的 `data/puhui_cache.json`（唯讀；引擎不改 Node 線）。欄位對映：`water_level`→`water_level`、`puhui_sentiment`→`market_sentiment`。
