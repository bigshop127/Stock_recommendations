#!/usr/bin/env node
/**
 * 期貨保證金追繳／轉倉 Email 告警 ＋ 每日權益數快照
 * ---------------------------------------------------------------------------
 * 每日收盤後做兩件事：
 *   1. 抓期交所每日行情 → 算風險指標 → 低於門檻或該轉倉了就寄 Email。
 *   2. 把當天的權益數寫進 data/futures_equity_history.json（畫淨值曲線用）。
 *
 * 為什麼期貨要有獨立告警（不併進 rebalance_alert.cjs）：
 *   再平衡晚一天處理沒事，期貨晚一天可能已經被斷頭。而且兩者的觸發條件、收件內容
 *   完全不同，硬併會讓兩邊都難改。
 *
 * 設計原則（比照 scripts/rebalance_alert.cjs，刻意獨立）：
 *   - 只用 Node 內建模組，零新依賴。
 *   - 完全不 require 也不改動 rebalance_alert.cjs / puhui_daily.cjs，
 *     只沿用同一組 Google OAuth env 與相同的 Gmail API 手法（各自複製一份）。
 *   - 部位讀 data/futures_positions.json（＝期貨頁「存到雲端」寫的那一份，
 *     前端與這支腳本共用同一個事實來源）。
 *   - 行情打本機 gateway 的 /api/futures/quote（它會代抓期交所並快取）。
 *   - 計算是 review-web/src/lib/futures.ts 的忠實移植，**逐月份取價**。
 *   - 去重：只在「等級變化」時寄（ok→warn→call→danger 任一方向），
 *     等級不變不重複轟炸；轉倉提醒另外記已通知過的月份。
 *
 * 用法：
 *   node scripts/futures_alert.cjs             正常執行（cron 用）
 *   node scripts/futures_alert.cjs --dry-run   只計算與印出，不寄信、不寫 state/快照
 *   node scripts/futures_alert.cjs --force     忽略去重，強制寄一次（驗證信箱用）
 *   node scripts/futures_alert.cjs --snapshot-only  只寫權益快照，不寄任何信
 *
 * 排程（VM crontab，週一~五 收盤後；VM 為 Asia/Taipei）：
 *   5 15 * * 1-5  cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/futures_alert.cjs >> data/futures_alert.log 2>&1
 *   （排在 rebalance_alert.cjs 的 15:00 之後，錯開避免同時打 gateway）
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── 先載入 .env（cron 環境通常沒有 export）──────────────────────────
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(p, 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch (_) { /* 無 .env 就靠既有環境變數 */ }
}
loadEnvFile();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'a4980678@gmail.com';
const GATEWAY_BASE = process.env.REVIEW_GATEWAY_BASE || 'http://localhost:3000';

// 自訂預警門檻，以**維持**保證金為基準：權益數低於維持保證金的 1.5 倍就先講一聲。
// 期交所管的兩條線（權益數＜維持＝追繳、風險指標＜25%＝斷頭）觸發時都已經太晚。
const WARN_RATIO = Math.max(1, Number(process.env.FUTURES_WARN_RATIO) || 1.5);

const DATA_DIR = path.join(__dirname, '..', 'data');
// 可覆寫路徑：測試時指到別的檔案，免得動到 production 那份（前端會從它載入）
const POSITIONS_PATH = process.env.FUTURES_POSITIONS_PATH || path.join(DATA_DIR, 'futures_positions.json');
// 三個路徑都可以用環境變數覆寫，理由同 FUTURES_POSITIONS_PATH：測告警與去重時
// 不該去動到真的狀態檔與真的權益數歷史。
const STATE_PATH = process.env.FUTURES_ALERT_STATE_PATH || path.join(DATA_DIR, 'futures_alert_state.json');
const HISTORY_PATH = process.env.FUTURES_EQUITY_HISTORY_PATH || path.join(DATA_DIR, 'futures_equity_history.json');
const LOG_PATH = path.join(DATA_DIR, 'futures_alert.log');
const HISTORY_MAX = 1500; // 約 6 年交易日，夠畫曲線又不會讓檔案無限長

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

// ── HTTP 工具 ────────────────────────────────────────────────────
function httpGetJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error('回傳非 JSON: ' + String(d).slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('請求逾時')));
  });
}

function httpsPostForm(hostname, pathName, body) {
  return new Promise((resolve, reject) => {
    const b = new URLSearchParams(body).toString();
    const req = https.request(
      { hostname, path: pathName, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject); req.write(b); req.end();
  });
}

// ── Gmail 寄信（沿用 puhui_daily.cjs 手法，獨立複製一份）────────────
async function getAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const r = await httpsPostForm('oauth2.googleapis.com', '/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  return r && r.access_token ? r.access_token : null;
}

const encodeSubject = (t) => '=?UTF-8?B?' + Buffer.from(t, 'utf-8').toString('base64') + '?=';

async function sendGmail(token, subject, textBody, htmlBody) {
  const boundary = '----b_' + Date.now();
  const raw = htmlBody
    ? [
      `From: ${NOTIFY_EMAIL}`, `To: ${NOTIFY_EMAIL}`, `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody,
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', htmlBody,
      `--${boundary}--`,
    ].join('\r\n')
    : [
      `From: ${NOTIFY_EMAIL}`, `To: ${NOTIFY_EMAIL}`, `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', textBody,
    ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await new Promise((resolve, reject) => {
    const b = JSON.stringify({ raw: encoded });
    const req = https.request(
      { hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Gmail API ${res.statusCode}: ${d.slice(0, 200)}`))));
      }
    );
    req.on('error', reject); req.write(b); req.end();
  });
}

// ── 期貨計算（移植自 review-web/src/lib/futures.ts）──────────────────
function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}
const sign = (side) => (side === 'short' ? -1 : 1);

/** 逐月份取價；該月沒行情時退回使用者手填的參考價 */
function priceOf(prices, fallback, month) {
  const v = prices && prices[month];
  return Number.isFinite(v) && v > 0 ? v : Math.max(0, safeNum(fallback, 0));
}

function positionPnl(pos, price, spec) {
  const lots = Math.max(0, safeNum(pos.lots, 0));
  const entry = Math.max(0, safeNum(pos.entry_price, 0));
  const p = Math.max(0, safeNum(price, 0));
  const unit = Math.max(1, safeNum(spec.contract_size, 1000));
  const s = sign(pos.side);
  const contract_value = p * unit * lots;
  const cost_value = entry * unit * lots;
  const gross = s * (p - entry) * unit * lots;
  const fees = Math.max(0, safeNum(spec.fee_per_lot, 0)) * lots * 2;
  const tax = (cost_value + contract_value) * Math.max(0, safeNum(spec.tax_rate, 0));
  return { contract_value, net_pnl: gross - fees - tax };
}

/**
 * 舊格式遷移：8/24 以前存的部位檔整包只有一組 `contract`/`spec`/`beta`/
 * `index_ref`/`price`/`prices`，這裡把它們包成 `products` 表裡的單一商品，跟
 * review-web 前端／gateway 的遷移邏輯（見 futuresStore.ts／routes/futures.js）
 * 對齊。這支只用來讀（不寫回檔案），所以不用做到跟前端一樣嚴格的白名單 clamp。
 */
function migrateFutures(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const codeOf = (v, fb) => {
    const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    return s || fb;
  };
  const rawProducts = f.products;
  const hasNewShape = Boolean(rawProducts && typeof rawProducts === 'object' && Object.keys(rawProducts).length > 0);
  const products = {};
  let defaultCode;
  if (hasNewShape) {
    for (const [k, p] of Object.entries(rawProducts)) {
      const code = codeOf(k, 'SRF');
      const o = p && typeof p === 'object' ? p : {};
      products[code] = {
        code,
        name: String(o.name || code),
        quote_contract: codeOf(o.quote_contract, code),
        spec: Object.assign({ contract_size: 1000, tick_size: 0.05, initial_margin: 0, maintenance_margin: 0, fee_per_lot: 0, tax_rate: 0, rollover_days: 7, liquidation_ratio: 0.25 }, o.spec || {}),
        beta: safeNum(o.beta, 1),
        index_ref: safeNum(o.index_ref, 0),
        price: safeNum(o.price, 0),
        prices: (o.prices && typeof o.prices === 'object') ? Object.assign({}, o.prices) : {},
      };
    }
    defaultCode = Object.keys(products)[0] || 'SRF';
  }
  if (Object.keys(products).length === 0) {
    const code = codeOf(f.contract, 'SRF');
    products[code] = {
      code, name: code, quote_contract: code,
      spec: Object.assign({ contract_size: 1000, tick_size: 0.05, initial_margin: 0, maintenance_margin: 0, fee_per_lot: 0, tax_rate: 0, rollover_days: 7, liquidation_ratio: 0.25 }, f.spec || {}),
      beta: safeNum(f.beta, 1),
      index_ref: safeNum(f.index_ref, 0),
      price: safeNum(f.price, 0),
      prices: (f.prices && typeof f.prices === 'object') ? Object.assign({}, f.prices) : {},
    };
    defaultCode = code;
  }
  const positions = (Array.isArray(f.positions) ? f.positions : []).map((p) => {
    const rawCode = p && p.product ? codeOf(p.product, '') : '';
    const product = rawCode && products[rawCode] ? rawCode : defaultCode;
    return Object.assign({}, p, { product });
  });
  return { products, positions, cash: safeNum(f.cash, 0) };
}

/** 口數最多的「商品＋月份」——追繳/斷頭價、報價時段等headline 數字都以它為準 */
function pickReferenceCode(products, positions) {
  const byCode = new Map();
  const fallback = Object.keys(products)[0] || '';
  for (const p of Array.isArray(positions) ? positions : []) {
    const lots = Math.max(0, safeNum(p.lots, 0));
    if (lots <= 0) continue;
    const code = p.product && products[p.product] ? p.product : fallback;
    byCode.set(code, (byCode.get(code) || 0) + lots);
  }
  let best = fallback, bestLots = -1;
  for (const [code, lots] of byCode) if (lots > bestLots) { bestLots = lots; best = code; }
  return best;
}

/**
 * 帳戶彙總——多商品版。與前端 summarizeAccountAll（src/lib/futures.ts）同一套定義：
 *   權益數 ＝ 保證金專戶現金 ＋ 未實現損益（已扣來回費用與期交稅，逐部位各自的商品）
 *   風險指標 ＝ 權益數 ÷ 所需**原始**保證金（期交所定義；期貨商 App 顯示的就是它）
 * 追繳則是另一條線：權益數 ＜ 所需維持保證金。兩者不同門檻，不能用同一個比值分級。
 * 追繳／斷頭價解的是「大盤同時變動 X%」，每個部位用自己商品的 beta 換算價格變動——
 * 兩個不同商品（0050 期貨、個股期貨）不能用同一個絕對價格平移量描述。
 * `warn` 是這支腳本自訂的預警緩衝（仍以維持保證金為基準），跟前端頁面的 `warn`
 * 定義不同，是刻意的（見下方 WARN_RATIO 註解），不要「修」成一致。
 */
function summarizeAll(products, positions, cash) {
  const list = Array.isArray(positions) ? positions : [];
  const codes = Object.keys(products);
  const fallbackCode = codes[0];
  const resolve = (code) => products[code] || products[fallbackCode];

  let total_lots = 0, net_lots = 0, long_lots = 0, short_lots = 0;
  let contract_value = 0, unrealized = 0, denom = 0;
  const lotsByRef = new Map();
  const byProduct = new Map();

  for (const posn of list) {
    const lots = Math.max(0, safeNum(posn.lots, 0));
    if (lots <= 0) continue;
    const pp = resolve(posn.product || fallbackCode);
    if (!pp) continue;
    const spec = pp.spec || {};
    const unit = Math.max(1, safeNum(spec.contract_size, 1000));
    const price0 = priceOf(pp.prices, pp.price, posn.month);
    const beta = Math.max(0, safeNum(pp.beta, 1));
    const s = sign(posn.side);
    const taxRate = Math.max(0, safeNum(spec.tax_rate, 0));

    total_lots += lots;
    net_lots += s * lots;
    if (s > 0) long_lots += lots; else short_lots += lots;

    const r = positionPnl(posn, price0, spec);
    contract_value += r.contract_value;
    unrealized += r.net_pnl;

    const k = unit * price0 * beta;
    denom += lots * k * (s - taxRate);

    const code = posn.product || fallbackCode;
    const refKey = `${code}:${posn.month}`;
    lotsByRef.set(refKey, (lotsByRef.get(refKey) || 0) + lots);

    const row = byProduct.get(code) || { product: code, lots: 0, unrealized: 0, required_initial: 0, required_maintenance: 0 };
    row.lots += lots;
    row.unrealized += r.net_pnl;
    row.required_initial += Math.max(0, safeNum(spec.initial_margin, 0)) * lots;
    row.required_maintenance += Math.max(0, safeNum(spec.maintenance_margin, 0)) * lots;
    byProduct.set(code, row);
  }

  let reference_product = '', reference_month = '', refLots = -1;
  for (const key of [...lotsByRef.keys()].sort()) {
    const l = lotsByRef.get(key) || 0;
    if (l > refLots) { refLots = l; const [prod, month] = key.split(':'); reference_product = prod; reference_month = month; }
  }
  const refPP = reference_product ? resolve(reference_product) : resolve(fallbackCode);
  const refBeta = refPP ? Math.max(0, safeNum(refPP.beta, 1)) : 1;
  const reference_price = total_lots > 0 && refPP ? priceOf(refPP.prices, refPP.price, reference_month) : 0;

  const months = [...new Set(list.map((p) => p.month))].sort();
  const required_initial = [...byProduct.values()].reduce((sum, r) => sum + r.required_initial, 0);
  const required_maintenance = [...byProduct.values()].reduce((sum, r) => sum + r.required_maintenance, 0);

  const cashBal = safeNum(cash, 0);
  const equity = cashBal + unrealized;
  const risk_indicator = required_initial > 0 ? equity / required_initial : null;
  const liquidation_ratio = Math.max(0, safeNum(refPP && refPP.spec ? refPP.spec.liquidation_ratio : 0.25, 0.25));

  const shiftToMove = (target) => (denom === 0 ? null : (target - equity) / denom);
  const call_move = shiftToMove(required_maintenance);
  const cut_move = shiftToMove(required_initial * liquidation_ratio);
  const moveToShift = (move) => (move === null ? null : reference_price * refBeta * move);
  const call_shift = moveToShift(call_move);
  const cut_shift = moveToShift(cut_move);

  // 三條線各自獨立：斷頭看風險指標（÷原始）、追繳看權益數是否低於維持保證金、
  // warn 是自訂的預警緩衝，仍以維持保證金為基準（改成 ÷原始 會讓告警提早近一倍而變吵）。
  let status = 'flat';
  if (total_lots > 0 && risk_indicator !== null) {
    if (risk_indicator < liquidation_ratio) status = 'danger';
    else if (equity < required_maintenance) status = 'call';
    else if (equity < required_maintenance * WARN_RATIO) status = 'warn';
    else status = 'ok';
  }

  return {
    total_lots, net_lots, long_lots, short_lots, months, reference_product, reference_month, reference_price,
    contract_value, unrealized, equity, cash: cashBal,
    required_initial, required_maintenance, risk_indicator, liquidation_ratio, status,
    margin_call_price: call_shift === null ? null : Math.max(0, reference_price + call_shift),
    liquidation_price: cut_shift === null ? null : Math.max(0, reference_price + cut_shift),
    by_product: [...byProduct.values()],
  };
}

/** 最後交易日＝第三個星期三，遇休市順延（假日曆抓不到時只跳過週末） */
function lastTradingDay(month, holidays) {
  const m = /^(\d{4})(\d{2})$/.exec(String(month || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const d = new Date(Date.UTC(y, mo - 1, 1 + ((3 - firstDow + 7) % 7) + 14));
  for (let i = 0; i < 30; i += 1) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !(holidays && holidays.has(iso))) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

function tradingDaysBetween(from, to, holidays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const span = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  if (span === 0) return 0;
  const step = span > 0 ? 1 : -1;
  const d = new Date(from + 'T00:00:00Z');
  let n = 0;
  for (let i = 0; i < Math.abs(span); i += 1) {
    d.setUTCDate(d.getUTCDate() + step);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !(holidays && holidays.has(iso))) n += step;
  }
  return n;
}

// ── 信件 ─────────────────────────────────────────────────────────
const fmtMoney = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}NT$${Math.abs(Math.round(n)).toLocaleString('en-US')}`);
const fmtPct = (n) => (n === null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(0)}%`);
const fmtPx = (n) => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(2));

const LEVEL_META = {
  danger: { zh: '🟥 斷頭風險', color: '#c62828', urgency: '盤中觸價會被期貨商直接代為沖銷，不會等你補錢。' },
  call: { zh: '🟨 已進追繳區', color: '#ef6c00', urgency: '權益數已低於維持保證金，期貨商會發追繳通知，要補到原始保證金水準。' },
  warn: { zh: '⚠️ 接近追繳', color: '#f9a825', urgency: `權益數低於維持保證金的 ${Math.round(WARN_RATIO * 100)}%（自訂預警線，非期交所規定）。還有時間決定補錢還是減碼。` },
};

function buildEmail(s, products, quoteDate, rollovers, marginNotices, notes = {}) {
  const meta = LEVEL_META[s.status];
  const isRolloverOnly = !meta;
  const codes = Object.keys(products);
  const nameOf = (code) => (products[code] && products[code].name) || code;
  const multi = codes.length > 1;
  const label = codes.map(nameOf).join('＋');

  // 風險在安全區時，標題與抬頭要講「實際上發生了什麼」，不要無條件寫轉倉——
  // 從真的存在的事由組出來，才不會因為快照沒寫成就寄一封標題叫「轉倉提醒」的信
  const reasons = [];
  if (rollovers.length > 0) reasons.push('轉倉');
  if (marginNotices.length > 0) reasons.push('保證金');
  if (notes.snapshotSkip) reasons.push('權益曲線');
  const noticeLabel = reasons.length > 0 ? `${reasons.join('與')}提醒` : '狀態提醒';
  const subjectPrefix = `【期貨${noticeLabel}】`;

  const subject = isRolloverOnly
    ? `${subjectPrefix}${label}${rollovers.length > 0 ? ` ${rollovers.map((r) => (multi ? `${nameOf(r.product)}${r.month}` : r.month)).join('、')} 即將到期` : ''}`
    : `【期貨風險告警】${label} ${meta.zh}｜風險指標 ${fmtPct(s.risk_indicator)}`;

  const rolloverLines = rollovers.length > 0
    ? ['', '── 轉倉提醒 ──', ...rollovers.map((r) => {
      const prefix = multi ? `${nameOf(r.product)} ` : '';
      return r.expired
        ? `● ${prefix}${r.month} 已過最後交易日（${r.ltd}），${r.lots} 口應已被現金結算，請確認後在網頁上移到平倉紀錄`
        : `● ${prefix}${r.month} 還剩 ${r.left} 個交易日到期（最後交易日 ${r.ltd}），持有 ${r.lots} 口`;
    })]
    : [];

  const marginLines = marginNotices.length > 0
    ? [
      '',
      '── 保證金異動 ──',
      ...marginNotices.flatMap((n) => [
        `● ${multi ? nameOf(n.product) + '：' : ''}期交所 ${n.date} 現行值${n.stale ? '（期交所暫時抓不到，這是磁碟快取）' : ''}：原始 ${n.apiInitial.toLocaleString()} / 維持 ${n.apiMaintenance.toLocaleString()}`,
        `  你目前設定：原始 ${n.currentInitial.toLocaleString()} / 維持 ${n.currentMaintenance.toLocaleString()}；依新值重算，追繳價會從 ${fmtPx(n.oldMarginCallPrice)} 變成 ${fmtPx(n.newMarginCallPrice)}`,
      ]),
      `● 到「契約規格 & 設定」按「同步保證金」更新`,
    ]
    : [];

  const productLines = multi
    ? ['', '── 逐商品小計 ──', ...s.by_product.map((r) => `● ${nameOf(r.product)}：${r.lots} 口，原始保證金 ${fmtMoney(r.required_initial)}，未實現 ${fmtMoney(r.unrealized)}`)]
    : [];

  const snapshotLines = notes.snapshotSkip
    ? ['', '── 權益曲線 ──', `● ${notes.snapshotSkip}`, '● 補救：期交所每日行情恢復後會自動接上，但缺的那幾天不會回填']
    : [];

  // 這封信用的是「此刻的市價」，可能是夜盤。夜盤價跟日盤收盤差兩三塊是常態，
  // 不講清楚的話收信的人會以為算錯——網頁上那個徽章的同一個問題。
  const sessionNote = notes.quoteStale
    ? '※ ⚠ 完全抓不到期交所行情，本信用的是 data/futures_positions.json 裡**上次存下來的價**，可能已經過期很久，只能當作「部位還在」的提醒，數字不要當真。'
    : notes.session === 'night'
      ? '※ 報價取自期交所**盤後（夜盤）交易時段**的最新成交價。夜盤 15:00–翌日 05:00 照樣在跑，跟日盤收盤價差幾塊是常態。注意：官方每日結算價與追繳通知只由日盤決定，本信是提前示警。'
      : notes.session === 'day'
        ? '※ 報價取自期交所**一般（日盤）交易時段**的最新成交價。'
        : '※ 該月份目前沒有成交，報價退回期交所**每日結算價**（比今天慢一個交易日），盤中跌破的話這封信會晚一天。';

  const lines = [
    isRolloverOnly ? `${label} 期貨${noticeLabel}` : `${label} 期貨風險告警：${meta.zh}`,
    '',
    ...(meta ? [meta.urgency, ''] : []),
    '── 帳戶 ──',
    `● 風險指標：${fmtPct(s.risk_indicator)}＝權益數÷原始保證金（斷頭 ${fmtPct(s.liquidation_ratio)}）`,
    `● 權益數：${fmtMoney(s.equity)}＝現金 ${fmtMoney(s.cash)} ＋ 未實現 ${fmtMoney(s.unrealized)}`,
    `● 所需原始／維持保證金：${fmtMoney(s.required_initial)} ／ ${fmtMoney(s.required_maintenance)}`,
    `● 超額保證金：${fmtMoney(s.equity - s.required_initial)}`,
    '',
    '── 部位 ──',
    `● 多 ${s.long_lots} 口 / 空 ${s.short_lots} 口（淨 ${s.net_lots >= 0 ? '+' : ''}${s.net_lots}）`,
    `● 名目曝險：${fmtMoney(s.contract_value)}`,
    `● 月份：${s.months.join('、') || '—'}（各月份分別報價）`,
    `● 參考：${multi ? nameOf(s.reference_product) + '　' : ''}${fmtPx(s.reference_price)}（${s.reference_month}，期交所 ${quoteDate}）`,
    ...productLines,
    '',
    '── 危險價位（大盤同時變動時，換算成參考商品的價格）──',
    `● 追繳價：${fmtPx(s.margin_call_price)}`,
    `● 斷頭價：${fmtPx(s.liquidation_price)}`,
    ...rolloverLines,
    ...marginLines,
    ...snapshotLines,
    '',
    sessionNote,
    '※ 口數與保證金專戶餘額取自 data/futures_positions.json，如已異動請在網頁上更新並「存到雲端」。',
    '※ 崩盤時期交所常會調高保證金，實際追繳會比本信更早發生。本信為機械提醒，非投資建議。',
  ];
  const text = lines.join('\n');

  const color = meta ? meta.color : '#1565c0';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px;">${label} 期貨${isRolloverOnly ? noticeLabel : '風險告警'}</h2>
  ${meta ? `<p style="margin:0 0 12px;color:${color};font-weight:bold;">${meta.zh}</p>` : ''}
  <div style="background:${color}11;border:1px solid ${color}33;border-radius:6px;padding:14px;text-align:center;margin-bottom:14px;">
    <div style="font-size:13px;color:#555;">風險指標</div>
    <div style="font-size:32px;font-weight:800;color:${color};">${fmtPct(s.risk_indicator)}</div>
    <div style="font-size:12px;color:#777;">權益數÷原始保證金｜斷頭 ${fmtPct(s.liquidation_ratio)}</div>
  </div>
  ${meta ? `<p style="font-size:13px;color:#444;background:#fafafa;border-left:3px solid ${color};padding:8px 12px;margin:0 0 14px;">${meta.urgency}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px;border:1px solid #eee;">權益數</td><td style="padding:6px;border:1px solid #eee;"><b>${fmtMoney(s.equity)}</b>（現金 ${fmtMoney(s.cash)} ＋ 未實現 ${fmtMoney(s.unrealized)}）</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">所需原始 / 維持</td><td style="padding:6px;border:1px solid #eee;">${fmtMoney(s.required_initial)} / ${fmtMoney(s.required_maintenance)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">部位</td><td style="padding:6px;border:1px solid #eee;">多 ${s.long_lots} / 空 ${s.short_lots} 口，名目 ${fmtMoney(s.contract_value)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">參考價</td><td style="padding:6px;border:1px solid #eee;">${multi ? nameOf(s.reference_product) + ' ' : ''}${fmtPx(s.reference_price)}（${s.reference_month}，${quoteDate}）</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">追繳價 / 斷頭價</td><td style="padding:6px;border:1px solid #eee;"><b style="color:#ef6c00;">${fmtPx(s.margin_call_price)}</b> / <b style="color:#c62828;">${fmtPx(s.liquidation_price)}</b></td></tr>
    ${multi ? s.by_product.map((r) => `<tr><td style="padding:6px;border:1px solid #eee;">${nameOf(r.product)}</td><td style="padding:6px;border:1px solid #eee;">${r.lots} 口，原始保證金 ${fmtMoney(r.required_initial)}，未實現 ${fmtMoney(r.unrealized)}</td></tr>`).join('\n    ') : ''}
    ${rollovers.map((r) => `<tr><td style="padding:6px;border:1px solid #eee;">轉倉 ${multi ? nameOf(r.product) + ' ' : ''}${r.month}</td><td style="padding:6px;border:1px solid #eee;">${r.expired ? `已過最後交易日 ${r.ltd}` : `剩 ${r.left} 個交易日（${r.ltd}）`}，${r.lots} 口</td></tr>`).join('\n    ')}
  </table>
  ${marginNotices.length > 0 ? `
  <div style="background:#fff3e0;border:1px solid #ffe0b2;border-radius:6px;padding:12px;margin-top:14px;font-size:13px;">
    <h4 style="margin:0 0 6px;color:#e65100;">── 保證金異動 ──</h4>
    ${marginNotices.map((n) => `
    <p style="margin:0 0 4px;">● ${multi ? `<b>${nameOf(n.product)}</b>：` : ''}期交所 <b>${n.date}</b> 現行值${n.stale ? '（期交所暫時抓不到，這是磁碟快取）' : ''}：原始 ${n.apiInitial.toLocaleString()} / 維持 ${n.apiMaintenance.toLocaleString()}</p>
    <p style="margin:0 0 4px;">　你目前設定：原始 ${n.currentInitial.toLocaleString()} / 維持 ${n.currentMaintenance.toLocaleString()}；追繳價會從 <b>${fmtPx(n.oldMarginCallPrice)}</b> 變成 <b>${fmtPx(n.newMarginCallPrice)}</b></p>`).join('\n    ')}
    <p style="margin:0;color:#e65100;font-weight:bold;">● 請到「契約規格 & 設定」按「同步保證金」更新</p>
  </div>` : ''}
  ${notes.snapshotSkip ? `
  <div style="background:#fffde7;border:1px solid #fff59d;border-radius:6px;padding:12px;margin-top:14px;font-size:13px;">
    <h4 style="margin:0 0 6px;color:#f57f17;">── 權益曲線 ──</h4>
    <p style="margin:0 0 4px;">● ${notes.snapshotSkip}</p>
    <p style="margin:0;">● 期交所每日行情恢復後會自動接上，但缺的那幾天不會回填</p>
  </div>` : ''}
  <p style="font-size:12px;color:#999;margin-top:14px;">${sessionNote.replace(/^※ /, '').replace(/\*\*/g, '')}<br>崩盤時期交所常調高保證金，實際追繳會更早。持倉取自 data/futures_positions.json。機械提醒，非投資建議。</p>
</body></html>`;

  return { subject, text, html };
}

// ── 權益數快照 ────────────────────────────────────────────────────
function readHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    return Array.isArray(j.rows) ? j.rows : [];
  } catch { return []; }
}

/**
 * 一天一列，以報價日為 key（同一天重跑會覆蓋，冪等）。
 * 存的是**當天收盤後的狀態**，之後用來畫權益數曲線與最大回撤。
 */
function writeSnapshot(rows, s, quoteDate) {
  const row = {
    date: quoteDate,
    equity: Math.round(s.equity),
    cash: Math.round(s.cash),
    unrealized: Math.round(s.unrealized),
    contract_value: Math.round(s.contract_value),
    net_lots: s.net_lots,
    total_lots: s.total_lots,
    risk_indicator: s.risk_indicator === null ? null : Number(s.risk_indicator.toFixed(4)),
    price: Number(s.reference_price.toFixed(2)),
    status: s.status,
  };
  const next = rows.filter((r) => r && r.date !== quoteDate);
  next.push(row);
  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const trimmed = next.slice(-HISTORY_MAX);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HISTORY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ updated_at: new Date().toISOString(), rows: trimmed }, null, 2));
  fs.renameSync(tmp, HISTORY_PATH);
  return row;
}

// ── 主流程 ────────────────────────────────────────────────────────
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } };
function writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { log('寫入 state 失敗: ' + e.message); }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const snapshotOnly = argv.includes('--snapshot-only');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf-8'));
  } catch {
    log(`找不到或無法解析期貨部位檔 ${POSITIONS_PATH}（請先在網頁上按「存到雲端」）。跳過。`);
    return;
  }
  const migrated = migrateFutures(raw);
  const products = migrated.products;
  const cash = migrated.cash;
  const positions = migrated.positions.filter((p) => safeNum(p.lots, 0) > 0);
  if (positions.length === 0) { log('沒有未平倉部位，無需告警也不寫快照。'); return; }

  const referenceCode = pickReferenceCode(products, positions);

  // 行情：逐商品打本機 gateway（它會代抓期交所並快取），抓不到就用存檔裡的價格續行——
  // 部位還在、風險還在，用舊價至少能算出一個保守的提醒，比整支跳過好。
  // 兩套價，用途不同、不能混：
  //   prices（各商品 .prices）── 風險評估用「此刻的市價」（即時價優先），信裡講的追繳距離要照這個
  //   snapshot（各商品 ._settlement）── 權益曲線用「日盤結算價」。每日結算價只由一般交易時段決定
  //                     （期交所每日行情檔的盤後列 SettlementPrice 是 NULL），追繳也照它算；
  //                     而且用當下成交價的話，同一天幾點跑 cron 就得到不同的歷史值，
  //                     曲線會變成不可重現。代價是曲線比今天慢一個交易日（每日檔要等
  //                     夜盤跑完才出），這是刻意換來的。
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  for (const [code, pp] of Object.entries(products)) {
    try {
      const q = await httpGetJson(`${GATEWAY_BASE}/api/futures/quote?contract=${encodeURIComponent(pp.quote_contract || code)}`);
      const months = (q && q.months) || [];
      const snap = {};
      let got = 0, settleGot = 0;
      for (const m of months) {
        const live = pos(m.live);
        const daily = pos(m.settlement) ?? pos(m.last);
        if (live !== null || daily !== null) { pp.prices[m.month] = live ?? daily; got += 1; }
        if (daily !== null) { snap[m.month] = daily; settleGot += 1; }
      }
      if (got > 0) {
        pp._quoteStale = false;
        pp._quoteDate = q.live_as_of ? q.live_as_of.slice(0, 10) : (q.date || null);
        const withLive = months.find((m) => pos(m.live) !== null);
        pp._session = withLive ? (withLive.live_session || null) : null;
      } else {
        pp._quoteStale = true;
        log(`${code} 期交所回應沒有可用價格，改用部位檔裡的存價`);
      }
      if (settleGot > 0 && q.date) pp._settlement = { prices: snap, date: q.date };
    } catch (e) {
      pp._quoteStale = true;
      log(`抓 ${code} 期交所行情失敗（${e.message}），改用部位檔裡的存價`);
    }
  }
  const refPP = products[referenceCode];
  const quoteStale = !refPP || refPP._quoteStale !== false;
  const quoteDate = (refPP && refPP._quoteDate) || new Date().toLocaleDateString('sv-SE');
  const priceSession = (refPP && refPP._session) || null;

  // 休市日曆（同樣走 gateway；抓不到就只跳過週末）
  let holidays = null;
  try {
    const h = await httpGetJson(`${GATEWAY_BASE}/api/market/holidays`);
    if (h && Array.isArray(h.dates)) holidays = new Set(h.dates);
  } catch (e) { log(`抓休市日曆失敗（${e.message}），最後交易日只跳過週末`); }

  const s = summarizeAll(products, positions, cash);
  log(`風險指標=${fmtPct(s.risk_indicator)} 狀態=${s.status} 權益=${fmtMoney(s.equity)} 參考=${referenceCode}@${fmtPx(s.reference_price)}@${quoteDate}${quoteStale ? '(存價)' : ''} 追繳=${fmtPx(s.margin_call_price)} 斷頭=${fmtPx(s.liquidation_price)}`);

  // 抓期交所保證金（用於核對不一致）——逐商品各自核對，個股期貨沒有這個端點會自然略過
  const marginNotices = [];
  try {
    const apiMargins = await httpGetJson(`${GATEWAY_BASE}/api/futures/margins`);
    if (apiMargins && apiMargins.margins) {
      for (const [code, pp] of Object.entries(products)) {
        const info = apiMargins.margins[pp.quote_contract || code];
        if (!info) continue;
        const currentInitial = safeNum(pp.spec.initial_margin, 0);
        const currentMaintenance = safeNum(pp.spec.maintenance_margin, 0);
        if (currentInitial === info.initial && currentMaintenance === info.maintenance) continue;
        // 跟上面的 s 用同一份 positions，否則兩邊的追繳價不是同一個基準
        const virtualProducts = Object.assign({}, products, {
          [code]: Object.assign({}, pp, { spec: Object.assign({}, pp.spec, { initial_margin: info.initial, maintenance_margin: info.maintenance }) }),
        });
        const virtualSummary = summarizeAll(virtualProducts, positions, cash);
        marginNotices.push({
          product: code,
          date: apiMargins.date,
          // 去重要用「保證金數值」，不能用 date：實測期交所這個端點的 Date 是
          // **資料日**（每個交易日都推進一天），不是公告日。用 date 當 key 的話
          // 只要設定沒同步，就會每個交易日都寄一封一模一樣的信。
          key: `${code}:${info.initial}/${info.maintenance}`,
          stale: apiMargins.stale === true,
          apiInitial: info.initial,
          apiMaintenance: info.maintenance,
          currentInitial,
          currentMaintenance,
          oldMarginCallPrice: s.margin_call_price,
          newMarginCallPrice: virtualSummary.margin_call_price,
        });
      }
    }
  } catch (e) {
    log(`抓期交所保證金失敗（${e.message}），略過保證金核對`);
  }

  // 快照：用日盤結算價那套價，日期也用參考商品每日行情檔自己的日期——不是「今天」。
  // 抓不到參考商品的每日行情就整個略過，寧可曲線缺一天，也不要寫進一列基準不同的資料。
  let snapshotSkip = null;
  const snapshotDate = refPP && refPP._settlement ? refPP._settlement.date : null;
  if (snapshotDate) {
    const snapshotProducts = {};
    for (const [code, pp] of Object.entries(products)) {
      const settle = pp._settlement;
      snapshotProducts[code] = Object.assign({}, pp, { prices: (settle && settle.prices) ? settle.prices : pp.prices });
    }
    const snapSummary = summarizeAll(snapshotProducts, positions, cash);
    if (dryRun) {
      log(`DRY-RUN 快照 ${snapshotDate}（日盤結算價）：權益 ${fmtMoney(snapSummary.equity)}`);
    } else {
      const row = writeSnapshot(readHistory(), snapSummary, snapshotDate);
      log(`已寫入權益快照 ${row.date}（日盤結算價）：權益 ${fmtMoney(row.equity)}`);
    }
  } else {
    snapshotSkip = '抓不到期交所每日行情，今天沒有寫入權益快照——曲線會缺這一段';
    log(snapshotSkip);
  }
  if (snapshotOnly) return;

  // 轉倉提醒：進入提醒區間（預設到期前 7 個交易日）或已過期——依「商品＋月份」分組
  const today = new Date().toLocaleDateString('sv-SE');
  const lotsByKey = new Map();
  for (const p of positions) {
    const code = p.product && products[p.product] ? p.product : referenceCode;
    const key = `${code}:${p.month}`;
    const row = lotsByKey.get(key) || { product: code, month: p.month, lots: 0 };
    row.lots += safeNum(p.lots, 0);
    lotsByKey.set(key, row);
  }
  const rollovers = [];
  for (const { product, month, lots } of lotsByKey.values()) {
    const pp = products[product] || refPP;
    const window = Math.max(0, safeNum(pp && pp.spec ? pp.spec.rollover_days : 7, 7));
    const ltd = lastTradingDay(month, holidays);
    if (!ltd) continue;
    const left = tradingDaysBetween(today, ltd, holidays);
    const expired = left !== null && left < 0;
    if (expired || (left !== null && left <= window)) rollovers.push({ product, month, lots, ltd, left, expired });
  }

  const state = readState();
  const riskActionable = s.status === 'warn' || s.status === 'call' || s.status === 'danger';
  const riskChanged = s.status !== state.last_status;
  // 轉倉去重記到「商品＋月份＋是否已過期」的層級：同一個月份從「快到期」變成「已過期」要再寄一次
  const rolloverKey = rollovers.map((r) => `${r.product}:${r.month}:${r.expired ? 'x' : 'due'}`).join(',');
  const rolloverChanged = rolloverKey !== '' && rolloverKey !== state.last_rollover_key;

  // 保證金去重：同一組保證金數值只講一次（見上面 key 的註解，不能用日期）
  const marginNoticeKey = marginNotices.map((n) => n.key).sort().join(',');
  const hasNewMarginNotice = marginNoticeKey !== '' && marginNoticeKey !== state.last_margin_notice_key;

  // 快照沒寫成的話要講一聲，否則權益曲線會安靜地長洞。只在「從正常變成寫不進去」
  // 那一次寄，連續失敗不重複轟炸——跟上面狀態／轉倉／保證金同一套去重邏輯。
  const snapshotSkipNew = !!snapshotSkip && !state.last_snapshot_skip;

  if (!dryRun) {
    writeState({
      last_status: s.status,
      last_rollover_key: rolloverKey,
      last_date: quoteDate,
      risk_indicator: s.risk_indicator,
      last_margin_notice_key: marginNoticeKey || state.last_margin_notice_key,
      last_snapshot_skip: !!snapshotSkip,
      updated_at: new Date().toISOString(),
    });
  }

  if (!riskActionable && rollovers.length === 0 && !hasNewMarginNotice && !snapshotSkipNew) { log('風險指標安全、無到期部位、無新保證金通知且快照正常，無需告警。'); return; }
  if (!force && !riskChanged && !rolloverChanged && !hasNewMarginNotice && !snapshotSkipNew) {
    log(`狀態 ${s.status}／轉倉 ${rolloverKey || '無'}／保證金公告／快照 皆未變（上次已通知），略過寄信。加 --force 可強制寄。`);
    return;
  }
  // 風險在安全區、只是轉倉提醒或保證金通知時，仍要寄（信件標題會自動切成轉倉/保證金版）
  if (!riskActionable && !rolloverChanged && !hasNewMarginNotice && !snapshotSkipNew && !force) { log('轉倉提醒/保證金未變化，略過。'); return; }

  const { subject, text, html } = buildEmail(
    s, products, quoteDate + (quoteStale ? '（存價）' : ''), rollovers, marginNotices,
    { session: priceSession, snapshotSkip, quoteStale },
  );
  if (dryRun) { log('DRY-RUN，不寄信。主旨: ' + subject); console.log('\n' + text + '\n'); return; }

  const token = await getAccessToken();
  if (!token) { log('取不到 Gmail access token（檢查 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN），無法寄信。'); process.exitCode = 1; return; }
  try {
    await sendGmail(token, subject, text, html);
    log(`已寄送告警 → ${NOTIFY_EMAIL}：${subject}`);
  } catch (e) {
    log('寄信失敗: ' + e.message);
    process.exitCode = 1;
  }
}

main().catch((e) => { log('未預期錯誤: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
