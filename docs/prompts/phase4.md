# 階段 4：老王訊號整合 + 自動觀察清單

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase4.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、階段 3 的 `/signal`、`/backtest`，
> 再讀本檔「⚠️ 開工前必讀」，**先做 Step 0（確認資料來源）並把結果回報給我**，等我確認後才動手；完成後務必做「完成收尾清單」。

## 你的角色
資深量化工程師。把專案**獨家**的老王內容情報接進量化引擎——這是別人沒有的護城河。
但護城河的「水」放在哪、長什麼樣，先確認清楚再蓋橋（見下方 Step 0）。

---

## ⚠️ 開工前必讀：老王資料的真實現況（2026-06-13 盤點，修正舊版錯誤前提）

舊版本提示詞與 `ROADMAP §0` 把 **`data/puhui_analysis/*.json`** 寫成「已存在的結構化獨家資產」
（含 `market_regime`、`mentioned_stocks[code/name/signal/reason]`、`entry/exit_conditions`、`strategy_insights`）。
**經實際盤點，這個檔案從未被產生、且被 gitignore，repo 與舊專案都沒有。** 不要假設它存在。

真實情況如下，**Step 0 必須先驗證一次再動手**：

| 來源 | 是否存在 | git 追蹤 | 內容 | 可用性 |
|---|---|---|---|---|
| **`reports/**/*.md`** | ✅ 有（repo 內 18 篇，2026-05-14 起） | ✅ 已追蹤 | 每日老王報告原文，**固定模板**（操作水位 / 大盤美股 / 當日主題 / 個股區塊 / 老王提醒 / 風險 callout） | **這是真正的獨家資產，階段4 的解析對象** |
| `data/puhui_cache.json` | ⚠️ 由 `puhui_daily.cjs` 每日覆寫，可能不在 | ❌ gitignored | **淺層 regex 萃取**：`{date, water_level, stocks:[{name, emoji}], market_sentiment{label,score}, sector_rotation[], confidence_level}` | **只當日一筆、會被覆寫**；`stocks` **只有股名＋emoji，沒有代號、沒有 BUY/SELL、沒有 reason** |
| `data/puhui_analysis/*.json` | ❌ **不存在、從未產生** | ❌ gitignored | 舊提示詞幻想的 schema | **禁止假設存在**；階段3 `sentiment.py` 已有讀它的程式碼，因缺檔一律降級 |

### 由此推導的三個關鍵事實（影響整個階段設計）

1. **「老王情報層」的地基不是『載入 JSON』，而是『寫一個確定性的 Markdown 報告解析器』**
   讀 `reports/**/*.md`（模板由 `scripts/puhui_daily.cjs` 的 `buildObsidianPromptSplit` 系統提示詞定義，結構穩定），
   萃取出引擎要的結構化情報：每日 `water_level`、每檔 `{code, name, emoji, signal, 操作建議/reason}`、大盤情緒、風險警示。
   這個解析器**就是**舊提示詞口中那個「不存在的 puhui_analysis JSON」的真正產生者。
   產出可選擇落地成 `data/puhui_analysis/{date}.json`（仍 gitignored，當快取），或純記憶體索引——**Step 0 一併讓我選**。

2. **🚨 最大坑：報告 emoji 色碼語意與股市慣例相反**（這是本階段的「還原股價級」陷阱）
   報告模板的個股色碼是：
   - 🔴（color:red）＝**可持續抱股 / 看多**（不是「跌」！）
   - 🟠（color:#B35A00）＝**觀察、訊號待確認**
   - 🟢（color:green）＝**風險警示 / 看空**（不是「漲」！）
   **若用「紅漲綠跌」直覺映射，每一檔訊號都會被反向。** 解析器與融合規則必須以上述語意為準，並寫測試鎖死。

3. **老王情報是 live / 近期導向，不是回測資產**
   報告史只有近一個多月（18 篇），且情緒/老王在階段3 已定為 **live_only、不進回測**。
   故階段 4 **不新增回測**，產出的是「即時融合訊號 + 當日觀察清單」，與階段3 的可回測核心分流（與 `scoring-model §1.1` 一致）。

### 代號解析（次要但會卡住）
- 主力個股標題含代號：`### <span ...>🔴 股名（代號）</span>`，可直接抓。
- 次要個股常只有股名（例 `### 🟠 緯創`，無代號）→ 需 **name→code 反查**。
  `engine/app/data/finmind_client.py` 已有 `get_stock_name(code)`（code→name，走 TaiwanStockInfo）；
  反查請用**同一份 TaiwanStockInfo 建 name→code 映射**（記憶體快取），查不到該檔則降級標 `code=null` 並 note，不可硬猜。

---

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 3 已有確定性多因子引擎 + 回測（`engine /signal?mode=swing|daytrade`、`POST /backtest`）。
- 本階段**仍無 LLM**（LLM 是階段5）：老王報告本身已是 LLM 產出的結構化內容，階段4 用**確定性解析器**消費它即可。
- 獨家資產（以實況為準，見上表）：**`reports/**/*.md`** 為主、`data/puhui_cache.json` 為輔（可能缺）。
- 輸出型別契約見 `docs/contracts/`：`StockSignal`、`Watchlist`、`DailySnapshot`、`FactorScore`。終局見 `docs/ROADMAP.md`。

## 本階段目標

1. **老王情報層（engine 內，read-only 消費端）**
   - 寫 `engine/app/puhui/`（建議）：Markdown 報告解析器 + 日期/個股索引 + name↔code 解析。
   - 對齊階段 3 `StockSignal`：輸出每日 `water_level`、`market_regime/sentiment`、`mentioned_stocks[{code,name,emoji,signal,reason}]`。
   - 缺日/缺股/缺代號 → **優雅降級**（沿用階段3 原則：降信心、退出加權、note 標註，**不可硬填預設值**）。
   - 取代階段3 `sentiment.py` 裡讀不存在 `puhui_analysis` 的舊路徑：改由本層供應老王子訊號。

2. **融合訊號（量化 × 老王）**
   - 把老王個股訊號與階段3 `swing_score` 融合，輸出帶**衝突標記**的訊號：
     同向 → 提升信心；背離（老王看多 vs 量化偏空，或反之）→ 標記 `conflict` 並降信心，不直接蓋掉量化分。
   - 老王 `water_level` / `market_sentiment` 當**大盤過濾層**，疊加在階段3 regime gate 之上（兩者如何相乘/取小，列入下方決策讓我選）。
   - 融合規則寫進 `docs/blend-rules.md`。

3. **自動觀察清單（核心需求）**
   - 候選自動帶入：老王報告 `mentioned_stocks` ∪ 引擎自選（factor）。
   - 對每檔同時算兩分數並各自排序（依 `docs/contracts/Watchlist.md`）：
     - `swing_score`（波段潛力，階段3 swing 引擎）→ `rank_swing`
     - `daytrade_prob`（短線當沖機率，階段3 daytrade 引擎，吃富果/MIS 盤中）→ `rank_daytrade`
   - 標 `source`（`puhui`/`factor`）、`puhui_signal`、`puhui_reason`、`tags`；標哪些是「當沖候選」哪些是「波段潛力」。
   - 盤後快照無即時盤口 → `daytrade_prob` 可為當日最後值或 `null`（無資料者排末），不可硬填。

4. **engine API**
   - `GET /signal/blended?code=&date=`：量化 + 老王 融合訊號（含 `conflict` 標記與雙方理由）。
   - `GET /watchlist?date=`：自動觀察清單（當沖/波段分開排序，含標籤）。
   - `GET /puhui/view?code=&date=`：純老王觀點查詢（解析結果原樣回，供前端/除錯）。

## 需先給我選的決策（Step 0 之後、動手之前一起提案）

1. **老王資料來源與落地**：(a) 純讀 `reports/**/*.md` 即時解析、(b) 解析後落地 `data/puhui_analysis/{date}.json` 當快取（gitignored）。建議 (b) 兼顧速度與可檢視。
2. **訊號映射表**：emoji（🔴/🟠/🟢，記得語意相反）+ 個股表格「操作建議」關鍵詞（續抱/減碼/停損/出清/突破…）→ `signal ∈ {BUY, ADD, HOLD, WATCH, REDUCE, SELL}` 與分數。給我一張對照表確認。
3. **融合規則**：同向加成幅度、背離的衝突降信心幅度、老王水位×regime gate 的疊加方式（相乘 / 取較嚴 / 加權）。
4. **觀察清單排序公式**：純量化分排序，或「老王偏多」給加權；當沖候選的最低流動性/盤口門檻。
5. **缺資料降級策略**：缺代號 / 缺當日報告 / cache 缺檔 時各自怎麼標、信心怎麼降。

## 限制與原則
- **不要動 `scripts/puhui_daily.cjs`**（它持續產生新報告與 cache，本階段是唯讀消費端）。
- engine 對 Node 既有產物**唯讀**；不寫回 `reports/`、不改 `puhui_cache.json` 的 schema。
- 老王資料可能缺日/缺股/缺代號 → 一律優雅降級，**不硬填預設值**（承階段3 原則）。
- **無 LLM**（LLM 是階段5）：解析器走確定性 regex/模板，可測、不打網路（測試 mock）。
- emoji 色碼語意相反這點，**必須有專測鎖住**（見上方坑 #2）。
- `.env` 已 gitignored，勿提交祕密。

## 驗收標準
- 任選 `reports/` 提到的個股 + 日期，`/signal/blended` 與 `/puhui/view` 能同時看到「量化訊號 / 老王觀點 / 融合訊號 / 是否衝突」。
- `GET /watchlist?date=` 能吐出當日自動觀察清單，當沖候選與波段潛力分開排序。
- 至少一筆「老王看多但量化偏空（或反之）」的衝突案例被正確標記、信心下降。
- emoji 語意相反的專測通過（🔴=看多 / 🟢=看空 不被反向）。
- 融合邏輯有 `docs/blend-rules.md`；pytest 全綠（mock，不打網路）。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 4 標 ✅ + 階段4 完成紀錄；**順手修正 §0 對 `data/puhui_analysis` 的錯誤描述**（改記真實資產為 `reports/**/*.md` + cache 現況）。
2. 更新 `docs/scoring-model.md` §1.1 sentiment 老王來源描述（對齊真實解析來源）。
3. 更新 Obsidian：`C:\obsidian\儲存庫\財經APP開發\階段4-完成紀錄.md` + `開發進度.md`。
4. 更新記憶 + `MEMORY.md`（記下「老王 JSON 從未存在、真實來源是 reports/*.md」「emoji 語意相反」兩個關鍵事實）。
5. 程式放 `engine/`，規則文件放 `docs/`。
6. **git commit & push**（`phase4: 老王整合與觀察清單`）：commit 後直接 push。

## 開始方式
**Step 0（先做、回報給我）**：實跑驗證上方「老王資料現況」——
列出 `reports/**/*.md` 實際篇數與最新日期、`data/puhui_cache.json` 是否存在及其真實欄位、確認 `data/puhui_analysis` 不存在，
並挑 1–2 篇報告示範你的解析器能抓到哪些 `{code,name,emoji,signal,操作建議}`。
接著提出「需先給我選的決策」5 項方案 + 融合規則 + 觀察清單排序方案讓我選，**等我確認後再動手**。
