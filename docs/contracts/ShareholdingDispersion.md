# 契約與資料介面：集保戶股權分散表（大戶／散戶結構）

**端點**：`GET /api/stocks/:code/shareholding?weeks=16`
**代理後端**：Engine `GET /data/shareholding?code=...&weeks=...`
**資料源**：TDCC 集保戶股權分散表 (id=1-5)（週頻官方開放資料）

---

## 1. 請求參數

| 參數 | 型別 | 必填 | 預設值 | 說明 |
|---|---|---|---|---|
| `code` | string | 是 | — | 台股代號（例 `3450`） |
| `weeks` | number | 否 | 16 | 查詢週數上限（預設 16 週） |

---

## 2. 回傳 JSON 結構 (§2.15)

```json
{
  "code": "3450",
  "name": "聯鈞",
  "levels": {
    "retail": "≤50 張",
    "mid": "50–400 張",
    "large": ">400 張"
  },
  "weekly": [
    {
      "date": "2026-07-03",
      "retail": { "people": 71047, "people_delta": null, "shares_pct": 39.75 },
      "mid":    { "people": 145,   "people_delta": null, "shares_pct": 12.59 },
      "large":  { "people": 49,    "people_delta": null, "shares_pct": 47.57 }
    }
  ],
  "source": "TDCC 集保戶股權分散表 (id=1-5)",
  "as_of": "2026-07-03"
}
```

---

## 3. 說明與備註

- **歷史累積說明**：TDCC 免費開放資料僅提供「最新一週」全市場快照。系統於每週自動儲存快照，歷史週數隨時間逐週累積（上線初期 `weekly` 週數可能 `< 16`；查無資料回空陣列 `weekly: []`）。
- **級距過濾**：
  - `retail`：散戶（Level 1–8: ≤ 50 張 / ≤ 50,000 股）
  - `mid`：中實戶（Level 9–11: 50–400 張 / 50,001–400,000 股）
  - `large`：大戶（Level 12–15: > 400 張 / > 400,000 股）
  - **Level 16（差異數調整）與 Level 17（合計）已精確排除，確保大戶人數與總佔比不被合計欄位污染。**
