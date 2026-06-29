/**
 * puhui_daily.cjs — 浦惠投顧每日摘要自動化
 *
 * 流程：
 *   1. 檢查今日輸出（本機 Obsidian 筆記 / VM repo 報告）是否已存在 → 存在即退出
 *   2. 測試 Google OAuth 健康狀態 → 失敗則 Telegram 告警
 *   3. 搜尋 Gmail 取得今日每日摘要郵件
 *   4. 若無郵件 → 從通知信取 PressPlay URL → Playwright 無頭抓取
 *   5. AI 摘要：本機/VM = Claude CLI 主力 → Gemini fallback；雲端 CI = 只用 Gemini
 *   6. 格式化為 Markdown
 *   7. 寫入輸出：本機寫 Obsidian + repo reports/；VM/CI 只寫 repo reports/
 *   8. git push reports/（本機 + VM；CI 由 workflow 另外 push）＋ Telegram 安全網告警
 *
 * 執行環境（RUN_TARGET，階段8 §A 解耦原本黏在 IS_CI 的多個面向）：
 *   local（預設）= Claude CLI + 寫 Obsidian + git push + 告警   ← Windows 本機 Task Scheduler
 *   vm           = Claude CLI + 不寫 Obsidian + git push + 告警  ← Oracle Linux VM cron（B1）
 *   ci           = 只用 Gemini + 不寫 Obsidian + 不在腳本內 push ← GitHub Actions
 *   相容性：未設 RUN_TARGET 時，CI=true→ci、否則→local，與舊行為完全一致。
 *
 * 執行：node scripts/puhui_daily.cjs [YYYY-MM-DD] [URL]（無參數則用今天）
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── 設定 ────────────────────────────────────────────────
// TARGET_DATE 用 Asia/Taipei 算當天日期。
// Why: 原本用 new Date().toISOString() = UTC，當 cron 在台北凌晨跑時 UTC 還在「昨天」，
// target 會算錯一天（2026-06-04→6-05 跳過事件就是這個 bug）。
const TARGET_DATE = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const FORCE_REGENERATE = process.argv.includes('--force');
const ARTICLE_URL_OVERRIDE = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : null;

// ── 執行環境解耦（階段8 §A）────────────────────────────────
// 原本 IS_CI 一個旗標綁了四件事：用 Claude CLI / 寫 Obsidian / git push / 發告警。
// Oracle VM 兩者都不符（要 Claude CLI＋push＋告警，但沒有 Obsidian），故拆成 RUN_TARGET。
// 相容性：未設 RUN_TARGET → CI=true 視為 'ci'、否則 'local'，本機與 CI 行為完全不變。
const RUN_TARGET = (process.env.RUN_TARGET || (process.env.CI === 'true' ? 'ci' : 'local')).toLowerCase();
const IS_CI = RUN_TARGET === 'ci';             // 只用 Gemini、不寫 Obsidian、push 由 workflow 處理
const WRITE_OBSIDIAN = RUN_TARGET === 'local'; // 只有本機寫 Obsidian vault（VM/CI 不寫）
// 其餘沿用 !IS_CI 語意（local + vm）：用 Claude CLI 主力、會 git push、會發 Telegram 告警。
const [Y, M, D] = TARGET_DATE.split('-');
const DATE_DISPLAY = `${Y}/${M}/${D}`;

// 計算月份內的週數（week-of-month）用於資料夾組織
// 規則：日期所在 ISO 週的星期一決定歸屬月份；W = 該月第幾個星期一
// 例：5/04 (Mon) → 2026-05/W1；5/22 (Fri, Mon=5/18) → 2026-05/W3；
//     5/01 (Fri, Mon=4/27) → 2026-04/W4（孤兒日跟 Monday 走）
function getMonthWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = date.getUTCDay() || 7; // Sun=7
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayOfWeek + 1);
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  const mondayDay = monday.getUTCDate();
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = firstOfMonth.getUTCDay() || 7;
  const firstMondayDay = firstDow === 1 ? 1 : (1 + (8 - firstDow));
  const weekOfMonth = Math.floor((mondayDay - firstMondayDay) / 7) + 1;
  return { year, month, weekOfMonth };
}

const { year: targetYear, month: targetMonth, weekOfMonth } = getMonthWeek(TARGET_DATE);
const MONTH_FOLDER = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
const WEEK_FOLDER = `W${weekOfMonth}`;

const OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || 'C:\\obsidian\\儲存庫\\浦惠投顧報告整理';
const NOTE_DIR = path.join(OBSIDIAN_DIR, MONTH_FOLDER, WEEK_FOLDER);
const NOTE_PATH = path.join(NOTE_DIR, `${TARGET_DATE}.md`);
// repo reports/（手機透過 GitHub pull 讀取；本機 + VM + CI 都寫這裡）
const REPORT_DIR = path.join(__dirname, '..', 'reports', MONTH_FOLDER, WEEK_FOLDER);
const REPORT_PATH = path.join(REPORT_DIR, `${TARGET_DATE}.md`);
// 「今天是否已產出」判斷：本機看 Obsidian 筆記、VM 看 repo 報告（CI 永不跳過）
const EXISTING_OUTPUT_PATH = WRITE_OBSIDIAN ? NOTE_PATH : REPORT_PATH;
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'puhui_daily.log');
const PUHUI_CACHE_PATH = path.join(__dirname, '..', 'data', 'puhui_cache.json');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2;
const GEMINI_API_KEY_3 = process.env.GEMINI_API_KEY_3;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'a4980678@gmail.com';

// Gmail token 在 OAuth 成功後填入，供 sendEmail 使用
let _gmailToken = null;

// ── 工具函式 ────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const b = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b), ...headers } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject); req.write(b); req.end();
  });
}

function httpsPostJson(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject); req.write(b); req.end();
  });
}

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject); req.end();
  });
}

function decodeBase64(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractTextFromPayload(payload) {
  function walk(p) {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64(p.body.data);
    if (p.mimeType === 'text/html' && p.body?.data) {
      return decodeBase64(p.body.data)
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
    }
    if (p.parts) { for (const pt of p.parts) { const t = walk(pt); if (t) return t; } }
    return '';
  }
  return walk(payload);
}

// ── 通知：Telegram + Email ────────────────────────────────
async function sendTelegram(text, { html = false } = {}) {
  try {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text };
    if (html) payload.parse_mode = 'HTML';
    const result = await httpsPostJson('api.telegram.org',
      `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload
    );
    if (result.ok) {
      log(`Telegram 已發送 (message_id: ${result.result?.message_id})`);
    } else {
      log(`Telegram API 回傳失敗: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    log(`Telegram 發送失敗: ${e.message}`);
  }
}

// 偶發失敗（chromium SIGSEGV、暫時性網路錯誤）的 retry 包裝
async function withRetry(fn, label, { max = 3, delayMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) log(`${label} 第 ${attempt} 次嘗試成功`);
      return result;
    } catch (e) {
      lastErr = e;
      log(`${label} 失敗 (attempt ${attempt}/${max}): ${e.message}`);
      if (attempt < max) {
        log(`等 ${Math.round(delayMs / 1000)}s 後重試...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// buildTelegramSummary 已於 2026-05-28 (commit a4e48ac) 從 main flow 移除，
// 整個函式於 2026-06-04 一併刪除，徹底斷根避免任何路徑誤觸發 Telegram 每日摘要。
// 報告統一在 Obsidian / GitHub 查看；Telegram 僅保留 cookies/OAuth/崩潰等安全網警告。

function encodeSubject(text) {
  // RFC 2047 encoding for non-ASCII subjects
  const encoded = Buffer.from(text).toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

function markdownToHTML(markdown) {
  let html = markdown;

  // Process tables first (before line breaks)
  const tableRegex = /^\|[\s\S]*?\n\|.*?\|[\s\S]*?(?=\n\n|\n[^|]|$)/gm;
  html = html.replace(tableRegex, (tableStr) => {
    const rows = tableStr.trim().split('\n');
    if (rows.length < 2) return tableStr;

    const headers = rows[0].split('|').slice(1, -1).map(h => h.trim());
    const cellStyle = 'padding:10px;border:1px solid #ddd;text-align:left';
    const headerStyle = 'padding:12px;border:1px solid #ddd;background:#f5f5f5;font-weight:bold;color:#1a1a1a';

    let table = '<table style="border-collapse:collapse;width:100%;margin:12px 0">';
    table += '<thead><tr>' + headers.map(h => `<th style="${headerStyle}">${h}</th>`).join('') + '</tr></thead>';
    table += '<tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].split('|').slice(1, -1).map(c => c.trim());
      if (cells.some(c => c.length > 0)) {
        table += '<tr>' + cells.map(c => `<td style="${cellStyle}">${c}</td>`).join('') + '</tr>';
      }
    }
    table += '</tbody></table>';
    return table;
  });

  // Headers (before escaping)
  html = html.replace(/^# (.*?)$/gm, '<h1 style="color:#1a1a1a;margin:24px 0 12px;font-size:28px;font-weight:bold">$1</h1>');
  html = html.replace(/^## (.*?)$/gm, '<h2 style="color:#333;margin:20px 0 10px;font-size:22px;font-weight:bold">$1</h2>');
  html = html.replace(/^### (.*?)$/gm, '<h3 style="color:#555;margin:16px 0 8px;font-size:18px;font-weight:bold">$1</h3>');
  html = html.replace(/^#### (.*?)$/gm, '<h4 style="color:#666;margin:12px 0 6px;font-size:16px;font-weight:bold">$1</h4>');

  // Blockquotes (警示框)
  html = html.replace(/^> (.*?)$/gm, '<div style="background:#fff3cd;border-left:4px solid #ff9800;padding:12px 16px;margin:12px 0;border-radius:4px;color:#e65100">$1</div>');

  // Links (before escaping)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#1976d2;text-decoration:none">$1</a>');

  // Bold and italic (before escaping)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#d32f2f">$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Escape remaining HTML in plain text
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Restore HTML tags
  html = html.replace(/&lt;a href=/g, '<a href=').replace(/&quot;/g, '"').replace(/&lt;\/a&gt;/g, '</a>');
  html = html.replace(/&lt;strong/g, '<strong').replace(/&lt;\/strong&gt;/g, '</strong>');
  html = html.replace(/&lt;em/g, '<em').replace(/&lt;\/em&gt;/g, '</em>');
  html = html.replace(/&lt;h[1-4]/g, (m) => m.replace('&lt;', '<')).replace(/&lt;\/h[1-4]&gt;/g, (m) => m.replace('&lt;', '<').replace('&gt;', '>'));
  html = html.replace(/&lt;div style=/g, '<div style=').replace(/&lt;\/div&gt;/g, '</div>');
  html = html.replace(/&lt;table/g, '<table').replace(/&lt;\/table&gt;/g, '</table>');
  html = html.replace(/&lt;thead/g, '<thead').replace(/&lt;\/thead&gt;/g, '</thead>');
  html = html.replace(/&lt;tbody/g, '<tbody').replace(/&lt;\/tbody&gt;/g, '</tbody>');
  html = html.replace(/&lt;tr/g, '<tr').replace(/&lt;\/tr&gt;/g, '</tr>');
  html = html.replace(/&lt;th/g, '<th').replace(/&lt;\/th&gt;/g, '</th>');
  html = html.replace(/&lt;td/g, '<td').replace(/&lt;\/td&gt;/g, '</td>');
  html = html.replace(/&lt;span style=/g, '<span style=').replace(/&lt;\/span&gt;/g, '</span>');

  // Lists
  html = html.replace(/^- (.+?)$/gm, '<li style="margin:10px 0;line-height:1.6">$1</li>');
  const listRegex = /(<li[^<]*>[^<]*<\/li>[\s\n]*)+/gm;
  html = html.replace(listRegex, (match) => `<ul style="margin:16px 0;padding:0 0 0 24px">\n${match}</ul>\n`);

  // Line breaks and paragraphs
  html = html.replace(/\n\n+/g, '</p><p style="margin:14px 0;line-height:1.8;color:#333">');
  html = html.replace(/\n/g, '<br>');
  html = `<p style="margin:14px 0;line-height:1.8;color:#333">${html}</p>`;

  // Remove double paragraph tags
  html = html.replace(/<\/p>\s*<p>/g, '</p><p>');

  const css = `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 900px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; font-size: 28px; margin: 24px 0 12px; }
    h2 { color: #333; font-size: 22px; margin: 20px 0 10px; }
    h3 { color: #555; font-size: 18px; margin: 16px 0 8px; }
    h4 { color: #666; font-size: 16px; margin: 12px 0 6px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th { background: #f5f5f5; padding: 12px; border: 1px solid #ddd; font-weight: bold; color: #1a1a1a; }
    td { padding: 10px; border: 1px solid #ddd; }
    a { color: #1976d2; text-decoration: none; }
    strong { color: #d32f2f; font-weight: bold; }
    em { font-style: italic; }
    ul { margin: 8px 0 8px 20px; padding: 0; }
    li { margin: 6px 0; }
    div[style*="background"] { border-radius: 4px; }
  </style>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css}
</head>
<body>
${html}
</body>
</html>`;
}

async function sendEmail(subject, body, htmlBody = null) {
  if (!_gmailToken) return; // OAuth 尚未成功，跳過
  try {
    const encodedSubject = encodeSubject(subject);
    let raw;
    if (htmlBody) {
      // Multipart MIME with HTML alternative
      const boundary = '----boundary_' + Date.now();
      const textPart = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
      const htmlPart = `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`;
      const closing = `--${boundary}--`;

      raw = [
        `From: ${NOTIFY_EMAIL}`,
        `To: ${NOTIFY_EMAIL}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        textPart,
        htmlPart,
        closing
      ].join('\r\n');
    } else {
      // Plain text email
      raw = [
        `From: ${NOTIFY_EMAIL}`,
        `To: ${NOTIFY_EMAIL}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
      ].join('\r\n');
    }

    const encoded = Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await new Promise((resolve, reject) => {
      const b = JSON.stringify({ raw: encoded });
      const req = https.request(
        { hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send',
          method: 'POST', headers: { Authorization: `Bearer ${_gmailToken}`,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
        res => { res.resume(); res.on('end', resolve); }
      );
      req.on('error', reject); req.write(b); req.end();
    });
  } catch (e) {
    log(`Email 發送失敗: ${e.message}`);
  }
}

async function notify(subject, text) {
  await Promise.all([
    sendTelegram(text),
    sendEmail(`[浦惠自動化] ${subject}`, text.replace(/<[^>]+>/g, '').replace(/\*/g, '').replace(/_/g, '')),
  ]);
}

// ── Google OAuth ──────────────────────────────────────────
async function getAccessToken() {
  const r = await httpsPost('oauth2.googleapis.com', '/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  if (r.error) throw new Error(`OAuth: ${r.error} - ${r.error_description}`);
  return r.access_token;
}

// ── Gmail ─────────────────────────────────────────────────
async function searchGmail(token, query, max = 10) {
  const q = encodeURIComponent(query);
  return httpsGet('gmail.googleapis.com', `/gmail/v1/users/me/messages?maxResults=${max}&q=${q}`, token);
}

async function getEmail(token, id) {
  return httpsGet('gmail.googleapis.com', `/gmail/v1/users/me/messages/${id}?format=full`, token);
}

function extractPressPlayLinks(payload) {
  function walk(p) {
    if (!p) return '';
    if (p.mimeType === 'text/html' && p.body?.data) return decodeBase64(p.body.data);
    if (p.parts) return p.parts.map(walk).join('');
    return '';
  }
  const html = walk(payload);
  const links = [];
  const re = /href="([^"]+pressplay\.cc\/project\/[^"]+\/articles\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return [...new Set(links)];
}

// ── PressPlay API 直接抓取（取代 Playwright headless）───────
// 使用 og-web.pressplay.cc/timeline/{id}/info，穩定不受 bot 偵測影響
async function fetchPressPlayArticle(url) {
  const articleId = url.match(/articles\/([A-Z0-9]+)/i)?.[1];
  if (!articleId) throw new Error(`無法從 URL 取得文章 ID: ${url}`);

  const cookies = fs.existsSync(COOKIES_PATH)
    ? JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'))
    : [];
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  log(`已載入 ${cookies.length} 個 PressPlay cookies`);

  const PP_HEADERS = {
    'Cookie': cookieStr,
    'pp-os': 'Web', 'pp-os-ver': '1.0', 'pp-app-ver': '1.0',
    'pp-locale': 'zh-TW', 'pp-region': 'TW',
    'pp-timezone': 'Asia/Taipei', 'pp-timezone-offset': '-480',
    'pp-device-id': 'howdoyouturnthison',
    'x-requested-with': 'XMLHttpRequest',
    'accept': 'application/json',
    'referer': 'https://www.pressplay.cc/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };

  const data = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'og-web.pressplay.cc', path: `/timeline/${articleId}/info`,
        method: 'GET', headers: PP_HEADERS },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.end();
  });

  if (!data?.data?.canReadTimeline) {
    log(`⚠️ canReadTimeline=false，cookies 可能失效（status=${data?.status}）`);
  }

  const info = data?.data?.timeline_info || {};
  const htmlContent = info.timeline_desc || '';
  const title = info.timeline_title || '';

  // HTML → 純文字
  const content = htmlContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const preview = content.substring(0, 200).replace(/\n/g, ' ');
  log(`抓取完成，內容長度: ${content.length}，前200字: ${preview}`);
  return { title, content };
}

// ── Obsidian 報告 Prompt（金標準：2026-05-21）────────────
function buildObsidianPrompt(articleTitle, rawContent, dateDisplay) {
  const { systemPrompt, userPrompt } = buildObsidianPromptSplit(articleTitle, rawContent, dateDisplay);
  return systemPrompt + '\n\n' + userPrompt;
}

function buildObsidianPromptSplit(articleTitle, rawContent, dateDisplay) {
  const systemPrompt = `你是台股投資分析助手。請將浦惠投顧老王的每日分析文章，整理成繁體中文的 Obsidian Markdown 筆記。

【第一步：段落分組 — 最重要的規則】
閱讀全文後，先在腦中把所有段落依主題分組：
- 討論「同一家公司財報/事件」的多段 → 合併為同一個 ## 或 ### 區塊
- 討論「同一個市場/指數走勢」的多段 → 合併
- 討論「同一個選股邏輯/操作建議」的多段 → 合併
- 只有真正不相關的段落才分開
**每一段原文內容都必須涵蓋到，不能漏掉任何段落的資訊。**

【報告章節結構 — 依序輸出】
1. 標題 + 副標題
2. ## 🎯 整體操作水位（[!tip] callout，放最前面）
3. ## 🌍 大盤與美股觀察（含指數表格）
4. 當日主題區塊（依文章內容動態生成，例：## 💡 Nvidia 財報、## 🚀 SpaceX IPO 等）
5. ## 🇹🇼 台股評估與選股邏輯（含老王選股教學）
6. **重大風險警示區塊（若原文有提及高盛、聯準會、地緣政治、IPO 風險等情緒警示，必須獨立成段，不可只用 [!warning] 一句帶過）**
7. ## 📌 今日提到個股（每檔獨立 ### + 表格）
8. ## ⚠️ 老王重要提醒

【Obsidian Callout 語法 — 絕對不用 HTML div，只用這個】
\`\`\`
> [!tip] 標題文字
> 內容

> [!info] 標題文字
> 內容

> [!note] 標題文字
> 內容

> [!warning] 標題文字
> 內容

> [!danger] 標題文字
> 內容
\`\`\`
使用時機：
- [!tip]：操作水位、正面訊號、選股建議
- [!info]：數據統計、財報數字、指數表現
- [!note]：補充說明、細節資訊
- [!warning]：重要觀察、需注意事項、均線警戒
- [!danger]：重大風險、IPO 重要事件、利空警示

【重大風險警示區塊 — 強制獨立成段】
原文若出現以下任一主題，必須建立獨立 ## 章節（不可只用 [!warning] 一句帶過）：
- 高盛 / JPMorgan / 大型投行對市場情緒的警示（如「貪婪 > 恐懼」）
- 聯準會利率 / 通膨 / 油價對市場的潛在衝擊
- IPO 風險（SpaceX、OpenAI、Anthropic 等）
- 地緣政治、AI 巨頭資本支出反噬等系統性風險

章節格式：
\`\`\`
## 🏦 [機構名稱]示警：[核心警示主題]

[2 段論述文字，2-3 句話 / 段，完整呈現警示邏輯與市場含義]

> [!danger] 市場情緒風險警示
> - 高盛 Solomon：<span style="color:red">**貪婪 > 恐懼**</span>，市場已進入情緒驅動價格的階段
> - 潛在風險一：油價推升通膨 → 聯準會利率壓力重回市場
> - 潛在風險二：AI 財測若不如預期，市場震盪可能又快又狠
> - 外資疾呼：<span style="color:red">**漲多就是最大的風險來源**</span>
> - 高本益比、高油價、通膨壓力，目前市場選擇全數無視
\`\`\`

【色碼系統 — 個股與內文】
個股標題色碼（用 <span style="color:..."> 包住 ### 標題）：
- 🔴 可持續抱股 → color:red
- 🟠 觀察個股訊號 → color:#B35A00
- 🟢 風險警示 → color:green

個股表格內「關鍵訊號 / 操作建議」要用「螢光筆背景」凸顯（與標題 emoji 同色系）：
- 🔴 個股 → <mark style="background:#FFCDD2">**重點文字**</mark>（粉紅螢光）
- 🟠 個股 → <mark style="background:#FFE0B2">**重點文字**</mark>（橘色螢光）
- 🟢 個股 → <mark style="background:#C8E6C9">**重點文字**</mark>（綠色螢光）
規則：
- 同一檔個股的表格內，只有 emoji 對應的螢光色，不可混色
- 一格內最多 1-2 處螢光重點，不要整段都包進去
- 一般敘述（補充說明、均線判斷）不加螢光，僅關鍵訊號／操作建議用

內文重點色碼（章節敘述中用 <span style="color:..."> 包住關鍵文字，非個股表格）：
- color:red → 強勢訊號、利多、漲停、創新高
- color:#B35A00 → 警戒觀察、均線挑戰、尚未確認
- color:green → 安全持有確認

【個股區塊格式 — 欄位數量依個股重要程度動態調整】

**主力個股（當日重點 / 外資加碼 / 創新高 / 突破關鍵均線）→ 6-8 列**
原文有詳細財報、外資評估、供需結構、催化劑、目標價的個股，必須完整呈現。

**欄位選擇規則（重要）**：欄位名稱必須**依照當日原文實際提到的內容命名與填寫**，不可硬套下方範例的欄位名稱。範例只是格式示意，實際欄位由原文決定（例如台積電應該是 CoWoS 產能/HBM 綁定/北美客戶；中華電應該是 5G ARPU/低軌衛星佈局等）。**原文沒有提到的欄位不要硬塞，也不可填「N/A」**。

通用欄位池（依原文挑選 6-8 個對應的）：
- **近期表現 / 技術面**（必有，描述今日 K 棒、均線狀態、波段位置）
- **法人評估**（外資 / 投信目標價、評等異動，原文有才放）
- **產業地位 / 護城河**（市佔、技術領先、產能優勢，依個股產業填）
- **供需邏輯 / 漲價催化**（缺貨、調漲、產能轉移等基本面驅動，原文有才放）
- **財報亮點**（單月/季度 EPS、營收、年增率，原文有才放）
- **關鍵催化劑**（同業比價、即將公布的事件、外資籌碼動向）
- **操作建議**（必有，明確的減碼/續抱/停損條件）
- **目標展望**（外資目標價、長線 EPS 推估、本益比邏輯，原文有才放）

範例格式（國巨案例，僅示範表格結構與螢光筆用法，**欄位名稱請依當日個股調整**）：
\`\`\`
### <span style="color:red">🔴 [股名]（[代號]）</span>

| 項目 | 內容 |
| --- | --- |
| **近期表現** | <mark style="background:#FFCDD2">**[依原文：K棒型態 / 創新高 / 突破壓力]**</mark>，[補充技術面] |
| **法人評估** | <mark style="background:#FFCDD2">**[依原文：哪家投行調升目標價多少]**</mark>，[評等動向] |
| **產業地位** | [依原文：市佔、產能、技術領先點] |
| **漲價/供需邏輯** | [依原文：缺貨倍數、客戶拉貨情況] |
| **財報亮點** | [依原文：單月 EPS、年增率，例 <span style="color:red">**+216 倍 YoY**</span>] |
| **關鍵催化劑** | [依原文：即將公布的事件、同業動態] |
| **操作建議** | [明確的均線進出條件] |
| **目標展望** | <mark style="background:#FFCDD2">**[外資目標價或長線推估]**</mark> |
\`\`\`

**次要個股（提及但無深入分析）→ 4-5 列**
\`\`\`
### <span style="color:#B35A00">🟠 緯創</span>

| 項目 | 內容 |
| --- | --- |
| **關鍵訊號** | <mark style="background:#FFE0B2">**連三漲停後昨爆 28 萬張超級大量**</mark> |
| **操作建議** | <mark style="background:#FFE0B2">**昨日爆量低點不能跌破**</mark>，量縮即轉弱 |
| **均線判斷** | 五日均線 = 減碼防線，十日均線 = 波段防線 |
| **補充說明** | AI PC 族群短線飆漲後典型量價結構 |
\`\`\`

🟠 與 🟢 個股請對應改用 #FFE0B2、#C8E6C9 螢光色。

**個股表格欄位選擇原則：**
- 原文有提到的欄位必須涵蓋，**不可省略原文已有的資訊**
- 主力推薦個股（當日重點 / 外資加碼 / 創新高）至少 6 列
- 一般觀察個股至少 4 列
- **欄位名稱必須對應當日個股產業與原文實際內容**：半導體個股用 CoWoS / HBM / 製程節點；面板用稼動率 / OLED / 新世代產線；金融用淨利息收益率 / 資本適足率；通路用毛利率 / 庫存週轉。**禁止把示範裡的「鉭質電容護城河 / 晶片電阻優勢」等國巨專屬欄位硬套到非被動元件個股上**
- 螢光筆用在「關鍵訊號 / 操作建議 / 目標展望 / 法人評估」等決策性欄位

【表格使用規則】
- 美股指數比較 → Markdown 表格（| 市場 | 今日表現 | 備註 |）
- 財務數據比較（多業務/多季） → 表格
- 個股操作建議 → 詳細欄位表格（見【個股區塊格式】）
- 情境操作策略（A/B/C 場景）→ 表格

【表格漲跌色彩 — 強制】
- 表格儲存格內出現**漲幅 / 利多 / 創新高**數據，用 <span style="color:red">**+X%**</span> 紅字粗體
- 表格儲存格內出現**跌幅 / 利空 / 回檔**數據，用 <span style="color:green">**-X%**</span> 綠字粗體
- 例（大盤觀察表格）：
  | 市場 | 今日表現 | 備註 |
  | --- | --- | --- |
  | S&P500 | 收 **7609** 創歷史新高 | YTD <span style="color:red">**+11.2%**</span> |
  | Alphabet | <span style="color:green">**-3.9%**</span> | 籌資 800 億美元壓力 |
- 表格下方若出現英文縮寫（YTD、CAGR、ADR、MLCC、ODM、CSP 等），必須加註：
  例：
  > *YTD：今年以來漲幅　　*CAGR：年複合成長率　　*MLCC：多層陶瓷電容
- 註解放在表格緊接的下一行，用斜體 + 全形空白分隔

【數據格式】
- 所有百分比、點數、億美元、倍數 → **粗體**
- 例：**+92% YoY**、**752 億美元**、**漲停**、**10 倍**
- 章節敘述（非表格）中，關鍵漲幅/目標價/重要倍數應用 <span style="color:red">**...**</span> 包覆，不可只用粗體

【排除段落 — 絕對不可寫入報告】
以下三類段落屬於文章固定樣板，**不是當日分析內容**，必須完全忽略、不要轉述、不要做成 callout：
1. **業配 / 訂閱推銷**：浦惠選股 APP 實戰績效、APP 推薦、勸誘加入 3999 會員、訂閱方案說明、【郁金香】【浦惠】等專欄訂閱導購段落
2. **著作權警示**：「浦惠投顧所有會員付費文章與圖片都已採用電子編碼追蹤外流」、智慧財產權法第 91 條三年以下有期徒刑罰則那段
3. **投資聲明**：王倚隆 / 為投顧會員服務分析文章 / 僅提供支撐壓力價位 / 並非帶進帶出服務 / 投資應獨立判斷自負風險 那段
報告焦點是當日的盤勢分析、個股操作、選股邏輯、風險提醒，業配與制式聲明一律剔除。

【完整性要求 — 絕對不可違反】
- 原文「實際盤勢分析」每段都必須涵蓋（指數、個股、選股邏輯、風險提醒），重點不可漏
- 數據必須精確，直接來自原文（億美元、百分比、倍數等全部保留）
- 老王實戰示範、選股教學是內容；APP 推薦頁則屬上方排除清單，不寫
- 在輸出最後一個段落前，不得停止生成
- 個股區塊每一檔都要完整輸出（不可省略任何一檔）

【精簡寫作風格 — 重要】
- **輸出字數：1500-2000 字（繁體中文字）**，主力個股表格擴充可超過，不要為了湊字數重複敘述
- 每段最多 2-3 句話；資訊一旦超過 3 句，改用 bullet 條列（- 開頭）
- 同主題的多段原文要合併濃縮成 1 段，重複的話只說一次
- 偏好「短句 + 數據粗體 + 條列」的節奏，避免長段堆疊文字
- 章節敘述開頭可寫 1 句總結句，接著用 bullet 列關鍵點

【多事件描述 — 強制條列拆分】
段落內涉及多檔個股、多個事件、多筆量價數據時，**禁止串成一句長句**，必須拆成獨立 bullet：
- ❌ 錯誤示範：「仁寶 5/29 爆 60 萬張大量、英業達同日爆 19 萬張長黑後守住低點，均再續漲。昨日廣達、緯創、英業達同步爆波段最大量，今日續推高。」
- ✅ 正確示範：
  - 仁寶 5/29 爆 **60 萬張**大量
  - 英業達同日爆 **19 萬張**長黑後守住低點，均再續漲
  - 昨日廣達、緯創、英業達同步爆波段最大量，今日續推高
規則：「、」分隔的兩個以上個股訊號 → 拆成多個 bullet；逗號連接的兩個事件 → 拆成多個 bullet

直接輸出完整 Markdown 報告，不要輸出任何說明文字，不要在報告完成前停止。`;

  const userPrompt = `文章標題：${articleTitle}
日期：${dateDisplay}

文章內容：
${rawContent.content.substring(0, 8000)}

🔗 原文網址：${rawContent.url || ''}

請依照上述規則，輸出完整的 Obsidian Markdown 報告。`;

  return { systemPrompt, userPrompt };
}

// ── Gemini 主力（3 key 輪換，flash → flash-lite）─────────────
async function summarizeWithGemini(articleTitle, rawContent) {
  const prompt = buildObsidianPrompt(articleTitle, rawContent, DATE_DISPLAY);
  const { default: fetch } = await import('node-fetch');

  const apiKeys = [GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3].filter(Boolean);
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
  let lastError;

  for (const apiKey of apiKeys) {
    const keyHint = apiKey.slice(-8);
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.3 }
        })
      });
      const data = await r.json();
      if (data.error) {
        const is400 = data.error.code === 400 || data.error.status === 'INVALID_ARGUMENT';
        log(`Gemini ${model} (...${keyHint}) 失敗: ${data.error.message?.substring(0, 120)}`);
        lastError = new Error(`Gemini ${model}: ${data.error.message}`);
        if (is400) break; // key itself invalid, skip to next key
        continue; // quota/other error, try next model
      }
      log(`Gemini ${model} (...${keyHint}) 摘要成功`);
      return data.candidates[0].content.parts[0].text;
    }
  }
  throw lastError || new Error('所有 Gemini API key 均失敗');
}

// ── Groq 摘要（Claude CLI 失敗時的中間層，免費額度充足）──────
async function summarizeWithGroq(articleTitle, rawContent) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY 未設定');
  const { systemPrompt, userPrompt } = buildObsidianPromptSplit(articleTitle, rawContent, DATE_DISPLAY);
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 4096,
    temperature: 0.3
  };
  const r = await httpsPostJson('api.groq.com', '/openai/v1/chat/completions', body, {
    Authorization: `Bearer ${GROQ_API_KEY}`
  });
  if (r.error) throw new Error(`Groq: ${r.error.message || JSON.stringify(r.error)}`);
  if (!r.choices?.[0]?.message?.content) throw new Error(`Groq 無輸出: ${JSON.stringify(r).substring(0, 200)}`);
  const out = r.choices[0].message.content.trim();
  if (out.length < 500) throw new Error(`Groq 輸出過短 (${out.length} chars)`);
  log(`Groq (llama-3.3-70b) 摘要完成 (${out.length} 字元)`);
  return out;
}

// ── Claude CLI 摘要（本機 fallback，吃 Claude Pro/Max 訂閱）─
// 雲端 GitHub Actions 沒有 claude CLI，呼叫端需自行判斷 IS_CI
async function summarizeWithClaudeCli(articleTitle, rawContent) {
  const fullPrompt = buildObsidianPrompt(articleTitle, rawContent, DATE_DISPLAY);

  // Windows arg 傳長中文 prompt 不可靠（CreateProcess 32k 限制 + UTF-16），
  // 改用 stdin pipe 把 prompt 餵進去（claude -p 支援 stdin）
  // 必須指向 claude.exe，不可用 'claude'（會被 resolve 到 claude.cmd，stdin 不透傳）
  const CLAUDE_BIN = process.env.CLAUDE_BIN ||
    'C:\\Users\\bigsh\\.local\\bin\\claude.exe';
  const result = spawnSync(CLAUDE_BIN, ['-p'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  });

  const combined = (result.stdout || '') + (result.stderr || '');
  if (/usage limit|rate limit|limit reached|exceeded.*limit/i.test(combined)) {
    throw new Error('Claude CLI 用量上限');
  }
  if (result.error || result.status !== 0) {
    throw new Error(`Claude CLI 失敗: ${result.error?.message || `exit ${result.status}`} ${combined.substring(0, 200)}`);
  }
  const out = (result.stdout || '').trim();
  if (out.length < 500) {
    throw new Error(`Claude CLI 輸出過短 (${out.length} chars): ${out.substring(0, 200)}`);
  }
  return out;
}

// ── Playwright 文章列表頁抓取（不需 OAuth）─────────────────
async function fetchArticleUrlByDate(dateDisplay) {
  const { chromium } = require('playwright-core');
  const WIN_CHROMIUM_FALLBACK = 'C:\\Users\\bigsh\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe';
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    (!IS_CI && process.platform === 'win32' ? WIN_CHROMIUM_FALLBACK : null);
  const LIST_URL = 'https://www.pressplay.cc/project/CF6DA5CB5BE8C843FE37526843D3E126/articles';

  const browser = await chromium.launch({
    ...(execPath ? { executablePath: execPath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext();
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Scroll down multiple times to trigger lazy-loading of older articles
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    // 收集所有當日候選 URL（同日可能有多篇：每日盤勢 + 週報 + 3999 專屬等）
    const candidates = await page.evaluate((date) => {
      const projectPattern = /pressplay\.cc\/project\/[A-Z0-9]+\/articles\/[A-Z0-9]+/i;
      const anchors = Array.from(document.querySelectorAll('a'));
      const seen = new Set();
      const result = [];
      for (const a of anchors) {
        if (projectPattern.test(a.href) && a.textContent.trim().includes(date) && !seen.has(a.href)) {
          seen.add(a.href);
          result.push({ url: a.href, text: a.textContent.trim().substring(0, 80) });
        }
      }
      // 若當日無命中，把最新一篇當 fallback
      if (result.length === 0) {
        for (const a of anchors) {
          if (projectPattern.test(a.href) && !seen.has(a.href)) {
            seen.add(a.href);
            result.push({ url: a.href, text: a.textContent.trim().substring(0, 80) });
            break;
          }
        }
      }
      return result;
    }, dateDisplay);

    return candidates;
  } finally {
    await browser.close();
  }
}

// 檢查 URL 對應文章是否為當前 cookies 可讀（避免抓到無權限的會員專屬文）
async function checkArticleReadable(articleUrl) {
  const articleId = articleUrl.match(/articles\/([A-Z0-9]+)/i)?.[1];
  if (!articleId) return { readable: false, title: '' };
  const cookies = fs.existsSync(COOKIES_PATH)
    ? JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')) : [];
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  const PP_HEADERS = {
    'Cookie': cookieStr,
    'pp-os': 'Web', 'pp-os-ver': '1.0', 'pp-app-ver': '1.0',
    'pp-locale': 'zh-TW', 'pp-region': 'TW',
    'pp-timezone': 'Asia/Taipei', 'pp-timezone-offset': '-480',
    'pp-device-id': 'howdoyouturnthison',
    'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json',
    'referer': 'https://www.pressplay.cc/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'og-web.pressplay.cc', path: `/timeline/${articleId}/info`,
          method: 'GET', headers: PP_HEADERS },
        res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }
      );
      req.on('error', reject); req.end();
    });
    return {
      readable: !!data?.data?.canReadTimeline,
      title: data?.data?.timeline_info?.timeline_title || '',
    };
  } catch (_) {
    return { readable: false, title: '' };
  }
}

// ── puhui_cache.json（供 premarket GitHub Actions 讀取）────
function extractPuhuiCache(markdown) {
  const waterMatch = markdown.match(/([一二三四五六七八九十]+成)持股水位/);
  const waterLevel = waterMatch ? waterMatch[1] : '未知';
  const stocks = [];

  // Format 1: ### <span> headings (Obsidian callout style)
  const stockRe = /###\s*<span[^>]*>(🟢|🟠|🔴)\s+([^<（(]+)/gu;
  let m;
  while ((m = stockRe.exec(markdown)) !== null) {
    const name = m[2].trim();
    if (name) stocks.push({ name, emoji: m[1].trim() });
  }

  // Format 2: Markdown table under 個股 section (standard Gemini output)
  if (stocks.length === 0) {
    const lines = markdown.split('\n');
    let inStockSection = false;
    for (const l of lines) {
      if (l.startsWith('## ') && l.includes('個股')) { inStockSection = true; continue; }
      if (l.startsWith('## ') && inStockSection) break;
      if (!inStockSection || !l.startsWith('|')) continue;
      const cells = l.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length < 2 || /^[-:]+$/.test(cells[0]) || cells[0] === '代號') continue;
      const [code, name, advice = ''] = cells;
      const em = (advice.includes('出清') || advice.includes('賣出')) ? '🔴' :
                 (advice.includes('續抱') || advice.includes('持有') || advice.includes('持股')) ? '🟢' : '🟠';
      const displayName = name ? `${code} ${name}` : code;
      if (displayName) stocks.push({ name: displayName, emoji: em });
    }
  }

  // Phase 12: Extract market_sentiment (樂觀/中立/悲觀 + 1-10 score)
  const sentimentMap = {
    '樂觀': 8, '看多': 8, '偏多': 7, '積極': 7,
    '中立': 5, '平盤': 5, '觀望': 5,
    '悲觀': 2, '看空': 2, '警惕': 3, '謹慎': 4, '保守': 4
  };
  let marketSentiment = { label: '中立', score: 5 };
  for (const [label, score] of Object.entries(sentimentMap)) {
    if (markdown.includes(label)) {
      marketSentiment = { label, score };
      break;
    }
  }

  // Phase 12: Extract sector_rotation (板塊輪動觀點)
  const knownSectors = ['科技', '電子', '傳產', '金融', '航運', '鋼鐵', '能源', '化工', '醫療', '消費', '建構'];
  const sectorRotation = [];
  for (const sector of knownSectors) {
    if (markdown.includes(sector) && !sectorRotation.includes(sector)) {
      sectorRotation.push(sector);
    }
  }

  // Phase 12: Extract confidence_level (1-10 報告信心度)
  let confidenceLevel = 7; // default
  // Boost confidence if many stocks mentioned (high detail)
  if (stocks.length >= 8) confidenceLevel = 8;
  if (stocks.length >= 12) confidenceLevel = 9;
  // Reduce if few stocks or vague language
  if (stocks.length < 3) confidenceLevel = 5;
  // Check for explicit confidence mention
  const confMatch = markdown.match(/信心度[：:]*([0-9]|十)/);
  if (confMatch) {
    confidenceLevel = confMatch[1] === '十' ? 10 : parseInt(confMatch[1]) || confidenceLevel;
  }

  const cache = {
    date: TARGET_DATE,
    water_level: waterLevel,
    stocks,
    market_sentiment: marketSentiment,
    sector_rotation: sectorRotation,
    confidence_level: confidenceLevel
  };
  try {
    fs.mkdirSync(path.dirname(PUHUI_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PUHUI_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
    log(`puhui_cache.json 已寫入: 水位=${waterLevel}, 個股=${stocks.length} 檔, 情緒=${marketSentiment.label}(${marketSentiment.score}), 信心=${confidenceLevel}`);
  } catch (e) {
    log(`puhui_cache.json 寫入失敗: ${e.message}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  log(`===== puhui_daily 啟動 target=${TARGET_DATE} =====`);

  // 0. 檢查 PressPlay cookies 過期狀態
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      const jwt = Array.isArray(cookies)
        ? cookies.find(c => c.name === 'JAccessToken')?.value
        : cookies['JAccessToken'];
      if (jwt) {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
        const expMs = payload.exp * 1000;
        const daysLeft = Math.ceil((expMs - Date.now()) / 86400000);
        if (daysLeft <= 0) {
          log('⛔ JAccessToken 已過期！請立刻更新 PressPlay cookies');
          await sendTelegram('⛔ 浦惠投顧 PressPlay cookies 已過期！請立刻更新並重新存入 data/pressplay_cookies.json');
        } else if (daysLeft <= 5) {
          log(`⚠️ JAccessToken 將在 ${daysLeft} 天後過期（${new Date(expMs).toISOString().slice(0,10)}），請盡快更新 cookies`);
          await sendTelegram(`⚠️ 浦惠投顧 PressPlay cookies 將在 ${daysLeft} 天後過期（${new Date(expMs).toISOString().slice(0,10)}），請盡快更新`);
        }
      }
    }
  } catch (_) {}

  // 1. 檢查今日輸出是否已存在（CI 環境略過，--force 時強制重新生成）
  //    本機看 Obsidian 筆記、VM 看 repo 報告（EXISTING_OUTPUT_PATH）
  if (!IS_CI && !FORCE_REGENERATE && fs.existsSync(EXISTING_OUTPUT_PATH)) {
    log(`輸出已存在: ${EXISTING_OUTPUT_PATH} → 跳過`);
    return;
  }

  // 2. 測試 OAuth（失敗不中止，改走 Playwright fallback）
  let token;
  let gmailAvailable = false;
  try {
    token = await getAccessToken();
    _gmailToken = token;
    gmailAvailable = true;
    log('OAuth 正常');
  } catch (e) {
    // 2026-06-26：OAuth/Gmail 已非必要——報告一律走 Playwright fallback 正常產出並寫進 Obsidian，
    // 使用者只需維持 Obsidian、不要 OAuth 噪音，故 OAuth 失敗不再發 Telegram 告警（保留 log 供排查）。
    log(`OAuth 失敗（已忽略，改走 Playwright fallback；不發 Telegram）: ${e.message}`);
  }

  // 3 & 4. 取文章（Gmail 優先，Playwright 列表頁 fallback）
  const gmailDate = `${Y}/${M}/${D}`;
  const nextDate = new Date(TARGET_DATE);
  nextDate.setDate(nextDate.getDate() + 1);
  const nextStr = nextDate.toISOString().slice(0, 10).replace(/-/g, '/');

  let articleContent = null;
  let articleTitle = '';
  let articleUrl = '';

  if (gmailAvailable) {
    log(`搜尋每日摘要郵件 after:${gmailDate} before:${nextStr}`);
    const summaryList = await searchGmail(token, `浦惠 每日摘要 after:${gmailDate} before:${nextStr}`, 5);
    const summaryList2 = await searchGmail(token, `subject:[浦惠投顧] ${DATE_DISPLAY} after:${gmailDate} before:${nextStr}`, 5);
    const msgs = [...(summaryList.messages || []), ...(summaryList2.messages || [])];

    if (msgs.length > 0) {
      log(`找到 ${msgs.length} 封摘要郵件，使用第一封`);
      const email = await getEmail(token, msgs[0].id);
      const subjHeader = email.payload.headers.find(h => h.name === 'Subject');
      const emailBody = extractTextFromPayload(email.payload);
      // 若 email 內容太短（< 800 字），多半是通知信而非實際摘要，改走 Playwright 抓原文
      if (emailBody.length < 800) {
        log(`Gmail 摘要內容過短（${emailBody.length} 字），疑為通知信 → 改走 Playwright 抓原文`);
        // 嘗試從通知信內容抽出 PressPlay 文章 URL
        const links = extractPressPlayLinks(email.payload);
        if (links[0]) {
          articleUrl = links[0];
          log(`從通知信抽出文章 URL: ${articleUrl}`);
        }
        articleTitle = subjHeader?.value || DATE_DISPLAY;
      } else {
        articleTitle = subjHeader?.value || DATE_DISPLAY;
        articleContent = { content: emailBody, url: '' };
      }
    }

    if (!articleContent) {
      log('未找到摘要郵件，搜尋通知信...');
      const notifList = await searchGmail(token, `浦惠投顧方案最新動態通知 after:${gmailDate} before:${nextStr}`, 3);

      if (notifList.messages?.length > 0) {
        const email = await getEmail(token, notifList.messages[0].id);
        const links = extractPressPlayLinks(email.payload);
        articleUrl = links[0] || '';
        log(`取得文章 URL: ${articleUrl}`);
        const notifText = extractTextFromPayload(email.payload);
        const titleMatch = notifText.match(new RegExp(`${DATE_DISPLAY}[^若]+`));
        articleTitle = titleMatch ? titleMatch[0].trim() : DATE_DISPLAY;
      }
    }
  }

  // Playwright 文章列表頁 fallback（OAuth 失敗或 Gmail 無結果時）
  if (!articleContent && !articleUrl) {
    if (ARTICLE_URL_OVERRIDE) {
      articleUrl = ARTICLE_URL_OVERRIDE;
      log(`使用 URL override: ${articleUrl}`);
    } else {
      log(`Gmail 無結果或不可用，改用 Playwright 抓取文章列表（${DATE_DISPLAY}）`);
      try {
        const candidates = await withRetry(
          () => fetchArticleUrlByDate(DATE_DISPLAY),
          'Playwright 文章列表抓取'
        );
        if (!candidates || candidates.length === 0) {
          log(`文章列表中找不到 ${DATE_DISPLAY} 的文章，可能未發文（週末/假日/請假）`);
          await notify(`${DATE_DISPLAY} 今日無發文`, `ℹ️ 浦惠投顧 ${DATE_DISPLAY}\n\n今日無發文（週末/假日/老王請假）`);
          return;
        }
        log(`找到 ${candidates.length} 篇候選文章，逐一檢查閱讀權限...`);
        // 從候選裡挑可讀的（跳過 3999 會員專屬等無權限文章）
        for (const c of candidates) {
          const { readable, title } = await checkArticleReadable(c.url);
          log(`  候選: ${title.substring(0, 50)} | canRead=${readable}`);
          if (readable) {
            articleUrl = c.url;
            break;
          }
        }
        if (!articleUrl) {
          log(`所有候選文章都無權限閱讀（可能是 3999 會員專屬週報等）`);
          await notify(`${DATE_DISPLAY} 今日無一般每日盤勢文`,
            `ℹ️ 浦惠投顧 ${DATE_DISPLAY}\n\n當日有 ${candidates.length} 篇文章但都不在你的閱讀權限內：\n${candidates.map(c => '- ' + c.text).join('\n')}`);
          return;
        }
        log(`選定可讀 URL: ${articleUrl}`);
      } catch (e) {
        log(`Playwright 文章列表抓取失敗: ${e.message}`);
        await notify(`${DATE_DISPLAY} 文章列表抓取失敗`, `⚠️ 浦惠投顧 ${DATE_DISPLAY}\n\n${e.message}`);
        process.exit(1);
      }
    }
  }

  // Playwright 抓取文章內容
  if (!articleContent && articleUrl) {
    log('Playwright 無頭抓取文章...');
    try {
      const fetched = await withRetry(
        () => fetchPressPlayArticle(articleUrl),
        'Playwright 文章內容抓取'
      );
      articleTitle = fetched.title || articleTitle || DATE_DISPLAY;
      const isPaywall = fetched.content.length < 500;
      log(`抓取結果: ${fetched.content.length} 字${isPaywall ? ' ⚠️ 疑似 paywall teaser' : ' ✅ 正常'}`);

      if (isPaywall) {
        // 若已有完整輸出（長度 > 1000），保留現有檔案，不覆蓋（本機看筆記、VM 看報告）
        if (!IS_CI && fs.existsSync(EXISTING_OUTPUT_PATH)) {
          const existingLen = fs.readFileSync(EXISTING_OUTPUT_PATH, 'utf-8').length;
          if (existingLen > 1000) {
            log(`paywall 偵測，現有筆記完整（${existingLen} 字） → 保留，略過覆蓋`);
            return;
          }
        }
        await notify(`${DATE_DISPLAY} Cookies 疑似失效`, `⚠️ 浦惠投顧 ${DATE_DISPLAY}\n\n文章抓取失敗（疑似 paywall），PressPlay cookies 可能已失效\n\n請更新 cookies 後以 --force 重跑\nURL: ${articleUrl}`);
        process.exit(1);
      }

      articleContent = { content: fetched.content, url: articleUrl };

      // 成功抓取後備份 cookies（防止檔案被意外清空）
      try {
        if (fs.existsSync(COOKIES_PATH)) {
          const cookieData = fs.readFileSync(COOKIES_PATH);
          const b64 = cookieData.toString('base64');
          const B64_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies_b64.txt');
          fs.writeFileSync(B64_PATH, b64);
        }
      } catch (_) {}
    } catch (e) {
      log(`Playwright 抓取失敗: ${e.message}`);
      await notify(`${DATE_DISPLAY} 文章抓取失敗`, `⚠️ 浦惠投顧 ${DATE_DISPLAY} 文章抓取失敗\n\n${e.message}\n\n請手動補建筆記：${articleUrl}`);
      process.exit(1);
    }
  }

  // 5 & 6. AI 摘要
  //   本機/VM：Claude CLI 主 → Groq 中間層 → Gemini fallback（3 key 輪換）
  //   雲端 CI：Groq → Gemini（沒有 Claude CLI）
  let markdown;
  const errors = [];

  if (!IS_CI) {
    log('呼叫 Claude CLI 進行摘要（本機優先）...');
    try {
      markdown = await summarizeWithClaudeCli(articleTitle, articleContent);
      log(`Claude CLI 摘要完成 (${markdown.length} 字元)`);
    } catch (e) {
      log(`Claude CLI 失敗，改用 Groq: ${e.message}`);
      errors.push(`Claude CLI: ${e.message}`);
    }
  }

  if (!markdown) {
    log('呼叫 Groq 進行摘要...');
    try {
      markdown = await summarizeWithGroq(articleTitle, articleContent);
    } catch (e) {
      log(`Groq 失敗，改用 Gemini: ${e.message}`);
      errors.push(`Groq: ${e.message}`);
    }
  }

  if (!markdown) {
    log('呼叫 Gemini 進行摘要...');
    try {
      markdown = await summarizeWithGemini(articleTitle, articleContent);
      log('Gemini 摘要完成');
    } catch (e) {
      log(`Gemini 全部 key 失敗: ${e.message}`);
      errors.push(`Gemini: ${e.message}`);
      await notify(`${DATE_DISPLAY} AI 摘要失敗`, `⚠️ 浦惠投顧 ${DATE_DISPLAY} AI 摘要失敗\n\n${errors.join('\n\n')}`);
      process.exit(1);
    }
  }
  // 清除 UTF-8 替換字元（API 截斷導致的亂碼）
  markdown = markdown.replace(/�/g, '');

  // 若 AI 沒有加原文連結，補上
  if (articleUrl && !markdown.includes(articleUrl)) {
    markdown += `\n\n---\n🔗 [閱讀原文](${articleUrl})`;
  }

  // 寫入 puhui_cache.json（供 premarket workflow 隔日讀取）
  extractPuhuiCache(markdown);

  // 7. 寫入報告
  if (WRITE_OBSIDIAN) {
    // 本機：寫入 Obsidian vault（PC 讀取）；VM/CI 不寫（無 vault）
    fs.mkdirSync(NOTE_DIR, { recursive: true });
    fs.writeFileSync(NOTE_PATH, markdown, 'utf-8');
    log(`筆記寫入完成: ${NOTE_PATH} (${WEEK_FOLDER})`);
  }

  // 本機 & VM & CI：都寫入 repo reports/（手機透過 GitHub pull 讀取；REPORT_DIR/PATH 已於頂部宣告）
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, markdown, 'utf-8');
  log(`報告寫入 repo: reports/${MONTH_FOLDER}/${WEEK_FOLDER}/${TARGET_DATE}.md`);

  // 本機 & VM：自動 git push，讓手機可 pull 到最新報告（CI 由 workflow 的 commit/push step 處理）
  // push 被 reject (non-fast-forward) 時自動 pull --rebase 重試一次，避免 VM/本機雙寫分岔。
  if (!IS_CI) {
    const repoDir = path.join(__dirname, '..');
    try {
      execSync(
        `git -C "${repoDir}" add "reports/" && (git -C "${repoDir}" diff --cached --quiet || git -C "${repoDir}" commit -m "report: ${TARGET_DATE} (local)")`,
        { stdio: 'pipe' }
      );
      try {
        execSync(`git -C "${repoDir}" push`, { stdio: 'pipe' });
        log('報告已推送到 GitHub（手機可同步）');
      } catch (pushErr) {
        log(`GitHub push 第一次失敗，rebase 後重試: ${String(pushErr.message).slice(0, 120)}`);
        // rebase 目標用「目前分支」，不硬寫 master（VM 在 phase3-chips 時硬寫 master 會造成分叉）。
        const branch = execSync(`git -C "${repoDir}" rev-parse --abbrev-ref HEAD`).toString().trim();
        execSync(`git -C "${repoDir}" pull --rebase origin ${branch}`, { stdio: 'pipe' });
        execSync(`git -C "${repoDir}" push`, { stdio: 'pipe' });
        log('報告已推送到 GitHub（rebase 後重試成功）');
      }
    } catch (e) {
      log(`GitHub push 失敗（非致命）: ${String(e.message).slice(0, 150)}`);
    }
  }

  // 7.5 Gmail 已停發完整報告（2026-05-28）：報告改在 Obsidian / GitHub 查看
  //     原因：markdownToHTML 不認 Obsidian callout 多行語法，callout 內 table 會碎片化

  // 8. Telegram 每日摘要已停發（2026-05-28）：報告改在 Obsidian / GitHub 查看
  //     保留：cookies 過期、OAuth 失效、崩潰通知（安全網警告）
  log('===== puhui_daily 完成 =====');
}

// 直接執行才跑 main()；被 require（回歸測試讀 RUN_TARGET 等旗標）時不自動執行。
if (require.main === module) {
  main().catch(async e => {
    log(`未捕捉錯誤: ${e.message}\n${e.stack}`);
    await notify('puhui_daily 崩潰', `🚨 puhui_daily 崩潰\n\n${e.message}`);
    process.exit(1);
  });
}

// 供回歸測試讀取環境解耦旗標（不影響直接執行）
module.exports = { RUN_TARGET, IS_CI, WRITE_OBSIDIAN, TARGET_DATE, NOTE_PATH, REPORT_PATH, EXISTING_OUTPUT_PATH };
