/**
 * PressPlay Cookies 自動導出工具
 * 使用 Playwright 從瀏覽器抓取 cookies 並保存
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRESSPLAY_URL = 'https://www.pressplay.cc/project/CF6DA5CB5BE8C843FE37526843D3E126';
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');

async function exportCookies() {
  let browser;

  try {
    console.log('[導出開始] 啟動 Playwright 瀏覽器...');
    browser = await chromium.launch({ headless: false }); // headless: false 讓使用者看到窗口
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`[導航] 前往 ${PRESSPLAY_URL}`);
    await page.goto(PRESSPLAY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待頁面穩定
    await page.waitForTimeout(2000);

    // 檢查是否已登入
    let isLoggedIn = false;
    try {
      isLoggedIn = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        return bodyText.includes('我的課程') || bodyText.includes('個人頁面');
      });
    } catch (err) {
      console.log('[提示] 無法檢查登入狀態，假設未登入');
    }

    if (!isLoggedIn) {
      console.log('[等待] ⏳ 請在瀏覽器中登入你的 PressPlay 帳戶...');
      console.log('[提示] 登入完成後，Console 會自動抓取 cookies（大約需要 30 秒）');

      // 等待登入信號
      await page.waitForTimeout(35000);
    } else {
      console.log('[檢測] ✅ 已登入狀態');
    }

    // 抓取 cookies
    console.log('[抓取] 導出 PressPlay cookies...');
    const cookies = await context.cookies();

    if (cookies.length === 0) {
      console.error('[❌ 錯誤] 沒有抓取到任何 cookies！');
      console.log('[提示] 請確保已登入 PressPlay 帳戶');
      process.exit(1);
    }

    // 轉換為容易使用的格式
    const cookieDict = {};
    cookies.forEach(cookie => {
      cookieDict[cookie.name] = cookie.value;
    });

    // 保存到文件
    const dataDir = path.dirname(COOKIES_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookieDict, null, 2), 'utf8');

    console.log(`\n✅ [成功] 導出 ${cookies.length} 個 cookies`);
    console.log(`📁 已保存到: ${COOKIES_PATH}`);

    // 顯示 cookies 摘要
    console.log('\n📋 Cookies 列表:');
    Object.keys(cookieDict).forEach(name => {
      const value = cookieDict[name];
      const display = value.length > 30 ? value.substring(0, 30) + '...' : value;
      console.log(`  • ${name}: ${display}`);
    });

    console.log('\n✨ 下次執行 puhui_daily.cjs 時會自動使用新的 cookies');

    await context.close();
    await browser.close();

  } catch (error) {
    console.error('[❌ 錯誤]', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

exportCookies();
