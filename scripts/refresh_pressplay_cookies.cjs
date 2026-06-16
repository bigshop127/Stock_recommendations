/**
 * refresh_pressplay_cookies.cjs
 *
 * 🚫 已棄用（2026-06-16）：本腳本用 Playwright 自帶 Chromium，PressPlay 走 Google OAuth
 *    登入時會被 Google 擋（「目前無法登入帳戶／瀏覽器可能有安全疑慮」）。請改用
 *    scripts/extract_pressplay_cookies_cdp.cjs（真實 Chrome + CDP）。詳見 docs/runbook.md §7.1。
 *    保留此檔僅供歷史參考。
 *
 * 開啟有頭 Chromium 讓你手動登入 PressPlay，
 * 登入完成後按 Enter，自動儲存 cookies 到 data/pressplay_cookies.json
 *
 * 執行：node scripts/refresh_pressplay_cookies.cjs
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const execPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  'C:\\Users\\bigsh\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe';
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');
const LOGIN_URL = 'https://www.pressplay.cc/login';

(async () => {
  console.log('=== PressPlay Cookie 更新工具 ===');
  console.log('1. 即將開啟瀏覽器視窗');
  console.log('2. 請在瀏覽器中登入 PressPlay');
  console.log('3. 登入並進入會員頁面後，回到這裡按 Enter');
  console.log('');

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: false,
    args: ['--no-sandbox', '--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('瀏覽器已開啟 PressPlay 登入頁面。');
  console.log('請完成登入後，回到這個視窗按 Enter...');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', resolve));
  rl.close();

  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  console.log(`\n✅ 已儲存 ${cookies.length} 個 cookies 到 ${COOKIES_PATH}`);

  await browser.close();
  console.log('完成！可以執行 node scripts/puhui_daily.cjs 測試。');
})().catch(e => {
  console.error('❌ 錯誤:', e.message);
  process.exit(1);
});
