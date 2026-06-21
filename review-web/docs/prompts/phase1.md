# Phase 1 — 盤勢總覽（完整）（個股全面審視網）

> 你（Claude）正在協助使用者開發「**個股全面審視網**」。本檔是 Phase 1 工作說明。
> **互動模式：你提供「希望看到的內容＋驗收標準＋schema 規格」並解答疑問；使用者自己寫 code；寫完你 review。不要你直接寫產品程式碼。**
> ✅ 本檔已於 **2026-06-21 依 Phase 0 實際產出校正**（contracts.md / api.ts / Dashboard.tsx 都讀過）。下方 schema 為 Phase 1 權威規格，以本檔為準。

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
      "volume": 382400000000,
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
  "sectors": [ { "name": "半導體", "change_pct": 1.45, "net_amount": 12450000000, "source": "TWSE" } ]
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

**資料源建議**（實作時確認，能用官方免金鑰就別用 FinMind）：
- 指數現值 → TWSE MIS（免金鑰）；台指期 → TAIFEX；sparkline `intraday` → TWSE MIS 當日分時；`history` → TWSE/yfinance(`^TWII`) 日收。
- 廣度漲跌/漲跌停家數 → TWSE 每日收盤行情；MA 比例 → 沿用 Phase 0 算法。
- 類股 → TWSE 分類指數日報。
- 三大法人 → TWSE 三大法人買賣金額日報（免金鑰），`trend` 取近 `days` 個交易日。

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
