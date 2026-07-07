#!/usr/bin/env node
/**
 * 00631L「正2 + 防守端」再平衡 Email 告警
 * ---------------------------------------------------------------------------
 * 每日收盤後檢查投組 Beta：破容忍區間上限(該賣出)或下限(該買進)就寄 Email。
 * 【增修I】防守端＝現金＋債券 ETF（00687B/00953B）市值，皆視為 β=0；
 * β 分母為總資產（00631L 市值＋防守端）。舊持倉檔（無 bonds 欄位）行為完全不變。
 *
 * 設計原則（刻意獨立）：
 *   - 完全獨立於 scripts/puhui_daily.cjs，不 require、不改動它（該檔為 production 命脈）。
 *     只「沿用同一組 Google OAuth env」與相同的 Gmail API 寄信手法（各自複製一份）。
 *   - 只用 Node 內建模組（https/http/fs/path），零新依賴。
 *   - 持倉讀 data/rebalance_holdings.json（gitignore；由 rebalance_holdings.example.json 複製後填）。
 *     —— 因為前端計算機的持倉存在瀏覽器 localStorage，排程腳本讀不到，故需獨立設定檔。
 *   - 再平衡計算為 review-web/src/lib/rebalance.ts 的忠實移植（00631L＋防守端，債券 β=0）。
 *   - 債券收盤價：抓 gateway ohlcv；抓不到時退用持倉檔 bonds[].price（前端最後同步價），
 *     兩者皆無（price=0）該檔市值以 0 計並於信中註記。
 *   - 告警去重：只在「狀態變化」時寄（normal→buy / normal→sell / buy↔sell），
 *     狀態持續不變不重複轟炸；狀態存 data/rebalance_alert_state.json。
 *
 * 用法：
 *   node scripts/rebalance_alert.cjs            正常執行（cron 用）
 *   node scripts/rebalance_alert.cjs --dry-run  只計算與印出，不寄信、不寫 state（測試用）
 *   node scripts/rebalance_alert.cjs --force     忽略去重，強制寄一次（驗證信箱用）
 *
 * 排程（VM crontab，週一~五 收盤後；VM 若為 UTC，07:00 UTC = 15:00 台北）：
 *   0 7 * * 1-5  cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/rebalance_alert.cjs >> data/rebalance_alert.log 2>&1
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── 先載入 .env（cron 環境通常沒有 export，靠這支補齊）──────────────
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(p, 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
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
const ETF_CODE = '00631L';
// 【增修I】防守端債券 ETF（與 review-web/src/lib/rebalance.ts BOND_ETFS 對齊）
const BOND_ETFS = [
  { code: '00687B', name: '國泰20年美債' },
  { code: '00953B', name: '群益優選非投等債' },
];

const DATA_DIR = path.join(__dirname, '..', 'data');
const HOLDINGS_PATH = path.join(DATA_DIR, 'rebalance_holdings.json');
const STATE_PATH = path.join(DATA_DIR, 'rebalance_alert_state.json');
const LOG_PATH = path.join(DATA_DIR, 'rebalance_alert.log');

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

function encodeSubject(text) {
  return '=?UTF-8?B?' + Buffer.from(text, 'utf-8').toString('base64') + '?=';
}

async function sendGmail(token, subject, textBody, htmlBody) {
  const boundary = '----b_' + Date.now();
  let raw;
  if (htmlBody) {
    raw = [
      `From: ${NOTIFY_EMAIL}`, `To: ${NOTIFY_EMAIL}`, `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody,
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', htmlBody,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    raw = [
      `From: ${NOTIFY_EMAIL}`, `To: ${NOTIFY_EMAIL}`, `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', textBody,
    ].join('\r\n');
  }
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

// ── 再平衡計算（移植自 review-web/src/lib/rebalance.ts；00631L＋防守端（現金＋債券 β=0））──
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}

function computeRebalance(input) {
  const shares = Math.max(0, safeNum(input.shares, 0));
  const price = Math.max(0, safeNum(input.price, 0));
  const avg_cost = Math.max(0, safeNum(input.avg_cost, 0));
  const cash = Math.max(0, safeNum(input.cash, 0));
  // 【增修I】債券市值（外部先算好傳入；舊持倉檔無 bonds → 0，行為同舊版）
  const bond_value = Math.max(0, safeNum(input.bond_value, 0));
  const defensive_value = cash + bond_value;
  const target_beta = safeNum(input.target_beta, 1.3);
  const tolerance_mode = input.tolerance_mode === 'pct' ? 'pct' : 'abs';
  const threshold_pct = Math.max(0, safeNum(input.threshold_pct, 10));
  const threshold_abs = Math.max(0, safeNum(input.threshold_abs, 0.1));
  const etf_beta = Math.max(0.1, safeNum(input.etf_beta, 2.0));

  const etf_value = shares * price;
  const total_value = etf_value + defensive_value;

  let cost_basis = null, unrealized_pnl = null, unrealized_pnl_pct = null;
  if (shares > 0 && avg_cost > 0) {
    cost_basis = shares * avg_cost;
    unrealized_pnl = etf_value - cost_basis;
    unrealized_pnl_pct = cost_basis > 0 ? unrealized_pnl / cost_basis : null;
  }

  const target_etf_weight = etf_beta > 0 ? clamp(target_beta / etf_beta, 0, 1) : null;
  const upper_band = tolerance_mode === 'abs' ? target_beta + threshold_abs : target_beta * (1 + threshold_pct / 100);
  const lower_band = Math.max(tolerance_mode === 'abs' ? target_beta - threshold_abs : target_beta * (1 - threshold_pct / 100), 0);

  if (total_value <= 0) {
    return { status: 'empty', current_beta: null, target_beta, upper_band, lower_band,
      etf_value: 0, total_value: 0, cash, bond_value, defensive_value,
      cost_basis, unrealized_pnl, unrealized_pnl_pct,
      etf_value_delta: null, trade_shares: null, post_beta: null, note: '尚未輸入持倉' };
  }

  const etf_weight = etf_value / total_value;
  const current_beta = etf_weight * etf_beta;
  let status = 'normal';
  if (current_beta > upper_band) status = 'sell';
  else if (current_beta < lower_band) status = 'buy';

  let target_etf_value = null, etf_value_delta = null, trade_shares = null, post_beta = null;
  if (target_etf_weight !== null) {
    target_etf_value = target_etf_weight * total_value;
    etf_value_delta = target_etf_value - etf_value;
    if (price > 0) {
      trade_shares = Math.round(etf_value_delta / price);
      const post_shares = shares + trade_shares;
      const post_etf_value = post_shares * price;
      // 【增修I】買賣 00631L 動用/回流的是防守端（現金），債券市值不動
      const post_defensive = defensive_value - trade_shares * price;
      const post_total = post_etf_value + post_defensive;
      post_beta = post_total > 0 ? (post_etf_value / post_total) * etf_beta : null;
    }
  }

  return { status, current_beta, target_beta, upper_band, lower_band, etf_weight,
    etf_value, total_value, cash, bond_value, defensive_value,
    cost_basis, unrealized_pnl, unrealized_pnl_pct,
    target_etf_value, etf_value_delta, trade_shares, post_beta };
}

// ── 信件內容 ──────────────────────────────────────────────────────
function fmtMoney(n) { return '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); }
function fmtBeta(n) { return n === null || n === undefined ? '—' : Number(n).toFixed(2) + 'X'; }

function buildEmail(r, price, priceDate, bondDetails) {
  const isSell = r.status === 'sell';
  const actionZh = isSell ? '建議賣出 00631L（部位過重、β 破上限）' : '建議買進 00631L（部位過輕、β 破下限）';
  const amountZh = r.etf_value_delta !== null ? `${isSell ? '賣出' : '買進'} ${fmtMoney(r.etf_value_delta)}` : '—';
  const sharesZh = r.trade_shares !== null ? `約 ${Math.abs(r.trade_shares).toLocaleString('en-US')} 股` : '—';
  const subject = `[00631L 再平衡] ${isSell ? '⚠ 該賣出' : '⚠ 該買進'} ${amountZh}（${sharesZh}）`;

  // 【增修I】防守端拆解（現金＋各債券 ETF 市值）；無債券持倉時只顯示現金
  const bonds = Array.isArray(bondDetails) ? bondDetails.filter((b) => b.shares > 0 || b.value > 0) : [];
  const defensiveLines = [`● 防守端合計：${fmtMoney(r.defensive_value)}（閒置現金 ${fmtMoney(r.cash)}` +
    (bonds.length > 0 ? ` ＋ 債券市值 ${fmtMoney(r.bond_value)}）` : '）')];
  for (const b of bonds) {
    defensiveLines.push(`   - ${b.code} ${b.name}：${b.shares.toLocaleString('en-US')} 股 × $${b.price} ＝ ${fmtMoney(b.value)}${b.source === 'holdings' ? '（沿用同步價）' : b.source === 'none' ? '（無價格，以 0 計）' : `（${b.date}）`}`);
  }

  const lines = [
    `00631L 再平衡提醒 — ${actionZh}`,
    ``,
    `● 動作：${amountZh}（${sharesZh}，${isSell ? '轉回現金' : '動用閒置現金'}）`,
    `● 目前投組 β：${fmtBeta(r.current_beta)}（目標 ${fmtBeta(r.target_beta)}，容忍區間 [${fmtBeta(r.lower_band)}, ${fmtBeta(r.upper_band)}]）`,
    `● 成交後 β 將回歸：${fmtBeta(r.post_beta)}`,
    ``,
    `── 依據 ──`,
    `● 00631L 收盤價：$${price}（${priceDate}）`,
    `● 00631L 市值：${fmtMoney(r.etf_value)}｜投組總資產：${fmtMoney(r.total_value)}`,
    ...defensiveLines,
    r.unrealized_pnl !== null
      ? `● 未實現損益：${r.unrealized_pnl >= 0 ? '+' : '-'}${fmtMoney(r.unrealized_pnl)}` +
        (r.unrealized_pnl_pct !== null ? `（${r.unrealized_pnl_pct >= 0 ? '+' : '-'}${Math.abs(r.unrealized_pnl_pct * 100).toFixed(1)}%）` : '')
      : `● 未實現損益：未填平均成本`,
    ``,
    `※ 本信為機械再平衡提醒（00631L β=2.0，防守端＝現金＋債券市值皆視為 β=0 簡化），依收盤價每日檢查，非投資建議。`,
    `※ 持倉數字取自 data/rebalance_holdings.json，如已異動請更新該檔。`,
  ];
  const text = lines.join('\n');

  const color = isSell ? '#d32f2f' : '#2e7d32';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px;">00631L 再平衡提醒</h2>
  <p style="margin:0 0 12px;color:${color};font-weight:bold;">${actionZh}</p>
  <div style="background:${isSell ? '#fdecea' : '#e8f5e9'};border:1px solid ${color}33;border-radius:6px;padding:14px;text-align:center;margin-bottom:14px;">
    <div style="font-size:13px;color:#555;">${isSell ? '應賣出 00631L' : '應買進 00631L'}</div>
    <div style="font-size:28px;font-weight:800;color:${color};">${r.etf_value_delta !== null ? fmtMoney(r.etf_value_delta) : '—'}</div>
    <div style="font-size:12px;color:#777;">${sharesZh}（${isSell ? '轉回現金' : '動用閒置現金'}）</div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px;border:1px solid #eee;">目前投組 β</td><td style="padding:6px;border:1px solid #eee;"><b>${fmtBeta(r.current_beta)}</b>（目標 ${fmtBeta(r.target_beta)}）</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">容忍區間</td><td style="padding:6px;border:1px solid #eee;">[${fmtBeta(r.lower_band)}, ${fmtBeta(r.upper_band)}]</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">成交後 β 回歸</td><td style="padding:6px;border:1px solid #eee;">${fmtBeta(r.post_beta)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">收盤價</td><td style="padding:6px;border:1px solid #eee;">$${price}（${priceDate}）</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">市值 / 總資產</td><td style="padding:6px;border:1px solid #eee;">${fmtMoney(r.etf_value)} / ${fmtMoney(r.total_value)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #eee;">防守端合計</td><td style="padding:6px;border:1px solid #eee;">${fmtMoney(r.defensive_value)}（現金 ${fmtMoney(r.cash)}${bonds.length > 0 ? `＋債券 ${fmtMoney(r.bond_value)}` : ''}）</td></tr>
    ${bonds.map((b) => `<tr><td style="padding:6px;border:1px solid #eee;">　${b.code} ${b.name}</td><td style="padding:6px;border:1px solid #eee;">${b.shares.toLocaleString('en-US')} 股 × $${b.price} ＝ ${fmtMoney(b.value)}</td></tr>`).join('\n    ')}
    ${r.unrealized_pnl !== null ? `<tr><td style="padding:6px;border:1px solid #eee;">未實現損益</td><td style="padding:6px;border:1px solid #eee;">${r.unrealized_pnl >= 0 ? '+' : '-'}${fmtMoney(r.unrealized_pnl)}${r.unrealized_pnl_pct !== null ? `（${r.unrealized_pnl_pct >= 0 ? '+' : '-'}${Math.abs(r.unrealized_pnl_pct * 100).toFixed(1)}%）` : ''}</td></tr>` : ''}
  </table>
  <p style="font-size:12px;color:#999;margin-top:14px;">機械再平衡提醒（00631L β=2.0，防守端＝現金＋債券市值皆視為 β=0 簡化），依收盤價每日檢查，非投資建議。持倉取自 data/rebalance_holdings.json。</p>
</body></html>`;

  return { subject, text, html };
}

// ── 主流程 ────────────────────────────────────────────────────────
function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } }
function writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { log('寫入 state 失敗: ' + e.message); }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');

  let holdings;
  try {
    holdings = JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf-8'));
  } catch {
    log(`找不到或無法解析持倉設定 ${HOLDINGS_PATH}（請由 scripts/rebalance_holdings.example.json 複製後填入）。跳過。`);
    return;
  }

  let price, priceDate;
  try {
    const o = await httpGetJson(`${GATEWAY_BASE}/api/stocks/${ETF_CODE}/ohlcv`);
    const rows = (o && o.data) || [];
    if (rows.length === 0) throw new Error('ohlcv 無資料');
    const latest = rows.reduce((a, b) => (b.date > a.date ? b : a));
    price = latest.close;
    priceDate = latest.date;
    if (!(Number.isFinite(price) && price > 0)) throw new Error('收盤價無效: ' + price);
  } catch (e) {
    log('抓取 00631L 收盤價失敗: ' + e.message);
    process.exitCode = 1;
    return;
  }

  // 【增修I】債券 ETF 市值：抓 ohlcv 收盤價；失敗退用持倉檔 bonds[].price（前端同步價）
  const holdingsBonds = Array.isArray(holdings.bonds) ? holdings.bonds : [];
  const bondDetails = [];
  let bond_value = 0;
  for (const meta of BOND_ETFS) {
    const hb = holdingsBonds.find((x) => x && typeof x === 'object' && x.code === meta.code) || {};
    const bShares = Math.max(0, safeNum(hb.shares, 0));
    if (bShares <= 0) continue; // 沒持倉不抓價，行為與舊版一致
    let bPrice = 0, bDate = '', source = 'ohlcv';
    try {
      const o = await httpGetJson(`${GATEWAY_BASE}/api/stocks/${meta.code}/ohlcv`);
      const rows = (o && o.data) || [];
      if (rows.length === 0) throw new Error('ohlcv 無資料');
      const latest = rows.reduce((a, b) => (b.date > a.date ? b : a));
      if (!(Number.isFinite(latest.close) && latest.close > 0)) throw new Error('收盤價無效');
      bPrice = latest.close; bDate = latest.date;
    } catch (e) {
      const stored = Math.max(0, safeNum(hb.price, 0));
      if (stored > 0) { bPrice = stored; source = 'holdings'; log(`抓 ${meta.code} 收盤價失敗（${e.message}），退用持倉檔同步價 $${stored}`); }
      else { source = 'none'; log(`抓 ${meta.code} 收盤價失敗（${e.message}）且持倉檔無價格，該檔市值以 0 計`); }
    }
    const value = bShares * bPrice;
    bond_value += value;
    bondDetails.push({ code: meta.code, name: meta.name, shares: bShares, price: bPrice, value, date: bDate, source });
  }

  const r = computeRebalance({ ...holdings, price, bond_value });
  log(`β=${fmtBeta(r.current_beta)} 目標=${fmtBeta(r.target_beta)} 區間=[${fmtBeta(r.lower_band)},${fmtBeta(r.upper_band)}] 狀態=${r.status} 價=$${price}@${priceDate} 防守端=${fmtMoney(r.defensive_value)}（現金 ${fmtMoney(r.cash)}＋債券 ${fmtMoney(r.bond_value)}）`);

  const state = readState();
  const actionable = r.status === 'buy' || r.status === 'sell';
  const changed = r.status !== state.last_status;

  if (!dryRun) {
    writeState({ last_status: r.status, last_date: priceDate, current_beta: r.current_beta, updated_at: new Date().toISOString() });
  }

  if (!actionable) { log('β 在容忍區間內，無需告警。'); return; }
  if (!force && !changed) { log(`狀態 ${r.status} 未變（上次已通知），略過寄信。加 --force 可強制寄。`); return; }

  const { subject, text, html } = buildEmail(r, price, priceDate, bondDetails);
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
