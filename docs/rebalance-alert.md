# 00631L 再平衡 Email 告警（rebalance_alert.cjs）

每日收盤後檢查 00631L「正2 + 現金」投組 Beta，破容忍區間就寄 Email 到 `a4980678@gmail.com`。
搭配前端計算機（`/review/rebalance`, opt10）——**計算機是互動試算，本腳本是背景自動盯盤**。

## 為什麼是腳本＋排程，不是網頁功能
前端計算機是純瀏覽器工具、持倉存在 localStorage，關掉分頁就不跑、伺服器也讀不到。要「該賣出/買進時自動寄信」必須有背景排程 + 獨立持倉設定檔。

## 運作
1. 讀持倉 `data/rebalance_holdings.json`（**gitignore**，由 `scripts/rebalance_holdings.example.json` 複製後填）。
2. 打本機 gateway `GET /api/stocks/00631L/ohlcv` 取最新交易日收盤價（未還原）。
3. 用移植自 `review-web/src/lib/rebalance.ts` 的邏輯算投組 β 與買/賣金額、股數。
4. β 破**上限**→ 該賣出、破**下限**→ 該買進 → 寄 Email（HTML＋純文字）。
5. **去重**：只在「狀態變化」時寄（`normal→buy`/`normal→sell`/`buy↔sell`），持續同狀態不重複寄；狀態存 `data/rebalance_alert_state.json`。

## 設計約束
- **完全獨立於 `scripts/puhui_daily.cjs`**（不 require、不改動；該檔為 production 命脈）。只沿用同一組 Google OAuth env 與 Gmail API 寄信手法（各自複製）。
- 只用 Node 內建模組，零新依賴。
- 沿用既有 env：`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`（VM `.env` 已有，供 puhui 每日報告用）、`NOTIFY_EMAIL`（預設 `a4980678@gmail.com`）。可選 `REVIEW_GATEWAY_BASE`（預設 `http://localhost:3000`）。

## 部署（VM）
```bash
cd /home/ubuntu/Stock_recommendations
git pull

# 1) 建立持倉設定（填你的實際數字；此檔 gitignore 不進版控）
cp scripts/rebalance_holdings.example.json data/rebalance_holdings.json
nano data/rebalance_holdings.json     # shares / avg_cost / cash / target_beta / threshold_abs ...

# 2) 先手動驗證：計算對不對、信箱收得到（--force 忽略去重強制寄一次）
node scripts/rebalance_alert.cjs --dry-run     # 只印不寄，看數字
node scripts/rebalance_alert.cjs --force        # 強制寄一封到 a4980678@gmail.com 驗信箱

# 3) 掛 cron（週一~五 收盤後；VM 若為 UTC，07:00 UTC = 15:00 台北）
crontab -e
# 加一行：
0 7 * * 1-5 cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/rebalance_alert.cjs >> data/rebalance_alert.log 2>&1
```
- 確認 VM 時區：`timedatectl`。若 VM 已是台北時間，改用 `30 14 * * 1-5`（14:30）或收盤後任意時點。
- `node` 路徑用 `which node` 確認（cron 環境 PATH 精簡，建議寫絕對路徑）。
- gateway/engine 需在跑（production 常駐）；抓不到價會記 log、不寄信、隔天再試。

## 指令
| 指令 | 作用 |
|---|---|
| `node scripts/rebalance_alert.cjs` | 正常執行（cron 用）；狀態變化才寄 |
| `node scripts/rebalance_alert.cjs --dry-run` | 只計算＋印出，不寄信、不寫 state |
| `node scripts/rebalance_alert.cjs --force` | 忽略去重強制寄一次（驗信箱） |

## 持倉異動
改了持股/現金/目標 β → 直接編輯 `data/rebalance_holdings.json` 即可，下次排程生效。
（前端計算機的 localStorage 與本檔各自獨立、不互通——這是刻意的隱私邊界。）

## 坑
- **首次收不到信**：多半是 Gmail OAuth token 失效或 env 沒帶進 cron 環境。腳本會自動讀 repo 根 `.env`；若 token 過期照 puhui pipeline 的 OAuth 重授權流程更新 `GOOGLE_REFRESH_TOKEN`。先用 `--force` 在 VM 手動確認。
- **每天都收到同一封**：不會——去重只在狀態變化寄。若想「持續破區間時每天提醒」再改需求。
- **盤中不會即時寄**：用的是每日收盤價、每日排程；非盤中即時報價（即時價來源限流不穩，故不採）。
