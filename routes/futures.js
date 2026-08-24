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

/**
 * 截圖匯入用的來源指紋。**這是白名單，漏加欄位會被安靜吃掉**（opt29 踩過），
 * 而 ref 一旦掉了，下次匯入同一張截圖就會認不出「這筆吃過了」而重複計帳。
 */
function safeRef(v) {
  return str(v).slice(0, 160);
}

/** 券商實收費用：非負有限數才留，其餘回 null 代表「沒這個資料，請用 spec 推估」 */
function feeOrNull(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 商品代碼：大寫英數，上限比舊版帳戶代碼的 6 碼寬一些（自建個股期貨代碼可能更長） */
function safeProductCode(v, fb) {
  const s = str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return s || (fb || '');
}

function sanitizePositions(val, codes, defaultCode) {
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
    const rawProduct = safeProductCode(p.product);
    const product = rawProduct && codes.includes(rawProduct) ? rawProduct : defaultCode;
    const id = str(p.id) || `f_${product}_${month}_${side}_${i}_${lots}_${entry_price}`;
    const note = str(p.note);
    const ref = safeRef(p.ref);
    out.push({
      id, product, month, side, lots, entry_price, entry_date,
      ...(note ? { note } : {}),
      ...(ref ? { ref } : {}),
    });
  });
  return out;
}

function sanitizeClosed(val, codes, defaultCode) {
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
    const entry_date = safeDate(t.entry_date);
    const rawProduct = safeProductCode(t.product);
    const product = rawProduct && codes.includes(rawProduct) ? rawProduct : defaultCode;
    const id = str(t.id) || `c_${product}_${month}_${side}_${i}_${lots}_${exit_price}`;
    const note = str(t.note);
    const ref = safeRef(t.ref);
    const fee = feeOrNull(t.fee);
    const tax = feeOrNull(t.tax);
    out.push({
      id, product, month, side, lots, entry_price, exit_price, exit_date,
      ...(entry_date ? { entry_date } : {}),
      ...(note ? { note } : {}),
      ...(ref ? { ref } : {}),
      ...(fee !== null ? { fee } : {}),
      ...(tax !== null ? { tax } : {}),
    });
  });
  return out;
}

/**
 * 帳戶資金進出（入金／出金）流水帳。
 *
 * 金額一律存正數、方向存在 type：舊資料若把出金存成負數，取絕對值後方向仍由
 * type 決定，不會變成「負的出金＝入金」。沒有日期或金額 ≤ 0 的丟掉——沒有日期
 * 就沒辦法歸到權益曲線的哪一段，留著只會讓報酬率算錯。
 */
function sanitizeCashFlows(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  val.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const date = safeDate(f.date);
    if (!date) return;
    const amount = Math.abs(num(f.amount, 0));
    if (!(amount > 0)) return;
    const type = f.type === 'withdraw' ? 'withdraw' : 'deposit';
    const id = str(f.id) || `cf_${date}_${type}_${i}_${amount}`;
    const note = str(f.note).slice(0, 100);
    out.push({ id, date, type, amount, ...(note ? { note } : {}) });
  });
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// 建倉試算與存股比較的參數：純規劃用，但一樣要跟著雲端走，換裝置才不會歸零。
// 每個欄位都 clamp 在合理區間，手改壞檔案也不會讓前端算出 NaN。
const DEFAULT_PLANNER = {
  capital: 0,
  target_leverage: 1.2,
  gain_pct: 0.2,
  reserve_multiple: 2.5,
  trailing_peak: 0,
  trailing_dist: 2,
  plan_base_leverage: 1.2,
  plan_peak: 0,
  stress_drops: [-0.05, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3],
};


const clamp = (v, lo, hi, fb) => Math.min(hi, Math.max(lo, num(v, fb)));

// 各月份報價：key 必須是 'YYYYMM'、價格 > 0。不同月份是不同合約不同價格，
// 全部套同一個數字會讓多月份持倉的損益與追繳價一起偏掉。
function sanitizePrices(v) {
  const o = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const [k, val] of Object.entries(o)) {
    const m = safeMonth(k);
    if (!m) continue;
    const p = num(val, 0);
    if (p > 0) out[m] = p;
  }
  return out;
}

function sanitizeBatches(v) {
  const arr = Array.isArray(v) ? v : [];
  const out = arr.slice(0, 6).map((b) => {
    const o = b && typeof b === 'object' ? b : {};
    return { price: Math.max(0, num(o.price, 0)), lots: Math.max(0, num(o.lots, 0)) };
  });
  while (out.length < 3) out.push({ price: 0, lots: 0 });
  return out;
}

function sanitizePlanner(v) {
  const o = v && typeof v === 'object' ? v : {};
  // 負值＝上漲情境（空單那一側），故區間是 (−1, 1)
  const drops = [...new Set((Array.isArray(o.stress_drops) ? o.stress_drops : [])
    .map((d) => num(d, NaN))
    .filter((d) => Number.isFinite(d) && d > -1 && d < 1 && d !== 0))]
    .slice(0, 14)
    .sort((a, b) => a - b);
  return {
    capital: Math.max(0, num(o.capital, DEFAULT_PLANNER.capital)),
    target_leverage: clamp(o.target_leverage, 0.1, 10, DEFAULT_PLANNER.target_leverage),
    gain_pct: clamp(o.gain_pct, -0.9, 5, DEFAULT_PLANNER.gain_pct),
    reserve_multiple: clamp(o.reserve_multiple, 1, 10, DEFAULT_PLANNER.reserve_multiple),
    trailing_peak: Math.max(0, num(o.trailing_peak, DEFAULT_PLANNER.trailing_peak)),
    trailing_dist: Math.max(0, num(o.trailing_dist, DEFAULT_PLANNER.trailing_dist)),
    plan_base_leverage: clamp(o.plan_base_leverage, 0.1, 5, DEFAULT_PLANNER.plan_base_leverage),
    plan_peak: Math.max(0, num(o.plan_peak, DEFAULT_PLANNER.plan_peak)),
    batches: sanitizeBatches(o.batches),
    stress_drops: drops.length ? drops : [...DEFAULT_PLANNER.stress_drops],
  };
}


/**
 * 截圖匯入已經吃過的成交指紋。只留最近 300 筆，免得這個檔案被無限追加撐大。
 * 這欄位掉了不會壞畫面，但同一張截圖會被重複匯入一次——所以它必須在白名單裡。
 */
const MAX_IMPORTED_REFS = 300;
function sanitizeRefs(val) {
  if (!Array.isArray(val)) return [];
  const out = val.map((x) => str(x).slice(0, 160)).filter(Boolean);
  return [...new Set(out)].slice(-MAX_IMPORTED_REFS);
}

/**
 * 一個商品的完整設定。個股期貨跟 SRF/NYF 一樣沒有 OpenAPI 保證金端點，契約規格
 * 一律由前端手動輸入送上來——這裡只 clamp／補預設值，不驗證數字合不合理。
 */
function sanitizeProduct(v, code) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    code,
    name: str(o.name) || code,
    quote_contract: safeProductCode(o.quote_contract, code) || code,
    underlying: str(o.underlying),
    spec: sanitizeSpec(o.spec),
    beta: clamp(o.beta, 0.01, 5, 1),
    index_ref: Math.max(0, num(o.index_ref, 0)),
    index_linked: Boolean(o.index_linked),
    price: Math.max(0, num(o.price, 0)),
    prices: sanitizePrices(o.prices),
    price_month: safeMonth(o.price_month),
    price_as_of: /^\d{4}-\d{2}-\d{2}/.test(str(o.price_as_of)) ? str(o.price_as_of) : '',
    price_source: o.price_source === 'live' ? 'live' : (o.price_source === 'manual' ? 'manual' : 'daily'),
    is_custom: Boolean(o.is_custom),
  };
}

function sanitizeProducts(v) {
  const o = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const [k, val] of Object.entries(o)) {
    const code = safeProductCode(k);
    if (!code) continue;
    out[code] = sanitizeProduct(val, code);
  }
  return out;
}

/**
 * 舊格式遷移：8/24 以前存的帳戶設定整包只有一組 `contract`/`spec`/`beta`/
 * `index_ref`/`prices`，把它們包成 products 表裡的單一商品。VM 正式站現在存的
 * 就是這個格式——遷移錯了會讓既有 SRF 部位的保證金/風險指標跟遷移前對不起來，
 * 這段動了要先跑 review-web 的 futures.test.ts 遷移回歸案例再部署。
 */
function legacyProduct(b) {
  const code = safeProductCode(b.contract, 'SRF') || 'SRF';
  return {
    code,
    product: {
      code,
      name: code,
      quote_contract: code,
      underlying: '',
      spec: sanitizeSpec(b.spec),
      beta: clamp(b.beta, 0.01, 5, 1),
      index_ref: Math.max(0, num(b.index_ref, 0)),
      index_linked: false,
      price: Math.max(0, num(b.price, 0)),
      prices: sanitizePrices(b.prices),
      price_month: safeMonth(b.price_month),
      price_as_of: /^\d{4}-\d{2}-\d{2}/.test(str(b.price_as_of)) ? str(b.price_as_of) : '',
      price_source: b.price_source === 'live' ? 'live' : 'daily',
      is_custom: false,
    },
  };
}

function sanitizeFutures(body) {
  const b = body && typeof body === 'object' ? body : {};

  const rawProducts = b.products;
  const hasNewShape = Boolean(rawProducts && typeof rawProducts === 'object' && Object.keys(rawProducts).length > 0);
  let products;
  let migratedDefaultCode = '';
  if (hasNewShape) {
    products = sanitizeProducts(rawProducts);
  } else {
    const legacy = legacyProduct(b);
    products = { [legacy.code]: legacy.product };
    migratedDefaultCode = legacy.code;
  }
  if (Object.keys(products).length === 0) {
    const legacy = legacyProduct({});
    products = { [legacy.code]: legacy.product };
    migratedDefaultCode = legacy.code;
  }
  const codes = Object.keys(products);
  const wantedActive = safeProductCode(b.active_product);
  const active_product = codes.includes(wantedActive)
    ? wantedActive
    : (migratedDefaultCode && codes.includes(migratedDefaultCode) ? migratedDefaultCode : codes[0]);

  const positions = sanitizePositions(b.positions, codes, active_product);
  const ids = new Set(positions.map((p) => p.id));
  const stopIn = b.stop_loss && typeof b.stop_loss === 'object' ? b.stop_loss : {};
  const stop_loss = {};
  for (const k of Object.keys(stopIn)) {
    if (!ids.has(k)) continue;
    const p = num(stopIn[k], 0);
    if (p > 0) stop_loss[k] = p;
  }

  // planner 舊格式是單一物件（沒有逐商品 key）；新格式才是 `{ [code]: PlannerConfig }`
  const plannerIn = b.planner && typeof b.planner === 'object' ? b.planner : {};
  const planner = {};
  if (hasNewShape) {
    for (const c of codes) planner[c] = sanitizePlanner(plannerIn[c]);
  } else {
    for (const c of codes) planner[c] = c === active_product ? sanitizePlanner(plannerIn) : sanitizePlanner({});
  }

  return {
    products,
    active_product,
    cash: num(b.cash, 0), // 權益數可為負（穿價），不 clamp
    positions,
    closed: sanitizeClosed(b.closed, codes, active_product),
    cash_flows: sanitizeCashFlows(b.cash_flows),
    stop_loss,
    planner,
    imported_refs: sanitizeRefs(b.imported_refs),
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

// ── 期交所每日行情與即時報價 ──────────────────────────────────────────────────
const TAIFEX_URL = 'https://openapi.taifex.com.tw/v1/DailyMarketReportFut';
const TAIFEX_MIS_URL = process.env.TAIFEX_MIS_URL
  || 'https://mis.taifex.com.tw/futures/api/getQuoteDetail';

const CONTRACT_TO_MIS = {
  'SRF': 'SRF',
  'NYF': 'NYF',
  'TX': 'TXF',
  'MTX': 'MXF',
  'TMF': 'TMF'
};
const MONTH_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
const QUOTE_TTL_LIVE_MS = 20 * 1000;
const QUOTE_TTL_CLOSED_MS = 10 * 60 * 1000;
const DAILY_TTL_MS = 10 * 60 * 1000;

let dailyRawCache = { at: 0, rows: null };
let liveQuoteCache = {}; // keyed by contract: { at, data, live_as_of }

function pickNum(v) {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

const FRESH_MS = 5 * 60 * 1000;

/** 報價時間距離某個時刻在 5 分鐘內＝那時候市場正在動。休市日也能正確判為 false。 */
function isFresh(liveAsOf, atMs) {
  if (!liveAsOf) return false;
  const t = new Date(liveAsOf).getTime();
  return Number.isFinite(t) && atMs - t < FRESH_MS;
}

/**
 * 快取要放多久。
 *
 * 關鍵是拿 **cachedAt**（抓的當下）而不是 now 去問「市場在不在動」。用 now 會變成
 * 循環：只要沒人請求超過 5 分鐘，這份資料就自己老到過門檻、被判成「非即時」而升級
 * 成 10 分鐘 TTL，接著在夜盤正熱的時候繼續放送舊價。2026-08-05 00:04 實測踩到——
 * 23:57 抓的資料在 00:04 被當成收盤資料續發，同一時間 MIS 上 00:03:45 才剛成交。
 */
function cacheTtlFor(cachedAt, liveAsOf, hadError) {
  return (isFresh(liveAsOf, cachedAt) || hadError) ? QUOTE_TTL_LIVE_MS : QUOTE_TTL_CLOSED_MS;
}

function getPreferredSession(tpeDate) {
  const hh = tpeDate.getUTCHours();
  const mm = tpeDate.getUTCMinutes();
  const timeVal = hh * 60 + mm;
  return (timeVal >= 525 && timeVal < 900) ? 'day' : 'night';
}

function getValidQuote(q) {
  if (!q) return null;
  const lastPrice = parseFloat(q.CLastPrice);
  const time = q.CTime;
  if (Number.isFinite(lastPrice) && lastPrice > 0 && typeof time === 'string' && time.trim() !== '') {
    return {
      price: lastPrice,
      refPrice: parseFloat(q.CRefPrice) || null,
      volume: parseInt(q.CTotalVolume, 10) || 0,
      bid: parseFloat(q.CBestBidPrice) || null,
      ask: parseFloat(q.CBestAskPrice) || null,
      date: q.CDate,
      time: q.CTime
    };
  }
  return null;
}

/**
 * 把 MIS 的 CTime（HHMMSS）組成帶時區的時間戳。
 *
 * 刻意**不用 CDate**：夜盤跨過午夜之後期交所是回開盤日還是當日，官方沒文件，
 * 白天也驗不出來（22:14 與 23:41 兩次實測都是 20260804，兩種語意都成立）。
 * 而 CDate 一旦是開盤日，凌晨 00:30 夜盤正熱時 live_time 會變成 24 小時前，
 * 連帶 live_as_of → intraday → 快取 TTL → 狀態列文案全部跟著錯。
 *
 * 各時段的行情板每天都會重置（實測：8/3 有成交的 SRFF7，8/4 沒成交就回空，
 * 不會殘留前一天的價），所以 CTime 必定落在「現在往前推 24 小時」內——
 * 用台北時鐘反推日期比賭 CDate 的語意可靠：報價時刻若看起來比現在還晚，
 * 那就是昨天的（夜盤時 -F 板留著的是昨天下午的成交）。
 */
function liveTimeFromClock(ctime, nowMs = Date.now()) {
  if (typeof ctime !== 'string') return null;
  // 先驗後補零：直接 padStart 的話空字串會變成 '000000'，一筆沒有時間的報價
  // 會被講成「今天午夜成交」。實測 MIS 給的是補滿的 6 碼（094459），5 碼是保險。
  const raw = ctime.trim();
  if (!/^\d{5,6}$/.test(raw)) return null;
  const ct = raw.padStart(6, '0');

  const tpe = new Date(nowMs + 8 * 3600 * 1000);
  const quoteSec = Number(ct.slice(0, 2)) * 3600 + Number(ct.slice(2, 4)) * 60 + Number(ct.slice(4, 6));
  const nowSec = tpe.getUTCHours() * 3600 + tpe.getUTCMinutes() * 60 + tpe.getUTCSeconds();
  // 留 120 秒容差，免得 VM 與期交所之間幾秒的時鐘差把剛成交的報價推成昨天
  const shifted = new Date(tpe.getTime() + (quoteSec > nowSec + 120 ? -86400000 : 0));

  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T${ct.slice(0, 2)}:${ct.slice(2, 4)}:${ct.slice(4, 6)}+08:00`;
}

function monthToSymbol(contract, monthStr) {
  const misCode = CONTRACT_TO_MIS[contract];
  if (!misCode) return null;
  const year = parseInt(monthStr.slice(0, 4), 10);
  const monthNum = parseInt(monthStr.slice(4, 6), 10);
  if (!Number.isFinite(year) || !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return null;
  const yearCode = String(year % 10);
  const monthCode = MONTH_CODES[monthNum - 1];
  return misCode + monthCode + yearCode;
}

function symbolToMonth(symbol) {
  const cleanSymbol = symbol.split('-')[0];
  const len = cleanSymbol.length;
  if (len < 3) return null;
  const yearCodeStr = cleanSymbol.slice(len - 1);
  const monthCodeStr = cleanSymbol.slice(len - 2, len - 1);

  const yearDigit = parseInt(yearCodeStr, 10);
  const monthIdx = MONTH_CODES.indexOf(monthCodeStr);
  if (!Number.isFinite(yearDigit) || monthIdx === -1) return null;

  const monthNum = monthIdx + 1;
  const monthStr = String(monthNum).padStart(2, '0');
  const year = 2020 + yearDigit;
  return `${year}${monthStr}`;
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
// 回傳該商品所有到期月份的每日行情與即時報價。前端拿來填現價、列到期月份選單、算轉倉價差。
router.get('/api/futures/quote', async (req, res) => {
  const contract = (str(req.query.contract, 'SRF') || 'SRF').toUpperCase().slice(0, 6);
  const now = Date.now();

  // 1. Cache hit check
  const cached = liveQuoteCache[contract];
  if (cached) {
    const cachedTpe = new Date(cached.at + 8 * 3600 * 1000);
    const currentTpe = new Date(now + 8 * 3600 * 1000);
    const sameSession = getPreferredSession(cachedTpe) === getPreferredSession(currentTpe);

    if (sameSession) {
      const ttl = cacheTtlFor(cached.at, cached.live_as_of, !!cached.data.live_error);
      if (now - cached.at < ttl) {
        // intraday 是「這次回應」的性質，照現在的時間重算（見 routes/market.js 同一個坑）
        return res.json({
          ...cached.data,
          intraday: isFresh(cached.live_as_of, now),
          cached: true
        });
      }
    }
  }

  let months = [];
  let date = '';

  // 2. Fetch or reuse daily market report
  try {
    // 新鮮度只看 dailyRawCache.at，不能看 parseRows 的結果——「這份檔裡沒有這個商品」
    // 跟「快取過期」是兩件事，混在一起的話不認識的 contract 會每次請求都重抓 815 KB。
    if (!dailyRawCache.rows || now - dailyRawCache.at >= DAILY_TTL_MS) {
      const r = await fetch(TAIFEX_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'puhui-review-web/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        return sendError(res, httpError(502, 'TAIFEX', `期交所回應 HTTP ${r.status}`));
      }
      dailyRawCache = { at: now, rows: await r.json() };
    }

    months = parseRows(dailyRawCache.rows, contract);
    if (months.length > 0) {
      date = months[0].date;
    }

    if (!months.length) {
      return sendError(res, httpError(404, 'TAIFEX', `期交所今日行情沒有 ${contract} 的資料`));
    }
  } catch (err) {
    return sendError(res, httpError(502, 'TAIFEX', '抓取期交所行情失敗: ' + err.message));
  }

  let live_error = null;
  let live_source = null;
  let updatedMonths = months.map(m => ({
    ...m,
    live: null,
    live_session: null,
    live_time: null,
    live_volume: null,
    live_bid: null,
    live_ask: null
  }));

  // 3. Fetch live details from MIS
  const misCode = CONTRACT_TO_MIS[contract];
  if (misCode) {
    try {
      const symbolIDs = [];
      for (const m of months) {
        const baseSymbol = monthToSymbol(contract, m.month);
        if (baseSymbol) {
          symbolIDs.push(`${baseSymbol}-F`, `${baseSymbol}-M`);
        }
      }

      const misRes = await fetch(TAIFEX_MIS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://mis.taifex.com.tw/futures/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ SymbolID: symbolIDs }),
        signal: AbortSignal.timeout(10000)
      });

      if (!misRes.ok) {
        throw new Error(`MIS 回應 HTTP ${misRes.status}`);
      }
      const misJson = await misRes.json();
      if (misJson.RtCode !== '0') {
        throw new Error(misJson.RtMsg || `MIS RtCode ${misJson.RtCode}`);
      }

      const quoteLookup = new Map();
      for (const q of (misJson.RtData?.QuoteList || [])) {
        if (q && q.SymbolID) {
          quoteLookup.set(q.SymbolID, q);
        }
      }

      const tpe = new Date(Date.now() + 8 * 3600 * 1000);
      const hh = tpe.getUTCHours();
      const mm = tpe.getUTCMinutes();
      const timeVal = hh * 60 + mm;

      live_source = 'taifex-mis';

      updatedMonths = months.map(m => {
        const baseSymbol = monthToSymbol(contract, m.month);
        if (!baseSymbol) {
          return {
            ...m,
            live: null,
            live_session: null,
            live_time: null,
            live_volume: null,
            live_bid: null,
            live_ask: null
          };
        }
        const symbolF = `${baseSymbol}-F`;
        const symbolM = `${baseSymbol}-M`;

        const qF = getValidQuote(quoteLookup.get(symbolF));
        const qM = getValidQuote(quoteLookup.get(symbolM));

        let pickedSession = null;
        let pickedQuote = null;

        if (timeVal >= 525 && timeVal < 900) { // 08:45 <= t < 15:00
          if (qF) {
            pickedSession = 'day';
            pickedQuote = qF;
          } else if (qM) {
            pickedSession = 'night';
            pickedQuote = qM;
          }
        } else {
          if (qM) {
            pickedSession = 'night';
            pickedQuote = qM;
          } else if (qF) {
            pickedSession = 'day';
            pickedQuote = qF;
          }
        }

        if (pickedQuote) {
          return {
            ...m,
            live: pickedQuote.price,
            live_session: pickedSession,
            live_time: liveTimeFromClock(pickedQuote.time),
            live_volume: pickedQuote.volume,
            live_bid: pickedQuote.bid,
            live_ask: pickedQuote.ask
          };
        }
        return {
          ...m,
          live: null,
          live_session: null,
          live_time: null,
          live_volume: null,
          live_bid: null,
          live_ask: null
        };
      });
    } catch (err) {
      live_error = err.message;
    }
  }

  // Find live_as_of (newest live_time among all months)
  let live_as_of = null;
  for (const m of updatedMonths) {
    if (m.live_time) {
      if (!live_as_of || m.live_time > live_as_of) {
        live_as_of = m.live_time;
      }
    }
  }

  const formattedDate = date && date.length === 8
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : '';

  const data = {
    contract,
    date: formattedDate,
    live_source,
    live_as_of,
    live_error,
    months: updatedMonths,
    fetched_at: new Date().toISOString(),
  };

  // Store to cache
  liveQuoteCache[contract] = {
    at: now,
    data,
    live_as_of
  };

  const dynamicIntraday = isFresh(live_as_of, Date.now());

  return res.json({
    ...data,
    intraday: dynamicIntraday,
    cached: false
  });
});

// ── 期交所保證金自動同步 ──────────────────────────────────────────────────
const MARGINS_CACHE_PATH = path.join(DATA_DIR, 'taifex_margins.json');
const MARGINS_TTL_MS = 6 * 60 * 60 * 1000;
// 退回磁碟快取時只快取 15 分鐘：保證金直接決定追繳價，期交所一次暫時性失敗
// 不該讓我們接下來六小時都不再去問。
const MARGINS_STALE_TTL_MS = 15 * 60 * 1000;
// 覆寫用途只有一個：測「期交所掛掉時會不會正確標 stale」。同 FUTURES_POSITIONS_PATH
// 的用法——沒有辦法讓外部 API 按需失敗，就得留一個可以指向壞掉端點的開關。
const MARGINS_URL = process.env.TAIFEX_MARGINS_URL
  || 'https://openapi.taifex.com.tw/v1/IndexFuturesAndOptionsMargining';
let marginsCache = { at: 0, data: null, stale: false };

const MARGIN_NAME_TO_CODE = {
  '臺股期貨': 'TX',
  '小型臺指': 'MTX',
  '微型臺指期貨': 'TMF',
};

function parseTaifexDate(v) {
  const s = str(v).trim().replace(/[^0-9]/g, '');
  if (s.length === 8) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (s.length === 7) {
    return rocToIso(s) || '';
  }
  return '';
}

// GET /api/futures/margins —— 期交所保證金
router.get('/api/futures/margins', async (req, res) => {
  const now = Date.now();
  const ttl = marginsCache.stale ? MARGINS_STALE_TTL_MS : MARGINS_TTL_MS;
  if (marginsCache.data && now - marginsCache.at < ttl) {
    // stale 要跟著記憶體快取一起帶出去。少了這個旗標，一次抓取失敗之後的每個
    // 命中都會把磁碟上的舊保證金講成當前值，而前端就是靠它決定要不要警告。
    return res.json({ ...marginsCache.data, cached: true, stale: marginsCache.stale });
  }

  const serveDisk = (reason) => {
    try {
      if (fs.existsSync(MARGINS_CACHE_PATH)) {
        const disk = JSON.parse(fs.readFileSync(MARGINS_CACHE_PATH, 'utf-8'));
        const stale = { ...disk, stale_reason: reason };
        marginsCache = { at: now, data: stale, stale: true };
        return res.json({ ...stale, cached: false, stale: true });
      }
    } catch { /* 快取檔壞掉就當沒有 */ }
    return sendError(res, httpError(502, 'TAIFEX', '抓取期交所保證金失敗: ' + reason));
  };

  try {
    const r = await fetch(MARGINS_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'puhui-review-web/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      return serveDisk(`HTTP ${r.status}`);
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return serveDisk('回應沒有可用的保證金資料');
    }

    const margins = {};
    const unmappedSet = new Set();
    const dates = [];

    for (const r of rows) {
      const name = str(r.Contract).trim();
      if (!name) continue;

      const code = MARGIN_NAME_TO_CODE[name];
      const initial = parseFloat(r.InitialMargin);
      const maintenance = parseFloat(r.MaintenanceMargin);
      const clearing = parseFloat(r.ClearingMargin);
      const dateStr = parseTaifexDate(r.Date);

      if (code) {
        if (!Number.isFinite(initial) || !Number.isFinite(maintenance) || !Number.isFinite(clearing)) {
          continue;
        }
        if (initial < maintenance) {
          unmappedSet.add(name);
          continue;
        }
        margins[code] = {
          initial,
          maintenance,
          clearing,
          contract_name: name,
        };
        if (dateStr) {
          dates.push(dateStr);
        }
      } else {
        unmappedSet.add(name);
      }
    }

    if (Object.keys(margins).length === 0) {
      return serveDisk('無有效的指數類保證金資料');
    }

    const date = dates[0] || parseTaifexDate(rows[0].Date) || '';

    // cached / stale 是「這次回應」的性質，不是資料本身的性質，所以不落地——
    // 否則下次從磁碟讀回來會夾帶一個寫死的 stale:false。
    const data = {
      date,
      source: 'taifex-openapi',
      fetched_at: new Date().toISOString(),
      margins,
      unmapped: [...unmappedSet],
    };

    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = MARGINS_CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, MARGINS_CACHE_PATH);
    } catch (e) {
      // 落地失敗不影響這次回應
    }

    marginsCache = { at: now, data, stale: false };
    return res.json({ ...data, cached: false, stale: false });
  } catch (err) {
    return serveDisk(err.message);
  }
});

// ── 權益數歷史（scripts/futures_alert.cjs 每日寫入）──────────────────────────
//
// 只讀不寫：寫入端是排程腳本，網頁改設定不該動到歷史紀錄。檔案不存在（還沒跑過
// 任何一天）時回空陣列而不是 404，前端才好處理「還沒有資料」的空態。
const EQUITY_HISTORY_PATH = path.join(DATA_DIR, 'futures_equity_history.json');

router.get('/api/futures/equity-history', (req, res) => {
  try {
    if (!fs.existsSync(EQUITY_HISTORY_PATH)) {
      return res.json({ exists: false, rows: [], updated_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(EQUITY_HISTORY_PATH, 'utf-8'));
    const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
      .filter((r) => r && safeDate(r.date))
      .map((r) => ({
        date: safeDate(r.date),
        equity: num(r.equity, 0),
        cash: num(r.cash, 0),
        unrealized: num(r.unrealized, 0),
        contract_value: num(r.contract_value, 0),
        net_lots: num(r.net_lots, 0),
        total_lots: num(r.total_lots, 0),
        risk_indicator: Number.isFinite(num(r.risk_indicator, NaN)) ? num(r.risk_indicator, 0) : null,
        price: num(r.price, 0),
        status: str(r.status, 'ok'),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return res.json({
      exists: true,
      rows,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取權益數歷史失敗: ' + err.message));
  }
});

// ── 台股休市日曆 ────────────────────────────────────────────────────────────
//
// 路徑掛在 /api/market/* 底下（語意上是全市場資料），但**實作放這個檔案**：
// routes/market.js 整支都是 Python engine 的代理，而期貨頁刻意不依賴 engine，
// 期貨的最後交易日又非有假日曆不可，所以放在同樣 engine-free 的這裡。
//
// 來源：證交所 OpenAPI（公開、免金鑰）。只給**當年度**，跨年的月份查不到，
// 前端會退回純「第三個星期三」規則並標示未經假日校正。
const TWSE_HOLIDAY_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
const HOLIDAY_TTL_MS = 6 * 60 * 60 * 1000; // 一年才變一次，快取半天綽綽有餘
const HOLIDAY_CACHE_PATH = path.join(DATA_DIR, 'twse_holidays.json');
let holidayCache = { at: 0, data: null, stale: false };

/** 民國日期字串 '1150101' → '2026-01-01'；格式不對回 null */
function rocToIso(v) {
  const s = str(v).trim();
  const m = /^(\d{3,4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2]}-${m[3]}`;
}

/**
 * 證交所這份清單裡混了**兩種**列：真正的休市日，以及「國曆新年開始交易日」
 * 「農曆春節前最後交易日」「農曆春節後開始交易日」這種**有開盤**的標記列。
 * 名稱含「交易日」的都是後者，必須排除，否則會把開盤日當成休市日。
 * 「市場無交易，僅辦理結算交割作業」不含「交易日」三字，會正確留下。
 */
function parseHolidays(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = str(r && r.Name);
    if (name.includes('交易日')) continue;
    const iso = rocToIso(r && r.Date);
    if (iso) out.add(iso);
  }
  return [...out].sort();
}

// GET /api/market/holidays —— 台股休市日（當年度）
router.get('/api/market/holidays', async (req, res) => {
  const now = Date.now();
  if (holidayCache.data && now - holidayCache.at < HOLIDAY_TTL_MS) {
    return res.json({ ...holidayCache.data, cached: true, stale: holidayCache.stale });
  }
  const serveDisk = (reason) => {
    // 證交所掛掉時退回磁碟快取——假日曆一年才變一次，舊的一份仍然可用，
    // 比整個功能失效好。前端靠 stale 旗標決定要不要提醒，所以旗標要跟著進
    // 記憶體快取，不然後續的命中會把舊資料講成新鮮的。
    try {
      if (fs.existsSync(HOLIDAY_CACHE_PATH)) {
        const disk = JSON.parse(fs.readFileSync(HOLIDAY_CACHE_PATH, 'utf-8'));
        const stale = { ...disk, stale_reason: reason };
        holidayCache = { at: now, data: stale, stale: true };
        return res.json({ ...stale, stale: true });
      }
    } catch { /* 快取檔壞掉就當沒有 */ }
    return sendError(res, httpError(502, 'TWSE', '抓取證交所休市日曆失敗: ' + reason));
  };

  try {
    const r = await fetch(TWSE_HOLIDAY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'puhui-review-web/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return serveDisk(`HTTP ${r.status}`);
    const dates = parseHolidays(await r.json());
    if (!dates.length) return serveDisk('回應沒有可用的休市日');

    const data = {
      year: Number(dates[0].slice(0, 4)),
      dates,
      source: 'twse-openapi',
      fetched_at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = HOLIDAY_CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, HOLIDAY_CACHE_PATH);
    } catch { /* 落地失敗不影響這次回應 */ }
    holidayCache = { at: now, data, stale: false };
    return res.json({ ...data, stale: false });
  } catch (err) {
    return serveDisk(err.message);
  }
});

router.monthToSymbol = monthToSymbol;
router.symbolToMonth = symbolToMonth;
router.getValidQuote = getValidQuote;
router.liveTimeFromClock = liveTimeFromClock;
router.cacheTtlFor = cacheTtlFor;
router.isFresh = isFresh;
router.sanitizeCashFlows = sanitizeCashFlows;
router.sanitizeClosed = sanitizeClosed;
router.sanitizeRefs = sanitizeRefs;
router.sanitizePositions = sanitizePositions;
router.CONTRACT_TO_MIS = CONTRACT_TO_MIS;
router.MONTH_CODES = MONTH_CODES;

module.exports = router;
