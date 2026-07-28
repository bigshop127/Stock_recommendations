# 個股全面審視網 (review-web) — 部署說明

本文件記載 `review-web`（PWA 整合版前端）如何打包並部署至 Oracle VM 雲端環境中與既有 `web/` 共存。

## 1. 部署架構與並存規則

- **同源並存**：`review-web` 採用同源部署，由 Express Gateway (`server.cjs`) 同時提供服務。
- **路徑隔離**：
  - 既有 `web/` 仍佔用根路徑 `/` 及 `/index.html`。
  - 新前端 `review-web/` 佔用子路徑 `/review`，靜態檔放置於 `review-web/dist`，入口為 `/review/index.html`。
  - API 統一走 `/api/*`。

## 2. 前端配置對齊 (子路徑三件套)

為使 `/review` 子路徑下的單頁應用 (SPA) 路由及 PWA 資源載入正常，專案已對齊下列設定：
1. **Vite Base Path** (`vite.config.ts`)：
   `base: '/review/'`
2. **React Router Basename** (`src/App.tsx`)：
   `<Router basename="/review">`
3. **PWA Scope & start_url** (`vite.config.ts`)：
   - `start_url: '/review/'`
   - `scope: '/review/'`
   - `workbox.navigateFallback: '/review/index.html'`

## 3. 後端 Gateway Serve 設定 (`server.cjs`)

Express 伺服器在既有 `webDist` fallback 之前，新增 `reviewDist` 的靜態服務與 SPA fallback：

```javascript
// 1. 註冊 review-web 靜態與 fallback 路由（必須在 web/ catch-all 之前）
const reviewDist = path.join(__dirname, 'review-web', 'dist');
if (fs.existsSync(reviewDist)) {
  app.use('/review', express.static(reviewDist));
  app.get(/^\/review(?:\/|$).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(reviewDist, 'index.html'));
  });
}

// 2. 既有 web/ 靜態及 catch-all 路由（維持不變）
const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}
```

## 4. 實機部署步驟 (Oracle VM)

### 4.1 VM 連線與環境資訊
- **IP**: `140.238.48.197`
- **User**: `ubuntu`
- **Key Path**: `C:\Users\bigsh\.ssh\oracle_puhui.key`
- **Repo Path**: `/home/ubuntu/Stock_recommendations`
- **Node 版本**: Node 20 / npm 10+ (aarch64)

### 4.2 部署指令流程

1. **連線至 VM 並拉取最新程式碼**：
   ```bash
   ssh -i C:\Users\bigsh\.ssh\oracle_puhui.key ubuntu@140.238.48.197
   cd /home/ubuntu/Stock_recommendations
   git fetch origin
   git checkout master   # 2026-06-28 起分支已收斂，一律部署 master（phase3-chips 已退役）
   git pull
   ```

2. **建置前端 (由於 dist 被 gitignore，需在 VM 上編譯)**：
   ```bash
   cd review-web
   # 由於 Vite 8 與部分插件 peerDeps 衝突，使用 --legacy-peer-deps 進行安裝
   npm ci --legacy-peer-deps
   npm run build
   ```

3. **重啟服務**：
   ```bash
   sudo systemctl restart puhui-gateway
   ```
   - 🚨 **若本次 `git pull` 含 engine 程式碼變動（新增/修改 `engine/` 端點，例如 review-web 補的 `/market/*`、`/data/{chips,fundamentals,stock_news}`），必須一併重啟 engine**，否則跑著的舊 engine 程序不會載入新端點 → 前端打到 `/api/market/*` 等會收到 **404/502**：
     ```bash
     sudo systemctl restart puhui-engine
     ```
   - 純前端（只動 `review-web/`）更新才可省略 engine 重啟。
   - engine 重啟後 `/market/breadth`、`/market/institutional` 首次為冷啟動較慢（~15–20s），且高並發冷載偶發 **502**（TWSE MIS 限流）→ 前端「重試」即可，屬上游資料源瞬斷非程式錯誤。
   - 🚨 **若個股 `chips`/`fundamentals` 回 502 且 engine log 出現 `HTTP 402 ... "Requests reach the upper limit"`**：是 FinMind 免費級「每小時請求上限」被打爆（盤勢總覽冷載＋多檔個股查詢很耗額度）。engine 已支援**多 token 輪替**——在 `engine/.env` 填 `FINMIND_TOKENS=token1,token2,...`（逗號分隔多顆，撞額度自動換顆重試；會與單顆 `FINMIND_TOKEN` 合併去重），改完 `sudo systemctl restart puhui-engine` 生效。

4. **確認服務狀態與日誌**：
   ```bash
   sudo systemctl status puhui-gateway
   journalctl -u puhui-gateway -n 50 -f
   ```

### 4.3 驗收測試

- **本機 Port Forwarding**：
  ```bash
  ssh -L 3000:localhost:3000 -i C:\Users\bigsh\.ssh\oracle_puhui.key ubuntu@140.238.48.197
  ```
  然後於本機瀏覽器開啟 `http://localhost:3000/review/`。
- **日常一鍵存取（本機，零公網暴露）**：桌面捷徑「個股全面審視網」→ 雙擊即自動建立上述 SSH 通道（最小化視窗常駐）並開瀏覽器到 `/review/`；通道已開則重用。啟動腳本＝`review-web/tools/open-review.ps1`，重建捷徑指向它即可。中斷＝關掉那個最小化的 SSH 視窗。僅限持金鑰的本機可連。
  - 🚨 **`open-review.ps1` 必須存成 UTF-8 with BOM**：捷徑用 `powershell.exe`（Windows PowerShell 5.1），它會把「無 BOM」的 UTF-8 檔當系統 ANSI 碼頁（zh-TW＝CP950）解讀，腳本內的中文註解被誤解碼 → **整支 parse error、雙擊完全沒反應**（不是通道問題）。若哪天改了這支腳本後捷徑又「沒反應」，先確認存檔編碼仍含 BOM：`(Get-Content -Encoding Byte -TotalCount 3 path) -join ' '` 應為 `239 187 191`。
- **VM 內部 Curl 驗證**：
  - 大盤總覽 `/` 正常：`curl -I http://localhost:3000/` (應該回傳 `Content-Length` 為 481 左右的舊 `web/` HTML)
  - 新個股審視 `/review/` 正常：`curl -I http://localhost:3000/review/` (應該回傳 `Content-Length` 為 901 左右的新版 HTML)
  - API 正常：`curl http://localhost:3000/api/health` (應該回傳 `{"gateway":"ok","engine":"up",...}`)

### 4.4 上版後前端看到舊畫面 → PWA Service Worker 快取排除

**2026-07-11 已修復根因（commit `85e55c4`）**：workbox 設定原本只有 `skipWaiting` 漏了 `clientsClaim`，新 SW activate 後不會接管「已經開著」的分頁/手機 PWA，`main.tsx` 的 `controllerchange` 自動重整監聽器因此永遠等不到事件。已補上 `clientsClaim: true`（`vite.config.ts`）＋手機 PWA 從背景切回時主動 `registration.update()`（`main.tsx` 的 `visibilitychange` 監聽）。**修復後理論上不再需要下面這套手動排除步驟**——但若哪天又踩到舊畫面，以下仍是有效的救急手段：

`review-web` 的 PWA 採 `registerType: 'autoUpdate'`，Service Worker 會積極快取整個 app shell。**上版後瀏覽器很可能還在跑舊的 hashed chunk（舊 JS），看不到新功能。**

🚨 **實測（2026-07-04 opt8 上版）：光按 `Ctrl+Shift+R`（強制重整）不夠**——連按兩次仍載到舊 chunk。判斷「新 JS 是否真的載入」的鐵證＝**Console 堆疊追蹤裡的 chunk hash**（如 `StockDetail-0ORDw7af.js`），與 `dist/assets/` 下建置產出的檔名比對即可確認。

確實有效的排除步驟（依序做）：
1. DevTools → **Application → Service Workers → Unregister**（把 review 網域的 SW 註銷）。
2. 同頁 **Storage → Clear site data**（清掉 Cache Storage / 舊 precache）。
3. 再 `Ctrl+Shift+R` 硬重整一次。
4. 回 Console 確認 chunk hash 已換成新的，才算真的吃到新版。

### 4.5 手機存取（Tailscale，2026-07-07 新增）

桌面走 `ssh -L`（§4.3）手機不適用（離開家用 WiFi、用行動網路時無法建立 SSH 通道）。改用 **Tailscale** 私人網路：VM 與手機各自加入同一 tailnet，湊不到公網曝露，也不需要另外管理帳密/憑證。

**一次性設定（已完成，供日後重建 VM 或除錯參考）**：
1. VM 安裝：`curl -fsSL https://tailscale.com/install.sh | sh`（Ubuntu 22.04 aarch64 已驗證）。
2. `sudo tailscale up --hostname=puhui-oracle-vm`，印出的登入連結需**使用者本人**開啟並用其 Tailscale 帳號（`a4980678@gmail.com`）授權——這步驟無法由 Claude 代為完成。
3. 手機安裝 Tailscale App（iOS/Android），登入**同一帳號**。
4. Tailscale 帳號需**啟用 HTTPS Certificates 與 Serve**（首次執行 `tailscale serve` 若未啟用會印出一次性啟用連結，開啟並用該帳號登入核可即可，同樣需使用者本人操作）。
5. VM 執行 `sudo tailscale serve --bg 3000`（背景常駐；設定存在 tailscaled 狀態內，`tailscaled.service` 已 `systemctl enable`，重開機自動恢復，不需寫額外 systemd unit）。
6. 確認：`tailscale serve status` 應顯示 `https://puhui-oracle-vm.tail73ac0d.ts.net` proxy 到 `http://127.0.0.1:3000`。

**日常使用**：手機 Tailscale App 保持連線（背景 VPN 開關，不需手動操作），瀏覽器開 `https://puhui-oracle-vm.tail73ac0d.ts.net/review/`——有效 HTTPS 憑證（Tailscale 自動核發/續期），PWA manifest/service worker 沿用既有設定，「加到主畫面」可正常安裝離線可用的 APP 圖示。**2026-07-07 手機（Android，行動網路）實測通過**。

**安全性**：僅限已登入同一 Tailscale 帳號的裝置能解析/連線該網域，未對 Oracle Cloud 安全清單開任何新 inbound port，與桌面 `ssh -L` 管道並存不衝突。若要新增裝置（如平板）：安裝 Tailscale App 登入同帳號即可，VM 端不需任何改動。

### 4.6 真實持倉同步（手機/桌面皆可觸發，2026-07-11 新增；2026-07-29 改為 VM 執行）

再平衡頁最上方「TAIEX 市場狀態燈號」卡有一顆「真實同步」按鈕，桌面或手機（Tailscale）點擊皆可，會從玉山證券（Fugle Trade）真實帳戶抓庫存/現金覆蓋期初部位。**READ-ONLY：只呼叫 `get_inventories`/`get_balance`/`get_settlements`，不具下單能力。**

#### 現行架構（2026-07-29 起）

網頁按鈕 → `POST /api/rebalance/sync-holdings-trigger`（`routes/rebalance.js`）→ gateway 直接在 VM 上 spawn `deploy/sync_holdings_vm.sh` → 該腳本用 **amd64 容器**跑 `scripts/sync_fugle_holdings.py` → 持倉 POST 回同一個 gateway 端點（`--network host`，走 `localhost:3000`）。端點立刻回 202，結果寫進 `data/sync_holdings_status.json`，前端輪詢 `GET /api/rebalance/sync-holdings-status`（失敗時直接顯示真正原因）與 `GET /api/rebalance/holdings` 的 `saved_at`，約 3 分鐘逾時。

**為什麼要包 docker + qemu**：玉山的 `esun_trade` SDK 只出 `win_amd64` / macOS / **manylinux x86_64** 的 wheel，官方 Node.js SDK 的原生模組同樣只有 `darwin-arm64`/`darwin-x64`/`linux-x64-gnu`/`win32-x64-msvc` — **兩邊都沒有 linux-aarch64**，而這台 VM 是 ARM（Ampere）。因此裝 `qemu-user-static` 註冊 binfmt，用 `--platform linux/amd64` 跑 x86_64 容器執行 SDK。一天叫幾次的 REST 查詢，模擬的速度損失無感（實測登入＋查詢數秒內完成）。

**VM 上的一次性設定（供重建參考）**：
```bash
sudo apt-get install -y docker.io qemu-user-static binfmt-support
sudo usermod -aG docker ubuntu
# 官方 Linux wheel（下載頁：/trading-platforms/api-trading/docs/download/download-sdk/）
curl -sL -o ~/fugle-sync/esun_trade-2.2.0-...-manylinux_2_17_x86_64...whl \
  https://www.esunsec.com.tw/trading-platforms/api-trading/binary-packages/esun_trade-2.2.0-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
# 在 amd64 容器裡 pip install 該 wheel + requests，再 docker commit 成 fugle-sync:2.2.0
# （docker 20.10 的 legacy builder 跨平台 build 會 NotFound，故用 run + commit）
```

**憑證位置（2026-07-29 起放 VM，使用者已授權）**：`/home/ubuntu/.fugle/`（`chmod 600`，只有 `ubuntu` 讀得到）
- `config.ini`：Core Entry、API Key/Secret、帳號；`Cert.Path` 指向**容器內**路徑 `/creds/H125655312_20270126.p12`
- `H125655312_20270126.p12`：憑證
- `keyring.env`：cryptfile keyring 的隨機加密密碼
- `/home/ubuntu/.fugle-keyring/`：帳號密碼與憑證密碼（cryptfile 加密後端；headless 環境無法用預設的 SecretService，故 image 內設 `PYTHON_KEYRING_BACKEND=keyrings.cryptfile.cryptfile.CryptFileKeyring`）

**這次改版順手解掉的三個老故障**：
| 錯誤碼 | 舊病因 | 現況 |
|---|---|---|
| `AGA0002 Invalid IP` | 家用/手機網路是浮動 IP，白名單一直飄掉 | VM 公網 IP 固定 `140.238.48.197`，白名單設一次就好 |
| `AWA0005 Invalid Timestamp` | 本機 `w32time` 停掉導致時鐘慢十幾秒 | VM 由 chrony 持續校時 |
| `FUGLE_CONFIG_PATH file missing` | `config.ini` 放 Downloads 被清理程式刪掉 | 憑證在 VM 的 `~/.fugle`，本機清理碰不到 |

#### 本機備援路徑（保留）

`review-web/tools/sync-holdings.ps1` + `.github/workflows/sync_fugle_holdings.yml`（self-hosted runner，label `fugle-sync`）維持可用，但**已不是網頁按鈕會走的路徑**——gateway 不再呼叫 `workflow_dispatch`，VM 的 `GH_ACTIONS_PAT` 也不再被讀取。當 VM 出事時可在本機手動雙擊執行。此 repo 為 PUBLIC，該 workflow 仍**只掛 `workflow_dispatch`** 且用專屬 runner 標籤，維持原本的兩層防護。
