# 優化專案 14b — 股權分散資料源改走 TDCC 免費開放資料＋修級距歸併 bug

> **這份取代 opt14 §2–§3 的「資料源」與「後端」部分。** 前端（opt14 §4）大致不動，只補「歷史累積中」的短資料處理。
> 起因：opt14 假設 FinMind 可抓 `TaiwanStockHoldingSharesPer`，但**實測全 7 顆 token 皆 register 級，此資料集被 FinMind 鎖在付費牆**（HTTP 400 `Your level is register`）。故 opt14 版在 production 只會 fallback 到 `generate_mock_dispersion`（捏造數字），且歸併把 level 16/17 誤併進大戶。本案改用**免費官方源 TDCC**並修 bug。
> 互動模式沿用：Claude 給規格＋驗收，**你寫 code**，寫完 Claude review＋部署。

---

## 0. 已查證的事實（給你背景，不用重查）

- FinMind `TaiwanStockHoldingSharesPer` → 付費級，本案 token 打不到。**放棄 FinMind 這條。**
- TDCC 免費開放資料可打（實測 HTTP 200，2.3 MB）：
  `https://opendata.tdcc.com.tw/getOD.ashx?id=1-5`
  CSV 首列：`資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%`
  - **只有「最新一週」全市場快照**（單一 `資料日期`）。TDCC 不提供歷史批次 → **趨勢要靠我們每週存快照累積**（已與使用者確認接受此限制：上線初期折線點數少，逐週長出來）。
  - `證券代號` 欄有尾隨空白，要 strip。
- 3450 真實級距實測（`資料日期=20260703`），**證實級距是 1–17，不是 1–15**：

  | 持股分級 | 意義 | 3450 人數 | 佔比% |
  |---|---|---|---|
  | 1–8 | 1 股 ～ 50,000 股（≤50 張） | ... | ... |
  | 9,10,11 | 50,001 ～ 400,000 股（50–400 張） | ... | ... |
  | 12,13,14,15 | >400,000 股（>400 張，含 15=1,000,001以上） | 大戶 49 人 | 47.6% |
  | **16** | **差異數調整** | 0 | 0 |
  | **17** | **合計（全部股東 total）** | **71,241** | **100.00** |

  → opt14 版 `_classify_dispersion_level` 的 `else → large` 把 **16、17 都併進大戶**，3450 大戶會變 `49+0+71241=71290` 人、佔比 `47.6%+100%=147.6%`。**必修。**

---

## 1. 後端改動

### 1-1. 新增 `engine/app/data/tdcc_client.py`

仿 `twse_openapi_client.py` 的結構（日快取＋降級路徑）：

- 常數 `TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"`。
- `fetch_latest_snapshot() -> pd.DataFrame`：抓 CSV，解析成欄位
  `["date", "code", "HoldingSharesLevel", "people", "shares", "percent"]`：
  - `date`：`20260703` → `2026-07-03`。
  - `code`：strip 尾隨空白。
  - `HoldingSharesLevel`：int。
  - `people` / `shares`：int（去逗號）。`percent`：float。
  - 解析失敗回空 DataFrame（別讓整條 pipeline 掛）。
- **快照落地**（累積歷史）：存到既有 parquet 快取目錄（已 gitignored）
  `settings.cache_path / "tdcc_shareholding" / f"{date}.parquet"`（**全市場整週一檔**，約 2 MB/週）。
  - `save_snapshot() -> str | None`：抓最新快照 → 取其 `date` → 若 `{date}.parquet` 已存在則**跳過**（冪等）→ 否則寫檔，回傳 date。
- `load_history(code, weeks=16) -> list[dict]`：
  - 列出 `tdcc_shareholding/*.parquet`，取**日期最新的 N 檔**，各讀出、filter `code`，串成 rows。
  - 回傳 rows 的欄位鍵沿用 `aggregate_dispersion` 已認得的 `date / HoldingSharesLevel / people / percent`（**這樣 `aggregate_dispersion` 不用改介面，直接復用**）。

### 1-2. 修 `service.py` 的級距歸併（**核心 bug fix**）

`_classify_dispersion_level`：把「其餘都算大戶」改成**只認 1–15，16/17 排除**：

```python
def _classify_dispersion_level(level_raw):
    try:
        lvl = int(level_raw)
    except (ValueError, TypeError):
        return None          # 認不得就丟掉，別亂塞
    if lvl <= 8:   return "retail"   # 1–8   ≤50,000 股 (≤50 張)
    if lvl <= 11:  return "mid"      # 9–11  50,001–400,000 股 (50–400 張)
    if lvl <= 15:  return "large"    # 12–15 >400,000 股 (>400 張)
    return None                       # 16 差異數調整 / 17 合計 → 排除
```

`aggregate_dispersion` 迴圈內：`cat = _classify_dispersion_level(...)`; **`if cat is None: continue`**（跳過，不計入任何組、不污染佔比）。
> 保留原本 string 級距的容錯分支也可以，但 TDCC 走 int，主路徑是上面這段；string 分支若留著，記得「合計/差異數」字樣也要回 None。

### 1-3. 改 `service.get_shareholding_dispersion(code, weeks=16)` 走 TDCC

- 先 `tdcc_client.save_snapshot()`（惰性補當週快照；冪等，已存在就秒回）。
- `rows = tdcc_client.load_history(code, weeks)` → `aggregate_dispersion(rows)` → 取最後 `weeks` 週。
- `source` 改成 `"TDCC 集保戶股權分散表 (id=1-5)"`。
- `name` 沿用 `finmind_client.get_stock_name(code)`（名稱查詢 FinMind 免費級可用，不受影響）。
- **刪除 `generate_mock_dispersion`，不再回捏造資料。** 查無資料時回：
  ```json
  { "code": "...", "name": "...", "levels": {...}, "weekly": [], "source": "TDCC 集保戶股權分散表 (id=1-5)", "as_of": "..." }
  ```
  （`weekly: []` 讓前端走空態；別假裝有資料。）

### 1-4. 每週快照排程（VM）

TDCC 每週更新一次（資料日期落在週五），**必須每週抓一次否則該週永久遺失**。最省作法：
- 把 `tdcc_client.save_snapshot()` 掛進 VM **既有的浦惠每日 pipeline**（每天跑、冪等，有新週才寫）——不用另開 cron。
- 或獨立小腳本 `engine/scripts/snapshot_tdcc.py` + 一條每日 cron。**你選一個**，在計畫回報時告訴我掛在哪，我部署時確認排程有生效。

---

## 2. 契約與測試改動

- `docs/contracts/ShareholdingDispersion.md` 與 `contracts.md §2.15`：
  - `source` 標籤改 `TDCC 集保戶股權分散表 (id=1-5)`。
  - 加註「歷史逐週累積，上線初期 `weekly` 週數可能 < 16；查無資料回空陣列」。
- `engine/tests/test_shareholding.py`：**mock rows 補上 level 16、17**，斷言：
  - `large.people` **不含** level 17 的合計人數（例：加了 `{level:17, people:71241}` 後，large 仍是 12–15 的加總，不是暴增）。
  - `large.shares_pct` 不含 level 17 的 100%（不會 >100）。
  - level 16（差異數）同樣被排除。
  - 這條是本案回歸測試的重點，務必涵蓋。
- `aggregate_dispersion` 純函式測試維持（它介面沒變）。
- `get_shareholding_dispersion` / endpoint 測試：本機無歷史 parquet 時會回 `weekly: []`（或即時抓當週 1 檔）。斷言放寬成「200 且結構正確、`weekly` 為 list」即可，別再斷言固定週數。

---

## 3. 前端改動（在 opt14 已寫好的 UI 上補強）

opt14 §4 的 UI 大致不動，只補「資料稀少 / 空」的處理：

- **折線圖**：`weekly.length === 0` → 顯示空態卡「集保股權分散資料累積中，每週更新」。`length === 1` → 不畫線只畫點（或顯示單週長條），加小字「趨勢資料累積中」。避免只有 1 點時 SVG path 崩掉。
- **明細表**：`weekly` 空 → 空態；有幾週就列幾週。
- 「三大法人」「融資融券」兩子頁維持 opt14 的 `<ChipsCharts only=...>` 拆分，**與本案無關、照常上**（資料走現有 `/chips`，實測可用）。
- source 標籤若前端有顯示，改成 TDCC。

---

## 4. 驗收標準

1. `tsc -b && vite build` 乾淨；`pytest` 綠，且**新增的 level 16/17 排除測試通過**（large 不被合計污染）。
2. 部署後 `/api/stocks/3450/shareholding`：
   - `source` = TDCC；`weekly` 至少有當週 1 筆（惰性 `save_snapshot` 生效）。
   - 當週 large（大戶）人數量級 = **個位～數十**（3450 應 ~49），佔比 <100%、三組佔比合計 ≈100%（±調整）。**若大戶出現上萬人 = 16/17 沒排除，退回。**
3. TDCC 快照有落地到 `engine/data_cache/tdcc_shareholding/`，每週排程已掛（回報掛在哪）。
4. 查無股權分散（新股/純 ETF）→ 該子頁空態，不影響三大法人/融資融券兩子頁。
5. **沒有任何捏造資料路徑**（`generate_mock_dispersion` 已移除）。

---

## 5. 不做

- 歷史回補（backfill 過去數月股權分散）：TDCC 免費源無歷史批次，**不做**，逐週長。
- 主力分點、融券回補天數：維持 opt14 backlog。
