/**
 * server.cjs — Express gateway 入口（階段 6）。
 *
 * 只做 app 組裝：載 .env → CORS → json/static → 掛載 routes/。
 *   routes/gateway.js   階段 6 新增 /api/* 統一 gateway（代理 engine + 讀 reports/）
 *
 * engine（Python FastAPI）為**可選依賴**：掛掉時 reports 類與 degraded dashboard 仍可用，
 * 其餘 /api 端點回明確 503（見 routes/gateway.js 與 docs/api.md）。
 */
'use strict';

require('./lib/loadEnv').loadEnv();

const express = require('express');
const cors = require('cors');

const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // 補啟用 CORS（前端跨網域可打）
app.use(express.json());
app.use(express.static('public'));

app.use(require('./routes/gateway'));
app.use(require('./routes/market'));
app.use(require('./routes/rebalance'));
app.use(require('./routes/futures'));

// 階段 8：serve review-web 前端 build（review-web/dist）在子路徑 /review
const reviewDist = path.join(__dirname, 'review-web', 'dist');
if (fs.existsSync(reviewDist)) {
  app.use('/review', express.static(reviewDist));
  // 子路徑 SPA fallback
  app.get(/^\/review(?:\/|$).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(reviewDist, 'index.html'));
  });
}

// 階段 7：直接 serve 前端 build（web/dist）。同源免 CORS、鋪路階段8 無頭雲端部署。
// 未 build 時略過（dev 模式前端走 Vite dev server 5173 → 打 gateway 3000 走 CORS）。
const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback：非 /api、非既有路由 → 回 index.html（前端 client-side routing）
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`Puhui finance API gateway: http://localhost:${port}`);
  console.log(`  engine base: ${process.env.ENGINE_BASE_URL || 'http://127.0.0.1:8000'}`);
  console.log(`  web build: ${fs.existsSync(webDist) ? 'serving web/dist' : '(not built — dev via vite 5173)'}`);
});
