/**
 * routes/stock_realized.js — 個股／ETF 已實現損益的雲端端點（opt36，2026-08-27 新增）。
 *
 *   GET/POST /api/stock-realized —— 讀寫 data/stock_realized_trades.json（原子寫入）
 *   POST /api/stock-realized/sync-import —— 玉山 API 真實同步（scripts/sync_fugle_realized.py）
 *       寫入用的合併端點，見該函式上方註解（opt37，2026-08-27）
 *
 * 設計原則與 routes/futures.js 一致：純檔案持久化、伺服端一律 sanitize、
 * 原子寫入（.tmp → rename）、免登入個人自用（只走內網 / ssh -L / Tailscale）。
 *
 * 跟期貨的部位檔不同，這裡沒有「未平倉部位」也沒有保證金——已實現損益是
 * 每一列都已經結算完的獨立交易，資料形狀因此簡單很多：一個陣列 + 一組費率設定。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRADES_PATH = path.join(DATA_DIR, 'stock_realized_trades.json');
const MAX_IMPORTED_REFS = 300;

const DEFAULT_FEE_RATES = {
  fee_rate: 0.001425,
  fee_discount: 1,
  stock_tax_rate: 0.003,
  etf_tax_rate: 0.001,
};

function num(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}
function str(v, fb = '') { return typeof v === 'string' ? v : fb; }
function safeDate(v) {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function safeSymbol(v) {
  return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
function detectKind(symbol) {
  return /^00\d/.test(symbol) ? 'etf' : 'stock';
}
function safeKind(v, symbol) {
  return v === 'etf' || v === 'stock' ? v : detectKind(symbol);
}
function safeRef(v) {
  return str(v).slice(0, 160);
}
/** 券商實收費用：非負有限數才留，其餘 null＝沒這個資料，請用費率設定推估 */
function feeOrNull(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const clamp = (v, lo, hi, fb) => Math.min(hi, Math.max(lo, num(v, fb)));

function sanitizeFeeRates(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    fee_rate: clamp(o.fee_rate, 0, 0.01, DEFAULT_FEE_RATES.fee_rate),
    fee_discount: clamp(o.fee_discount, 0, 1, DEFAULT_FEE_RATES.fee_discount),
    stock_tax_rate: clamp(o.stock_tax_rate, 0, 0.01, DEFAULT_FEE_RATES.stock_tax_rate),
    etf_tax_rate: clamp(o.etf_tax_rate, 0, 0.01, DEFAULT_FEE_RATES.etf_tax_rate),
  };
}

/** 單筆 sanitize，回傳 null＝這筆資料不合格（丟棄）。i 只用來當 id fallback 的區隔碼。 */
function sanitizeTradeItem(t, i) {
  if (!t || typeof t !== 'object') return null;
  const symbol = safeSymbol(t.symbol);
  if (!symbol) return null;
  const sell_date = safeDate(t.sell_date);
  if (!sell_date) return null; // 沒有賣出日就沒辦法歸到哪個月份/區間，直接丟掉
  const qty = Math.max(0, num(t.qty, 0));
  const buy_price = Math.max(0, num(t.buy_price, 0));
  const sell_price = Math.max(0, num(t.sell_price, 0));
  const buy_date = safeDate(t.buy_date);
  const side = t.side === 'short' ? 'short' : 'long';
  const kind = safeKind(t.kind, symbol);
  const name = str(t.name).slice(0, 40) || symbol;
  const id = str(t.id) || `s_${symbol}_${sell_date}_${side}_${i}_${qty}_${sell_price}`;
  const note = str(t.note).slice(0, 100);
  const ref = safeRef(t.ref);
  const fee = feeOrNull(t.fee);
  const tax = feeOrNull(t.tax);
  return {
    id, symbol, name, kind, side, qty, buy_price, sell_price, buy_date, sell_date,
    fee, tax,
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
  };
}

function sanitizeTrades(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  val.forEach((t, i) => {
    const item = sanitizeTradeItem(t, i);
    if (item) out.push(item);
  });
  out.sort((a, b) => (a.sell_date < b.sell_date ? -1 : a.sell_date > b.sell_date ? 1 : 0));
  return out;
}

function sanitizeRefs(val) {
  if (!Array.isArray(val)) return [];
  const out = val.map((x) => str(x).slice(0, 160)).filter(Boolean);
  return [...new Set(out)].slice(-MAX_IMPORTED_REFS);
}

function sanitizeStockRealized(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    trades: sanitizeTrades(b.trades),
    fee_rates: sanitizeFeeRates(b.fee_rates),
    imported_refs: sanitizeRefs(b.imported_refs),
  };
}

router.get('/api/stock-realized', (req, res) => {
  try {
    if (!fs.existsSync(TRADES_PATH)) {
      return res.json({ exists: false, data: null, saved_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf-8'));
    return res.json({
      exists: true,
      data: sanitizeStockRealized(parsed),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取個股已實現損益檔失敗: ' + err.message));
  }
});

router.post('/api/stock-realized', (req, res) => {
  try {
    const clean = sanitizeStockRealized(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = TRADES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...clean, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, TRADES_PATH);
    return res.json({ ok: true, data: clean, saved_at });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存個股已實現損益失敗: ' + err.message));
  }
});

/**
 * POST /api/stock-realized/sync-import — 玉山 API 真實同步寫入端點（opt37）。
 *
 * 呼叫方是 scripts/sync_fugle_realized.py（在 VM 的 amd64 容器裡跑，見
 * deploy/sync_realized_vm.sh），不是瀏覽器。每筆交易帶一個 sync_ref（用玉山
 * 回傳的 order_no 組出來，穩定不會變），去重分兩層：
 *   1. 快速路徑：ref 已經在 imported_refs 裡 → 這筆同步過了，跳過。
 *   2. 保險路徑：ref 沒看過，但既有 trades 裡已經有「同代號＋同賣出日＋同股數＋
 *      賣出均價相差 <0.01」的一筆——這是為了接住「使用者先手動輸入或截圖匯入
 *      過同一筆交易，API 同步的買進均價換算方式跟截圖不同（API 這邊的買進均價
 *      是用玉山的 cost 欄位反推、已內含買進手續費，跟截圖上單純顯示的買進均價
 *      不會完全對得上小數點），若只靠 ref 比對會漏接、造成同一筆損益重複計入」
 *      → 視為已存在，只記錄 ref（下次同一筆秒過），不重複新增。
 * 兩層都沒中才真的新增一筆。
 */
function findFuzzyDuplicate(trades, symbol, sell_date, qty, sell_price) {
  return trades.find((t) => t.symbol === symbol
    && t.sell_date === sell_date
    && Math.abs(t.qty - qty) < 0.5
    && Math.abs(t.sell_price - sell_price) < 0.01);
}

router.post('/api/stock-realized/sync-import', (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.trades) ? req.body.trades : [];
    let current = { trades: [], fee_rates: DEFAULT_FEE_RATES, imported_refs: [] };
    if (fs.existsSync(TRADES_PATH)) {
      current = sanitizeStockRealized(JSON.parse(fs.readFileSync(TRADES_PATH, 'utf-8')));
    }
    const trades = current.trades.slice();
    const refSet = new Set(current.imported_refs);

    let added = 0;
    let skippedAlready = 0;
    let skippedDuplicate = 0;

    incoming.forEach((t, i) => {
      const symbol = safeSymbol(t && t.symbol);
      const sell_date = safeDate(t && t.sell_date);
      if (!symbol || !sell_date) return;
      const syncRef = safeRef(t && t.sync_ref);
      const ref = 'api|' + (syncRef || `${symbol}|${sell_date}|${num(t && t.qty, 0)}|${num(t && t.sell_price, 0)}`);
      if (refSet.has(ref)) { skippedAlready += 1; return; }

      const qty = Math.max(0, num(t && t.qty, 0));
      const sell_price = Math.max(0, num(t && t.sell_price, 0));
      if (findFuzzyDuplicate(trades, symbol, sell_date, qty, sell_price)) {
        refSet.add(ref);
        skippedDuplicate += 1;
        return;
      }

      const item = sanitizeTradeItem({ ...t, ref }, `api_${i}`);
      if (!item) return;
      trades.push(item);
      refSet.add(ref);
      added += 1;
    });

    trades.sort((a, b) => (a.sell_date < b.sell_date ? -1 : a.sell_date > b.sell_date ? 1 : 0));
    const clean = {
      trades,
      fee_rates: current.fee_rates,
      imported_refs: sanitizeRefs([...refSet]),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = TRADES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...clean, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, TRADES_PATH);

    return res.json({
      ok: true,
      added,
      skipped_already: skippedAlready,
      skipped_duplicate: skippedDuplicate,
      total_incoming: incoming.length,
      saved_at,
    });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '同步匯入個股已實現損益失敗: ' + err.message));
  }
});

module.exports = router;
