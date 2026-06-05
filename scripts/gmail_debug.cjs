/**
 * gmail_debug.cjs — 診斷 Gmail 搜尋（含 spam/trash）
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

async function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const b = new URLSearchParams(body).toString();
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', reject); req.write(b); req.end();
  });
}

async function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject); req.end();
  });
}

async function getToken() {
  const r = await httpsPost('oauth2.googleapis.com', '/token', {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN, grant_type: 'refresh_token'
  });
  if (r.error) throw new Error(`${r.error}: ${r.error_description}`);
  return r.access_token;
}

async function search(token, query) {
  const q = encodeURIComponent(query);
  const r = await httpsGet('gmail.googleapis.com', `/gmail/v1/users/me/messages?maxResults=5&q=${q}`, token);
  return r;
}

async function getEmailSubject(token, id) {
  const r = await httpsGet('gmail.googleapis.com', `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, token);
  const headers = r.payload?.headers || [];
  const get = (name) => headers.find(h => h.name === name)?.value || '';
  return { subject: get('Subject'), from: get('From'), date: get('Date') };
}

async function main() {
  console.log('取得 access token...');
  const token = await getToken();
  console.log('Token OK\n');

  const queries = [
    'in:anywhere from:service@inclusion.com.tw',
    'in:anywhere 浦惠',
    'in:anywhere pressplay',
    'in:anywhere 浦惠投顧',
    'in:spam 浦惠',
    'in:trash 浦惠',
    'in:anywhere label:spam 浦惠',
    'after:2026/04/22 in:anywhere',  // 所有最近的郵件
  ];

  for (const q of queries) {
    process.stdout.write(`搜尋: "${q}" ... `);
    try {
      const r = await search(token, q);
      const count = r.messages?.length || 0;
      if (count > 0) {
        console.log(`找到 ${count} 封`);
        for (const m of (r.messages || []).slice(0, 3)) {
          const info = await getEmailSubject(token, m.id);
          console.log(`  [${m.id}] ${info.date} | From: ${info.from}`);
          console.log(`          Subject: ${info.subject}`);
        }
      } else {
        console.log(`0 封`);
        if (r.error) console.log(`  Error: ${JSON.stringify(r.error)}`);
      }
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
    console.log('');
  }

  // 也顯示一下最近收到的幾封信（不限關鍵字）
  console.log('=== 最近 5 封郵件（全部）===');
  const recent = await httpsGet('gmail.googleapis.com', '/gmail/v1/users/me/messages?maxResults=5', token);
  for (const m of (recent.messages || [])) {
    const info = await getEmailSubject(token, m.id);
    console.log(`  ${info.date} | From: ${info.from}`);
    console.log(`  Subject: ${info.subject}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
