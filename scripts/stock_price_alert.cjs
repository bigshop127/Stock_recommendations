#!/usr/bin/env node
/**
 * 個股價格警示 Email 告警
 * ---------------------------------------------------------------------------
 * 收盤後跑一次：讀 data/stock_price_alerts.json 裡使用者設定的每檔個股警示
 * （方向 above/below ＋ 價位），打本機 gateway 的 /api/stocks/:code/ohlcv 拿當天
 * 收盤價，達到條件就寄 Email。
 *
 * 設計原則（比照 scripts/futures_alert.cjs，刻意獨立複製一份 Gmail 寄信邏輯，
 * 不共用模組——這是本專案既有慣例，各告警腳本互不 require）：
 *   - 只用 Node 內建模組，零新依賴。
 *   - 去重：以「警示 id ＋ 收盤日期」為 key，同一天只寄一次；但條件持續成立的話
 *     每個交易日都會再寄一次（收盤價每天達標就通知一次，是最直覺的語意）。
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

function buildEmail(hits) {
  const subject = `【個股價格警示】${hits.map((h) => `${h.name}(${h.code})`).join('、')} 收盤已達標`;
  const lines = [
    '以下個股收盤價已達到你設定的警示：',
    '',
    ...hits.map((h) => `● ${h.name}（${h.code}）：收盤 ${fmtPx(h.close)}，設定 ${h.direction === 'above' ? '高於' : '低於'} ${fmtPx(h.price)}${h.note ? `（${h.note}）` : ''}（${h.date}）`),
    '',
    '※ 收盤價取自 data/stock_price_alerts.json 對應的每日行情，機械提醒，非投資建議。',
    '※ 到網站個股頁「基本資料」分頁可調整或刪除警示。',
  ];
  const text = lines.join('\n');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 12px;">個股價格警示</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${hits.map((h) => `<tr><td style="padding:6px;border:1px solid #eee;"><b>${h.name}</b>（${h.code}）</td><td style="padding:6px;border:1px solid #eee;">收盤 <b>${fmtPx(h.close)}</b>，設定${h.direction === 'above' ? '高於' : '低於'} ${fmtPx(h.price)}${h.note ? `<br><span style="color:#777;font-size:12px;">${h.note}</span>` : ''}</td></tr>`).join('\n    ')}
  </table>
  <p style="font-size:12px;color:#999;margin-top:14px;">收盤價取自個股行情資料，機械提醒，非投資建議。到網站個股頁「基本資料」分頁可調整或刪除警示。</p>
</body></html>`;
  return { subject, text, html };
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } };
function writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { log('寫入 state 失敗: ' + e.message); }
}

async function latestClose(code) {
  const end = new Date().toLocaleDateString('sv-SE');
  const startD = new Date();
  startD.setDate(startD.getDate() - 20);
  const start = startD.toLocaleDateString('sv-SE');
  const url = `${GATEWAY_BASE}/api/stocks/${encodeURIComponent(code)}/ohlcv?start=${start}&end=${end}`;
  const resp = await httpGetJson(url);
  const rows = Array.isArray(resp && resp.data) ? resp.data : [];
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = sorted[sorted.length - 1];
  const close = Number(last.close);
  return Number.isFinite(close) ? { close, date: String(last.date).slice(0, 10) } : null;
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

    let quote;
    try {
      quote = await latestClose(code);
    } catch (e) {
      log(`抓 ${code} 收盤價失敗（${e.message}），跳過該檔`);
      continue;
    }
    if (!quote) { log(`${code} 沒有可用的收盤價資料，跳過`); continue; }

    for (const a of alerts) {
      const triggered = a.direction === 'above' ? quote.close >= a.price : quote.close <= a.price;
      if (!triggered) continue;
      const sentKey = `${a.id}:${quote.date}`;
      if (state[sentKey]) continue; // 同一天已寄過
      newSentKeys[sentKey] = true;
      hits.push({
        code, name: entry.name || code, direction: a.direction, price: a.price,
        note: a.note || '', close: quote.close, date: quote.date,
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
