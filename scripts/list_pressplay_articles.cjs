/**
 * list_pressplay_articles.cjs — 列出文章列表頁所有文章標題+URL
 * 執行：node scripts/list_pressplay_articles.cjs
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  'C:\\Users\\bigsh\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe';
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');
const LIST_URL = 'https://www.pressplay.cc/project/CF6DA5CB5BE8C843FE37526843D3E126/articles';

(async () => {
  const browser = await chromium.launch({ executablePath: execPath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    await context.addCookies(cookies);
  }
  const page = await context.newPage();
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Scroll down 20 times to load more articles
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    process.stdout.write('.');
  }
  console.log('\n');

  const articles = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/articles/"]'));
    return anchors
      .map(a => ({
        text: a.textContent.trim().replace(/\s+/g, ' ').substring(0, 60),
        href: a.href.startsWith('http') ? a.href : 'https://www.pressplay.cc' + a.getAttribute('href')
      }))
      .filter((a, i, arr) => a.text.length > 5 && arr.findIndex(x => x.href === a.href) === i);
  });

  articles.forEach(a => console.log(`${a.text}\n  → ${a.href}\n`));
  console.log(`共找到 ${articles.length} 篇文章`);
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
