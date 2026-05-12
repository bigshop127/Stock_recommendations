/**
 * reauth_with_gmail.cjs — 重新授權 Google 帳戶，加入 Gmail 發送權限
 * 使用方式：node scripts/reauth_with_gmail.cjs
 */

const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { exec } = require('child_process');

const envPath = path.join(__dirname, '../.env');
const envConfig = dotenv.parse(fs.readFileSync(envPath));

const app = express();
const PORT = 3002;

const CLIENT_ID = envConfig.GOOGLE_CLIENT_ID || '939568061140-922kr3lovdkb8alfi1p8kt1p302su1rh.apps.googleusercontent.com';
const CLIENT_SECRET = envConfig.GOOGLE_CLIENT_SECRET || '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';
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// ✅ 加入 Gmail 發送權限
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.send',  // ← 新增：Gmail 發送權限
  'https://www.googleapis.com/auth/gmail.readonly',  // ← 新增：Gmail 讀取權限
];

console.log('[INFO] 新授權 Scopes：');
SCOPES.forEach(s => console.log(`  - ${s}`));
console.log();

app.get('/', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',  // ← 強制顯示同意畫面
  });
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('授權失敗，未取得 code。');

  try {
    const { tokens } = await oauth2Client.getToken(code);

    // 更新 .env
    envConfig.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    if (tokens.access_token) envConfig.GOOGLE_ACCESS_TOKEN = tokens.access_token;

    const newEnvContent = Object.entries(envConfig)
      .map(([key, val]) => `${key}=${val}`)
      .join('\n');

    fs.writeFileSync(envPath, newEnvContent);

    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #4CAF50;">✅ Google 重新授權成功！</h1>
        <p><strong>新權限已激活：</strong></p>
        <ul style="text-align: left; display: inline-block;">
          <li>✓ Gmail 發送權限</li>
          <li>✓ Gmail 讀取權限</li>
          <li>✓ 帳號資訊</li>
        </ul>
        <p style="margin-top: 30px;">Refresh Token 已安全存入 .env 檔案。</p>
        <p>您可以關閉此視窗並返回 CLI。</p>
      </div>
    `);

    console.log('\n✅ [成功] Google 帳號重新授權完成（包含 Gmail 權限）');
    console.log(`   Refresh Token: ${tokens.refresh_token?.substring(0, 30)}...`);
    console.log(`   .env 已更新\n`);
    setTimeout(() => process.exit(0), 2000);
  } catch (err) {
    res.status(500).send(`授權過程發生錯誤: ${err.message}`);
    console.error('❌ Token 交換失敗:', err.message);
  }
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`========================================`);
  console.log(`正在啟動 Google OAuth 重新授權流程...`);
  console.log(`預期會添加 Gmail 發送權限`);
  console.log(`\n請在瀏覽器中完成授權：${url}`);
  console.log(`========================================\n`);

  // Windows 自動開啟瀏覽器
  exec(`start ${url}`, (err) => {
    if (err) console.log(`[提示] 請手動訪問：${url}`);
  });
});
