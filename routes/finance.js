/**
 * finance.js — 既有 Node 內容線端點（階段 6 前就存在，行為一字不改）。
 *
 *   GET  /api/finance/status        讀 data/finance_progress.json
 *   POST /api/finance/update        更新單筆任務進度
 *   POST /api/run-script            白名單跑 puhui_synthesize.js / sync_to_obsidian.js
 *
 * 從 server.cjs 原樣搬出成 Router（路徑、白名單、回傳格式不變），不可破壞。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '..');
const FINANCE_PROGRESS_PATH = path.join(PROJECT_ROOT, 'data', 'finance_progress.json');

function getFinanceProgress() {
  if (!fs.existsSync(FINANCE_PROGRESS_PATH)) return { tasks: [] };
  return JSON.parse(fs.readFileSync(FINANCE_PROGRESS_PATH, 'utf8'));
}

function saveFinanceProgress(data) {
  fs.writeFileSync(FINANCE_PROGRESS_PATH, JSON.stringify(data, null, 4));
}

router.get('/api/finance/status', (req, res) => {
  res.json(getFinanceProgress());
});

router.post('/api/finance/update', (req, res) => {
  const { id, status, progress, message } = req.body;
  if (!id || !status) return res.status(400).json({ success: false, message: 'id and status required' });
  const data = getFinanceProgress();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ success: false, message: `Task ${id} not found` });
  task.status = status;
  if (progress !== undefined) task.progress = progress;
  if (message !== undefined) task.message = message;
  task.updatedAt = new Date().toISOString();
  saveFinanceProgress(data);
  console.log(`[Finance] ${id} -> ${status}${progress ? ' (' + progress + ')' : ''}`);
  res.json({ success: true, task });
});

const ALLOWED_SCRIPTS = ['puhui_synthesize.js', 'sync_to_obsidian.js'];

router.post('/api/run-script', (req, res) => {
  const { script } = req.body;
  if (!script || !ALLOWED_SCRIPTS.includes(script)) {
    return res.status(403).json({ success: false, message: `Script not allowed. Allowed: ${ALLOWED_SCRIPTS.join(', ')}` });
  }
  console.log(`[Puhui] Running script: ${script}`);
  exec(`node scripts/${script}`, { cwd: PROJECT_ROOT }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Script Error] ${script}: ${error.message}`);
      return res.status(500).json({ success: false, message: error.message, stderr });
    }
    console.log(`[Script Done] ${script}: ${stdout.substring(0, 200)}`);
    res.json({ success: true, stdout: stdout.substring(0, 1000) });
  });
});

module.exports = router;
