/**
 * send_puhui_email.cjs — 發送浦惠投顧報告（HTML 格式，動態從 Obsidian markdown 轉換）
 * 用法：node scripts/send_puhui_email.cjs [YYYY-MM-DD]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const path = require('path');
const { loadAndConvertReport } = require('./puhui_markdown_to_html.cjs');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

const RECIPIENT = 'a4980678@gmail.com';
const OBSIDIAN_BASE_PATH = 'C:\\obsidian\\儲存庫\\浦惠投顧報告整理';

// 計算日期所在的週數（1-5）
function getWeekNumber(date) {
  const dayOfMonth = date.getDate();
  const week = Math.ceil(dayOfMonth / 7);
  return Math.min(week, 5); // 最多 W5
}

// 取得 Obsidian 報告文件路徑
function getReportFilePath(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const week = getWeekNumber(date);
  return path.join(OBSIDIAN_BASE_PATH, `${year}-${month}`, `W${week}`, `${dateStr}.md`);
}

// HTML 格式的浦惠投顧報告（動態生成，見下方主流程）
let HTML_CONTENT = '';

// 刷新 Token
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

// 對中文 Subject 進行 RFC 2047 編碼
function encodeSubject(subject) {
  const buf = Buffer.from(subject, 'utf-8');
  const encoded = buf.toString('base64');
  return `=?utf-8?B?${encoded}?=`;
}

// 發送 HTML 郵件
async function sendEmail(accessToken, to, subject, htmlBody) {
  return new Promise((resolve, reject) => {
    const encodedSubject = encodeSubject(subject);
    const emailContent =
      `From: me\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n` +
      `${htmlBody}`;

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

// 主流程
(async () => {
  try {
    // 確定報告日期（預設為今日，或從命令列參數取得）
    const dateArg = process.argv[2];
    let dateStr;
    if (dateArg) {
      dateStr = dateArg;
    } else {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    }
    console.log(`📅 準備發送報告：${dateStr}\n`);

    console.log('[STEP 1] 載入 Obsidian 報告...');
    const reportFilePath = getReportFilePath(dateStr);
    console.log(`   路徑: ${reportFilePath}`);
    let htmlContent;
    try {
      htmlContent = await loadAndConvertReport(reportFilePath);
      console.log(`✓ 報告已載入並轉換為 HTML\n`);
    } catch (fileErr) {
      throw new Error(`無法載入報告檔案：${fileErr.message}`);
    }

    console.log('[STEP 2] 刷新 Google Access Token...');
    const tokenResp = await refreshAccessToken();
    if (tokenResp.error) {
      throw new Error(`Token 刷新失敗: ${tokenResp.error} - ${tokenResp.error_description}`);
    }
    const newAccessToken = tokenResp.access_token;
    console.log(`✓ Token 刷新成功\n`);

    console.log('[STEP 3] 發送浦惠投顧 HTML 郵件...');
    const subject = `📊 浦惠投顧每日摘要 — ${dateStr}`;
    const sendResp = await sendEmail(newAccessToken, RECIPIENT, subject, htmlContent);
    console.log(`✓ 發送請求完成 (HTTP ${sendResp.status})\n`);

    if (sendResp.status === 200) {
      console.log('✅ 浦惠投顧報告已發送成功！');
      console.log(`Message ID: ${sendResp.data.id}`);
      console.log('\n📧 請打開 Gmail 查看：https://mail.google.com');
    } else {
      console.log(`⚠️  發送狀態異常: ${sendResp.status}`);
      console.log('Response:', JSON.stringify(sendResp.data, null, 2));
    }
  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
})();
