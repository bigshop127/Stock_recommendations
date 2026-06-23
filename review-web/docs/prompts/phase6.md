# Phase 6 — 個股新聞輿情・情緒

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋契約規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase6.md`，然後根據裡面的說明進行」。

## 1. 本階段目標

在 `/stock/:code` 個股頁補上**新聞輿情・情緒**模組：抓該股近期相關新聞清單、**逐則標情緒（利多/利空/中性）**、給一個**整體輿情摘要**，並（行有餘力）做事件時間線。這是 Phase 1–5 鋪好個股深度頁後的「消息面」拼圖，也是 Phase 7「AI 全面審視」新聞段的資料底座。

**範圍：**
- **必做**：① gateway **新端點** `/api/stocks/:code/news`（engine 已有 `/data/news`，但缺 code→股名解析、缺逐則情緒標記、缺整體摘要，需在 engine service 層補齊後 gateway 薄轉發）② 前端新聞清單（標題連結、來源、相對時間、**逐則情緒徽章**）③ **整體輿情摘要 chip**（正/負/中性則數 + 整體傾向）④ 載入/空/失敗三態 + 手動重新整理。
- **可選（行有餘力，否則 Phase 後期再補）**：事件時間線（按日分組的時序列表）、情緒與股價疊圖（新聞太稀疏，預設不做）、把整體輿情與既有 `/api/stocks/:code` 的 **F_sentiment 因子分**並排當交叉佐證。

## 2. 互動與架構鐵律（務必遵守）

- 本階段**有後端工**（與 Phase 5 零後端不同）：engine 補一支「個股新聞＋逐則情緒」聚合、gateway 補 `/api/stocks/:code/news` 薄轉發。沿用 Phase 1/3/4 的分層：**engine `service.get_*` 聚合 → `/data/*` 端點 → gateway `/api/stocks/:code/*` 薄轉發 → 前端只打 `/api`**。
- 🟢 **情緒判讀一律「便宜的關鍵字詞典」，嚴禁逐則叫 LLM**。理由：本案唯一 LLM 路徑是 `agents/decide`（~187s/股、7×LLM、很貴、**只前端按鈕觸發**）；新聞清單會有數十則，逐則叫 LLM 會燒爆額度。情緒分類用既有中文財經極性詞典即可。
  - 逃生門（**本階段不做**）：若未來要「精準逐則情緒」再評估接 `agents/decide` 的 `news_sentiment_analyst`，但那屬 Phase 7 招牌段、按鈕觸發。
- 🚨 **單一事實來源：複用既有極性詞典，別再寫第二份**。`engine/app/factors/sentiment.py` 已有 `_POS`/`_NEG` 中文財經詞典與逐則極性邏輯（`_news_polarity`），**請把「逐則分類」抽成共用 helper**（如 `app/data/news_sentiment.py` 或 `factors/sentiment.py` 內 export `classify_polarity(text) -> {label, score, hits}`），讓**因子與新端點共用同一份詞典**。⚠️ 抽取時**不可改動 F_sentiment 因子的既有行為/數值**（教訓同 Phase 3/4：跨模組共用邏輯被就地改，害到既有因子分還測試剛好沒抓到）——抽完務必跑既有 `test_factors`/sentiment 相關回歸確認分數不變。
- engine 已有的 `/data/news`（`app/api/data.py:104`，`news_client.get_news(keyword, limit)`）是**通用**新聞源（帶 keyword→Google News RSS、否則→鉅亨最新台股），**回 `[{title, summary, published, url, source_feed}]` 但沒有逐則情緒、沒做 code→股名、`published` 還是 RFC822 原樣**。本階段在它之上補個股化聚合，不要重接新聞源。
- 前端**只打 gateway `/api`**，不直連 engine、不自己用詞典在前端算情緒（情緒在 engine 算好吐出來）。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源、不碰既有因子分數；欄位/型別一律 `snake_case`。
- 新聞**時效性高、無乾淨歷史語料**（`news_client.py` 已註明不長期快取、`sentiment.py` 標 `live_only` 不進回測）→ gateway 快取 TTL **要短**（如 5 分鐘），不要拿舊新聞當即時。

## 3. 後端規格（engine + gateway）

### 3.1 engine：個股新聞＋逐則情緒聚合
建議新增 `service.get_stock_news(code: str, limit: int = 30)`（或沿用既有 service 命名風格），流程：
1. **code → 股名解析**：用**既有**的 code→name 對照（signal/agents pipeline 已在用的那套，如 FinMind `TaiwanStockInfo` 或既有快取 map）。搜尋關鍵字用**股名為主**（Google News 對純代號 `2330` 易撈到雜訊），解析不到時退回用 code 字串當關鍵字。可選 `"{name} {code}"` 併查。
2. 呼叫既有 `news_client.get_news(keyword=<股名>, limit=limit)`。
3. **逐則情緒標記**：對每則 `title + summary` 跑共用 `classify_polarity`（§2 的詞典 helper），輸出 `sentiment: {label, score, hits}`：
   - `label ∈ {"positive","negative","neutral"}`（或中文「利多/利空/中性」，二擇一一致即可，建議英文 enum 前端再 i18n）。
   - `score`：0~100（沿用 `_news_polarity` 的 `(pol+1)/2*100`），無極性詞 → `neutral`/`50`。
   - `hits`：可選，命中的詞（debug/透明度用）。
4. **`published` 正規化**：Google News RSS 給 RFC822（如 `Mon, 23 Jun 2026 …`）、鉅亨給 epoch → 一律轉 **ISO8601**（沿用 `news_client._iso_from_epoch` 風格；RFC822 用 `email.utils.parsedate_to_datetime`）。轉不動就保留原字串但別讓前端炸。
5. **整體摘要**：`summary: {overall_label, overall_score, positive, negative, neutral, total}`（則數統計 + 整體傾向；overall 可用有極性則的平均 score，與 §2 詞典一致）。
6. **回傳契約**（snake_case）：
```jsonc
{
  "code": "2330",
  "name": "台積電",
  "as_of": "2026-06-23T12:00:00+08:00",
  "summary": { "overall_label": "positive", "overall_score": 63.2,
               "positive": 12, "negative": 5, "neutral": 13, "total": 30 },
  "items": [
    { "title": "…", "summary": "…|null", "url": "https://…",
      "source": "經濟日報",            // 從 source_feed / Google 標題尾「- 媒體」萃取
      "published": "2026-06-22T09:15:00+08:00",
      "sentiment": { "label": "positive", "score": 75.0, "hits": ["利多","訂單"] } }
  ]
}
```
7. 暴露 engine 端點（沿用 `/data` 風格，例如 `/data/stock_news?code=&limit=` 或在既有 `/data/news` 加 `code` 參數路徑——擇一，**別破壞既有 `/data/news` 既有呼叫者**：F_sentiment 仍走原 `get_news`）。

### 3.2 gateway：薄轉發
- 新增 `GET /api/stocks/:code/news`（`routes/stocks.js` 或對應檔），轉發到 engine 的個股新聞端點，**短 TTL 快取**（如 `T.news = 300s`），沿用既有降級語意（engine 掛 → 502/標 degraded，不假裝成功）。
- 更新 `docs/contracts.md`（既有契約檔已預留 news 介面，對齊 §3.1 schema）。

### 3.3 著色與語意（沿用全案鐵律，**反直覺，務必讀**）
- 🚨 台股 **bull=紅 / bear=綠**，且本案沿用老王報告的色碼語意 → **情緒徽章：利多/positive = 紅、利空/negative = 綠、中性 = 灰**。**這與西方「正面=綠」相反**，但與本案 OSC/量/籌碼/營收/老王 emoji 一致。別套成「負面=紅」。
- 詞典是粗略 keyword count → **保守標註**：無極性詞一律「中性」，別硬分；整體摘要文案別過度宣稱（這是關鍵字情緒、非語意模型）。

## 4. 希望看到的內容（前端）

在 `StockDetail.tsx` 加「新聞」區。沿用既有 Tab 結構（籌碼/基本面已是 Tab）——建議新增**「新聞輿情」Tab**或獨立區塊（你拍板）。

1. **整體輿情摘要 chip**：正 N / 負 N / 中性 N 則 + 整體傾向徽章（紅利多/綠利空/灰中性），可附 F_sentiment 因子分（讀既有 `/api/stocks/:code`，若有）當交叉佐證。
2. **新聞清單**：每則一列／卡片 = 情緒徽章（色） + 標題（連結，`target="_blank" rel="noopener"`） + 來源 + 相對時間（如「3 小時前」）。可選摘要兩行截斷。
3. **三態**：載入骨架／空清單「近期無相關新聞」／失敗「新聞暫時無法載入」+ 重試鈕（沿用既有降級 UI 風格，不破版）。
4. **手動重新整理**：新聞時效高但非即時 → **開 Tab 載一次 + 手動刷新鈕**即可，**不要**像五檔那樣 5s 輪詢（會浪費且 Google News 可能限流）。
5. **（可選）事件時間線**：把 items 按日分組成時序垂直時間線（每天一節點、底下列當日標題+徽章）；嫌繁可先用單純倒序清單，時間線當後續優化。

## 5. 工作清單

- engine：抽 `classify_polarity` 共用 helper（複用 `sentiment.py` 詞典，**不改因子行為**）；新 `service.get_stock_news`（code→name、逐則情緒、`published` ISO 化、整體摘要）；暴露端點（不破既有 `/data/news`）。
- gateway：`GET /api/stocks/:code/news` 薄轉發 + 短 TTL；更新 `docs/contracts.md`。
- 前端：新聞 Tab/區塊（清單 + 逐則徽章 + 摘要 chip + 三態 + 刷新）；`api.ts` 加型別與 client 方法（snake_case）。
- 測試：engine 加 `get_stock_news` 測試（mock `news_client.get_news`／FinMind 解析，斷言逐則 `sentiment.label`、`summary` 則數統計、`published` 正規化）；**回歸**：確認抽 helper 後 F_sentiment 因子分不變（跑既有 sentiment/factors 測試）。

## 6. 驗收標準

- [ ] `GET /api/stocks/:code/news` 回 §3.1 契約（snake_case）：`items[]` 每則含 `title/url/source/published(ISO)/sentiment{label,score}`、`summary{overall_label,overall_score,positive,negative,neutral,total}`、`name`/`as_of`。
- [ ] code→股名解析正確（複用既有對照，不另接源）；解析不到退回 code 當關鍵字不報錯。
- [ ] 逐則情緒**複用既有 `sentiment.py` 詞典**（無第二份字典）；抽 helper 後 **F_sentiment 因子分數不變**（回歸綠）。
- [ ] **情緒徽章著色：利多=紅、利空=綠、中性=灰**（台股慣例，與全案一致，非西方綠正紅負）。
- [ ] **無逐則 LLM 呼叫**（情緒走詞典）；未動 `agents/decide`、未在首頁/個股自動觸發 LLM。
- [ ] `published` 正規化成 ISO（Google RFC822 / 鉅亨 epoch 都轉）；前端相對時間顯示正常、不 `Invalid Date`。
- [ ] 三態完整（載入/空/失敗+重試）；engine 掛或新聞源失敗 → gateway 降級、前端不破版；**不 5s 輪詢**（開 Tab 載一次 + 手動刷新）。
- [ ] gateway 新聞快取 **短 TTL**（時效性，不拿舊新聞當即時）；既有 `/data/news` 呼叫者（F_sentiment）不受影響。
- [ ] 未動 `web/`、未改壞 `puhui_daily.cjs`、未碰既有因子分；`docs/contracts.md` 已更新。
- [ ] engine pytest 綠（含新 `get_stock_news` 測試 + sentiment 回歸）、`tsc -b && vite build` 乾淨。

## 7. 沿用既有坑（帶進 review）

- 🚨 **情緒著色反直覺**：利多=紅、利空=綠、中性=灰（台股 bull=紅，與老王 emoji/OSC/籌碼/營收同調）；別套成西方配色。
- 🚨 **別改壞既有因子**：抽共用詞典 helper 時，F_sentiment（`compute_sentiment`/`_news_polarity`）行為與數值要不變——這是 Phase 3/4 重複踩過的坑（共用邏輯被就地改、測試剛好沒抓）。抽完跑回歸。
- 🚨 **嚴禁逐則 LLM**：情緒=便宜詞典；`agents/decide` 很貴、只 Phase 7 按鈕觸發。
- 新聞源易變/可失敗：鉅亨 newslist 是未文件化 JSON（會變、已有 Google News 備援）、Google News 可能限流 → engine `DataSourceError` → gateway 降級、前端三態，別假裝成功。
- Google News 標題常是「`標題 - 媒體名`」格式、`link` 是 `news.google.com` 轉址 → `source` 從標題尾或 `source_feed` 萃取；連結開新分頁即可（會自動轉址）。
- `published` 來源格式不一（RFC822 vs epoch）→ engine 統一 ISO，別把原字串丟前端硬 parse。
- 詞典情緒是粗略 keyword count（非語意）→ 保守標、無極性詞=中性、文案別過度宣稱。
- 新聞**不進回測、不長期快取**（`live_only`）；gateway TTL 短即可。
- engine 掛要 graceful degradation（沿用既有降級語意）；前端只打 `/api`、不直連 engine。
