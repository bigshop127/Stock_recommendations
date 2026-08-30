#!/usr/bin/env node
/**
 * 個股價格警示 Email 告警
 * ---------------------------------------------------------------------------
 * 收盤後跑一次：讀 data/stock_price_alerts.json 裡使用者設定的每檔個股警示，
 * 打本機 gateway 的 /api/stocks/:code/ohlcv 拿全部可用歷史，達到條件就寄 Email。
 * 支援 12 種條件：收盤高於/低於價位、KD 黃金/死亡交叉、5/10/20/60 日均線跌破/站回
 * （後者共 10 種都是「穿越」事件，用今日與昨日兩組值比較抓轉折，不是單純判斷當下位置）。
 *
 * 設計原則（比照 scripts/futures_alert.cjs，刻意獨立複製一份 Gmail 寄信邏輯，
 * 不共用模組——這是本專案既有慣例，各告警腳本互不 require；均線/KD 公式也是
 * 獨立複製一份自 src/lib/indicators.ts，同樣不跨前後端共用模組）：
 *   - 只用 Node 內建模組，零新依賴。
 *   - 去重：以「警示 id ＋ 收盤日期」為 key，同一天只寄一次。收盤價高於/低於這種
 *     「位置」條件，只要持續成立就會逐日再寄；KD/均線這種「穿越」條件，轉折當天
 *     過後條件本身就不再成立，自然只會寄一次，不需要額外的「觸發後關閉」開關。
 *
 * 用法：
 *   node scripts/stock_price_alert.cjs             正常執行（cron 用）
 *   node scripts/stock_price_alert.cjs --dry-run   只計算與印出，不寄信、不寫 state
 *
 * 排程（VM crontab，週一~五 收盤後；VM 為 Asia/Taipei，TWSE 13:30 收盤）：
 *   40 13 * * 1-5  cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/stock_price_alert.cjs >> data/stock_price_alert.log 2>&1
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_PATH = process.env.STOCK_ALERTS_PATH || path.join(DATA_DIR, 'stock_price_alerts.json');
const STATE_PATH = process.env.STOCK_ALERT_STATE_PATH || path.join(DATA_DIR, 'stock_price_alert_state.json');
const LOG_PATH = path.join(DATA_DIR, 'stock_price_alert.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

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

// ── Gmail 寄信（沿用 futures_alert.cjs / puhui_daily.cjs 手法，獨立複製一份）────
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
  const raw = [
    `From: ${NOTIFY_EMAIL}`, `To: ${NOTIFY_EMAIL}`, `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody,
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', htmlBody,
    `--${boundary}--`,
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

const fmtPx = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(2));

// 12 種警示條件的顯示文字（獨立複製一份，跟前端 src/pages/StockDetail.tsx 的 ALERT_CONDITION_LABEL
// 對應但不共用模組——沿用本專案「告警腳本互不 require」的既有慣例）。
const CONDITION_LABEL = {
  price_above: '收盤高於', price_below: '收盤低於',
  kd_golden_cross: 'KD 黃金交叉', kd_death_cross: 'KD 死亡交叉',
  ma5_break_below: '跌破 5 日均線', ma5_break_above: '站回 5 日均線',
  ma10_break_below: '跌破 10 日均線', ma10_break_above: '站回 10 日均線',
  ma20_break_below: '跌破 月線 (20MA)', ma20_break_above: '站回 月線 (20MA)',
  ma60_break_below: '跌破 季線 (60MA)', ma60_break_above: '站回 季線 (60MA)',
};
const isPriceCondition = (c) => c === 'price_above' || c === 'price_below';
const describeCondition = (h) => (isPriceCondition(h.conditionType) ? `${CONDITION_LABEL[h.conditionType]} ${fmtPx(h.price)}` : CONDITION_LABEL[h.conditionType]);

function buildEmail(hits) {
  const subject = `【個股價格警示】${hits.map((h) => `${h.name}(${h.code})`).join('、')} 已觸發警示`;
  const lines = [
    '以下個股已觸發你設定的警示：',
    '',
    ...hits.map((h) => `● ${h.name}（${h.code}）：${describeCondition(h)}，收盤 ${fmtPx(h.close)}${h.note ? `（${h.note}）` : ''}（${h.date}）`),
    '',
    '※ 收盤價與技術指標取自 data/stock_price_alerts.json 對應的每日行情，機械提醒，非投資建議。',
    '※ 到網站個股頁「基本資料」分頁可調整或刪除警示。',
  ];
  const text = lines.join('\n');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 12px;">個股價格警示</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${hits.map((h) => `<tr><td style="padding:6px;border:1px solid #eee;"><b>${h.name}</b>（${h.code}）</td><td style="padding:6px;border:1px solid #eee;">${describeCondition(h)}，收盤 <b>${fmtPx(h.close)}</b>${h.note ? `<br><span style="color:#777;font-size:12px;">${h.note}</span>` : ''}</td></tr>`).join('\n    ')}
  </table>
  <p style="font-size:12px;color:#999;margin-top:14px;">收盤價與技術指標取自個股行情資料，機械提醒，非投資建議。到網站個股頁「基本資料」分頁可調整或刪除警示。</p>
</body></html>`;
  return { subject, text, html };
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } };
function writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { log('寫入 state 失敗: ' + e.message); }
}

// 抓全部可用歷史（不帶 start/end，比照前端 fetchKlineData 拿法），這樣算出來的均線／KD
// 才會盡量跟網站上顯示的一致。
async function fetchHistory(code) {
  const url = `${GATEWAY_BASE}/api/stocks/${encodeURIComponent(code)}/ohlcv?adjust=true`;
  const resp = await httpGetJson(url);
  const rows = Array.isArray(resp && resp.data) ? resp.data : [];
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted
    .map((r) => ({ date: String(r.date).slice(0, 10), close: Number(r.close), high: Number(r.high), low: Number(r.low) }))
    .filter((r) => Number.isFinite(r.close) && Number.isFinite(r.high) && Number.isFinite(r.low));
}

// 簡單移動平均（沿用 src/lib/indicators.ts 的 calculateSMA 公式：近 N 筆收盤價平均）。
function calcSMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += closes[i - j];
    out[i] = sum / period;
  }
  return out;
}

// KD(9,3,3)（沿用 src/lib/indicators.ts 的 calculateKD 公式：RSV → K=2/3·K₋₁+1/3·RSV → D=2/3·D₋₁+1/3·K，
// K/D 初始值 50，i>=8 才開始有效）。
function calcKD(rows) {
  const n = rows.length;
  const K = new Array(n).fill(50);
  const D = new Array(n).fill(50);
  if (n < 9) return { k: new Array(n).fill(null), d: new Array(n).fill(null) };
  for (let i = 8; i < n; i++) {
    let h9 = -Infinity, l9 = Infinity;
    for (let j = 0; j < 9; j++) {
      if (rows[i - j].high > h9) h9 = rows[i - j].high;
      if (rows[i - j].low < l9) l9 = rows[i - j].low;
    }
    const rsv = h9 !== l9 ? ((rows[i].close - l9) / (h9 - l9)) * 100 : 50;
    K[i] = (2 / 3) * K[i - 1] + (1 / 3) * rsv;
    D[i] = (2 / 3) * D[i - 1] + (1 / 3) * K[i];
  }
  return { k: K.map((v, i) => (i >= 8 ? v : null)), d: D.map((v, i) => (i >= 8 ? v : null)) };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf-8'));
  } catch {
    log(`找不到或無法解析 ${ALERTS_PATH}（尚未設定任何警示）。跳過。`);
    return;
  }
  const stocks = cfg && typeof cfg.stocks === 'object' ? cfg.stocks : {};
  const codes = Object.keys(stocks);
  if (codes.length === 0) { log('沒有設定任何個股警示，跳過。'); return; }

  const state = readState();
  const hits = [];
  const newSentKeys = {};

  for (const code of codes) {
    const entry = stocks[code];
    const alerts = (entry && Array.isArray(entry.alerts) ? entry.alerts : []).filter((a) => a.enabled !== false);
    if (alerts.length === 0) continue;

    let history;
    try {
      history = await fetchHistory(code);
    } catch (e) {
      log(`抓 ${code} 歷史行情失敗（${e.message}），跳過該檔`);
      continue;
    }
    if (history.length === 0) { log(`${code} 沒有可用的行情資料，跳過`); continue; }

    const n = history.length;
    const last = history[n - 1];
    const prev = n >= 2 ? history[n - 2] : null;
    const closes = history.map((r) => r.close);

    let kd = null; // 惰性計算：只有真的用到 KD 條件才算
    const smaCache = new Map(); // period -> SMA 陣列，同一檔多筆均線警示不重算

    for (const a of alerts) {
      const { conditionType } = a;
      let triggered = false;

      if (isPriceCondition(conditionType)) {
        triggered = conditionType === 'price_above' ? last.close >= a.price : last.close <= a.price;
      } else if (conditionType === 'kd_golden_cross' || conditionType === 'kd_death_cross') {
        if (!prev) continue;
        if (!kd) kd = calcKD(history);
        const curK = kd.k[n - 1], curD = kd.d[n - 1], prevK = kd.k[n - 2], prevD = kd.d[n - 2];
        if (curK === null || prevK === null) { log(`${code} 歷史筆數不足以算 KD，略過此警示`); continue; }
        triggered = conditionType === 'kd_golden_cross'
          ? (prevK <= prevD && curK > curD)
          : (prevK >= prevD && curK < curD);
      } else {
        const m = /^ma(\d+)_break_(below|above)$/.exec(conditionType);
        if (!m || !prev) continue;
        const period = Number(m[1]);
        if (!smaCache.has(period)) smaCache.set(period, calcSMA(closes, period));
        const sma = smaCache.get(period);
        const curMA = sma[n - 1], prevMA = sma[n - 2];
        if (curMA === null || prevMA === null) { log(`${code} 歷史筆數不足以算 ${period} 日均線，略過此警示`); continue; }
        triggered = m[2] === 'below'
          ? (prev.close >= prevMA && last.close < curMA)
          : (prev.close <= prevMA && last.close > curMA);
      }

      if (!triggered) continue;
      const sentKey = `${a.id}:${last.date}`;
      if (state[sentKey]) continue; // 同一天已寄過
      newSentKeys[sentKey] = true;
      hits.push({
        code, name: entry.name || code, conditionType, price: a.price,
        note: a.note || '', close: last.close, date: last.date,
      });
    }
  }

  if (hits.length === 0) { log('無新觸發之價格警示。'); return; }

  log(`觸發 ${hits.length} 筆警示：${hits.map((h) => `${h.code}@${h.close}`).join('、')}`);
  const { subject, text, html } = buildEmail(hits);

  if (dryRun) { log('DRY-RUN，不寄信。主旨: ' + subject); console.log('\n' + text + '\n'); return; }

  const token = await getAccessToken();
  if (!token) { log('取不到 Gmail access token（檢查 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN），無法寄信。'); process.exitCode = 1; return; }
  try {
    await sendGmail(token, subject, text, html);
    log(`已寄送價格警示 → ${NOTIFY_EMAIL}：${subject}`);
    writeState({ ...state, ...newSentKeys });
  } catch (e) {
    log('寄信失敗: ' + e.message);
    process.exitCode = 1;
  }
}

main().catch((e) => { log('未預期錯誤: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
