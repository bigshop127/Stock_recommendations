/**
 * routes/rebalance.js — 再平衡持倉雲端同步（gateway 端點）。
 *
 * 讀寫 data/rebalance_holdings.json —— 與背景告警腳本 scripts/rebalance_alert.cjs
 * 讀的是「同一份檔」。前端按「送出/同步」→ POST 此端點寫檔 → 告警腳本自動吃到最新持倉。
 *
 * 設計原則：
 *   - 純檔案持久化，不經 Python engine（無 engine 資料需求）。
 *   - 伺服端一律 sanitize + 重算衍生 shares/avg_cost（＝aggregatePosition，忠實移植自
 *     review-web/src/lib/rebalance.ts），確保頂層 shares/avg_cost 永遠與報價單一致
 *     —— 告警腳本讀頂層 shares/avg_cost，故此端點為單一事實來源。
 *   - 原子寫入（.tmp → rename）避免告警腳本讀到寫一半的檔。
 *   - 免登入個人自用、僅走內網 / ssh -L；持倉檔已 gitignore。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const HOLDINGS_PATH = path.join(DATA_DIR, 'rebalance_holdings.json');

function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}

// 部位累算（移植自 lib/rebalance.ts aggregatePosition，單一標的）
function aggregatePosition(opening, trades) {
  let shares = Math.max(0, safeNum(opening && opening.shares, 0));
  let avg_cost = Math.max(0, safeNum(opening && opening.avg_cost, 0));
  let cost_basis = shares * avg_cost;
  const list = Array.isArray(trades) ? trades.slice() : [];
  list.sort((a, b) => {
    const da = a && typeof a.date === 'string' ? a.date : '';
    const db = b && typeof b.date === 'string' ? b.date : '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  for (const t of list) {
    const tShares = Math.max(0, safeNum(t && t.shares, 0));
    const tPrice = Math.max(0, safeNum(t && t.price, 0));
    if (tShares <= 0) continue;
    if (t && t.side === 'sell') {
      const sold = Math.min(tShares, shares);
      if (sold > 0) {
        cost_basis -= avg_cost * sold;
        shares -= sold;
        if (shares <= 0) { shares = 0; cost_basis = 0; avg_cost = 0; }
      }
    } else {
      cost_basis += tShares * tPrice;
      shares += tShares;
      avg_cost = shares > 0 ? cost_basis / shares : 0;
    }
  }
  return {
    shares: Number.isFinite(shares) ? shares : 0,
    avg_cost: Number.isFinite(avg_cost) ? avg_cost : 0,
  };
}

function sanitizeTrades(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  val.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const shares = Math.max(0, safeNum(t.shares, 0));
    const price = Math.max(0, safeNum(t.price, 0));
    const side = t.side === 'sell' ? 'sell' : 'buy';
    const date = typeof t.date === 'string' && t.date ? t.date : '';
    const id = typeof t.id === 'string' && t.id ? t.id : `t_${date}_${i}_${shares}_${price}`;
    out.push({ id, date, side, shares, price });
  });
  return out;
}

// 統一清洗＋重算衍生 shares/avg_cost，回傳落地用物件
function sanitizeHoldings(body) {
  const b = body && typeof body === 'object' ? body : {};
  const trades = sanitizeTrades(b.trades);
  let opening;
  if (b.opening && typeof b.opening === 'object') {
    opening = {
      shares: Math.max(0, safeNum(b.opening.shares, 0)),
      avg_cost: Math.max(0, safeNum(b.opening.avg_cost, 0)),
    };
  } else {
    // 遷移：無 opening 時用頂層 shares/avg_cost 當期初
    opening = {
      shares: Math.max(0, safeNum(b.shares, 0)),
      avg_cost: Math.max(0, safeNum(b.avg_cost, 0)),
    };
  }
  const agg = aggregatePosition(opening, trades);
  return {
    shares: agg.shares,       // 衍生（告警腳本讀這個）
    avg_cost: agg.avg_cost,   // 衍生
    price: Math.max(0, safeNum(b.price, 0)),
    cash: Math.max(0, safeNum(b.cash, 0)),
    target_beta: safeNum(b.target_beta, 1.3),
    tolerance_mode: b.tolerance_mode === 'pct' ? 'pct' : 'abs',
    threshold_pct: Math.max(0, safeNum(b.threshold_pct, 10)),
    threshold_abs: Math.max(0, safeNum(b.threshold_abs, 0.1)),
    etf_beta: Math.max(0.1, safeNum(b.etf_beta, 2.0)),
    opening,
    trades,
  };
}

router.get('/api/rebalance/holdings', (req, res) => {
  try {
    if (!fs.existsSync(HOLDINGS_PATH)) {
      return res.json({ exists: false, holdings: null });
    }
    const raw = fs.readFileSync(HOLDINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return res.json({ exists: true, holdings: sanitizeHoldings(parsed) });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取持倉檔失敗: ' + err.message));
  }
});

router.post('/api/rebalance/holdings', (req, res) => {
  try {
    const clean = sanitizeHoldings(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 保留範本 _readme（若原檔有）以利手動編輯者理解
    let readme;
    try {
      const prev = JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf-8'));
      if (prev && typeof prev._readme === 'string') readme = prev._readme;
    } catch (_) { /* 無舊檔或壞檔就略過 */ }
    const toWrite = readme ? { _readme: readme, ...clean } : clean;
    const tmp = HOLDINGS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
    fs.renameSync(tmp, HOLDINGS_PATH);
    return res.json({ ok: true, holdings: clean, saved_at: new Date().toISOString() });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存持倉失敗: ' + err.message));
  }
});

module.exports = router;
