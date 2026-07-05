# Contract: `CompanyProfile`

> 個股公司基本檔的 API 契約型別。端點合約見 `review-web/docs/contracts.md §2.14`。

## 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `code` | string | ✓ | 台股代號，例 `"2330"` |
| `name` | string \| null | ✓ | 公司簡稱，例 `"台積電"` |
| `full_name` | string \| null | — | 公司全名，例 `"台灣積體電路製造股份有限公司"` |
| `industry` | string \| null | — | 產業分類，例 `"半導體業"` |
| `founded` | string \| null | — | 成立年份，例 `"1987"` |
| `chairman` | string \| null | — | 董事長姓名 |
| `address` | string \| null | — | 總部地址 |
| `website` | string \| null | — | 官方網站網址（自動補 `https://`） |
| `capital` | number \| null | — | 實收資本額（元） |
| `source` | string | ✓ | 資料來源（例 `"TWSE OpenAPI t187ap03_L"` 或 `"TWSE OpenAPI (Degraded)"`） |
| `as_of` | string | ✓ | 資料抓取日期 YYYY-MM-DD |
