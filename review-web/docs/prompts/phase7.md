# Phase 7 — AI 全面審視（招牌段・多 agent 決策）

> 互動模式（沿用）：本檔由 Claude 給「希望看到的內容＋驗收標準＋契約規格」並解答疑問；**你寫 code**，寫完 Claude review。不要 Claude 直接寫產品程式碼。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\phase7.md`，然後根據裡面的說明進行」。

## 1. 本階段目標

在 `/stock/:code` 個股頁補上**招牌段「AI 全面審視」**：複用既有 `POST /api/agents/decide`（**輕量自寫編排／3 分析師／1 輪辯論／交易員／風控** 的多 agent LLM 決策層，階段5 已完成），把該股的「模擬交易公司」敘事＋最終決策**分段呈現**。這是 Phase 1–6 鋪好量化深度（籌碼/基本面/技術/新聞）後，最上層的「判讀與決策」拼圖。

⚠️ 這層**只判讀不重算**：數字一律吃 decide 回應裡的 `fact_base`（量化不可變底座，來自 `/signal/blended`）與各 agent 意見；前端不重做融合、不重算分數。

**範圍：**
- **必做**：① `/stock/:code` 新增「AI 全面審視」區塊／Tab，內含一個**觸發按鈕**（**預設不自動載入**）。② 點擊 → `POST /api/agents/decide` body **`{ codes: [code] }`（單股）**→ 取 `decisions[0]` 渲染。③ **分段渲染對齊實際 agent graph**：量化事實底座 → 三分析師（技術＋籌碼／消息情緒／老王在地專家）→ 多空辯論 → 交易員決策 → 風控審核 → 最終決策＋信心＋**一致性守門 warning**。④ **長等待 loading 態**（~2–3 分鐘）＋失敗態＋**用量遙測顯示**。⑤ **localStorage 快取**（code+date）＋「上次分析時間」＋「重新分析」鈕。
- **可選（行有餘力，否則後期再補）**：把各 agent 意見對應到頁面既有分頁（技術/籌碼/基本面/新聞）旁當交叉佐證；final_decision vs `blended_action` 對比視覺化；保留多筆歷史快取比較。

## 2. 互動與架構鐵律（務必遵守）

- 🚨 **`agents/decide` 很貴**（每股 7×LLM ≈187s）→ **只按鈕觸發**，**嚴禁進 `useEffect` 自動載入**、不在首頁/清單/開頁時自動跑。localStorage **硬快取**，預設不自動過期重跑。
- 🚨 **單股**：body 一律帶 **`{ codes: [activeCode] }`**。**絕不送 `codes: []` 或省略 `codes`**——engine 會退去取 `/watchlist` 前 N 檔**跑整批**（~187s × N），會燒爆 token。review-web 也不做多股批次觸發。
- 前端**只打 gateway `/api`**，不直連 engine、不重算數字、不重做融合（吃 decide 回應的 `fact_base`/`final_decision`/各 agent 文字即可）。
- gateway `POST /api/agents/decide` **已存在**（透傳 engine `/agents/decide`，timeout 已設 **1200s**）→ **本階段以零後端改動為原則**。
  - 逃生門（**本階段不做**）：若覺得全量 decide 太慢/太貴，未來可加「只回 `final_decision`＋各 agent `summary` 摘要」的精簡端點省 token——留後期評估，本階段先沿用全量 decide。
- 🚨 **著色台股慣例**（與全案一致，非西方）：**BUY／做多／bullish = 紅、SELL／做空／bearish = 綠、HOLD／中性 = 灰**。
- 🚨 **一致性守門 `consistency.warning` 必須醒目呈現**：非 `null` 時＝「最終決策**背離量化** blended 方向，卻沒被風控/交易員點名 → **系統（確定性、非 LLM）強制標記**」。前端要顯眼（如黃色置頂 banner），**不可吞掉**當普通欄位。
- 🚨 **老王 emoji 語意相反**已在 engine 端處理（agent 吃的是**已分類**的 `signal`/`stance`/`reason`，非原始 emoji）→ 前端把 agent 文字**照原樣**渲染，**別自己反向上色**。
- LLM 可能降級：gemini 額度撞牆→claude 備援（看 `_llm.provider`/`switched`）；全失敗→該 agent `llm_failed: true` 中性占位。VM 未裝 gemini → 全 claude（見 phase9 記憶）。前端要**容忍** `llm_failed`／頂層 `errors[]`／`degraded[]`，不破版。
- 不動既有 `web/`、不改壞 `puhui_daily.cjs`、不重接資料源；欄位/型別一律 `snake_case`。

## 3. 後端規格

### 3.1 沿用既有（零改動為原則）
gateway `POST /api/agents/decide` body `{ codes?: string[], date?: string }` → engine `/agents/decide`（`decide_many`）。前端送 `{ codes: [code] }`，取回應 `decisions[0]`（= `decide_one`）。

### 3.2 回應契約（**已從 `orchestrator.py`/`roles.py` 實查**，前端 `api.ts` 照此收緊型別）
```jsonc
{
  "date": "2026-06-24", "count": 1,
  "decisions": [
    {
      "code": "2330", "name": "台積電", "date": "2026-06-24",
      "fact_base": { "blended_score": 62.1, "blended_action": "BUY", "conflict": false /* 量化不可變底座（/signal/blended）；agent 只判讀 */ },
      "analysts": {
        "technical":      { "stance": "bullish", "confidence": 0.7, "summary": "…", "key_points": ["…"], "llm_failed": false,
                            "_llm": { "provider": "gemini", "switched": false, "elapsed_s": 21.3, "est_tokens": 700, "error": null }, "role": "technical_analyst" },
        "news_sentiment": { "stance": "neutral", "confidence": 0.5, "summary": "…", "key_points": ["…"], "_llm": { … }, "role": "news_sentiment_analyst" },
        "puhui":          { "stance": "bullish", "confidence": 0.6, "summary": "…", "key_points": ["…"], "_llm": { … }, "role": "puhui_expert" }
      },
      "debate": [
        { "side": "bull", "stance": "bullish", "confidence": 0.7, "summary": "…", "key_points": ["…"] },
        { "side": "bear", "stance": "bearish", "confidence": 0.6, "summary": "…", "key_points": ["…"] }
      ],
      "trader": { "decision": "BUY", "confidence": 0.65, "rationale": "…", "_llm": { … }, "role": "trader" },
      "risk":   { "final_decision": "HOLD", "confidence": 0.6, "risk_notes": "…", "conflict_acknowledged": true, "_llm": { … }, "role": "risk_manager" },
      "final_decision": "HOLD", "confidence": 0.6,
      "consistency": { "blended_direction": "bull", "agent_direction": "neutral",
                       "blended_conflict_quant_vs_puhui": false, "divergent_from_quant": false,
                       "divergence_flagged": true, "warning": null /* 或字串：背離未點名→系統強制標記 */ },
      "degraded": []
    }
  ],
  "errors": [],
  "usage": { /* 用量匯總：總 tokens / 各 provider 次數 / 耗時等 */ },
  "config": { "analysts": ["technical","news_sentiment","puhui"], "debate_rounds": 1,
              "primary_provider": "gemini", "fallback_provider": "claude" }
}
```
**🚨 注意 analysts 的 key 就是 `technical`（技術＋籌碼合一）/`news_sentiment`/`puhui` 三個——沒有獨立的 `fundamentals`/`company` 分析師**（基本面已有 Phase 4 自有面板）。分段照這三個來，**別照 ROADMAP 舊字面硬湊「公司/基本面」分析師**。

### 3.3（可選，本階段不做）輕量摘要端點
如前述逃生門：留後期評估，本階段不加。

## 4. 希望看到的內容（前端）

在 `StockDetail.tsx` 加「AI 全面審視」區（你拍板 Tab 或獨立大區塊；建議放頁面最下方或獨立 Tab，因為它最重、最貴）。

1. **觸發區**：標題「AI 全面審視（多 agent 決策）」＋大按鈕「啟動 AI 分析」，旁註「將呼叫多 agent LLM（約 2–3 分鐘、7×LLM），結果會快取」。**預設不自動跑**。
2. **長等待 loading 態**：點下去後 spinner ＋**已耗時計秒**＋「分析中…預計 2–3 分鐘，請勿關閉分頁」。**目前無 streaming → 不要造假階段進度條**，誠實顯示 spinner＋elapsed 即可。
3. **結果分段（由上而下，對齊 agent graph）**：
   - **最終決策 banner**：`final_decision`（BUY 紅／SELL 綠／HOLD 灰）＋`confidence`，並對比 `fact_base.blended_action`（量化方向）。**`consistency.warning` 非 null → 醒目黃色 banner 置於最上**。
   - **量化事實底座**：`blended_score`／`blended_action`／`conflict`，標註「不可變、agent 只判讀」。
   - **三分析師卡片**：技術＋籌碼／消息情緒／老王在地專家，各顯 `stance`（色）＋`confidence`＋`summary`＋`key_points[]`；`llm_failed` → 標「LLM 不可用・占位」。
   - **多空辯論**：bull vs bear 雙欄，各 `summary`＋`key_points`。
   - **交易員決策**：`decision`＋`confidence`＋`rationale`。
   - **風控審核**：`final_decision`＋`risk_notes`＋`conflict_acknowledged`。
   - **用量遙測**：`usage` 摘要（provider gemini/claude、總 tokens、耗時）——讓你看到這次花了多少。
4. **快取**：localStorage key 如 `aiReview:{code}:{date}`，存整個 `decision`＋分析時間戳；開頁讀快取直接顯示＋「上次分析：X 分鐘前」＋「重新分析」鈕（再打一次 API）。**不自動過期重跑**。
5. **失敗態**：頂層 `errors[0]` 或 fetch catch → 「AI 分析失敗」＋重試鈕；engine down（503）→ 降級訊息；**不破版**。

## 5. 工作清單
- 前端：「AI 全面審視」section（觸發鈕＋長 loading＋分段渲染＋一致性 warning＋用量遙測）；`api.ts` 收緊既有 `DecideResp`／新增 `AgentDecision` 型別（對齊 §3.2，`snake_case`）；localStorage 快取邏輯。
- 後端：**零改動**（沿用 `/api/agents/decide`）；省 token 摘要端點留後期。
- 契約：`review-web/docs/contracts.md` 補/對齊 `AgentDecision`；可新增 `docs/contracts/AgentDecision.md`。
- 測試：前端用 **mock decide 回應**驗證分段渲染＋warning 呈現＋快取讀寫＋`llm_failed`/`errors` 降級（沿用 Phase 各頁 `?mock=1` 風格）；後端無新測試（沿用階段5 pytest）。

## 6. 驗收標準
- [ ] AI 全面審視只在 `/stock/:code`、**只按鈕觸發**；無 `useEffect` 自動載入、不在首頁/清單/開頁自動跑。
- [ ] body 一律 **`{ codes: [code] }` 單股**；**絕不送 `codes: []`／省略**（不跑整 watchlist）。
- [ ] 分段渲染**對齊實際 agent graph**：`fact_base` → 3 analysts（`technical`/`news_sentiment`/`puhui`）→ `debate` → `trader` → `risk` → `final_decision`＋`consistency`；**不硬湊不存在的 analyst**。
- [ ] 著色 **BUY=紅／SELL=綠／HOLD=灰**、stance **bullish=紅／bearish=綠**（台股慣例）。
- [ ] **`consistency.warning` 非 null 時醒目置頂呈現**（背離量化未被點名→系統強制標記，不可吞）。
- [ ] 長等待 loading **誠實**（spinner＋elapsed，不造假進度）；失敗/503 降級不破版；`llm_failed`/`degraded`/`errors` 容忍。
- [ ] **localStorage 快取**（code+date）＋上次分析時間＋重新分析鈕；不自動重跑。
- [ ] **用量遙測顯示**（provider＋tokens＋耗時）。
- [ ] 前端只打 `/api`、不直連 engine、不重算/不重融合；未動 `web/`、未改壞 `puhui_daily.cjs`；`snake_case`。
- [ ] `tsc -b && vite build` 乾淨。

## 7. 沿用既有坑（帶進 review）
- 🚨 **很貴**：`agents/decide` ~187s、7×LLM/股 → 只按鈕觸發、硬快取、單股、別碰整 watchlist。
- 🚨 **著色反直覺**：BUY/bull=紅、SELL/bear=綠、HOLD=灰（與 OSC/量/籌碼/營收/老王 emoji 同調）。
- 🚨 **一致性守門 warning** 是**確定性系統標記**（非 LLM）：最終決策背離量化方向卻沒被風控/交易員點名才出現 → 必須顯眼，別當普通欄位吞掉。
- 🚨 **老王 emoji 語意相反**已在 engine 處理（agent 吃已分類 `stance`/`signal`/`reason`）→ 前端照原樣渲染 agent 文字、別反向上色。
- **LLM 降級**：gemini 額度→claude 備援（`_llm.provider`/`switched`）；全失敗→`llm_failed` 中性占位；VM 全 claude。前端容忍、別當錯誤。
- **analysts 無 fundamentals/company**（基本面在 Phase 4 面板）；別照 ROADMAP 舊「公司/基本面」字面硬做。
- gateway **agents timeout 已 1200s**；前端 fetch **別自設更短 timeout** 砍掉請求。
- decide **不進回測、live-only**；只判讀、以 `/signal/blended` 為事實底座。
