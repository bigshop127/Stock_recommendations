# 老王 × 量化 融合規則（階段 4）

> 定案 2026-06-14（階段4，使用者拍板決策1–5）。實作見 `engine/app/puhui/`；
> 權重/門檻集中在 `engine/app/factors/config.py` 的 `PuhuiConfig`（不寫死、可調）。
> 全局見 `ROADMAP.md`、`scoring-model.md`；型別見 `contracts/`。

---

## 0. 資料現況（修正舊前提，Step 0 實查 2026-06-14）

- 舊提示詞與 `ROADMAP §0` 寫的 **`data/puhui_analysis/*.json` 從未存在、且 gitignored**。
- 真實獨家資產 = **git 追蹤的 `reports/**/*.md`**（18 篇起，固定模板）。
- `data/puhui_cache.json` 由 `puhui_daily.cjs` 每日覆寫、gitignored，可能不在；**本階段不依賴它**。
- 本層是「舊提示詞口中那個不存在 JSON 的真正產生者」：確定性 MD 解析器（無 LLM）。

### 🚨 最大坑：emoji 色碼語意與股市慣例「相反」
報告模板個股色碼（`scripts/puhui_daily.cjs` 系統提示詞定義）：

| emoji | color | **語意** |
|---|---|---|
| 🔴 | red | **可持續抱股 / 看多** |
| 🟠 | #B35A00 | 觀察、訊號待確認 |
| 🟢 | green | **風險警示 / 看空** |

用「紅漲綠跌」直覺會把每一檔反向。映射以上表為準，有專測 `test_emoji_semantics_are_inverted...` 鎖死。

### 兩種模板（Step 0 新發現）
- **rich**（2026-05-19 起，16 篇）：`### <span style="color:..">🔴 股名（代號）</span>` + 2 欄表格。
- **legacy**（2026-05-14/15，2 篇）：單表格 `| 代號 | 名稱 | 關鍵訊號 | 操作建議 |`，無 emoji、含佔位假資料 → 信心 ×0.5。

---

## 1. 訊號映射表（決策2）

`emoji`（定分數帶）+ 個股表「操作建議」關鍵詞（挑 action）→ `signal` 與 0~100 分（即 `sentiment.puhui` 子訊號）。

| signal | score | 觸發 |
|---|---|---|
| `BUY` | 88 | 🔴 + 買進/進場/順勢翻多/突破 |
| `ADD` | 78 | 🔴 + 續抱/加碼/可抱 |
| `HOLD` | 65 | 🔴 無明確動作 |
| `WATCH` | 50（🟢 偏空觀望 → 40） | 🟠 觀察/等…再買；🟢「等站上均線再買」 |
| `REDUCE` | 32 | 🟢/🟠 + 減碼/調節/汰弱 |
| `SELL` | 18 | 🟢 + 出清/賣出/一律先賣 |

**關鍵規則**：看多建議內的**條件式停損**（「跌破均線即停損出場」）是風險提示，**不判 SELL**；
買訊優先於停損字樣（`classify_signal` 在 🔴 帶先判 `has_buy`）。專測 `test_conditional_stoploss_inside_buy_is_not_sell` 鎖死。
舊版（無 emoji）純靠關鍵詞、信心折半。

---

## 2. 融合規則（決策3）

老王個股訊號**已透過** `sentiment.puhui` 子訊號（0.20×0.5＝core 的 0.10）進入 `swing_score`。
本層**不再重加**老王分數（避免雙重計分），只做三件事：

### 2.1 同向加成 / 背離標記
- 方向判定（門檻見 `PuhuiConfig`）：
  - 量化：`swing_score ≥ 55` 多、`≤ 45` 空、否則中性。
  - 老王：`score ≥ 60` 多、`≤ 40` 空、否則中性。
- **同向**（aligned）：信心 `+0.08`。
- **背離**（divergent，一多一空）：`conflict=true`、信心 `−0.18`（下限 0.1），**不蓋掉量化分**。
- 任一中性 → `neutral`，不調整。

### 2.2 water_level 大盤過濾 × regime gate（**取較嚴 min**）
- 老王持股水位 `water_level`（0~1）→ `water_gate = clamp(0.50 + 0.70·water, 0.6, 1.05)`。
- 與階段3 `regime_gate` **取較嚴**：`final_gate = min(regime_gate, water_gate)`（避免相乘雙重重罰）。
- 重算：`core = swing_score / regime_gate`；`blended_score = clamp(core · final_gate, 0, 100)`。
- `water_level` 缺 → `water_gate=None`，不過濾（沿用 regime_gate）。

範例：量化偏空 40、regime 1.0、老王水位五成（water_gate 0.85）→ final 0.85 → blended 34（仍偏空，老王看多**不會**把它翻成多）。

---

## 3. 觀察清單排序（決策4）

候選 = 老王 `mentioned_stocks`（反查代號後的台股）∪ 引擎自選 factor 宇宙。對每檔同時算兩分數、**各自排序**：
- `rank_swing`：依 `swing_score` 由高到低。
- `rank_daytrade`：依 `daytrade_prob` 由高到低；**盤後無盤口 → null，一律排末**。

**純量化分排序**；老王只當 `source=["puhui"]`、`tags`（如 `老王🔴BUY`）、`puhui_signal/puhui_reason`，
**不加權、不污染排名**（與 §2「不雙重計分」一致）。當沖候選需過流動性閘門（近20日均量 ≥ `watchlist_min_lots` 張）。

---

## 4. 缺資料降級（決策5，承階段3「降信心不硬填」）

| 情境 | 處理 |
|---|---|
| **缺代號**（美股/反查失敗） | `code=null` + note，排除量化、只進 `/puhui/view`；**不硬猜** |
| **缺當日報告**（例 6/15–6/18 老王請假） | 沿用最近前一篇（≤ `fallback_max_days`＝7 calendar ≈ 5 交易日），標 `stale`、信心 ×0.85；超視窗 → 老王層退出、重正規化 |
| **cache 缺檔** | 直接 re-parse `reports/*.md`（cache 只加速、報告才是真相） |
| **舊版模板** | 盡力解析、信心 ×0.5、標 `legacy_template` |
| **老王整層不可得** | `sentiment.puhui` 退出加權、對 news 重正規化、降信心（沿用階段3 §0.5） |

---

## 5. API

| 端點 | 說明 |
|---|---|
| `GET /signal/blended?code=&date=` | 量化 + 老王 融合訊號（含 `conflict`、`agreement`、`puhui` 區塊與雙方理由、`blend` gate 明細） |
| `GET /watchlist?date=` | 自動觀察清單（波段潛力 / 當沖候選各自排序、含 tag） |
| `GET /puhui/view?code=&date=` | 純老王觀點（解析結果原樣回；省略 code = 當日全部個股） |

落地快取：`data/puhui_analysis/{date}.json`（決策1b，gitignored；報告比快取新則失效重解）。
本層對 Node 既有產物**唯讀**：不寫 `reports/`、不碰 `puhui_cache.json`、不動 `puhui_daily.cjs`。
