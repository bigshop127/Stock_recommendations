/**
 * routes/stock_realized_sync.js — 個股／ETF 已實現損益「真實同步」觸發端點（opt37，2026-08-27）。
 *
 * 比照 routes/rebalance.js 的「真實同步」機制：gateway 在 Oracle VM 上直接跑
 * scripts/sync_fugle_realized.py（deploy/sync_realized_vm.sh，amd64 容器 + qemu，
 * 玉山 esun_trade SDK 沒有 linux-aarch64 wheel），憑證用同一份 VM ~/.fugle。
 * 立即回 202，實際結果寫進 data/sync_realized_status.json，前端輪詢。
 *
 * 跟持倉同步不同的是：這裡同步的是「已實現交易」，玉山 get_transactions_by_date
 * 一次最多查到約 180 天（實測 180 天 OK、366 天回 AW00002），所以 Python 腳本
 * 自己切成多段往回查；這裡的 trigger 只負責把 since（回溯起點）傳進去。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const SYNC_SCRIPT = path.join(__dirname, '..', 'deploy', 'sync_realized_vm.sh');
const SYNC_STATUS_PATH = path.join(DATA_DIR, 'sync_realized_status.json');
const SYNC_TIMEOUT_MS = 180000; // 容器在 qemu 模擬下啟動較慢 + 多段查詢，抓 3 分鐘

let syncRunning = false;

function writeSyncStatus(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SYNC_STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, SYNC_STATUS_PATH);
  } catch (_) { /* 狀態檔寫不進去不該影響同步本身 */ }
}

// 與 rebalance.js 的 summarizeFailure 同一套錯誤碼判讀邏輯（AGA0002/AWA0005/憑證/docker）
function summarizeFailure(output) {
  const text = String(output || '');
  if (text.includes('AGA0002')) {
    return 'AGA0002：VM 的 IP 不在玉山金鑰白名單。到 esuntradingapi.esunsec.com.tw/keys/ 把 140.238.48.197 加進去。';
  }
  if (text.includes('AWA0005')) {
    return 'AWA0005：VM 時鐘偏移，交易 API 拒收。檢查 chrony（timedatectl）。';
  }
  if (text.includes('FUGLE_CONFIG_PATH') || text.includes('缺少憑證檔')) {
    return '憑證檔不見了（VM ~/.fugle）。重跑憑證上傳腳本即可。';
  }
  if (text.includes('Cannot connect to the Docker daemon') || text.includes('docker: not found')) {
    return 'VM 上的 docker 沒跑起來（同步是在 amd64 容器裡執行的）。';
  }
  const lines = text.trim().split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '同步失敗，原因不明';
}

// since 只接受 YYYY-MM-DD，其餘一律用腳本預設（往回 730 天）
function safeSince(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

router.post('/api/stocks/sync-realized-trigger', (req, res) => {
  if (syncRunning) {
    return sendError(res, httpError(409, 'BUSY', '同步已在進行中，請等它跑完'));
  }
  if (!fs.existsSync(SYNC_SCRIPT)) {
    return sendError(res, httpError(500, 'CONFIG',
      `找不到同步腳本 ${SYNC_SCRIPT}（真實同步只能在 Oracle VM 上執行）`));
  }

  const since = safeSince(req.body && req.body.since);
  const started_at = new Date().toISOString();
  syncRunning = true;
  writeSyncStatus({ state: 'running', started_at, finished_at: null, message: null, since: since || null });
  res.status(202).json({ ok: true, triggered_at: started_at });

  const env = { ...process.env };
  if (since) env.REALIZED_SYNC_SINCE = since;

  const child = spawn('/bin/bash', [SYNC_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    timeout: SYNC_TIMEOUT_MS,
    env,
  });
  let output = '';
  const collect = (buf) => { output = (output + buf.toString()).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const finish = (code, err) => {
    if (!syncRunning) return; // close 與 error 都會觸發，只認第一個
    syncRunning = false;
    const ok = !err && code === 0;
    let summary = null;
    if (ok) {
      const m = output.match(/SYNC_RESULT:(\{.*\})/);
      if (m) { try { summary = JSON.parse(m[1]); } catch (_) { /* 解析失敗就不附摘要 */ } }
    }
    writeSyncStatus({
      state: ok ? 'ok' : 'error',
      started_at,
      finished_at: new Date().toISOString(),
      exit_code: typeof code === 'number' ? code : null,
      message: ok ? null : summarizeFailure(err ? String(err.message) : output),
      summary,
      log_tail: output.slice(-2000),
    });
  };
  child.on('close', (code) => finish(code, null));
  child.on('error', (err) => finish(null, err));
});

router.get('/api/stocks/sync-realized-status', (req, res) => {
  if (!fs.existsSync(SYNC_STATUS_PATH)) {
    return res.json({ state: 'idle' });
  }
  try {
    return res.json(JSON.parse(fs.readFileSync(SYNC_STATUS_PATH, 'utf-8')));
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取同步狀態失敗: ' + err.message));
  }
});

module.exports = router;
