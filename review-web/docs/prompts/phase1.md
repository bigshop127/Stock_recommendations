# Phase 1 — 盤勢總覽（完整）（個股全面審視網）

> 你（Claude）正在協助使用者開發「**個股全面審視網**」。本檔是 Phase 1 工作說明。
> **互動模式：你提供「希望看到的內容＋驗收標準＋schema 規格」並解答疑問；使用者自己寫 code；寫完你 review。不要你直接寫產品程式碼。**
> ✅ 本檔已於 **2026-06-21 依 Phase 0 實際產出校正**（contracts.md / api.ts / Dashboard.tsx 都讀過）。下方 schema 為 Phase 1 權威規格，以本檔為準。
> ✅ **2026-06-22：4 端點資料源已 Claude 實打驗證**，schema 含 C3/C4 修正，另列 5 處必修＋實作備註於 **§2.5**（開工前必讀）。

## 0. 先讀

- 總綱：`C:\CC AI Agent\review-web\docs\ROADMAP.md`（§3 缺口表、§7 坑）
- Phase 0 產出：`review-web/`（腳手架）、`review-web/docs/contracts.md`（端點契約，**本階段要同步成 snake_case**）
- 既有後端：`C:\CC AI Agent\docs\api.md`、`engine/`（資料源實作）、`server.cjs`+`routes/`（gateway）

## 1. 本階段目標

做出 **完整盤勢總覽首頁 `/`**（參考 futures-ai `market-overview`，三大法人為重點），並在既有 repo 補 4 個盤勢端點。
**界線：engine/gateway 只「新增端點」，不改既有邏輯、不重算既有分數，不動既有 `web/`。** 市場層級資料**優先走 TWSE 官方免金鑰源**，省 FinMind 額度。

## 1.5 開工前先收掉的 Phase 0 技術債（重要）

Phase 0 review 發現兩件事必須在本階段一起處理，否則愈拖愈貴：

1. **命名規範統一為 `snake_case`（已拍板 2026-06-21）。** Phase 0 的 `contracts.md` / `api.ts`(229-317) / `Dashboard.tsx` 新端點欄位是 camelCase（`changePercent`/`above20MaRatio`/`foreignNetBuy`…），與既有 API 全 snake_case 不一致、後端 Python 還要多一層轉換。
   - 本階段把 **4 個 market 端點**的介面與用法改 snake_case（見下方 §2 schema）。
   - **順手把還沒實作的 3 個個股端點介面**（`StockChips`/`StockFundamentals`/`StockNews`，`api.ts:275-317`）也一起翻成 snake_case，避免 Phase 3/4/6 再返工。
   - 同步更新 `contracts.md` 成 snake_case 版本（它是端點 SSOT）。

2. **Mock fallback 不可遮蔽真實錯誤。** `Dashboard.tsx:29-36` 現在是「真 API 失敗 → 靜默載入 mock」。端點上線後，500 / NaN / timeout 都會被 mock 蓋掉只剩小 badge——牴觸「降級要可見」原則（且我們踩過 engine `NaN→500`）。本階段改成：
   - **逐區塊真實降級**：哪個端點掛了，就那一塊顯示「資料暫時無法取得 / 降級」，其餘正常。
   - Mock 僅保留在 `import.meta.env.DEV` 且明確開關（例如 `?mock=1`）下，**絕不由真實端點錯誤自動觸發**。

## 2. 希望看到的內容

**前端首頁 `/`（桌面多欄 → 手機收合）**
1. **指數列**：加權 / 櫃買 / 電子 / 金融 — 現值、漲跌、漲跌幅、**迷你走勢 sparkline**（已拍板含走勢）。
2. **大盤水位 + regime**：沿用既有 `GET /api/dashboard`（`water_level` 0~1 + `water_level_text`、`market_regime`）。
3. **市場廣度**：上漲/下跌/平盤家數、漲停/跌停、上漲比例（bar 或 donut）＋站上 20/50MA 比例（Phase 0 已做的好東西，保留）。
4. **類股熱力圖**：各類股當日漲跌幅，顏色深淺呈現（**漲紅跌綠＝台股慣例**；跟老王 emoji 是兩回事，別混淆）。
5. **市場三大法人買賣超總覽（重點）**：外資 / 投信 / 自營 當日買賣超 ＋ **近 N 日趨勢圖**；單位釘死（元，UI 自行轉億顯示）。
6. **自選 / 焦點股入口**：沿用 `GET /api/watchlist`，每列可點進 `/stock/:code`（個股頁 Phase 2 才實作，先導頁/佔位）。
7. engine / 某資料源 down → **該區塊**優雅降級，不白屏、不掉 mock。

**後端新增 4 端點（engine 吐資料 → gateway `/api/market/*` 轉發/組合）**
權威 schema（全 snake_case，單位/欄位以此為準，並同步進 `contracts.md`）：

```jsonc
GET /api/market/indices?range=1d|5d|1m
{
  "date": "YYYY-MM-DD",
  "as_of": "ISO",
  "indices": [
    {
      "key": "TWSE|OTC|electronic|finance|TX",   // 穩定鍵，前端據此排序/上色，不靠中文名
      "name": "加權指數",
      "price": 22845.81,
      "change": 182.42,
      "change_pct": 0.81,
      "volume": 382400000000,   // ⚠️C4：MIS 指數頻道 v=null。只加權/櫃買有全市場成交值(MI_INDEX/OTC)，電子/金融/台指期 → null（optional，別硬湊）
      "intraday": [ { "t": "09:05", "v": 22810.2 } ],     // range=1d 用，無金鑰源可空陣列→sparkline 降級
      "history": [ { "date": "2026-06-12", "close": 22600.1 } ], // range=5d|1m 用
      "source": "TWSE MIS"
    }
  ]
}

GET /api/market/breadth?date=
{
  "date": "YYYY-MM-DD",
  "advancing": 582, "declining": 324, "unchanged": 92,
  "limit_up": 12, "limit_down": 3,
  "total": 998,
  "advancing_pct": 0.583,
  "above_ma20_ratio": 0.625,   // Phase 0 已做，保留
  "above_ma50_ratio": 0.584,
  "source": "TWSE"
}

GET /api/market/sectors?date=
{
  "date": "YYYY-MM-DD",
  // ⚠️C3：官方無「類股淨流入」乾淨來源 → net_amount 改 turnover(成交金額, BFIAMU)，或 Phase 1 先省
  "sectors": [ { "name": "半導體", "change_pct": 1.45, "turnover": 12450000000, "source": "TWSE" } ]
}

GET /api/market/institutional?date=&days=20
{
  "date": "YYYY-MM-DD",
  "unit": "元",
  "latest": { "foreign": number, "investment_trust": number, "dealer": number, "total": number },
  "trend": [ { "date": "YYYY-MM-DD", "foreign": number, "investment_trust": number, "dealer": number, "total": number } ],
  "source": "TWSE"
}
```

## 2.5 資料源實測確認與 5 處修正（2026-06-22，Claude 實打驗證）

> 上面 §2 schema 已含 C3/C4 修正。下方為 4 端點資料源的**逐源實測結論**（用真實交易日 20260618/20260622 打過），全部可取、無死路。能用官方免金鑰就別用 FinMind。

**✅ 實測可用（直接照用）**
- **indices 指數現值** → TWSE MIS 指數頻道：`t00`加權 / `o00`櫃買 / `t13`電子工業 / `t17`金融保險（四個皆有效值，免金鑰）。
- **台指期** → TAIFEX `getQuotes?objId=2`：回 `TX` 台指期，外加 `TE` 電子期、`TF` 金融期（電子/金融可用真期貨，不必縮放）。
- **history 日收** → yfinance `^TWII`(加權) / `^TWOII`(櫃買) / `^TFNI`(金融) / `0053.TW`(電子ETF) / `0055.TW`(金融ETF)。
- **breadth 漲跌家數** → TWSE `MI_INDEX?type=MS`，**表 7「漲跌證券數合計」取「股票」欄**（非「整體市場」），格式 `574(58)` → advancing=574 / limit_up=58。MA 比例沿用 Phase 0 算法（見 C-impl ⑥）。
- **institutional 三大法人** → TWSE `BFI82U`（三大法人買賣金額日報，免金鑰，金額單位**元**）。

**⚠️ 5 處必修（不改第一版上線當天就出事）**
- **C1　電子/金融 sparkline 來源**：`^TELI`(電子) 5 天只回 1 根、5m 分時幾乎必空 → 電子改用 `0053.TW`/MIS `t13`/TAIFEX `TE`；金融 `^TFNI` 正常但建議比照 `0055.TW`/`TF`。無分時源時 sparkline 優雅降級不破版。
- **C2（最大坑）即時 vs 盤後日期落差**：同一時刻 MIS/TAIFEX/yfinance=今日 live，但 TWSE 盤後報表（breadth/institutional/sectors）**最新只到前一交易日**（實測 06-22 當下只到 06-18）。每個盤後端點必須：打 today → 若 `stat!="OK"`（回「很抱歉，沒有符合條件的資料!」）→ **回溯到最近有資料的交易日** → 回傳實際解析到的 `date`。前端各區塊各顯示自己的 as-of 日（不一致是正常）。**不處理 → 盤後資料出爐前整頁像壞掉。**
- **C3　sectors 來源要換**（schema 已改）：`type=MS` **沒有類股表**。各類股 change% → MIS 產業頻道 `tse_t11..t31`（z vs y 算，一次回約 21 個產業；**t 編號有缺號，用白名單對照別盲掃**）；各類股成交值 → TWSE `BFIAMU`。淨流入官方無乾淨源 → `net_amount`→`turnover` 或先省。
- **C4　指數 volume**（schema 已改）：MIS 指數頻道 `v=null`（實測）。只有加權(MI_INDEX 大盤統計成交金額)、櫃買(OTC 對應報表) 有全市場成交值；電子/金融/台指期 → `volume:null`（optional）。
- **C5　全域 NaN/Inf→null sanitizer**：依記憶 `engine-nan-json-500`，response 層至今**無**全域守衛（`/api/dashboard` 曾因此 500）。這批新端點更易生 NaN（prev=0 算漲跌幅、sparkline 缺洞、類股缺收盤）→ 在 FastAPI response 邊界加**一個**遞迴 NaN/Inf→null sanitizer（自訂 JSONResponse 或 middleware），別每端點各清；順手回頭保護舊端點。

**🔧 較小實作備註（省來回）**
- ① 欄名統一既有 `change_pct`/`prev_close`（engine `yfinance_client.get_market_snapshot` 已用此拼法），別出現 `change_percent`。
- ② 架構分工：抓取一律 engine（新 client + `/market/*` router），gateway **只薄轉發** `/api/market/*`（比照現有 `/data` 透傳，**別在 Node 直打 TWSE**，違反 phase6「gateway 不重算」）。
- ③ 可重用：MIS 指數/產業頻道重用 `twse_mis_client._ensure_cookie`/`get_json`（加 `get_index_quote(channels)`）；breadth/法人/類股成交值是全新盤後源 → 新開 `twse_report_client.py`（MI_INDEX/BFI82U/BFIAMU，目前皆不存在）。
- ④ TAIFEX getQuotes 是 **JSON list、price/updown 是含逗號字串**（"48,145"）要 strip，與既有 `taifex_client` 的 CSV 下載是不同函式；跌日請確認 `updown` 帶負號（實測當天為漲日無法證實負號）。
- ⑤ BFI82U 解析：自營=自營商(自行買賣)+自營商(避險) **兩列相加**；外資=外資及陸資(+外資自營商)；投信=投信；total=合計。`trend[]` 逐交易日迴圈（過去日不可變→快取）或用 FinMind `TaiwanStockTotalInstitutionalInvestors` 避免 N 次 HTTP。
- ⑥ **`above_ma20/50_ratio` 範圍要誠實**：engine K線快取**只有被查過的股**（watchlist+臨時查），**非全市場 ~1800 檔**。要嘛明確定義 universe（0050 成分/watchlist）並標註，要嘛 Phase 1 先緩——別宣稱全市場卻只算幾檔。

## 3. 技術約束

- 前端只打 `/api`、不重算；新端點 engine 算/聚合、gateway 只轉發或輕量組合。
- 新端點要有錯誤/降級處理（資料源掛掉回統一錯誤格式 `{ error:{ code,message,detail? } }`，前端**該區塊**降級）。
- 桌面多欄、`md` 以下收合不破版；圖表用 lightweight-charts 或輕量 SVG（sparkline 用輕量 SVG 即可，不必開 lightweight-charts 實例）。
- **不動既有端點與既有 `web/`。** 改 `server.cjs`/`routes/` 只「新增」route 檔，別動既有 route。

## 4. 驗收標準

- [ ] 4 個新端點各自可獨立 curl 成功，回應符合 §2 snake_case schema，單位明確。
- [ ] `contracts.md` / `api.ts` / `Dashboard.tsx` 的新端點欄位已全部改 snake_case，`tsc` 零錯。
- [ ] 首頁 6 區塊都有真實資料；指數 sparkline 有畫（無分時源時優雅降級不破版）。
- [ ] 三大法人總覽有**近 N 日趨勢圖**（外資/投信/自營/合計）。
- [ ] 廣度有漲跌家數 + 漲停/跌停 + 上漲比 + 20/50MA 比例。
- [ ] 類股熱力圖漲跌色為**台股慣例（漲紅跌綠）**，未誤用老王 emoji 語意。
- [ ] **某端點 500/錯誤時只該區塊降級**，其餘正常；mock 不會被真實錯誤自動觸發（僅 DEV `?mock=1`）。
- [ ] 既有 `web/` 與既有端點未受影響（回歸既有測試 / engine pytest）。

## 5. 你（Claude）本階段要做的事

1. 讀完「先讀」與 Phase 0 的 `contracts.md`，**複述 Phase 1 希望看到的內容**，對 4 端點資料源/單位給具體建議（哪個走 TWSE、欄位怎麼定、sparkline 怎麼取）。
2. 解答實作疑問（TWSE 來源格式、heatmap 畫法、sparkline、逐區塊降級、snake_case 遷移範圍）。
3. 使用者寫完 → 對照 §4 review：schema/單位/色碼/降級對嗎？snake_case 遷移乾淨嗎？mock 還會不會遮錯？沒動到既有邏輯吧？
4. 通過後更新 `ROADMAP.md`、Obsidian `2_盤勢總覽`、記憶；校正 `phase2.md` 與現況落差再進 Phase 2。

## 6. 帶進 review 的坑（見 ROADMAP §7 + Phase 0 review）

- **色碼兩套別混**：類股/指數漲跌＝台股慣例**漲紅跌綠**（Phase 0 已對）；老王報告 emoji 才相反（🔴看多/🟢看空）——首頁不碰老王 markdown。
- 型別：`water_level` 0~1（+中文 `water_level_text`）、`puhui_sentiment.score` 0~100。
- TWSE/TAIFEX CSV 解析常有 index_col / 編碼 / 千分位逗號坑（既有 data 層踩過，可參考 `engine/`）。
- 三大法人單位釘死 `元`，UI 自行 /1e8 顯示「億」；contracts 與 UI 一致。
- FinMind 額度緊 → 市場層級盡量別用 FinMind。
- **Mock 遮蔽錯誤**：Phase 0 的全域 mock fallback 必須拆成逐區塊真實降級（見 §1.5）。
- engine `NaN→JSON 500`（記憶 `engine-nan-json-500`）：新端點若聚合可能產生 NaN，序列化前先 sanitize，別讓整端點 500。
