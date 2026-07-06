# 優化專案 17 — 量化訊號整合（tw-stock-quant → review-web）

> 互動模式：本案**跨兩個 repo**——`tw-stock-quant`（Python/workflow）端由 Claude 直接實作（沿 N5 模式，已有 push 授權）；`review-web` 前端照全案慣例「Claude 給規格＋review、你寫 code」，開工時說「全部你來」也可以。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt17-quant-signals.md`，然後根據裡面的說明進行」。
> 設計日：2026-07-06（N5 升格當天由 Claude 設計）。

## 0. 前置條件（開工前必查，不滿足就停）

1. **時間 ≥ 2026-07-16**：N5 回滾條款（升格後 7 個交易日內實倉大虧 → `git revert f36664d`）觀察期結束後才動工。
2. 確認 N5 未被回滾：`git -C "C:\財經APP" log --oneline -10` 中 `f36664d` 仍在且沒有對它的 revert commit。**若已回滾，本案規格中的 strategy 欄位（雙濾網/MA10）要改回當時實況，先跟使用者確認再繼續。**
3. 確認 `scan_today()` 回傳契約未變（`C:\財經APP\scanner.py` docstring：`signals/market_bull/regime_date/data_status/skip_reason`）。變了就以現況為準調整 §2 schema。

## 1. 一句話

讓 tw-stock-quant（`C:\財經APP`，private repo）每日 15:30 收盤掃描的量化訊號，多輸出一份 JSON 推進 Stock_recommendations（public repo），由 review-web 展示——**兩專案保持獨立部署與回滾能力，只做資料融合，不合併 repo**。

```
tw-stock-quant daily_scan (GitHub Actions, 15:30 TST)
        │ scan_today() → export JSON → push 到 Stock_recommendations
        ▼
Stock_recommendations  reports/quant_signals/<date>.json   （git 追蹤，天然留歷史）
        │ gateway 讀本地檔；當日檔未 pull 到 → raw.githubusercontent 免 token 撈（public repo）
        ▼
review-web  Dashboard「量化訊號」卡 ＋ StockDetail 命中 badge
```

## 2. 資料契約（snake_case，ROADMAP §1 定案）

檔案：`reports/quant_signals/<YYYY-MM-DD>.json`（Asia/Taipei 交易日）。

```json
{
  "schema_version": 1,
  "generated_at": "2026-07-16T15:35:12+08:00",
  "source_repo": "bigshop127/tw-stock-quant",
  "source_commit": "abc1234",
  "trade_date": "2026-07-16",
  "strategy": {
    "name": "production-n5",
    "regime_filter": "^TWII AND ^TWOII > MA60",
    "stop_ref": "MA10"
  },
  "regime": {
    "market_bull": true,
    "regime_date": "2026-07-16",
    "data_status": "ok",
    "skip_reason": null
  },
  "signals": [
    { "symbol": "1314", "close": 10.40, "stop": 8.60,
      "risk_pct": 17.3, "rsi14": 62.1, "vol_ratio": 2.4 }
  ]
}
```

規則（口徑鎖死，web 端不得自行詮釋）：

- `data_status` ∈ `ok | index_fetch_failed | index_insufficient_history | stock_fetch_failed`。**非 `ok` 一律照常輸出檔案**（`signals: []`＋`skip_reason` 填原因），讓網頁顯示「資料失敗」而不是沉默或殘留昨日資料。
- **M2 誠實原則：資料失敗 ≠ 空頭 ≠ 零訊號**，三者是三種畫面（見 §5）。
- `risk_pct` 存**正值**（scanner 內 `(close-stop)/close*100`），顯示時前端自己加「−」號——別在管線裡改號造成雙重負號。
- `signals[].df` 是 DataFrame，**匯出時剔除**，只留可序列化欄位。
- 空頭日（`data_status=ok` 且 `market_bull=false`）也輸出檔案，`signals: []`。

## 3. 分段工

### 3a. tw-stock-quant 端（Claude 實作）

1. 新增純函式 `export_signals_json(res: dict, source_commit: str) -> dict`（建議放 `notifier.py` 旁的新檔或 `run_daily.py` 內，不碰 `scanner.py` 核心）＋ pytest ≥3 條：ok 有訊號／ok 零訊號（含空頭）／`data_status != ok`。
2. `run_daily.py` 掃描後（Telegram 圖卡流程**之後**，互不阻塞：JSON 匯出失敗不能害圖卡沒發，反之亦然）寫出 JSON 到 workspace。
3. `daily_scan.yml` 加一段 step：用 secret `QUANT_SIGNALS_PUSH_TOKEN` shallow-clone `bigshop127/Stock_recommendations`，寫入 `reports/quant_signals/<date>.json`，commit 訊息 `quant-signals: <date> [skip ci]`，push；**被拒就 `git pull --rebase` 重試（≤2 次）**——15:35 理論上不會撞 VM 13:05/14:00 的 push，但雙生報告日撞車有前例。
4. **PAT 由使用者自建**（憑證慣例）：fine-grained token、只授 `Stock_recommendations` 一個 repo、只給 Contents read/write，存進 tw-stock-quant Actions secrets。開工時給使用者一步一步的建立指引。

### 3b. gateway 端（Stock_recommendations，Node）

新端點 `GET /api/quant/signals`（新檔 `routes/quant.js` 或併入 `routes/market.js`）：

1. 解析今日（Asia/Taipei）→ 優先讀本地 `reports/quant_signals/<today>.json`（VM 每日 14:00 refresh.sh 的 `git pull` 隔日就會帶到本地，設計內延遲）。
2. 本地沒有當日檔 → fetch `https://raw.githubusercontent.com/bigshop127/Stock_recommendations/master/reports/quant_signals/<today>.json`（public repo 免 token），**記憶體快取 TTL 600s**，成功不落地寫檔（避免與 git pull 衝突）。
3. 當日檔遠端也還沒有（15:35 前、假日）→ 往回找最近 ≤5 天的本地檔，回傳時加 `"stale": true` 與該檔 `trade_date`；全都沒有 → `200 { "available": false }`（不要 404、不要假資料）。
4. `docs/contracts.md` 同步新端點契約（opt6 review 的教訓）。

### 3c. review-web 前端

1. **Dashboard 新卡**「量化訊號」（用 `components/OverviewCard.tsx` 殼）：
   - 頂部大盤 chip 三態：多頭確認 ✅（紅字，台股慣例）／空頭警示 ❌（綠字）／**資料無法判斷 ⚠️（灰態，明寫「指數抓取失敗，非空頭」）**。
   - 訊號表：代號（點列跳 `/stock/:code`）／收盤／停損 MA10／風險%（顯示 `−17.3%`）／RSI14／量比。零訊號且 ok →「今日無新訊號」。
   - footer：`trade_date`＋來源 `source_commit` 短碼＋「策略：^TWII∧^TWOII>MA60 雙濾網」；`stale: true` 時標「⚠ 顯示 <date> 快照」。
   - 固定小字「個人量化系統輸出，非投資建議」。
2. **StockDetail 命中 badge**：本股 symbol 在今日 `signals` 內 → 頭部顯示「⚡ 今日量化訊號命中｜停損 MA10=8.60」；未命中**不顯示**（MVP 不做灰 chip）。
3. 型別：`lib` 加 `QuantSignalsResponse`，欄位可 null 安全（沿 Phase 6 review 教訓）。
4. 手機單欄順序：量化訊號卡排在「盤面分析」之後、指數卡之前（訊號是行動項，優先級高）。

**本案不做（backlog）**：個股頁歷史命中日曆（近 30 日）、訊號回測績效對照、Intraday 風險警訊整合——等 MVP 跑順再開 opt。

## 4. 驗收標準

- [ ] tw-stock-quant：pytest 全綠（現有 29＋新增）；`gh workflow run daily_scan.yml` 手動觸發後，Stock_recommendations master 出現當日 JSON、schema 對 §2、`[skip ci]` 沒觸發連鎖 workflow。
- [ ] gateway：curl 驗三態（有當日檔／遠端 fallback／`available:false`）；欄位全 snake_case；`contracts.md` 已同步。
- [ ] 前端：`tsc -b && vite build` 乾淨；三態畫面（有訊號／零訊號 ok／資料失敗灰態）用假資料各截圖驗過。
- [ ] VM 部署：`git pull`＋build＋gateway 重啟，`ssh -L` 驗收端點與頁面；手機 PWA 看得到新卡。
- [ ] **隔日全自動鏈路**：15:35 workflow push JSON → 15:40 前網頁可見當日訊號，且與 Telegram 圖卡內容一致（同源 `scan_today()`，理應一字不差）。

## 5. 避坑（血淚整理，開工先讀完）

- **VM 的 `0 13` 老王 cron 行不要碰**。本設計刻意做成**零 cron 變更**（gateway lazy fetch），不需要動 crontab。
- `engine/.env` 是 untracked，別動；本案 VM 端**不需要新增任何憑證**（public raw 免 token）。
- `deploy/refresh.sh`／`puhui_daily.cjs`／`sync_puhui_to_obsidian.ps1` 已改走「目前分支」（9283888），本案**不需要改 refresh.sh**——別手癢。
- **隱私**：Stock_recommendations 是 public repo，量化訊號會公開（現況 `reports/signals/` 快照本來就公開）。若使用者介意，改方案 B：JSON 留在 private 的 tw-stock-quant，gateway 用 read-only PAT 撈——開工時提一句讓使用者選。
- 同日雙生報告（VM 13:00＋本機備援）push 被拒是**設計內非致命**；workflow push 加 rebase 重試即可，別去「修」雙生機制。
- 前端**只打 gateway `/api`**，不直連 raw.githubusercontent（CORS＋架構鐵律）。
- 本機 `C:\財經APP\cache_market.parquet` 是舊快取（gitignored），本機測試 regime_date 過時屬正常，雲端每次 fresh fetch。
- VM 上跑破壞性 git 指令前先請使用者授權（一般 pull/push 已授權）。

## 6. 收尾

完成後照全案慣例：更新本檔狀態＋ROADMAP §8 表格 → 同步 Obsidian（`個股全面審視網` vault＋財經APP `開發進度.md` 各補一段）→ `.claude` 記憶（`stock-review-web-project.md`＋`twstockquant-project.md` 各加一行）→ commit & push 兩個 repo。
