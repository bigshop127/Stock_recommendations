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
   git checkout phase3-chips
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
- **VM 內部 Curl 驗證**：
  - 大盤總覽 `/` 正常：`curl -I http://localhost:3000/` (應該回傳 `Content-Length` 為 481 左右的舊 `web/` HTML)
  - 新個股審視 `/review/` 正常：`curl -I http://localhost:3000/review/` (應該回傳 `Content-Length` 為 901 左右的新版 HTML)
  - API 正常：`curl http://localhost:3000/api/health` (應該回傳 `{"gateway":"ok","engine":"up",...}`)
