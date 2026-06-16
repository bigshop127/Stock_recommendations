/**
 * extract_pressplay_cookies_cdp.cjs
 *
 * 從「使用者自己啟動、且帶 --remote-debugging-port 的真實 Chrome」抓 cookies。
 * 真實 Chrome 不會被 Google 的自動化偵測擋（Playwright 自帶 Chromium 會被擋），
 * 用來繞過 refresh_pressplay_cookies.cjs 目前撞到的「目前無法登入帳戶」封鎖。
 *
 * 前置：使用者先在 PowerShell 跑（獨立 profile，可與日常 Chrome 並存）：
 *   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
 *     -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\Temp\pp-debug-profile','https://www.pressplay.cc/login'
 * 然後在該視窗用 email/密碼登入 → 打開一篇付費文章（讓 PressPlay 發 JAccessToken）。
 *
 * 本腳本：connectOverCDP 連上 9222，匯出 cookies 為「陣列」格式
 * （與 puhui_daily.cjs 的 context.addCookies 相容；不可用 {name:value} dict）。
 * 執行：node scripts/extract_pressplay_cookies_cdp.cjs
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const COOKIES_PATH = path.join(__dirname, '..', 'data', 'pressplay_cookies.json');

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP);
  } catch (e) {
    console.error('ERROR: 連不上 ' + CDP + ' — 請確認 Chrome 已用 --remote-debugging-port=9222 啟動。');
    console.error('  ' + e.message);
    process.exit(2);
  }

  const contexts = browser.contexts();
  if (!contexts.length) { console.error('ERROR: CDP 無任何 context'); process.exit(3); }

  // 收集所有 context 的 cookies（通常只有一個 default context）
  let all = [];
  for (const ctx of contexts) {
    try { all = all.concat(await ctx.cookies()); } catch (_) {}
  }

  // 只保留 PressPlay 網域的 cookies（窄範圍；不外帶其他站點登入態），並去重
  const seen = new Set();
  const cookies = [];
  for (const c of all) {
    if (!String(c.domain || '').toLowerCase().includes('pressplay')) continue;
    const k = c.name + '|' + c.domain + '|' + c.path;
    if (seen.has(k)) continue;
    seen.add(k);
    cookies.push(c);
  }

  const jwt = cookies.find(c => c.name === 'JAccessToken');

  if (!cookies.length) {
    console.error('ERROR: 沒抓到任何 pressplay cookies — Chrome 是否已登入 PressPlay？');
    process.exit(4);
  }
  if (!jwt) {
    console.error('WARN: 抓到 ' + cookies.length + ' 個 pressplay cookies 但找不到 JAccessToken。');
    console.error('  → 請在該 Chrome 視窗「打開一篇付費文章並確認讀得到內文」後再重跑本腳本。');
    console.error('  （未寫檔，避免覆蓋掉可能可用的舊 cookies。）');
    process.exit(5);
  }

  // 解碼 exp（只印日期、不印 token）
  let expLine = '(exp 解析失敗)';
  try {
    const p = JSON.parse(Buffer.from(jwt.value.split('.')[1], 'base64').toString('utf8'));
    const exp = new Date(p.exp * 1000);
    const days = Math.round((exp - Date.now()) / 86400000);
    expLine = 'JAccessToken exp=' + exp.toISOString().slice(0, 10) + ' (' + days + ' 天後)';
  } catch (_) {}

  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  console.log('OK: 已寫入 ' + cookies.length + ' 個 pressplay cookies。' + expLine);
  process.exit(0); // 不呼叫 browser.close()，避免關掉使用者的 Chrome
})();
