/**
 * 從已開啟的 Chrome 瀏覽器抓取 PressPlay cookies
 * 使用 Chrome DevTools Protocol (CDP) 連接現有 Chrome 實例
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');

async function extractCookies() {
  let browser;

  try {
    console.log('[連接] 連接到已開啟的 Chrome 瀏覽器...');

    // 連接到現有的 Chrome 實例（port 9222 是預設的遠程調試端口）
    // 先嘗試預設 port，如果失敗則尋找 Chrome 的遠程調試端口
    let browser;
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: 'ws://127.0.0.1:9222'
      });
    } catch (err) {
      console.log('[提示] 找不到遠程調試端口，嘗試啟動 Chrome with debugging...');
      // 如果 CDP 連接失敗，改為使用 Playwright 連接現有 Chrome
      throw new Error('請用以下指令在 PowerShell 中重啟 Chrome（啟用遠程調試）：\n' +
        'Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList "--remote-debugging-port=9222"');
    }

    console.log('[連接] ✅ 已連接到 Chrome');

    // 獲取所有 pages
    const pages = await browser.pages();
    if (pages.length === 0) {
      throw new Error('找不到任何 Chrome tab');
    }

    // 尋找 PressPlay 的 page
    let pressPlayPage = null;
    for (const page of pages) {
      const url = page.url();
      if (url.includes('pressplay.cc')) {
        pressPlayPage = page;
        console.log(`[發現] 找到 PressPlay 頁面: ${url}`);
        break;
      }
    }

    if (!pressPlayPage) {
      console.log('[提示] 使用第一個 tab');
      pressPlayPage = pages[0];
    }

    // 抓取 cookies
    console.log('[抓取] 從 PressPlay 抓取 cookies...');
    const cookies = await pressPlayPage.cookies();

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

    console.log('\n✨ 下次執行 puhui_daily.js 時會自動使用新的 cookies');

    await browser.close();

  } catch (error) {
    console.error('[❌ 錯誤]', error.message);
    process.exit(1);
  }
}

extractCookies();
