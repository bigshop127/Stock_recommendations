# 優化專案 24 — 期貨風險告警（Email）＋ 每日權益數曲線

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt24-futures-alert-equity-curve.md`，然後根據裡面的說明進行」。
> **相依**：opt23（期貨損益總覽）已完工上線；本案的後端兩塊 **Claude 已備妥並實測過**（見 §2），你要寫的是 **Part B 前端圖表** 與 **Part C VM 排程**。
> **範圍**：🟡 新增一支排程腳本（已備妥）＋一個 gateway 唯讀端點（已備妥）＋前端一張卡＋VM cron 一行。**不動 engine、不動 rebalance_alert.cjs、不動 puhui_daily.cjs**。

---

## 0. 為什麼要做這個（別把它當一般的 nice-to-have）

再平衡晚一天處理沒事，**期貨晚一天可能已經被斷頭**。目前期貨頁的風險指標只有「你自己打開網頁」才看得到，而斷頭是盤中發生的事。

同時，期貨頁現在只有「當下」的快照，沒有任何歷史——你看不出權益數是一路往下還是剛回穩，也算不出自己的最大回撤。現股那邊有崩盤實驗室可以回測，期貨這邊連自己走過什麼都沒有紀錄。

這兩件事共用同一份計算與同一次排程，所以合成一案。

---

## 1. 整體設計：一支腳本、兩個產出

```
VM cron 15:05（週一~五，排在 rebalance_alert.cjs 的 15:00 之後）
  └─ scripts/futures_alert.cjs
       ├─ 讀 data/futures_positions.json（＝期貨頁「存到雲端」寫的那份）
       ├─ 打 gateway /api/futures/quote 取當日行情（逐月份）
       ├─ 打 gateway /api/market/holidays 取休市日曆
       ├─ 算風險指標／追繳價／斷頭價／轉倉狀態
       ├─ 產出 1：狀態變化時寄 Email（去重）
       └─ 產出 2：寫 data/futures_equity_history.json（一天一列，冪等）
                    └─ gateway GET /api/futures/equity-history（唯讀）
                          └─ 前端「權益數走勢」卡  ← Part B，你要寫的
```

---

## 2. Claude 已備妥的部分（**勿重寫**，只需理解與驗收）

### 2.1 `scripts/futures_alert.cjs`

比照 `scripts/rebalance_alert.cjs` 的設計寫的：只用 Node 內建模組、零新依賴、完全獨立不 require 既有腳本、沿用同一組 Google OAuth env 與 Gmail API 手法。

**告警等級**（`status`）：

| 等級 | 條件 | 意義 |
|---|---|---|
| `ok` | 風險指標 ≥ 150% | 安全 |
| `warn` | < 150% | **自訂預警線，非期交所規定**。還有時間決定補錢或減碼。可用 env `FUTURES_WARN_RATIO` 調整 |
| `call` | < 100% | 期交所定義的追繳線（權益數低於維持保證金） |
| `danger` | < 25% | 盤中會被強制平倉 |

**去重**：等級變化才寄（`data/futures_alert_state.json`）。轉倉提醒另記 `month:due/expired` 的 key，同一個月份從「快到期」變「已過期」會再寄一次。

**計算**是 `review-web/src/lib/futures.ts` 的忠實移植，**逐月份取價**、追繳／斷頭價解的是「各月份一起平移多少」。

**已實測**（本機 dry-run，真實期交所行情）：

```
風險指標=67% 狀態=call 權益=NT$114,610 參考價=96.80@2026-07-28 追繳=98.81 斷頭=94.23
```

手算核對過（20 口 @99.5 + 8 口 @101，兩個月份不同價）：
- 未實現 −85,390 → 權益 200,000 − 85,390 = 114,610 ✓
- 維持保證金 28 × 6,100 = 170,800 → 114,610 / 170,800 = 67% ✓
- 追繳平移 = (170,800 − 114,610) / (1000 × (28 − 0.00002×28)) = +2.0068 → 96.80 + 2.01 = 98.81 ✓

**測試用途的環境變數**：`FUTURES_POSITIONS_PATH` 可指到別的檔案，避免測試時動到 production 那份（前端會從它載入）。

### 2.2 `GET /api/futures/equity-history`（`routes/futures.js`）

唯讀端點。回傳：

```jsonc
{
  "exists": true,          // 檔案不存在時 false + rows: []，不是 404
  "updated_at": "2026-07-29T...",
  "rows": [
    {
      "date": "2026-07-29",       // 報價日（不是執行日）
      "equity": 114610,
      "cash": 200000,
      "unrealized": -85390,
      "contract_value": 2714400,
      "net_lots": 28,
      "total_lots": 28,
      "risk_indicator": 0.6710,   // 無部位時 null
      "price": 96.80,             // 參考月份的價格
      "status": "call"
    }
  ]
}
```

寫入端只有排程腳本；網頁改設定不會動到歷史。同一天重跑會覆蓋（以 `date` 為 key），**只有拿到當日真行情才寫**——抓不到行情時用存價續算告警，但不寫快照，免得把舊價寫成新的一天。

`api.ts` 的 client 方法**還沒加**，那是你的工作（§3.1）。

---

## 3. Part B — 前端「權益數走勢」卡（你要寫的）

### 3.1 API client（`review-web/src/lib/api.ts`）

比照既有 `getFuturesQuote` 的寫法加一個：

```ts
getFuturesEquityHistory: () => req<FuturesEquityHistoryResp>('/futures/equity-history'),
```

型別 `FuturesEquityHistoryResp` / `FuturesEquityRow` 照 §2.2 的形狀定義。`risk_indicator` 要是 `number | null`。

### 3.2 純函式（`review-web/src/lib/futures.ts` 新增，配 vitest）

**不要在元件裡算這些**，全案慣例是算術一律進純函式。

```ts
export interface EquityPoint {
  date: string;
  equity: number;
  peak: number;          // 到當日為止的權益數高點
  drawdown: number;      // (equity − peak) / peak，≤ 0；peak ≤ 0 時為 0
  risk_indicator: number | null;
}

export interface EquityStats {
  points: EquityPoint[];
  first: EquityPoint | null;
  last: EquityPoint | null;
  total_return: number | null;   // (last.equity − first.equity) / first.equity；first ≤ 0 → null
  max_drawdown: number;          // 最深的 drawdown（負值；無資料 → 0）
  max_drawdown_date: string;     // 最深那天
  days: number;                  // 資料筆數
}

/** 從快照列算出權益曲線與回撤。rows 需已依日期升冪；函式內仍要自己排一次防呆。 */
export function equityStats(rows: FuturesEquityRow[], range?: { from?: string; to?: string }): EquityStats;
```

**注意事項**：
- `peak` 是**歷史高點**（running max），不是全期最大值——回撤要逐日對到當時的高點，用全期最大值算會把早期的回撤算成 0。
- 權益數**可以是負的**（穿價）。`peak ≤ 0` 時 `drawdown` 直接給 0，不要除以負數或 0。
- `total_return` 的分母是 `first.equity`；`first.equity ≤ 0` 回 `null`，不要生出荒謬的百分比。
- 入金／出金會讓權益數跳動，這條曲線**不是報酬率曲線**——這點要寫在卡片的說明文字裡（見 §3.4）。

### 3.3 圖表（`pages/FuturesPnl.tsx`，放在「損益總覽」分頁）

**用 inline SVG 手刻，不要引入 lightweight-charts**。理由：`FuturesPnl` chunk 已經 93KB，而 `vendor-charts` 是另一個 149KB 的 chunk，為了兩條線把它拉進來不划算；這頁的圖也不需要縮放/十字線那套完整互動。

版面：**上下兩張圖共用同一條 x 軸**（權益數在上、回撤在下）。

> ⚠️ **絕對不要做成雙 y 軸**（權益數和回撤各一個刻度疊在同一張圖）。那是最常見的圖表錯誤，兩條線的交叉點沒有任何意義。兩個量綱不同就分成兩張圖。

規格：
- 權益數：面積＋線。線寬 2px，顏色用 `primary`（`#3b82f6`）。面積用同色 8~15% 透明度。
- 回撤：面積，顏色用**風險語意色**而不是台股紅綠——與這頁既有的追繳／斷頭配色一致（amber `#f59e0b` → rose `#f43f5e`）。回撤是風險量值不是損益數字。
- 格線／軸線要**退到背景**（`border` 色 `#27272a`），不要跟資料線搶。
- **不要在每個點上標數字**。只直接標「最新值」與「最大回撤那一點」兩個。
- 單一序列**不需要圖例**——標題已經講明是什麼。
- hover：一條垂直十字線 ＋ tooltip（日期／權益數／回撤／風險指標）。滑鼠命中區要比線本身寬（整條垂直帶都可觸發）。
- 期間篩選放在圖**上方一列**：`近 1 個月 / 近 3 個月 / 近 1 年 / 全部`，預設「全部」。

上方擺三個數字（hero row，不是圖的一部分）：
| 最新權益數 | 期間報酬 | 最大回撤 |
|---|---|---|
| `money(last.equity)` | `pct(total_return)`，紅漲綠跌（台股慣例，與本頁一致） | `pct(max_drawdown)`＋日期 |

### 3.4 空態與說明文字

- `exists === false` 或 `rows.length === 0`：顯示「**還沒有歷史資料。快照由 VM 每日收盤後自動寫入，明天收盤後就會出現第一筆。**」不要顯示空白圖框。
- `rows.length === 1`：只有一個點畫不出線，顯示該點的數值 ＋「累積中，需要至少兩天」。
- 卡片下方常駐一行小字（**這句是必要的誠實揭露，不可省略**）：
  > 權益數會因入出金而跳動，這條線**不是報酬率曲線**。快照取自期交所每日行情（收盤／結算價），盤中不更新。

---

## 4. Part C — VM 排程（你要做的）

```bash
# SSH 進 VM 後
cd /home/ubuntu/Stock_recommendations
git pull

# 先手動跑一次確認（不寄信、不寫檔）
node scripts/futures_alert.cjs --dry-run

# 只寫快照不寄信（想先累積資料時用）
node scripts/futures_alert.cjs --snapshot-only

# 強制寄一次驗證信箱通了
node scripts/futures_alert.cjs --force
```

crontab（**VM 是 Asia/Taipei 時區，不是 UTC**——這點 ROADMAP 有記過，別再照搬 UTC 的算法）：

```
5 15 * * 1-5 cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/futures_alert.cjs >> data/futures_alert.log 2>&1
```

排 15:05 是為了讓開 `rebalance_alert.cjs` 的 15:00，兩支都會打同一個 gateway。

**不要動既有的三條 cron**（`refresh.sh` 14:00、`rebalance_alert.cjs` 15:00、以及另一條）。用 `crontab -l` 先存一份再改。

---

## 5. 測試

### 5.1 vitest（`src/lib/futures.test.ts` 追加）

`equityStats` 至少要涵蓋：
- 空陣列 → `first/last` 為 null、`max_drawdown` 為 0、不噴錯
- 單筆 → `total_return` 為 0、`max_drawdown` 為 0
- 單調上升 → `max_drawdown` 為 0（每天都是新高）
- 先漲後跌再漲 → `max_drawdown` 抓到的是**中間那段**而不是最後一天（這條專門釘 running-max 寫成全期最大值的 bug）
- 權益數變負 → 不出現 `NaN` / `Infinity`
- `first.equity ≤ 0` → `total_return` 為 `null`
- 日期亂序輸入 → 函式內部會排好

### 5.2 手動驗收

1. `npm run build` 乾淨（**注意：VM 的 `tsc -b` 比本機 `tsc --noEmit` 嚴格，本機要跑 `npm run build` 本身**，這是 opt19 踩過的坑）。
2. 本機 gateway 起著，塞幾筆假的 `futures_equity_history.json`（手寫即可），看圖畫得出來、hover 有反應、期間篩選會變。
3. 把 rows 清成空陣列，確認空態文字出現而不是空白圖框。
4. 手機寬度（Chrome DevTools 375px）看一次：圖不能溢出、hero row 要能換行。

---

## 6. 驗收標準

- [ ] `getFuturesEquityHistory` 加在 `api.ts`，型別完整（`risk_indicator` 是 `number | null`）
- [ ] `equityStats` 是純函式、在 `futures.ts`、有 vitest 覆蓋上列所有情境
- [ ] 「權益數走勢」卡出現在損益總覽分頁，**上下兩張圖共用 x 軸，沒有雙 y 軸**
- [ ] 單一序列沒有圖例；只標最新值與最大回撤兩個點
- [ ] hover 十字線 ＋ tooltip 可用，命中區比線寬
- [ ] 空態／單點態有專屬文字，不是空白圖框
- [ ] 「不是報酬率曲線」那句說明有出現
- [ ] `npm run build` 與 `npx vitest run` 全綠
- [ ] VM cron 掛上，`--dry-run` 與 `--force` 各跑過一次且結果合理
- [ ] `crontab -l` 確認既有三條 cron 沒被動到

---

## 7. 不做／備註

- ❌ **不做盤中即時告警**。期交所 OpenAPI 給的是每日行情，做不到盤中；要盤中得看期貨商軟體。這點在信裡已經寫明，不要在 UI 上暗示它是即時的。
- ❌ **不做 Telegram**。浦惠的 Telegram 摘要 5/28 已停發（見記憶），不要重新引入一條通知管道。
- ❌ **不把期貨告警併進 `rebalance_alert.cjs`**。觸發條件與收件內容完全不同，硬併會讓兩邊都難改。
- ❌ **不引入 lightweight-charts 到這一頁**（理由見 §3.3）。
- 📌 快照的 `date` 是**報價日**不是執行日。週末或連假跑到的話，報價日還是上一個交易日，因此會覆蓋同一列——這是刻意的，不是 bug。
