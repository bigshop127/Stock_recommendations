/**
 * routes/stock_alerts.js — 個股價格警示設定的雲端端點（2026-08-30 新增）。
 *
 *   GET/POST /api/stock-alerts —— 讀寫 data/stock_price_alerts.json（原子寫入）
 *
 * 只存「使用者設定了什麼警示」，不在這裡做判斷寄信——判斷與寄信在
 * scripts/stock_price_alert.cjs（VM crontab 收盤後跑一次），設計原則
 * 與 routes/stock_realized.js 一致：純檔案持久化、伺服端一律 sanitize、
 * 原子寫入（.tmp → rename）、免登入個人自用。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_PATH = path.join(DATA_DIR, 'stock_price_alerts.json');
const MAX_STOCKS = 100;
const MAX_ALERTS_PER_STOCK = 10;

function str(v, fb = '') { return typeof v === 'string' ? v : fb; }
function num(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}
function safeCode(v) {
  return str(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

// 12 種警示條件：收盤價 2 種（需要 price）＋ KD 反轉 2 種＋ 5/10/20/60 日均線跌破/站回 8 種（皆不需要 price）
const CONDITION_TYPES = new Set([
  'price_above', 'price_below',
  'kd_golden_cross', 'kd_death_cross',
  'ma5_break_below', 'ma5_break_above',
  'ma10_break_below', 'ma10_break_above',
  'ma20_break_below', 'ma20_break_above',
  'ma60_break_below', 'ma60_break_above',
]);
const PRICE_CONDITIONS = new Set(['price_above', 'price_below']);

function safeAlert(v, i) {
  if (!v || typeof v !== 'object') return null;
  const conditionType = str(v.conditionType);
  if (!CONDITION_TYPES.has(conditionType)) return null;
  const isPrice = PRICE_CONDITIONS.has(conditionType);
  let price;
  if (isPrice) {
    price = num(v.price, NaN);
    if (!Number.isFinite(price) || price <= 0) return null;
  }
  const id = str(v.id) || `a_${conditionType}_${price ?? ''}_${i}`;
  const enabled = v.enabled !== false;
  const note = str(v.note).slice(0, 100);
  return { id, conditionType, ...(isPrice ? { price } : {}), enabled, ...(note ? { note } : {}) };
}

function sanitizeAlerts(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rawStocks = b.stocks && typeof b.stocks === 'object' ? b.stocks : {};
  const stocks = {};
  let count = 0;
  for (const [rawCode, entry] of Object.entries(rawStocks)) {
    if (count >= MAX_STOCKS) break;
    const code = safeCode(rawCode);
    if (!code || !entry || typeof entry !== 'object') continue;
    const name = str(entry.name).slice(0, 40) || code;
    const rawAlerts = Array.isArray(entry.alerts) ? entry.alerts : [];
    const alerts = [];
    rawAlerts.forEach((a, i) => {
      const clean = safeAlert(a, i);
      if (clean && alerts.length < MAX_ALERTS_PER_STOCK) alerts.push(clean);
    });
    if (alerts.length === 0) continue;
    stocks[code] = { name, alerts };
    count += 1;
  }
  return { stocks };
}

router.get('/api/stock-alerts', (req, res) => {
  try {
    if (!fs.existsSync(ALERTS_PATH)) {
      return res.json({ exists: false, data: null, saved_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf-8'));
    return res.json({
      exists: true,
      data: sanitizeAlerts(parsed),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取價格警示設定失敗: ' + err.message));
  }
});

router.post('/api/stock-alerts', (req, res) => {
  try {
    const clean = sanitizeAlerts(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = ALERTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...clean, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, ALERTS_PATH);
    return res.json({ ok: true, data: clean, saved_at });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存價格警示設定失敗: ' + err.message));
  }
});

module.exports = router;
