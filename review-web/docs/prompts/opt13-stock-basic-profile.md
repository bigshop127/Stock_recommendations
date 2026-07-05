# 優化專案 13 — 個股「基本資料」分頁：公司基本檔＋財務概況卡

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt13-stock-basic-profile.md`，然後根據裡面的說明進行」。
> 參考範本：aistockmap `基本資料` 分頁（公司基本檔：市值/產業分類/成立年份/董事長/總部/官網＋「最新財務概況」六宮格：季營收/市值/本益比/股價淨值比/毛利率/營益率/淨利率/EPS）。**只仿版面，資料走自家 engine（FinMind）＋公開 TWSE/MOPS OpenAPI。**
> **相依：opt12（tab 骨架）須先完成。** 本案填 `基本資料` tab 的實際內容。

---

## 1. 本案目標

把 opt12 的 `基本資料` 佔位換成兩張卡：

1. **公司基本檔卡**：公司名/代號、市值、產業分類、成立年份、董事長、總部地址、官方網站。
2. **最新財務概況卡（六～八宮格）**：季營收（＋ QoQ 或 YoY 小徽章）、市值、本益比、股價淨值比、毛利率、營益率、淨利率、EPS。

> 這兩張卡多數欄位我們**已經有**（`/api/stocks/:code/fundamentals` 的 `summary`＋`financials`＋`valuation`），真正的缺口只有**公司靜態檔（董事長/總部/官網/成立年份）**——FinMind 基本面沒有這些，要另接來源。

---

## 2. 資料盤點：已有 vs 缺口（誠實標註）

| 欄位 | 來源 | 狀況 |
|---|---|---|
| 公司名 / 代號 | 既有 | ✅ header 已有 |
| 產業分類 | FinMind `TaiwanStockInfo.industry_category`（engine `market.py get_sector_by_code` 已在用） | ✅ 可直接取 |
| 市值 | fundamentals `summary.market_cap` | ✅ |
| 本益比 / 股價淨值比 | fundamentals `valuation`（最新一筆 pe_ratio / pb_ratio） | ✅ |
| 季營收 / 毛利率 / 營益率 / 淨利率 / EPS | fundamentals `financials`（最新季） | ✅（確認欄位齊全；缺哪個就該欄顯示「—」） |
| **成立年份 / 董事長 / 總部地址 / 官方網站** | **FinMind 無** | ❌ **缺口——見 §3** |

---

## 3. 缺口補法：公司靜態檔（本案主要新工）

**資料源選項（你先各戳一下確認可用性，再定案，回報給 Claude）**：

- **首選：TWSE OpenAPI 公司基本資料**（`openapi.twse.com.tw` 的 `t187ap03_L`「上市公司基本資料」；上櫃另有 TPEx 對應）。含公司名、成立日期、董事長、地址、網址、實收資本額、產業別等，**公開免金鑰、一次抓全市場、可本機快取**。這是最乾淨的做法。
- 備選：MOPS 公開資訊觀測站對應表（欄位更全但介面較雜）。
- **不做**：從 aistockmap 或任何策展站抓。

**後端作法（engine 新增，薄封裝）**：

- engine 新增 `get_company_profile(code)`：讀 TWSE OpenAPI 全市場基本資料（**日快取一次**，非逐股請求），回傳單股：
  ```json
  {
    "code": "3450", "name": "聯鈞", "industry": "半導體業",
    "founded": "2000", "chairman": "鄭祝良",
    "address": "新北市中和區橋安街35號10樓",
    "website": "http://www.elaser.com.tw",
    "capital": 1234567890,            // 實收資本額，可選
    "source": "TWSE OpenAPI t187ap03_L", "as_of": "2026-07-05"
  }
  ```
  任一欄缺 → `null`，前端顯示「—」。查無此代號（如興櫃/ETF）→ 整包降級（見驗收 §5.4）。
- gateway 新增 `GET /api/stocks/:code/profile` 薄轉發＋長 TTL 快取（公司靜態檔一天變不了，TTL 可 6–24h）。
- 契約寫入 `docs/contracts.md`（新增 §2.14「個股公司基本檔 `/api/stocks/:code/profile`」）。

> 若戳 TWSE OpenAPI 後發現上櫃/興櫃覆蓋不足，**允許降級**：profile 卡只顯示拿得到的欄位、拿不到的顯示「—」，**不得讓整個基本資料 tab 壞掉**（財務概況卡仍要正常，因為它走既有 fundamentals）。

---

## 4. 前端規格

- 新增 `profileState`（data/loading/error），在 `基本資料` tab **首次可見時才抓**（或沿用全頁 mount 即抓亦可；profile 很輕）。打 `/api/stocks/:code/profile`。
- **公司基本檔卡**：仿範本兩排欄位格（label 小灰字上、值粗體下），桌面 4 欄、手機 2 欄；官網做成可點外連（`target=_blank rel=noopener`）。
- **最新財務概況卡**：六～八宮格，數字大、label 小；季營收旁放 QoQ/YoY 小徽章（顏色沿台股慣例：增紅減綠）。本益比/PB 標 `x`、比率標 `%`、EPS 標 `元`（沿用範本單位）。資料取 fundamentals 既有 state，**不重抓**（財務概況本質是把散在『財務分析』tab 的最新一季濃縮到頂）。
- 三態：loading 骨架、error 可重試、profile 降級時只灰掉缺的欄位。

---

## 5. 驗收標準

1. `tsc -b && vite build` 乾淨；engine `pytest` 綠（新 `get_company_profile` 有基本測試：正常股回欄位、查無回降級）。
2. 2330/3450 進 `基本資料` tab：公司基本檔六欄有值（董事長/總部/官網/成立年份實際顯示），財務概況八宮格數字與『財務分析』tab 最新季一致。
3. `/api/stocks/:code/profile` 有快取（重複打不重抓 TWSE）、契約 §2.14 同步。
4. **降級路徑**：拿一檔 TWSE OpenAPI 沒有的代號（或斷網模擬），profile 欄位顯示「—」但財務概況卡與整個 tab 不壞。
5. 官網連結可點且外開；無官網時不顯示空連結。

---

## 6. 不做 / backlog

- 公司英文名、股本形成、重大行事曆、股東會日期（範本沒重點呈現，先不做）。
- 「重大資訊觀測站即時同步 MOPS」那塊是 aistockmap 付費功能——**不做**。
- 處置股警示橫幅（範本頂部紅框「處置股警示」）：可列 backlog，資料源＝TWSE 處置有價證券公告；**本案先不做**，如要做另開 opt。
