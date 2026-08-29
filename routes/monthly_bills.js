/**
 * routes/monthly_bills.js — 每月信用卡帳單（2026-08-29 新增，資產變化圖用）。
 *
 *   GET  /api/monthly-bills                 —— 讀 data/monthly_bills.json
 *   POST /api/monthly-bills                 —— 手動新增/覆蓋一筆（source: 'manual'）
 *   DELETE /api/monthly-bills/:id           —— 刪一筆
 *   POST /api/monthly-bills/sync-trigger    —— 立即跑一次 scripts/fetch_credit_card_bills.cjs
 *   GET  /api/monthly-bills/sync-status     —— 上一次觸發的結果（前端輪詢用）
 *
 * 寫入端有兩個：cron 排程的 scripts/fetch_credit_card_bills.cjs（source:'auto'，
 * 直接寫檔）與這裡的手動 POST（source:'manual'，補登/修正誤判用）——比照
 * routes/networth.js／routes/rebalance.js 的既有模式：純檔案持久化、伺服端一律
 * sanitize、原子寫入（.tmp → rename）。sync-trigger／sync-status 的 spawn＋狀態輪詢
 * 手法照抄 routes/rebalance.js 的 sync-holdings-trigger／sync-holdings-status。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const BILLS_PATH = path.join(DATA_DIR, 'monthly_bills.json');
const SYNC_SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch_credit_card_bills.cjs');
const SYNC_STATUS_PATH = path.join(DATA_DIR, 'monthly_bills_sync_status.json');
const SYNC_TIMEOUT_MS = 120000; // Gmail + PDF 解密 + Gemini，兩張卡跑完通常在一分鐘內

function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v.replace(/[,\s$]/g, '')); if (Number.isFinite(p)) return p; }
  return fb;
}
function safeDate(v) {
  const s = typeof v === 'string' ? v : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function sanitizeBill(b, i) {
  if (!b || typeof b !== 'object') return null;
  const bank = str(b.bank, 20);
  const currency = str(b.currency, 8) || 'TWD';
  const amount_due = safeNum(b.amount_due, null);
  if (!bank || amount_due === null) return null;
  const id = typeof b.id === 'string' && b.id ? b.id.slice(0, 80) : `bill_manual_${Date.now()}_${i}`;
  return {
    id,
    bank,
    card_name: str(b.card_name, 40),
    card_last4: str(b.card_last4, 4),
    statement_date: safeDate(b.statement_date),
    due_date: safeDate(b.due_date),
    currency,
    amount_due: Math.max(0, amount_due),
    minimum_due: Math.max(0, safeNum(b.minimum_due, 0)),
    source: b.source === 'auto' ? 'auto' : 'manual',
    gmail_message_id: str(b.gmail_message_id, 40),
    imported_at: typeof b.imported_at === 'string' ? b.imported_at : new Date().toISOString(),
  };
}

function loadRaw() {
  try {
    return JSON.parse(fs.readFileSync(BILLS_PATH, 'utf-8'));
  } catch (_) {
    return { bills: [], processed_message_ids: [] };
  }
}

function writeRaw(raw) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BILLS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, BILLS_PATH);
}

router.get('/api/monthly-bills', (req, res) => {
  try {
    if (!fs.existsSync(BILLS_PATH)) {
      return res.json({ exists: false, bills: [], updated_at: null });
    }
    const raw = loadRaw();
    const bills = (Array.isArray(raw.bills) ? raw.bills : [])
      .map(sanitizeBill)
      .filter(Boolean)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    return res.json({
      exists: true,
      bills,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取信用卡帳單檔失敗: ' + err.message));
  }
});

router.post('/api/monthly-bills', (req, res) => {
  try {
    const item = sanitizeBill({ ...req.body, source: 'manual' }, 0);
    if (!item) return sendError(res, httpError(400, 'BAD_REQUEST', '缺少必要欄位（bank／amount_due）'));
    const raw = loadRaw();
    const bills = Array.isArray(raw.bills) ? raw.bills : [];
    const idx = bills.findIndex((b) => b && b.id === item.id);
    if (idx >= 0) bills[idx] = item; else bills.push(item);
    writeRaw({ ...raw, bills, updated_at: new Date().toISOString() });
    return res.json({ ok: true, bill: item });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存信用卡帳單失敗: ' + err.message));
  }
});

router.delete('/api/monthly-bills/:id', (req, res) => {
  try {
    const raw = loadRaw();
    const bills = (Array.isArray(raw.bills) ? raw.bills : []).filter((b) => b && b.id !== req.params.id);
    writeRaw({ ...raw, bills, updated_at: new Date().toISOString() });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '刪除信用卡帳單失敗: ' + err.message));
  }
});

// ── 立即檢查帳單（比照 routes/rebalance.js 的 sync-holdings-trigger 手法）──────
let syncRunning = false;

function writeSyncStatus(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SYNC_STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, SYNC_STATUS_PATH);
  } catch (_) { /* 狀態檔寫不進去不該影響同步本身 */ }
}

router.post('/api/monthly-bills/sync-trigger', (req, res) => {
  if (syncRunning) {
    return sendError(res, httpError(409, 'BUSY', '帳單檢查已在進行中，請等它跑完'));
  }
  if (!fs.existsSync(SYNC_SCRIPT)) {
    return sendError(res, httpError(500, 'CONFIG', `找不到帳單檢查腳本 ${SYNC_SCRIPT}`));
  }

  const started_at = new Date().toISOString();
  syncRunning = true;
  writeSyncStatus({ state: 'running', started_at, finished_at: null, message: null });
  res.status(202).json({ ok: true, triggered_at: started_at });

  const child = spawn(process.execPath, [SYNC_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    timeout: SYNC_TIMEOUT_MS,
  });
  let output = '';
  const collect = (buf) => { output = (output + buf.toString()).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const finish = (code, err) => {
    if (!syncRunning) return; // close 與 error 都會觸發，只認第一個
    syncRunning = false;
    const ok = !err && code === 0;
    writeSyncStatus({
      state: ok ? 'ok' : 'error',
      started_at,
      finished_at: new Date().toISOString(),
      exit_code: typeof code === 'number' ? code : null,
      message: ok ? null : (err ? String(err.message) : output.split('\n').filter((l) => l.trim()).slice(-1)[0] || '帳單檢查失敗，原因不明'),
      log_tail: output.slice(-2000),
    });
  };
  child.on('close', (code) => finish(code, null));
  child.on('error', (err) => finish(null, err));
});

router.get('/api/monthly-bills/sync-status', (req, res) => {
  if (!fs.existsSync(SYNC_STATUS_PATH)) {
    return res.json({ state: 'idle' });
  }
  try {
    return res.json(JSON.parse(fs.readFileSync(SYNC_STATUS_PATH, 'utf-8')));
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取帳單檢查狀態失敗: ' + err.message));
  }
});

module.exports = router;
