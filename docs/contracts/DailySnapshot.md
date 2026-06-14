# Contract: `DailySnapshot`

> 每日盤後的「全局快照」：大盤環境 + 老王水位/情緒 + 觀察清單。
> 前端首頁與每日報告以此為主資料；gateway（階段6）對外吐這顆。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `date` | string (YYYY-MM-DD) | ✓ | 快照日期（Asia/Taipei） |
| `as_of_date` | string (YYYY-MM-DD) |  | 實際採用的老王報告日（缺日 fallback 時 ≠ `date`） |
| `market_regime` | object \| null | ✓ | 大盤環境，見下（degraded 時為 `null`） |
| `water_level` | number \| null | ✓ | 老王操作水位 **0~1**（如 `0.5`）。**階段6 正規化**：engine `/puhui/view` 原生即 float；degraded 由 `puhui_cache.json` 的中文「五成」轉換 |
| `water_level_text` | string \| null |  | 水位中文顯示字串，例 `"五成"`（供前端顯示） |
| `puhui_sentiment` | object \| null |  | 老王情緒 `{ label, score(0–100) }`（engine 原生 0~100；degraded 由 cache 的 1~10 ×10 對齊） |
| `watchlist` | `Watchlist[]` | ✓ | 觀察清單，見 `Watchlist.md` |
| `degraded` | boolean | ✓ | engine 不可用 → `true`（退讀 `puhui_cache.json`，無個股清單） |
| `generated_at` | string (ISO8601) | ✓ | 產生時間 |

> **階段6 變更（gateway 對外型別）**：原契約 `water_level` 為中文字串、`puhui_sentiment.score` 為 1–10。
> 因 engine `/puhui/view` 原生回 `water_level` float 0~1、`market_sentiment.score` 0~100，gateway 統一**正規化為數值**
> 並補 `water_level_text`（中文）、`degraded`、`as_of_date`。詳見 `docs/api.md`。

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
  "water_level": 0.7,
  "water_level_text": "七成",
  "puhui_sentiment": { "label": "偏多", "score": 70 },
  "degraded": false,
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

- **engine 正常**（主路徑）：`water_level` / `puhui_sentiment` 來自 engine `GET /puhui/view`（階段4 解析 `reports/**/*.md`）；`market_regime` 取代表股 `GET /signal?mode=swing` 的 `regime` 欄位（market-wide，gateway 不重算）；`watchlist` 來自 `GET /watchlist`。
- **engine 掛掉**（`degraded:true`）：`water_level` / `puhui_sentiment` 退讀既有 Node 線產出的 `data/puhui_cache.json`（唯讀），`market_regime:null`、`watchlist:[]`。
- 欄位對映：cache `water_level`(中文)→`water_level`(數值)+`water_level_text`、cache `market_sentiment`(1-10)→`puhui_sentiment`(0-100)。
