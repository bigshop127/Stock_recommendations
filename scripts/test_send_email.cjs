/**
 * test_send_email.cjs — 測試 Gmail 發送功能
 * 用法：node scripts/test_send_email.cjs [recipient_email] [subject] [message]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

const RECIPIENT = process.argv[2] || 'a4980678@gmail.com';
const SUBJECT = process.argv[3] || '測試郵件 — Gmail 發送測試';
const MESSAGE = process.argv[4] || `這是一封測試郵件，時間：${new Date().toISOString()}`;

console.log(`[INFO] 測試參數：`);
console.log(`  收件人：${RECIPIENT}`);
console.log(`  主旨：${SUBJECT}`);
console.log(`  內容：${MESSAGE.substring(0, 50)}...`);
console.log();

// ── 步驟 1：刷新 Token（如果 ACCESS_TOKEN 過期）
async function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 步驟 2：發送 Gmail
async function sendEmail(accessToken, to, subject, body) {
  return new Promise((resolve, reject) => {
    // 構建 RFC 2822 格式郵件
    const emailContent = `From: me\nTo: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`;

    // Base64 編碼（RFC 4648 URL-safe）
    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const reqBody = JSON.stringify({
      raw: encodedEmail,
    });

    const req = https.request(
      {
        hostname: 'gmail.googleapis.com',
        path: '/gmail/v1/users/me/messages/send',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, data });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ── 主流程
(async () => {
  try {
    console.log('[STEP 1] 刷新 Google Access Token...');
    const tokenResp = await refreshAccessToken();
    if (tokenResp.error) {
      throw new Error(`Token 刷新失敗: ${tokenResp.error} - ${tokenResp.error_description}`);
    }
    const newAccessToken = tokenResp.access_token;
    console.log(`✓ Token 刷新成功`);
    console.log();

    console.log('[STEP 2] 發送 Gmail...');
    const sendResp = await sendEmail(newAccessToken, RECIPIENT, SUBJECT, MESSAGE);
    console.log(`✓ 發送請求完成 (HTTP ${sendResp.status})`);
    console.log();

    if (sendResp.status === 200) {
      console.log('✅ 郵件發送成功！');
      console.log(`Message ID: ${sendResp.data.id}`);
    } else {
      console.log(`⚠️  發送狀態異常: ${sendResp.status}`);
      console.log('Response:', JSON.stringify(sendResp.data, null, 2));
    }
  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
})();
