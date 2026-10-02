/**
 * routes/reports_run.js — 老王每日報告「立即產生」按鈕（2026-10-02）。
 *
 * VM cron 只在 12:30／12:45／13:00 各試一次；老王晚發文時三次都撲空，要等隔天才補得到。
 * 這個端點讓網頁手動補跑同一支 scripts/puhui_daily.cjs（抓文章 → AI 摘要 → 寫 reports/
 * → git push → 更新 puhui_cache.json），環境比照 VM 的 ~/puhui_daily_cron.sh。
 * 比照 stock_realized_sync.js：立即回 202，結果寫進 data/puhui_run_status.json，前端輪詢。
 *
 * 一律帶 --quiet：結果直接顯示在網頁上，不另寄「今日無發文」之類的信（按早了會多一封噪音）。
 * 不帶 --force：今天已有報告就照腳本原本的規則跳過，不會蓋掉。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SCRIPT = path.join(ROOT, 'scripts', 'puhui_daily.cjs');
const STATUS_PATH = path.join(DATA_DIR, 'puhui_run_status.json');
// 跟 cron 那三次記在同一個檔，查 log 只要看一個地方
const CRON_LOG = path.join(os.homedir(), 'puhui_daily.cron.log');
// VM 上 Claude CLI 摘要最長實測約 10 分鐘，再加抓文章與 push
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

let running = false;

function writeStatus(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, STATUS_PATH);
  } catch (_) { /* 狀態檔寫不進去不該影響產生報告本身 */ }
}

function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

// 子行程環境只帶系統基本變數＋cron wrapper 那幾個 export，**不繼承 gateway 自己的 env**：
// gateway 啟動時已把 .env 灌進 process.env，而腳本的 dotenv 不覆蓋既有變數，
// 繼承下去的話 .env 換過的新 token 會被 gateway 手上的舊值蓋掉（2026-09-28 Google 重新授權踩過）。
function buildChildEnv() {
  const env = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return {
    ...env,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_OPTIONS: '--max_old_space_size=2048',
    RUN_TARGET: 'vm',
    CLAUDE_BIN: '/usr/bin/claude',
    PUHUI_QUIET: '1',
  };
}

// cron 那三次正在跑的話別再疊一個（兩邊會各寫一份、各呼叫一次 Claude）。
// 只認「node 執行檔開頭」的命令列：cron wrapper 是 exec /usr/bin/node scripts/puhui_daily.cjs，
// 不錨定的話 SSH 進來 tail/grep 那支腳本名的 bash -c 也會被當成在跑。
function cronRunActive() {
  try {
    return execFileSync('pgrep', ['-f', '^\\S*node\\s.*scripts/puhui_daily\\.cjs'], { encoding: 'utf8' }).trim() !== '';
  } catch (_) {
    return false; // pgrep 找不到時 exit 1
  }
}

/**
 * 把腳本輸出翻成網頁看得懂的結果。腳本「沒文章」「已存在」都是 exit 0，只能靠 log 字句分辨
 * （字句對應 scripts/puhui_daily.cjs main()，改那邊的 log 要一起改這裡）。
 * outcome：done 已產生／exists 今天本來就有／no_article 文章還沒出現／no_access 讀不到文章／error 失敗
 */
function summarizeRun(output, exitCode) {
  const text = String(output || '');
  // 失敗時腳本會 notify()，--quiet 下只留「[quiet] 略過 Email: [浦惠自動化] <主旨>」，
  // 那個主旨就是腳本自己寫的失敗摘要（例：AI 摘要失敗、文章抓取失敗），優先拿來用
  const lastLine = () => {
    const lines = text.split('\n').map((l) => l.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/, '').trim()).filter(Boolean);
    const subjects = lines.filter((l) => l.startsWith('[quiet] 略過 Email:'));
    if (subjects.length) {
      return subjects[subjects.length - 1].replace(/^\[quiet\] 略過 Email:\s*(\[浦惠自動化\]\s*)?/, '').slice(0, 300);
    }
    const plain = lines.filter((l) => !l.startsWith('[quiet]'));
    return plain.length ? plain[plain.length - 1].slice(0, 300) : '原因不明';
  };
  if (exitCode !== 0) {
    if (text.includes('疑似 paywall')) {
      return { outcome: 'no_access', message: '抓到的文章只有開頭（疑似 paywall），PressPlay 登入可能失效了，要重抓 cookies（runbook §7.1）。' };
    }
    return { outcome: 'error', message: `執行失敗：${lastLine()}` };
  }
  if (text.includes('===== puhui_daily 完成 =====')) {
    return { outcome: 'done', message: '今日報告已產生。' };
  }
  if (text.includes('輸出已存在') || text.includes('現有筆記完整')) {
    return { outcome: 'exists', message: '今天的報告已經有了，不用再產生。' };
  }
  if (text.includes('文章列表中找不到')) {
    return { outcome: 'no_article', message: 'PressPlay 上還沒有今天的文章（老王還沒發，或今天休息），晚點再按一次。' };
  }
  if (text.includes('canRead=false') || text.includes('無權限閱讀')) {
    return { outcome: 'no_access', message: '今天的文章讀不到（canRead=false）。如果不是會員專屬週報，就是 PressPlay 登入失效，要重抓 cookies（runbook §7.1）。' };
  }
  return { outcome: 'error', message: `結束了但沒有產生報告：${lastLine()}` };
}

router.post('/api/reports/run-trigger', (req, res) => {
  if (process.platform === 'win32') {
    return sendError(res, httpError(500, 'CONFIG', '只能在 Oracle VM 上執行（本機 gateway 不跑每日報告流程）'));
  }
  if (running) {
    return sendError(res, httpError(409, 'BUSY', '已經在產生了，請等它跑完'));
  }
  if (cronRunActive()) {
    return sendError(res, httpError(409, 'BUSY', '排程那次（12:30／12:45／13:00）正在跑，等它跑完再重新載入看看'));
  }
  if (!fs.existsSync(SCRIPT)) {
    return sendError(res, httpError(500, 'CONFIG', `找不到 ${SCRIPT}`));
  }

  const date = taipeiToday();
  const started_at = new Date().toISOString();
  running = true;
  writeStatus({ state: 'running', date, started_at, finished_at: null, outcome: null, message: null });
  res.status(202).json({ ok: true, date, triggered_at: started_at });

  let logStream = null;
  try {
    logStream = fs.createWriteStream(CRON_LOG, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
    logStream.write(`[${started_at}] （網頁按鈕手動觸發）\n`);
  } catch (_) { logStream = null; }

  const child = spawn(process.execPath, [SCRIPT, '--quiet'], {
    cwd: ROOT,
    env: buildChildEnv(),
    timeout: RUN_TIMEOUT_MS,
  });
  let output = '';
  const collect = (buf) => {
    output = (output + buf.toString()).slice(-20000);
    if (logStream) logStream.write(buf);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const finish = (code, signal, err) => {
    if (!running) return; // close 與 error 都會觸發，只認第一個
    running = false;
    if (logStream) logStream.end();
    let result;
    if (err) result = { outcome: 'error', message: `啟動失敗：${err.message}` };
    else if (signal) result = { outcome: 'error', message: `超過 ${RUN_TIMEOUT_MS / 60000} 分鐘沒跑完，已中止（${signal}）` };
    else result = summarizeRun(output, code);
    writeStatus({
      state: result.outcome === 'error' ? 'error' : 'ok',
      date,
      started_at,
      finished_at: new Date().toISOString(),
      exit_code: typeof code === 'number' ? code : null,
      ...result,
      log_tail: output.slice(-3000),
    });
  };
  child.on('close', (code, signal) => finish(code, signal, null));
  child.on('error', (err) => finish(null, null, err));
});

router.get('/api/reports/run-status', (req, res) => {
  if (!fs.existsSync(STATUS_PATH)) {
    return res.json({ state: 'idle' });
  }
  try {
    const st = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8'));
    // 檔案寫著 running、這個行程卻沒在跑＝跑到一半 gateway 重啟了，子行程跟著被收掉
    if (st.state === 'running' && !running) {
      return res.json({ ...st, state: 'error', outcome: 'error', message: '上次執行被中斷（gateway 重啟），請再按一次。' });
    }
    return res.json(st);
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取執行狀態失敗: ' + err.message));
  }
});

module.exports = router;
module.exports.summarizeRun = summarizeRun;
