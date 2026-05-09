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
      inStockSection = !!stripHtml(l).match(/今日提到個股|📌.*個股/);
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

async function sendEmail(subject, body) {
  if (!_gmailToken) return; // OAuth 尚未成功，跳過
  try {
    const raw = [
      `From: ${NOTIFY_EMAIL}`,
      `To: ${NOTIFY_EMAIL}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });

    // 擷取文章正文（優先用 .article-content，fallback 用 .article-main-content）
    const content = await page.evaluate(() => {
      const el = document.querySelector('.article-content') ||
                 document.querySelector('.article-main-content') ||
                 document.querySelector('.content.article-tab-content');
      if (!el) return '';
      return el.innerText.trim();
    });

    const title = await page.title();
    return { title: title.replace(' - PressPlay', '').replace(' - PressPlay Academy', '').trim(), content };
  } finally {
    await browser.close();
  }
}

// ── Groq 摘要 ─────────────────────────────────────────────
async function summarizeWithGroq(articleTitle, rawContent) {
  const prompt = `你是台股投資分析助手。請將以下浦惠投顧老王的每日分析文章，整理成繁體中文的 Obsidian Markdown 筆記。

格式要求：
- 第一行：# 📊 浦惠投顧每日摘要 — ${DATE_DISPLAY}
- 接著 > 引用句（用文章標題）
- ## 整體操作水位（持股水位，用紅色 span 標記）
- ## 大盤與美股觀察（要點列表）
- 族群分析章節（依文章內容動態決定）
- ## 📌 今日提到個股（Markdown 表格，欄位：代號、名稱、操作建議）
- 最後 🔗 [閱讀原文](${rawContent.url || ''})

文章標題：${articleTitle}

文章內容：
${rawContent.content.substring(0, 8000)}

請直接輸出 Markdown 內容，不要任何前言或解釋。`;

  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 3000,
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
  const prompt = `你是台股投資分析助手。請將以下浦惠投顧老王的每日分析文章，整理成繁體中文的 Obsidian Markdown 筆記。

格式要求：
- # 📊 浦惠投顧每日摘要 — ${DATE_DISPLAY}
- > 引用標題
- ## 整體操作水位
- ## 大盤與美股觀察
- 族群章節（依內容）
- ## 📌 今日提到個股（表格）

文章標題：${articleTitle}
文章內容：${rawContent.content.substring(0, 8000)}

請直接輸出 Markdown 內容。`;

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
    await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 40000 });

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
    await sendTelegram(`⚠️ 浦惠投顧 OAuth 異常，改走 Playwright fallback\n\n${e.message}\n\n請執行 node scripts/oauth_reauth.cjs 修復`);
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
      log(`抓取成功，內容長度: ${fetched.content.length}`);
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

  // 7. 寫入 Obsidian（CI 環境略過 Windows 路徑）
  if (!IS_CI) {
    fs.mkdirSync(OBSIDIAN_DIR, { recursive: true });
    fs.writeFileSync(NOTE_PATH, markdown, 'utf-8');
    log(`筆記寫入完成: ${NOTE_PATH}`);
  } else {
    log('CI 模式：跳過 Obsidian 寫入');
  }

  // 8. Telegram 通知
  const tgMessage = buildTelegramSummary(markdown, articleTitle, articleUrl);
  await notify(
    `${DATE_DISPLAY} 摘要完成 — ${articleTitle.substring(0, 30)}`,
    tgMessage
  );
  log('通知已發送（Telegram + Email）');
  log('===== puhui_daily 完成 =====');
}

main().catch(async e => {
  log(`未捕捉錯誤: ${e.message}\n${e.stack}`);
  await notify('puhui_daily 崩潰', `🚨 puhui_daily 崩潰\n\n${e.message}`);
  process.exit(1);
});
