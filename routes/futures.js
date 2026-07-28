/**
 * routes/futures.js — 期貨損益總覽的雲端端點（2026-07-29 新增）。
 *
 *   GET/POST /api/futures/positions —— 讀寫 data/futures_positions.json（原子寫入）
 *   GET      /api/futures/quote     —— 代抓期交所 OpenAPI 的每日行情（SRF 各月份）
 *
 * 設計原則與 routes/rebalance.js 一致：純檔案持久化、伺服端一律 sanitize、
 * 原子寫入（.tmp → rename）、免登入個人自用（只走內網 / ssh -L / Tailscale）。
 *
 * 報價來源：https://openapi.taifex.com.tw/v1/DailyMarketReportFut
 * 期交所官方 OpenAPI，公開資料、免金鑰。給的是**每日行情（收盤/結算價）**，不是
 * 即時報價——盤中想看即時價要自己看券商軟體，這頁的定位是「收盤後對帳與風險檢視」。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const POSITIONS_PATH = path.join(DATA_DIR, 'futures_positions.json');

// 契約規格預設（期交所 2026-06-18 保證金表；SRF＝小型臺灣50 ETF 期貨）
const DEFAULT_SPEC = {
  contract_size: 1000,
  tick_size: 0.05,
  initial_margin: 7900,
  maintenance_margin: 6100,
  fee_per_lot: 30,
  tax_rate: 0.00002,
  rollover_days: 7,
  liquidation_ratio: 0.25,
};

function num(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}
function str(v, fb = '') { return typeof v === 'string' ? v : fb; }
function safeMonth(v) {
  const s = str(v).replace(/[^0-9]/g, '');
  return /^\d{6}$/.test(s) ? s : '';
}
function safeDate(v) {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function sanitizeSpec(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    contract_size: Math.max(1, num(o.contract_size, DEFAULT_SPEC.contract_size)),
    tick_size: Math.max(0.0001, num(o.tick_size, DEFAULT_SPEC.tick_size)),
    initial_margin: Math.max(0, num(o.initial_margin, DEFAULT_SPEC.initial_margin)),
    maintenance_margin: Math.max(0, num(o.maintenance_margin, DEFAULT_SPEC.maintenance_margin)),
    fee_per_lot: Math.max(0, num(o.fee_per_lot, DEFAULT_SPEC.fee_per_lot)),
    tax_rate: Math.max(0, num(o.tax_rate, DEFAULT_SPEC.tax_rate)),
    rollover_days: Math.max(0, Math.round(num(o.rollover_days, DEFAULT_SPEC.rollover_days))),
    liquidation_ratio: Math.min(1, Math.max(0, num(o.liquidation_ratio, DEFAULT_SPEC.liquidation_ratio))),
  };
}

function sanitizePositions(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  val.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const month = safeMonth(p.month);
    if (!month) return;
    const side = p.side === 'short' ? 'short' : 'long';
    const lots = Math.max(0, num(p.lots, 0));
    const entry_price = Math.max(0, num(p.entry_price, 0));
    const entry_date = safeDate(p.entry_date);
    const id = str(p.id) || `f_${month}_${side}_${i}_${lots}_${entry_price}`;
    const note = str(p.note);
    out.push({ id, month, side, lots, entry_price, entry_date, ...(note ? { note } : {}) });
  });
  return out;
}

function sanitizeClosed(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  val.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const month = safeMonth(t.month);
    if (!month) return;
    const side = t.side === 'short' ? 'short' : 'long';
    const lots = Math.max(0, num(t.lots, 0));
    const entry_price = Math.max(0, num(t.entry_price, 0));
    const exit_price = Math.max(0, num(t.exit_price, 0));
    const exit_date = safeDate(t.exit_date);
    const id = str(t.id) || `c_${month}_${side}_${i}_${lots}_${exit_price}`;
    const note = str(t.note);
    out.push({ id, month, side, lots, entry_price, exit_price, exit_date, ...(note ? { note } : {}) });
  });
  return out;
}

function sanitizeFutures(body) {
  const b = body && typeof body === 'object' ? body : {};
  const positions = sanitizePositions(b.positions);
  const ids = new Set(positions.map((p) => p.id));
  const stopIn = b.stop_loss && typeof b.stop_loss === 'object' ? b.stop_loss : {};
  const stop_loss = {};
  for (const k of Object.keys(stopIn)) {
    if (!ids.has(k)) continue;
    const p = num(stopIn[k], 0);
    if (p > 0) stop_loss[k] = p;
  }
  return {
    contract: str(b.contract, 'SRF') || 'SRF',
    price: Math.max(0, num(b.price, 0)),
    price_month: safeMonth(b.price_month),
    price_as_of: safeDate(b.price_as_of),
    cash: num(b.cash, 0), // 權益數可為負（穿價），不 clamp
    spec: sanitizeSpec(b.spec),
    positions,
    closed: sanitizeClosed(b.closed),
    stop_loss,
  };
}

router.get('/api/futures/positions', (req, res) => {
  try {
    if (!fs.existsSync(POSITIONS_PATH)) {
      return res.json({ exists: false, futures: null, saved_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf-8'));
    return res.json({
      exists: true,
      futures: sanitizeFutures(parsed),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取期貨部位檔失敗: ' + err.message));
  }
});

router.post('/api/futures/positions', (req, res) => {
  try {
    const clean = sanitizeFutures(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = POSITIONS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...clean, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, POSITIONS_PATH);
    return res.json({ ok: true, futures: clean, saved_at });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存期貨部位失敗: ' + err.message));
  }
});

// ── 期交所每日行情 ──────────────────────────────────────────────────────────
const TAIFEX_URL = 'https://openapi.taifex.com.tw/v1/DailyMarketReportFut';
const QUOTE_TTL_MS = 10 * 60 * 1000; // 每日行情一天只變一次，快取 10 分鐘足夠擋掉連點
let quoteCache = { at: 0, key: '', data: null };

function pickNum(v) {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * 期交所回傳的一列＝一個「商品 × 月份 × 交易時段」。要注意兩件事：
 *   1. 同一月份有「一般交易時段」與「盤後（夜盤）」兩列，只有一般時段有結算價
 *      （盤後那列 SettlementPrice 是 'NULL'），故以「有結算價」判定日盤那列。
 *   2. 價差契約的月份長這樣：'202608/202609'，要濾掉，否則會被當成一個到期月份。
 */
function parseRows(rows, contract) {
  const byMonth = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (str(r.Contract).trim() !== contract) continue;
    const month = str(r['ContractMonth(Week)']).trim();
    if (!/^\d{6}$/.test(month)) continue; // 濾掉價差契約與週別合約
    const settlement = pickNum(r.SettlementPrice);
    const isDaySession = settlement !== null;
    const prev = byMonth.get(month);
    // 日盤那列優先；沒有日盤資料時才用夜盤的成交價墊著
    if (prev && prev._day && !isDaySession) continue;
    byMonth.set(month, {
      month,
      date: str(r.Date).trim(),
      last: pickNum(r.Last),
      settlement,
      open: pickNum(r.Open),
      high: pickNum(r.High),
      low: pickNum(r.Low),
      change: pickNum(r.Change),
      volume: pickNum(r.Volume),
      open_interest: pickNum(r.OpenInterest),
      best_bid: pickNum(r.BestBid),
      best_ask: pickNum(r.BestAsk),
      _day: isDaySession,
    });
  }
  return [...byMonth.values()]
    .map(({ _day, ...rest }) => rest)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

// GET /api/futures/quote?contract=SRF
// 回傳該商品所有到期月份的每日行情。前端拿來填現價、列到期月份選單、算轉倉價差。
router.get('/api/futures/quote', async (req, res) => {
  const contract = (str(req.query.contract, 'SRF') || 'SRF').toUpperCase().slice(0, 6);
  const now = Date.now();
  if (quoteCache.data && quoteCache.key === contract && now - quoteCache.at < QUOTE_TTL_MS) {
    return res.json({ ...quoteCache.data, cached: true });
  }
  try {
    const r = await fetch(TAIFEX_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'puhui-review-web/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      return sendError(res, httpError(502, 'TAIFEX', `期交所回應 HTTP ${r.status}`));
    }
    const rows = await r.json();
    const months = parseRows(rows, contract);
    if (!months.length) {
      return sendError(res, httpError(404, 'TAIFEX', `期交所今日行情沒有 ${contract} 的資料`));
    }
    const data = {
      contract,
      // 期交所給的是民國/西元 yyyymmdd 字串，轉成 'YYYY-MM-DD' 方便前端直接用
      date: months[0].date && months[0].date.length === 8
        ? `${months[0].date.slice(0, 4)}-${months[0].date.slice(4, 6)}-${months[0].date.slice(6, 8)}`
        : '',
      months,
      fetched_at: new Date().toISOString(),
    };
    quoteCache = { at: now, key: contract, data };
    return res.json(data);
  } catch (err) {
    return sendError(res, httpError(502, 'TAIFEX', '抓取期交所行情失敗: ' + err.message));
  }
});

module.exports = router;
