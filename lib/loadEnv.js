/**
 * loadEnv.js — 極簡 .env 載入（無 dotenv 依賴）。
 *
 * 讀專案根 `.env`（gitignored）的 KEY=VALUE，僅填補尚未存在的 process.env key
 * （已存在的環境變數優先，不覆蓋）。檔案不存在則靜默跳過。機密一律走 .env。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  let raw;
  try {
    if (!fs.existsSync(p)) return;
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

module.exports = { loadEnv };
