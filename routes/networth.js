/**
 * routes/networth.js — 資產變化圖／淨資產快照雲端端點（2026-08-28 新增）。
 *
 *   GET/POST /api/networth —— 讀寫 data/networth_snapshots.json（原子寫入）
 *
 * 設計原則與 routes/stock_realized.js 一致：純檔案持久化、伺服端一律 sanitize、
 * 原子寫入（.tmp → rename）、免登入個人自用。
 *
 * 資料形狀是一串「快照」，一天一筆（同一天多次儲存＝覆蓋，見 sanitizeSnapshots
 * 的 Map 去重，後蓋前）：股票現金／庫存市值（前端從 rebalance holdings 的
 * full_inventory 自動帶入，見 RebalanceHoldingsResp）＋期貨權益（前端從
 * futures/equity-history 自動帶入），全部自動同步、沒有任何手動輸入欄位。加總算
 * 「淨資產」是前端算，這裡只負責存這三個數字，不重新推導。
 *
 * 2026-08-29 移除了原本的「銀行帳戶」手動輸入欄位——使用者發現那格填的其實就是
 * 券商現金的重複人工估算，既然券商現金已經自動同步，這格沒有存在必要。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'networth_snapshots.json');

function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}
function safeDate(v) {
  const s = typeof v === 'string' ? v : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function sanitizeSnapshot(s, i) {
  if (!s || typeof s !== 'object') return null;
  const date = safeDate(s.date);
  if (!date) return null;
  const id = typeof s.id === 'string' && s.id ? s.id : `nw_${date}_${i}`;
  const note = typeof s.note === 'string' ? s.note.slice(0, 100) : '';
  return {
    id,
    date,
    stock_cash: Math.max(0, safeNum(s.stock_cash, 0)),
    // 交割款細分（2026-08-28 新增）：stock_cash 是「已入帳＋在途交割」的總額
    // （沿用 rebalance holdings.cash 的既有語意，不動它），這個欄位單獨存淨在途
    // 交割款（正＝應收、負＝應付），純粹是把 stock_cash 拆開顯示用，兩者相減
    // 才是「已入帳、不用等交割就能動用」的現金——不 clamp 正負，方向本身是資訊。
    stock_pending_settlement: safeNum(s.stock_pending_settlement, 0),
    stock_holdings_value: Math.max(0, safeNum(s.stock_holdings_value, 0)),
    // 期貨權益虧到接近斷頭時可能非常低但理論上不會真的變負（斷頭會強制平倉出場），
    // 不過不硬 clamp 0，免得把「快斷頭」的警訊悄悄抹平成看起來還好的 0。
    futures_equity: safeNum(s.futures_equity, 0),
    ...(note ? { note } : {}),
  };
}

// 同一天只留最後一筆（Map 後蓋前），日期由舊到新排序方便畫歷史線圖
function sanitizeSnapshots(val) {
  if (!Array.isArray(val)) return [];
  const map = new Map();
  val.forEach((s, i) => {
    const item = sanitizeSnapshot(s, i);
    if (item) map.set(item.date, item);
  });
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

router.get('/api/networth', (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOTS_PATH)) {
      return res.json({ exists: false, snapshots: [], saved_at: null });
    }
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf-8'));
    return res.json({
      exists: true,
      snapshots: sanitizeSnapshots(parsed.snapshots),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取淨資產快照檔失敗: ' + err.message));
  }
});

router.post('/api/networth', (req, res) => {
  try {
    const snapshots = sanitizeSnapshots(req.body && req.body.snapshots);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved_at = new Date().toISOString();
    const tmp = SNAPSHOTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ snapshots, _saved_at: saved_at }, null, 2));
    fs.renameSync(tmp, SNAPSHOTS_PATH);
    return res.json({ ok: true, snapshots, saved_at });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存淨資產快照失敗: ' + err.message));
  }
});

module.exports = router;
