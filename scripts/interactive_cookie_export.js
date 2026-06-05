/**
 * Interactive PressPlay cookie export
 * Opens browser, waits for user login, then extracts cookies
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');

async function exportCookies() {
  let browser;

  try {
    console.log('[開始] 啟動 Playwright 瀏覽器...');
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('[導航] 前往 PressPlay...');
    await page.goto('https://www.pressplay.cc', { waitUntil: 'networkidle', timeout: 30000 });

    console.log('[等待] 請在瀏覽器中完成登入...');
    console.log('[提示] 登入後系統會自動抓取 cookies（等待 15 秒）');

    // Wait 15 seconds for user to complete login
    await page.waitForTimeout(15000);

    // Get cookies from context
    const cookies = await context.cookies();

    if (cookies.length === 0) {
      console.error('[錯誤] 沒有抓取到任何 cookies！');
      process.exit(1);
    }

    // Convert to dictionary
    const cookieDict = {};
    let pressplayCount = 0;

    cookies.forEach(cookie => {
      cookieDict[cookie.name] = cookie.value;
      if (cookie.domain && cookie.domain.includes('pressplay')) {
        pressplayCount++;
      }
    });

    // Save to file
    const dataDir = path.dirname(COOKIES_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookieDict, null, 2), 'utf8');

    console.log('\n✓ 成功導出 ' + cookies.length + ' 個 cookies');
    console.log('✓ 已保存到: ' + COOKIES_PATH);
    console.log('\n[Cookies 摘要]');
    Object.keys(cookieDict).forEach(name => {
      const value = cookieDict[name];
      const display = value.length > 30 ? value.substring(0, 30) + '...' : value;
      console.log('  • ' + name + ': ' + display);
    });

    await context.close();
    await browser.close();

    console.log('\n✓ 完成！');

  } catch (error) {
    console.error('[錯誤]', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

exportCookies();
