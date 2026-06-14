/**
 * server.cjs — Express gateway 入口（階段 6）。
 *
 * 只做 app 組裝：載 .env → CORS → json/static → 掛載 routes/。
 *   routes/finance.js   既有 Node 內容線端點（不破壞）
 *   routes/gateway.js   階段 6 新增 /api/* 統一 gateway（代理 engine + 讀 reports/）
 *
 * engine（Python FastAPI）為**可選依賴**：掛掉時 reports 類與 degraded dashboard 仍可用，
 * 其餘 /api 端點回明確 503（見 routes/gateway.js 與 docs/api.md）。
 */
'use strict';

require('./lib/loadEnv').loadEnv();

const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // 補啟用 CORS（前端跨網域可打）
app.use(express.json());
app.use(express.static('public'));

app.use(require('./routes/finance'));
app.use(require('./routes/gateway'));

app.listen(port, () => {
  console.log(`Puhui finance API gateway: http://localhost:${port}`);
  console.log(`  engine base: ${process.env.ENGINE_BASE_URL || 'http://127.0.0.1:8000'}`);
});
