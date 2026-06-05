/**
 * oauth_reauth.cjs
 * 自動 OAuth 重授權：本地 server 接 redirect → 換 token → 更新 .env
 * 用法：node scripts/oauth_reauth.cjs
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const https = require('https');
const fs = require('fs');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}`;
const ENV_PATH = require('path').join(__dirname, '..', '.env');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

const authUrl =
  `https://accounts.google.com/o/oauth2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function updateEnv(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const code = urlObj.searchParams.get('code');
  const error = urlObj.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>授權失敗：${error}</h2>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Waiting...');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>授權成功！正在更新憑證，可以關閉此視窗。</h2>');
  server.close();

  console.log('\n[oauth_reauth] 收到授權 code，正在換 token...');
  try {
    const tokens = await postJson('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    if (tokens.error) {
      console.error('[oauth_reauth] 換 token 失敗:', tokens);
      process.exit(1);
    }

    console.log('[oauth_reauth] 換 token 成功');
    updateEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
    if (tokens.access_token) {
      updateEnv('GOOGLE_ACCESS_TOKEN', tokens.access_token);
    }
    console.log('[oauth_reauth] .env 已更新 GOOGLE_REFRESH_TOKEN');
    console.log('[oauth_reauth] 完成！');
    process.exit(0);
  } catch (err) {
    console.error('[oauth_reauth] 錯誤:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`[oauth_reauth] 本地伺服器啟動 port ${PORT}`);
  console.log('[oauth_reauth] 正在開啟瀏覽器...');
  // 開啟瀏覽器（Windows）
  exec(`start "" "${authUrl}"`, err => {
    if (err) {
      console.log('[oauth_reauth] 無法自動開啟瀏覽器，請手動開啟：');
      console.log(authUrl);
    }
  });
  console.log('\n請在瀏覽器中用 a4980678@gmail.com 登入並點擊「允許」...\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[oauth_reauth] Port ${PORT} 已被占用，請先關閉其他程式再試`);
  } else {
    console.error('[oauth_reauth] Server 錯誤:', err);
  }
  process.exit(1);
});
