/**
 * puhui_daily.js — 浦惠投顧每日摘要自動化
 *
 * 流程：
 *   1. 檢查今日 Obsidian 筆記是否已存在 → 存在即退出
 *   2. 測試 Google OAuth 健康狀態 → 失敗則 Telegram 告警
 *   3. 搜尋 Gmail 取得今日每日摘要郵件
 *   4. 若無郵件 → 從通知信取 PressPlay URL → Playwright 無頭抓取
 *   5. 用 Gemini 摘要文章（3 key 輪換：flash → flash-lite）
 *   6. 格式化為 Obsidian Markdown
 *   7. 寫入 Obsidian
 *   8. Telegram 通知
 *
 * 執行：node scripts/puhui_daily.js [YYYY-MM-DD]（無參數則用今天）
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── 設定 ────────────────────────────────────────────────
const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const FORCE_REGENERATE = process.argv.includes('--force');
const ARTICLE_URL_OVERRIDE = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : null;
const IS_CI = process.env.CI === 'true';
const [Y, M, D] = TARGET_DATE.split('-');
const DATE_DISPLAY = `${Y}/${M}/${D}`;

// 計算月份內的週數（week-of-month）用於資料夾組織
// 規則：(dayOfMonth - 1) / 7 向下取整 + 1
// 例：1-7 日 = W1，8-14 日 = W2，15-21 日 = W3，22-28 日 = W4，29+ = W5
function getMonthWeek(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const weekOfMonth = Math.floor((day - 1) / 7) + 1;
  return { year, month, weekOfMonth };
}

const { year: targetYear, month: targetMonth, weekOfMonth } = getMonthWeek(TARGET_DATE);
const MONTH_FOLDER = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
const WEEK_FOLDER = `W${weekOfMonth}`;

const OBSIDIAN_DIR = 'C:\\obsidian\\儲存庫\\浦惠投顧報告整理';
const NOTE_DIR = path.join(OBSIDIAN_DIR, MONTH_FOLDER, WEEK_FOLDER);
const NOTE_PATH = path.join(NOTE_DIR, `${TARGET_DATE}.md`);
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'puhui_daily.log');
const PUHUI_CACHE_PATH = path.join(__dirname, '..', 'data', 'puhui_cache.json');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2;
const GEMINI_API_KEY_3 = process.env.GEMINI_API_KEY_3;
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
async function sendTelegram(text) {
  try {
    const result = await httpsPostJson('api.telegram.org',
      `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }
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

function buildTelegramSummary(markdown, articleTitle, articleUrl) {
  const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stripHtml = s => s.replace(/<[^>]+>/g, '');
  const stripMd = s => s.replace(/\*\*([^*]+)\*\*/g, '$1');
  const clean = s => escHtml(stripMd(stripHtml(s)).trim());

  const lines = markdown.split('\n');
  const out = [];

  // Header + subtitle
  out.push(`📊 <b>浦惠投顧每日摘要</b> — ${DATE_DISPLAY}`);
  const subtitleLine = lines.find(l => l.startsWith('> ') && !l.includes('[!'));
  if (subtitleLine) out.push(`<i>${clean(subtitleLine.slice(2))}</i>`);
  out.push('');

  // 操作水位
  const waterIdx = lines.findIndex(l => stripHtml(l).includes('操作水位'));
  if (waterIdx >= 0) {
    for (let i = waterIdx; i < Math.min(waterIdx + 8, lines.length); i++) {
      const c = stripHtml(lines[i]);
      const m = c.match(/[一二三四五六七八九十]+成(?:持股水位)?|\d+%(?:持股)?水位/);
      if (m) { out.push(`💼 <b>操作水位：${escHtml(m[0])}</b>`); break; }
    }
  }

  // Danger callouts (重大警示)
  for (const l of lines) {
    if (l.includes('[!danger]')) {
      const content = clean(l.replace(/^>?\s*\[!danger\]\s*/, ''));
      if (content) out.push(`🚨 <b>${content}</b>`);
    }
  }

  // Individual stocks (table format or ### section format)
  const stocks = [];
  let inStockSection = false;
  for (const l of lines) {
    if (l.startsWith('## ')) {
      inStockSection = !!stripHtml(l).match(/個股/);
      continue;
    }

    if (inStockSection && l.trim().startsWith('|')) {
      if (l.match(/^\|\s*[-:]+/) || stripHtml(l).match(/代號|名稱/)) continue;
      const cells = l.split('|').slice(1, -1).map(c => clean(c.trim()));
      if (cells.length >= 2 && cells[0]) {
        const advice = cells[2] || '';
        const em = (advice.includes('出清') || advice.includes('賣出')) ? '🔴' :
                   (advice.includes('續抱') || advice.includes('持有') || advice.includes('持股')) ? '🟢' : '🟠';
        stocks.push(`${em} <b>${cells[0]} ${cells[1]}</b>${advice ? ` — ${advice.substring(0, 35)}` : ''}`);
      }
    }

    if (inStockSection && l.startsWith('### ')) {
      const raw = l.slice(4);
      const header = clean(raw);
      const em = (header.includes('🔴') || raw.includes('color:red')) ? '🔴' :
                 (header.includes('🟠') || raw.includes('#B35A00') || raw.includes('color:orange')) ? '🟠' :
                 (header.includes('🟢') || raw.includes('color:green')) ? '🟢' : '';
      if (em) stocks.push(`${em} <b>${header.replace(/^[🔴🟠🟢]\s*/u, '')}</b>`);
    }

    if (inStockSection && stocks.length > 0 && l.includes('操作建議') &&
        !stocks[stocks.length - 1].includes('↳')) {
      const advice = clean(l.replace(/^-?\s*\*\*操作建議\*\*[^：:]*[：:]\s*/, ''));
      if (advice) {
        const truncated = advice.length > 60 ? advice.substring(0, 60) + '…' : advice;
        stocks[stocks.length - 1] += `\n↳ ${truncated}`;
      }
    }
  }
  if (stocks.length > 0) {
    out.push('');
    out.push('📌 <b>今日個股</b>');
    out.push(...stocks);
  }

  // Original link
  const linkMatch = markdown.match(/\[閱讀原文\]\(([^)]+)\)/);
  const link = articleUrl || (linkMatch ? linkMatch[1] : null);
  if (link) { out.push(''); out.push(`🔗 <a href="${link}">閱讀原文</a>`); }

  const msg = out.join('\n');
  return msg.length > 3800 ? msg.substring(0, 3800) + '\n…' : msg;
}

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
6. ## 📌 今日提到個股（每檔獨立 ### + 表格）
7. ## ⚠️ 老王重要提醒

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

【色碼系統 — 個股與內文】
個股標題色碼（用 <span style="color:..."> 包住 ### 標題）：
- 🔴 可持續抱股 → color:red
- 🟠 觀察個股訊號 → color:#B35A00
- 🟢 風險警示 → color:green

內文重點色碼（用 <span style="color:..."> 包住關鍵文字）：
- color:red → 強勢訊號、利多、漲停、創新高
- color:#B35A00 → 警戒觀察、均線挑戰、尚未確認
- color:green → 安全持有確認

【個股區塊格式】
每檔個股用兩欄表格：
\`\`\`
### <span style="color:red">🔴 股票名稱（代號）</span>

| 項目 | 內容 |
| --- | --- |
| **關鍵訊號** | <span style="color:red">**訊號說明**</span> |
| **操作建議** | <span style="color:red">**操作說明**</span> |
\`\`\`

【表格使用規則】
- 美股指數比較 → Markdown 表格（| 市場 | 今日表現 | 備註 |）
- 財務數據比較（多業務/多季） → 表格
- 個股操作建議 → 每檔用「關鍵訊號 + 操作建議」兩欄表格
- 情境操作策略（A/B/C 場景）→ 表格

【數據格式】
- 所有百分比、點數、億美元、倍數 → **粗體**
- 例：**+92% YoY**、**752 億美元**、**漲停**、**10 倍**

【完整性要求 — 絕對不可違反】
- 原文每個段落的資訊都必須出現在報告中，不能遺漏任何段落
- 數據必須精確，直接來自原文（億美元、百分比、倍數等全部保留）
- 選股 APP 推薦個股、老王實戰示範等教學段落也要完整呈現
- 每篇文章通常有 8–15 段，報告必須完整覆蓋所有段落
- **輸出字數：2000 字以上（繁體中文字）**
- 每個 ## 章節至少 3 句話，不能只寫一句話就跳下一節
- 在輸出最後一個段落前，不得停止生成
- 個股區塊每一檔都要完整輸出（不可省略任何一檔）

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
    timeout: 300000,
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
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    (IS_CI ? null : 'C:\\Users\\bigsh\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe');
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

  // 1. 檢查筆記是否已存在（CI 環境略過，--force 時強制重新生成）
  if (!IS_CI && !FORCE_REGENERATE && fs.existsSync(NOTE_PATH)) {
    log(`筆記已存在: ${NOTE_PATH} → 跳過`);
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
    log(`OAuth 失敗: ${e.message} — 改走 Playwright 文章列表 fallback`);
    // 在 CI 或 deleted_client（永久失效）時不發 Telegram，避免每次觸發垃圾通知
    if (!IS_CI && !e.message.includes('deleted_client')) {
      await sendTelegram(`⚠️ 浦惠投顧 OAuth 異常，改走 Playwright fallback\n\n${e.message}\n\n請執行 node scripts/oauth_reauth.cjs 修復`);
    }
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
        const candidates = await fetchArticleUrlByDate(DATE_DISPLAY);
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
      const fetched = await fetchPressPlayArticle(articleUrl);
      articleTitle = fetched.title || articleTitle || DATE_DISPLAY;
      const isPaywall = fetched.content.length < 500;
      log(`抓取結果: ${fetched.content.length} 字${isPaywall ? ' ⚠️ 疑似 paywall teaser' : ' ✅ 正常'}`);

      if (isPaywall) {
        // 若已有完整筆記（長度 > 1000），保留現有筆記，不覆蓋
        if (!IS_CI && fs.existsSync(NOTE_PATH)) {
          const existingLen = fs.readFileSync(NOTE_PATH, 'utf-8').length;
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
  //   本機：Claude CLI 主（吃訂閱不限額）→ Gemini fallback（3 key 輪換）
  //   雲端 CI：只能用 Gemini（沒有 Claude CLI）
  let markdown;
  const errors = [];

  if (!IS_CI) {
    log('呼叫 Claude CLI 進行摘要（本機優先）...');
    try {
      markdown = await summarizeWithClaudeCli(articleTitle, articleContent);
      log(`Claude CLI 摘要完成 (${markdown.length} 字元)`);
    } catch (e) {
      log(`Claude CLI 失敗，改用 Gemini: ${e.message}`);
      errors.push(`Claude CLI: ${e.message}`);
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
  if (!IS_CI) {
    // 本機：寫入 Obsidian vault（PC 讀取）
    fs.mkdirSync(NOTE_DIR, { recursive: true });
    fs.writeFileSync(NOTE_PATH, markdown, 'utf-8');
    log(`筆記寫入完成: ${NOTE_PATH} (${WEEK_FOLDER})`);
  }

  // 本機 & CI：都寫入 repo reports/（手機透過 GitHub pull 讀取）
  const REPORT_DIR = path.join(__dirname, '..', 'reports', MONTH_FOLDER, WEEK_FOLDER);
  const REPORT_PATH = path.join(REPORT_DIR, `${TARGET_DATE}.md`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, markdown, 'utf-8');
  log(`報告寫入 repo: reports/${MONTH_FOLDER}/${WEEK_FOLDER}/${TARGET_DATE}.md`);

  // 本機：自動 git push，讓手機可 pull 到最新報告
  if (!IS_CI) {
    try {
      const repoDir = path.join(__dirname, '..');
      execSync(
        `git -C "${repoDir}" add "reports/" && git -C "${repoDir}" diff --cached --quiet || git -C "${repoDir}" commit -m "report: ${TARGET_DATE} (local)" && git -C "${repoDir}" push`,
        { stdio: 'pipe' }
      );
      log('報告已推送到 GitHub（手機可同步）');
    } catch (e) {
      log(`GitHub push 失敗（非致命）: ${e.message.slice(0, 150)}`);
    }
  }

  // 7.5 發送完整 HTML 報告到 Gmail（停用 notify 的郵件部分，避免重複）
  if (_gmailToken) {
    try {
      const htmlContent = markdownToHTML(markdown);
      await sendEmail(`浦惠投顧每日摘要 — ${DATE_DISPLAY}`, markdown, htmlContent);
      log('HTML 報告已發送到 Gmail');
    } catch (e) {
      log(`HTML 報告發送失敗: ${e.message}`);
    }
  }

  // 8. Telegram 通知（改用直接發送，避免 notify 函式的重複郵件）
  const tgMessage = buildTelegramSummary(markdown, articleTitle, articleUrl);
  await sendTelegram(tgMessage);
  log('Telegram 通知已發送');
  log('===== puhui_daily 完成 =====');
}

main().catch(async e => {
  log(`未捕捉錯誤: ${e.message}\n${e.stack}`);
  await notify('puhui_daily 崩潰', `🚨 puhui_daily 崩潰\n\n${e.message}`);
  process.exit(1);
});
