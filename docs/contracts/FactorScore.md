# Contract: `FactorScore`

> 單一因子的評分明細。`StockSignal.factors[]` 的元素。
> 重點：每個因子都標 `live_only`，回測模組（階段3）據此排除盤口等不可回測因子。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `key` | enum | ✓ | `"technical"` \| `"chips"` \| `"sentiment"` \| `"orderbook"` \| `"intraday_tech"` \| `"market_today"` |
| `name` | string | ✓ | 中文名（前端顯示） |
| `score` | number (0–100) | ✓ | 因子正規化後分數 |
| `weight` | number (0–1) | ✓ | 該 mode 下的權重（初始值，回測可調；同 mode 內各因子 weight 加總=1） |
| `confidence` | number (0–1) | ✓ | 資料完整度/可信度；資料缺漏時下降 |
| `live_only` | boolean | ✓ | `true`=不可回測（僅 `orderbook`/`intraday_tech`/`market_today` 為 true） |
| `inputs` | object |  | 計算用的原始子訊號（除錯/前端展開用） |
| `note` | string |  | 一句話摘要 |

## 約束

- 同一 `mode` 內、實際參與計分的因子 `weight` 加總必須為 1。某因子因資料缺漏退出時，須對剩餘因子重新正規化（並在 `note` 標註）。
- `live_only=true` 的因子**不得**出現在回測輸入。
- `key` 對映引擎：`technical/chips/sentiment` → swing；`orderbook/intraday_tech/market_today` → daytrade。

## 範例

```json
{
  "key": "chips",
  "name": "籌碼面",
  "score": 81,
  "weight": 0.40,
  "confidence": 0.80,
  "live_only": false,
  "inputs": {
    "foreign_net_buy_days": 3,
    "trust_net_buy": true,
    "margin_change_pct": -0.04,
    "short_margin_ratio": 0.22
  },
  "note": "外資連 3 買、融資減 4%，籌碼乾淨"
}
```

```json
{
  "key": "orderbook",
  "name": "盤口/主力",
  "score": 70,
  "weight": 0.45,
  "confidence": 0.6,
  "live_only": true,
  "inputs": { "bid_ask_ratio": 1.8, "depth_imbalance": 0.31, "large_order_net": 1250 },
  "note": "外盤主動、委買力道強（live，不進回測）"
}
```
