/**
 * puhui_daily.js — 浦惠投顧每日摘要自動化
 *
 * 流程：
 *   1. 檢查今日 Obsidian 筆記是否已存在 → 存在即退出
 *   2. 測試 Google OAuth 健康狀態 → 失敗則 Telegram 告警
 *   3. 搜尋 Gmail 取得今日每日摘要郵件
 *   4. 若無郵件 → 從通知信取 PressPlay URL → Playwright 無頭抓取
 *   5. 用 Groq (llama-3.3-70b) 摘要文章，Gemini 作為 fallback
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

// ── 設定 ────────────────────────────────────────────────
const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const ARTICLE_URL_OVERRIDE = process.argv[3] || null;
const IS_CI = process.env.CI === 'true';
const [Y, M, D] = TARGET_DATE.split('-');
const DATE_DISPLAY = `${Y}/${M}/${D}`;

const OBSIDIAN_DIR = 'C:\\obsidian\\儲存庫\\浦惠投顧報告整理';
const NOTE_PATH = path.join(OBSIDIAN_DIR, `${TARGET_DATE}.md`);
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'puhui_daily.log');
const PUHUI_CACHE_PATH = path.join(__dirname, '..', 'data', 'puhui_cache.json');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
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

  // Lists
  html = html.replace(/^- (.+?)$/gm, '<li style="margin:6px 0">$1</li>');
  const listRegex = /(<li[^<]*>[^<]*<\/li>[\s\n]*)+/gm;
  html = html.replace(listRegex, (match) => `<ul style="margin:8px 0 8px 20px;padding:0">\n${match}</ul>\n`);

  // Line breaks and paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

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

// ── Playwright 無頭抓取 ────────────────────────────────────
async function fetchPressPlayArticle(url) {
  const { chromium } = require('playwright-core');
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    (IS_CI ? null : 'C:\\Users\\bigsh\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe');

  const browser = await chromium.launch({
    ...(execPath ? { executablePath: execPath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext();

    // 載入已儲存的 cookies
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      await context.addCookies(cookies);
      log(`已載入 ${cookies.length} 個 PressPlay cookies`);
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for React-rendered article body to be populated (PressPlay SPA fetches
    // content via API after initial render — container exists but is empty at first)
    // Threshold 500 chars: teaser is ~87 chars (paywall), real article is typically 2000+
    await page.waitForFunction(() => {
      const el = document.querySelector('.article-content') ||
                 document.querySelector('.article-main-content') ||
                 document.querySelector('.content.article-tab-content');
      return el && el.innerText.trim().length > 500;
    }, { timeout: 30000 }).catch(() => {});

    // 擷取文章正文（優先用 .article-content，fallback 用 .article-main-content）
    const content = await page.evaluate(() => {
      const el = document.querySelector('.article-content') ||
                 document.querySelector('.article-main-content') ||
                 document.querySelector('.content.article-tab-content');
      if (!el) return '';
      return el.innerText.trim();
    });

    const title = await page.title();
    // Log first 200 chars to diagnose paywall/teaser vs real content in CI
    const preview = content.substring(0, 200).replace(/\n/g, ' ');
    log(`抓取完成，內容長度: ${content.length}，前200字: ${preview}`);
    return { title: title.replace(' - PressPlay', '').replace(' - PressPlay Academy', '').trim(), content };
  } finally {
    await browser.close();
  }
}

// ── Groq 摘要 ─────────────────────────────────────────────
async function summarizeWithGroq(articleTitle, rawContent) {
  const prompt = `你是台股投資分析助手。請將以下浦惠投顧老王的每日分析文章，整理成繁體中文的 Obsidian Markdown 筆記。報告必須與5月8日報告的結構和詳細程度一致。

【強制要求的報告結構】

# 📊 浦惠投顧每日摘要 — ${DATE_DISPLAY}
> ${articleTitle}

## 整體操作水位
- 清楚標記持股水位（如：七成持股水位）
- 說明持股邏輯和理由

## 大盤與美股觀察
- 包含大盤技術面分析
- 美股相關訊息
- 可以包含表格列出重點數據

## 原油
- 如果文章提到原油，必須獨立成章，包含：
  - 價格走勢
  - 對台股的影響
  - 警示信息（用 > 警示框）

## 重大政策事件 / 政策分析
- 如果文章提到政策、法規、或重要消息，必須獨立成章
- 清楚說明對台股的影響

## 台股評估
- 必須包含投資框架分析（如：Buffett Indicator、季節性、基本面等）
- 深入分析目前的市場條件
- 評估買進風險與機會

## 操作策略
- 【A場景】: 如果市場條件如何...那麼操作建議是...
- 【B場景】: 如果市場條件如何...那麼操作建議是...
- 【C場景】: 如果市場條件如何...那麼操作建議是...
- 清楚的進場點、停損點、獲利點

## 📌 今日提到個股
以 Markdown 表格形式，每隻股票必須包含：
| 代號 | 名稱 | 關鍵訊號 | 操作建議 |

對每隻股票的分析必須包括：
- 關鍵訊號：為什麼老王看好或看空這隻股票（技術面、基本面、消息面理由）
- 操作建議：具體的進場點、停損點、目標價或操作建議

## 老王重要提醒
- 交易風險提示
- 重要注意事項
- 本週或本月的重點提醒

🔗 [閱讀原文](${rawContent.url || ''})

【內容質量要求】
- 分析必須深入、有邏輯、有框架
- 個股分析不能是空泛的建議，要說明理由和訊號
- 表格要完整，每個欄位都要有實質內容
- 不要簡化、跳過任何章節
- 所有章節的分析深度要保持一致（都要有足夠的細節）

文章標題：${articleTitle}

文章內容：
${rawContent.content.substring(0, 8000)}

【摘要粒度 — 最重要】
- 對文章的每個主要段落，用 2-3 句話來總結（不要壓縮成 1-2 句或過度簡化）
- 保留原文的邏輯和細節，使用清晰的標題、要點符號、表格、引用框來美化內容
- 優先保留內容的完整性和可讀性，而不是過度濃縮
- 每個章節都應該讓讀者能理解老王的完整觀點，而不是只看到骨架

請直接輸出完整的 Markdown 內容，不要任何前言或解釋。確保報告包含所有強制要求的章節。`;

  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4500,
    temperature: 0.3
  };

  const r = await httpsPostJson('api.groq.com', '/openai/v1/chat/completions', body, {
    Authorization: `Bearer ${GROQ_API_KEY}`
  });

  if (r.error) throw new Error(`Groq: ${r.error.message}`);
  return r.choices[0].message.content;
}

// ── Gemini fallback ───────────────────────────────────────
async function summarizeWithGemini(articleTitle, rawContent) {
  const prompt = `你是台股投資分析助手。請將以下浦惠投顧老王的每日分析文章，整理成繁體中文的 Obsidian Markdown 筆記。報告必須與5月8日報告的結構和詳細程度一致。

【強制要求的報告結構】

# 📊 浦惠投顧每日摘要 — ${DATE_DISPLAY}
> ${articleTitle}

## 整體操作水位
- 清楚標記持股水位（如：七成持股水位）
- 說明持股邏輯和理由

## 大盤與美股觀察
- 包含大盤技術面分析
- 美股相關訊息
- 可以包含表格列出重點數據

## 原油
- 如果文章提到原油，必須獨立成章，包含：
  - 價格走勢
  - 對台股的影響
  - 警示信息（用 > 警示框）

## 重大政策事件 / 政策分析
- 如果文章提到政策、法規、或重要消息，必須獨立成章
- 清楚說明對台股的影響

## 台股評估
- 必須包含投資框架分析（如：Buffett Indicator、季節性、基本面等）
- 深入分析目前的市場條件
- 評估買進風險與機會

## 操作策略
- 【A場景】: 如果市場條件如何...那麼操作建議是...
- 【B場景】: 如果市場條件如何...那麼操作建議是...
- 【C場景】: 如果市場條件如何...那麼操作建議是...
- 清楚的進場點、停損點、獲利點

## 📌 今日提到個股
以 Markdown 表格形式，每隻股票必須包含：
| 代號 | 名稱 | 關鍵訊號 | 操作建議 |

對每隻股票的分析必須包括：
- 關鍵訊號：為什麼老王看好或看空這隻股票（技術面、基本面、消息面理由）
- 操作建議：具體的進場點、停損點、目標價或操作建議

## 老王重要提醒
- 交易風險提示
- 重要注意事項
- 本週或本月的重點提醒

🔗 [閱讀原文](${rawContent.url || ''})

【內容質量要求】
- 分析必須深入、有邏輯、有框架
- 個股分析不能是空泛的建議，要說明理由和訊號
- 表格要完整，每個欄位都要有實質內容
- 不要簡化、跳過任何章節
- 所有章節的分析深度要保持一致（都要有足夠的細節）

【摘要粒度 — 最重要】
- 對文章的每個主要段落，用 2-3 句話來總結（不要壓縮成 1-2 句或過度簡化）
- 保留原文的邏輯和細節，使用清晰的標題、要點符號、表格、引用框來美化內容
- 優先保留內容的完整性和可讀性，而不是過度濃縮
- 每個章節都應該讓讀者能理解老王的完整觀點，而不是只看到骨架

文章標題：${articleTitle}
文章內容：${rawContent.content.substring(0, 8000)}

請直接輸出完整的 Markdown 內容，不要任何前言或解釋。確保報告包含所有強制要求的章節。`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await r.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  return data.candidates[0].content.parts[0].text;
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

    const url = await page.evaluate((date) => {
      // Use computed a.href (absolute URL) instead of href attribute to avoid
      // selector mismatch when the page uses relative or JS-rendered links
      const projectPattern = /pressplay\.cc\/project\/[A-Z0-9]+\/articles\/[A-Z0-9]+/i;
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        if (projectPattern.test(a.href) && a.textContent.trim().includes(date)) {
          return a.href;
        }
      }
      // Fallback: return the first valid article link (most recent)
      for (const a of anchors) {
        if (projectPattern.test(a.href)) return a.href;
      }
      return null;
    }, dateDisplay);

    return url;
  } finally {
    await browser.close();
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

  // Format 2: Markdown table under 個股 section (standard Groq/Gemini output)
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

  // 1. 檢查筆記是否已存在（CI 環境略過，每次都執行）
  if (!IS_CI && fs.existsSync(NOTE_PATH)) {
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
      articleTitle = subjHeader?.value || DATE_DISPLAY;
      articleContent = { content: extractTextFromPayload(email.payload), url: '' };
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
        articleUrl = await fetchArticleUrlByDate(DATE_DISPLAY);
        if (articleUrl) {
          log(`從文章列表找到 URL: ${articleUrl}`);
        } else {
          log(`文章列表中找不到 ${DATE_DISPLAY} 的文章，可能未發文（週末/假日/請假）`);
          await notify(`${DATE_DISPLAY} 今日無發文`, `ℹ️ 浦惠投顧 ${DATE_DISPLAY}\n\n今日無發文（週末/假日/老王請假）`);
          return;
        }
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
      articleContent = { content: fetched.content, url: articleUrl };
      log(`抓取結果: ${fetched.content.length} 字${fetched.content.length < 500 ? ' ⚠️ 疑似 paywall teaser' : ' ✅ 正常'}`);
    } catch (e) {
      log(`Playwright 抓取失敗: ${e.message}`);
      await notify(`${DATE_DISPLAY} 文章抓取失敗`, `⚠️ 浦惠投顧 ${DATE_DISPLAY} 文章抓取失敗\n\n${e.message}\n\n請手動補建筆記：${articleUrl}`);
      process.exit(1);
    }
  }

  // 5 & 6. AI 摘要（Groq → Gemini fallback）
  log('呼叫 Groq 進行摘要...');
  let markdown;
  try {
    markdown = await summarizeWithGroq(articleTitle, articleContent);
    log('Groq 摘要完成');
  } catch (e) {
    log(`Groq 失敗 (${e.message})，切換 Gemini...`);
    try {
      markdown = await summarizeWithGemini(articleTitle, articleContent);
      log('Gemini 摘要完成');
    } catch (e2) {
      log(`Gemini 也失敗: ${e2.message}`);
      await notify(`${DATE_DISPLAY} AI 摘要失敗`, `⚠️ 浦惠投顧 ${DATE_DISPLAY} AI 摘要失敗\n\nGroq: ${e.message}\nGemini: ${e2.message}`);
      process.exit(1);
    }
  }

  // 若 AI 沒有加原文連結，補上
  if (articleUrl && !markdown.includes(articleUrl)) {
    markdown += `\n\n---\n🔗 [閱讀原文](${articleUrl})`;
  }

  // 寫入 puhui_cache.json（供 premarket workflow 隔日讀取）
  extractPuhuiCache(markdown);

  // 7. 寫入 Obsidian（CI 環境略過 Windows 路徑）
  if (!IS_CI) {
    fs.mkdirSync(OBSIDIAN_DIR, { recursive: true });
    fs.writeFileSync(NOTE_PATH, markdown, 'utf-8');
    log(`筆記寫入完成: ${NOTE_PATH}`);
  } else {
    log('CI 模式：跳過 Obsidian 寫入');
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
