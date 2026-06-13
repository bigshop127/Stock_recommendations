# Contract: `Watchlist`（item）

> 觀察清單的單筆。自動帶入老王 `mentioned_stocks` + 引擎自選，對每檔同時給波段分與當沖機率、各自排序。
> 是 `DailySnapshot.watchlist[]` 的元素。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 代號 |
| `name` | string | ✓ | 股名 |
| `source` | enum[] | ✓ | 來源，元素為 `"puhui"`（老王帶入）/ `"factor"`（引擎自選） |
| `puhui_signal` | string \| null |  | 老王訊號（`mentioned_stocks[].signal`，例 買進/續抱/觀察） |
| `puhui_reason` | string \| null |  | 老王理由（`mentioned_stocks[].reason`） |
| `swing_score` | number (0–100) | ✓ | 波段引擎分（潛力） |
| `daytrade_prob` | number (0–1) | ✓ | 當沖引擎機率（live；盤後快照可為當日最後值或 `null`） |
| `rank_swing` | integer | ✓ | 波段分排名（1 = 最高） |
| `rank_daytrade` | integer | ✓ | 當沖機率排名 |
| `tags` | string[] |  | 標籤（例 `["法人連買","站上月線"]`） |

## 排序規則

- `rank_swing`：依 `swing_score` 由高到低。
- `rank_daytrade`：依 `daytrade_prob` 由高到低（無盤口資料者排末）。
- 前端可讓使用者切換「波段潛力」/「短線當沖」兩種排序檢視。

## 範例

```json
[
  {
    "code": "2330", "name": "台積電",
    "source": ["puhui", "factor"],
    "puhui_signal": "續抱", "puhui_reason": "CoWoS 產能滿載、外資調升目標價",
    "swing_score": 78.5, "daytrade_prob": 0.41,
    "rank_swing": 1, "rank_daytrade": 5,
    "tags": ["法人連買", "站上月線"]
  },
  {
    "code": "3231", "name": "緯創",
    "source": ["puhui"],
    "puhui_signal": "觀察", "puhui_reason": "爆量後守低點",
    "swing_score": 61.0, "daytrade_prob": 0.66,
    "rank_swing": 4, "rank_daytrade": 1,
    "tags": ["AI PC", "盤口強"]
  }
]
```
