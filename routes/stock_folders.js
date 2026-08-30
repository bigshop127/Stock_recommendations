/**
 * routes/stock_folders.js — 「個股多維度審查」側邊欄資料夾的雲端端點（2026-08-30 新增）。
 *
 *   GET/POST /api/stock-folders —— 讀寫 data/stock_folders.json（原子寫入）
 *
 * 背景：資料夾清單原本純 localStorage（review-web/src/lib/userStore.ts），每次網站
 * 改版清瀏覽器快取（PWA service worker 卡舊 bundle 常見的 debug 步驟）就會連帶清掉
 * localStorage、把分類清空。改成跟 stock_realized 一樣的雲端 JSON 持久化，前端仍保留
 * localStorage 當即時快取／離線 fallback，但事實來源在這裡。
 *
 * 設計原則與 routes/stock_realized.js 一致：純檔案持久化、伺服端一律 sanitize、
 * 原子寫入（.tmp → rename）、免登入個人自用。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const FOLDERS_PATH = path.join(DATA_DIR, 'stock_folders.json');
const MAX_FOLDERS = 30;
const MAX_STOCKS_PER_FOLDER = 300;

const DEFAULT_FOLDERS = [
  { id: 'holdings', label: '我的持股' },
  { id: 'potential', label: '有潛力的' },
  { id: 'others', label: '其他' },
];

function str(v, fb = '') { return typeof v === 'string' ? v : fb; }

function safeFolderId(v, fb) {
  const s = str(v).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return s || fb;
}

function safeLabel(v) {
  return str(v).trim().slice(0, 30);
}

function safeCode(v) {
  return str(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function safeStock(v) {
  if (!v || typeof v !== 'object') return null;
  const code = safeCode(v.code);
  if (!code) return null;
  const name = str(v.name).slice(0, 40);
  const added_at = str(v.added_at) || new Date().toISOString();
  const note = str(v.note).slice(0, 200);
  return { code, name, added_at, ...(note ? { note } : {}) };
}

function sanitizeFolders(body) {
  const b = body && typeof body === 'object' ? body : {};

  const rawFolders = Array.isArray(b.folders) ? b.folders : [];
  const seen = new Set();
  const folders = [];
  for (const f of rawFolders) {
    if (!f || typeof f !== 'object') continue;
    const id = safeFolderId(f.id, '');
    if (!id || seen.has(id)) continue;
    const label = safeLabel(f.label) || id;
    seen.add(id);
    folders.push({ id, label });
    if (folders.length >= MAX_FOLDERS) break;
  }
  const finalFolders = folders.length > 0 ? folders : DEFAULT_FOLDERS.slice();

  const validIds = new Set(finalFolders.map((f) => f.id));
  const rawStocks = b.stocks && typeof b.stocks === 'object' ? b.stocks : {};
  const stocks = {};
  for (const id of validIds) {
    const list = Array.isArray(rawStocks[id]) ? rawStocks[id] : [];
    const codeSeen = new Set();
    const clean = [];
    for (const item of list) {
      const s = safeStock(item);
      if (!s || codeSeen.has(s.code)) continue;
      codeSeen.add(s.code);
      clean.push(s);
      if (clean.length >= MAX_STOCKS_PER_FOLDER) break;
    }
    stocks[id] = clean;
  }

  return { folders: finalFolders, stocks };
}

router.get('/api/stock-folders', (req, res) => {
  try {
    if (!fs.existsSync(FOLDERS_PATH)) {
      return res.json({ exists: false, data: null, saved_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(FOLDERS_PATH, 'utf-8'));
    return res.json({
      exists: true,
      data: sanitizeFolders(parsed),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取資料夾設定失敗: ' + err.message));
  }
});

router.post('/api/stock-folders', (req, res) => {
  try {
    const clean = sanitizeFolders(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = FOLDERS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...clean, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, FOLDERS_PATH);
    return res.json({ ok: true, data: clean, saved_at });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存資料夾設定失敗: ' + err.message));
  }
});

module.exports = router;
