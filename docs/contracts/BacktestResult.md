# Contract: `BacktestResult`

> 回測輸出（階段3）。**只回測 swing 引擎**——富果盤口無歷史，daytrade 不進回測。
> 同時用來驅動「因子權重最佳化」：跑不同 `params` 比較 `metrics`。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `strategy` | string | ✓ | 策略名/版本，例 `"swing_v1"` |
| `universe` | string | ✓ | 標的池描述，例 `"老王watchlist + 0050成分"` |
| `period` | object | ✓ | `{ start, end }`（YYYY-MM-DD） |
| `params` | object | ✓ | 本次參數：`weights`、`entry_score`、`exit_score`、`regime_gate` 等 |
| `metrics` | object | ✓ | 績效指標，見下 |
| `equity_curve` | array | ✓ | `[{ date, equity }]`，equity 以 1.0 起 |
| `benchmark` | object |  | 對照（例 0050）`{ name, cum_return }` |
| `generated_at` | string (ISO8601) | ✓ | 產生時間 |

### `metrics`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `cum_return` | number | 累積報酬（0.34 = +34%） |
| `annual_return` | number | 年化報酬 |
| `sharpe` | number | 夏普值 |
| `max_drawdown` | number | 最大回撤（負值，−0.18 = −18%） |
| `win_rate` | number | 勝率 0–1 |
| `trades` | integer | 交易筆數 |
| `avg_holding_days` | number | 平均持有天數 |

## 範例

```json
{
  "strategy": "swing_v1",
  "universe": "老王watchlist + 0050成分",
  "period": { "start": "2022-01-01", "end": "2026-06-12" },
  "params": {
    "weights": { "technical": 0.40, "chips": 0.40, "sentiment": 0.20 },
    "entry_score": 75,
    "exit_score": 45,
    "regime_gate": [0.5, 1.1]
  },
  "metrics": {
    "cum_return": 1.34,
    "annual_return": 0.21,
    "sharpe": 1.42,
    "max_drawdown": -0.18,
    "win_rate": 0.57,
    "trades": 212,
    "avg_holding_days": 14
  },
  "equity_curve": [
    { "date": "2022-01-03", "equity": 1.0 },
    { "date": "2026-06-12", "equity": 2.34 }
  ],
  "benchmark": { "name": "0050", "cum_return": 0.78 },
  "generated_at": "2026-06-13T16:00:00+08:00"
}
```

## 注意

- 嚴禁未來函數：因子、進出場只能用回測當日收盤前可得資訊。
- `live_only` 因子（盤口等）不得進回測輸入。
- 權重最佳化：固定其他參數、掃 `weights` 網格，挑 `sharpe`/`max_drawdown` 折衷最佳者回填到 `engine/app/factors` 設定。
