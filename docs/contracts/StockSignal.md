# Contract: `StockSignal`

> 全系統共用的「個股訊號」型別。引擎（階段3）產出、gateway（階段6）轉發、前端（階段7）顯示都以此為準。
> 一檔個股在某日、某 `mode` 下產生一筆 `StockSignal`（同一檔可同時有 swing 與 daytrade 兩筆）。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 台股代號，例 `"2330"` |
| `name` | string | ✓ | 股名，例 `"台積電"` |
| `date` | string (YYYY-MM-DD) | ✓ | 訊號日期（Asia/Taipei） |
| `mode` | enum | ✓ | `"swing"` \| `"daytrade"` |
| `action` | enum | ✓ | `"buy"` \| `"add"` \| `"hold"` \| `"reduce"` \| `"sell"` \| `"watch"` |
| `score` | number (0–100) | ✓ | 該 mode 引擎輸出分數（swing=swing_score；daytrade=daytrade_prob×100） |
| `confidence` | number (0–1) | ✓ | 整體信心（受資料完整度影響） |
| `factors` | `FactorScore[]` | ✓ | 構成此分數的因子明細，見 `FactorScore.md` |
| `reasons` | string[] | ✓ | 人話理由（前端直接顯示） |
| `regime_gate` | number \| null |  | 僅 swing：大盤環境閘門乘數（daytrade 為 `null`） |
| `live_only` | boolean | ✓ | 此訊號是否含不可回測因子（daytrade=true） |
| `generated_at` | string (ISO8601) | ✓ | 產生時間（含 +08:00） |

## 範例（swing）

```json
{
  "code": "2330",
  "name": "台積電",
  "date": "2026-06-13",
  "mode": "swing",
  "action": "buy",
  "score": 78.5,
  "confidence": 0.72,
  "factors": [
    { "key": "technical", "name": "技術面", "score": 74, "weight": 0.40, "confidence": 0.85, "live_only": false },
    { "key": "chips", "name": "籌碼面", "score": 81, "weight": 0.40, "confidence": 0.80, "live_only": false },
    { "key": "sentiment", "name": "消息情緒面", "score": 70, "weight": 0.20, "confidence": 0.60, "live_only": false }
  ],
  "reasons": ["三大法人連 3 買", "站上 20MA 且量增 1.6 倍", "老王列為重點續抱"],
  "regime_gate": 1.05,
  "live_only": false,
  "generated_at": "2026-06-13T08:30:00+08:00"
}
```

## 範例（daytrade）

```json
{
  "code": "3231",
  "name": "緯創",
  "date": "2026-06-13",
  "mode": "daytrade",
  "action": "watch",
  "score": 64.0,
  "confidence": 0.55,
  "factors": [
    { "key": "orderbook", "name": "盤口/主力", "score": 70, "weight": 0.45, "confidence": 0.6, "live_only": true },
    { "key": "intraday_tech", "name": "當日技術", "score": 62, "weight": 0.35, "confidence": 0.6, "live_only": true },
    { "key": "market_today", "name": "大盤當日", "score": 55, "weight": 0.20, "confidence": 0.7, "live_only": true }
  ],
  "reasons": ["外盤比 1.8、委買力道強", "開高走高、量比 2.1", "大盤漲跌家數偏多"],
  "regime_gate": null,
  "live_only": true,
  "generated_at": "2026-06-13T10:05:00+08:00"
}
```
