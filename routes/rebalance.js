/**
 * routes/rebalance.js — 再平衡持倉雲端同步（gateway 端點）。
 *
 * 讀寫 data/rebalance_holdings.json —— 與背景告警腳本 scripts/rebalance_alert.cjs
 * 讀的是「同一份檔」。前端按「送出/同步」→ POST 此端點寫檔 → 告警腳本自動吃到最新持倉。
 *
 * 設計原則：
 *   - 純檔案持久化，不經 Python engine（無 engine 資料需求）。
 *   - 伺服端一律 sanitize + 重算衍生 shares/avg_cost/cash（＝aggregatePortfolio，忠實移植自
 *     review-web/src/lib/rebalance.ts；【增修I】多資產共用現金：任一標的買扣賣加），
 *     確保頂層衍生值永遠與報價單一致 —— 告警腳本讀頂層值，故此端點為單一事實來源。
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

// 【增修I】多資產常數（與 review-web/src/lib/rebalance.ts 對齊）
const ETF_CODE = '00631L';
const BOND_ETFS = [
  { code: '00687B', name: '國泰20年美債' },
  { code: '00953B', name: '群益優選非投等債' },
];
const DEFAULT_CASH_RESERVE = 100000;
const DEFAULT_BOND_SPLIT = 0.6;

function safeNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v); if (Number.isFinite(p)) return p; }
  return fb;
}

/**
 * 多資產部位累算（移植自 lib/rebalance.ts aggregatePortfolio）：
 * 全部交易按日期全域排序、共用現金池（任一標的買進扣現金、賣出加現金），
 * 每檔各自加權平均成本、超賣 clamp 至現有股數。
 * opening.positions: { [code]: { shares, avg_cost } }
 */
function aggregatePortfolio(opening, trades) {
  let cash = Math.max(0, safeNum(opening && opening.cash, 0));
  const positions = {};
  const openPos = opening && opening.positions && typeof opening.positions === 'object'
    ? opening.positions : {};
  for (const code of Object.keys(openPos)) {
    const p = openPos[code] || {};
    const shares = Math.max(0, safeNum(p.shares, 0));
    const avg_cost = Math.max(0, safeNum(p.avg_cost, 0));
    positions[code] = { shares, avg_cost, cost_basis: shares * avg_cost };
  }
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
    const code = t && typeof t.code === 'string' && t.code ? t.code : ETF_CODE;
    if (!positions[code]) positions[code] = { shares: 0, avg_cost: 0, cost_basis: 0 };
    const pos = positions[code];
    if (t && t.side === 'sell') {
      const sold = Math.min(tShares, pos.shares);
      if (sold > 0) {
        cash += sold * tPrice;
        pos.cost_basis -= pos.avg_cost * sold;
        pos.shares -= sold;
        if (pos.shares <= 0) { pos.shares = 0; pos.cost_basis = 0; pos.avg_cost = 0; }
      }
    } else {
      pos.cost_basis += tShares * tPrice;
      pos.shares += tShares;
      pos.avg_cost = pos.shares > 0 ? pos.cost_basis / pos.shares : 0;
      cash -= tShares * tPrice;
    }
  }
  return { cash: Number.isFinite(cash) ? cash : 0, positions };
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
    // 【增修I】缺 code 的舊資料視為 00631L
    const code = typeof t.code === 'string' && t.code ? t.code : ETF_CODE;
    const id = typeof t.id === 'string' && t.id ? t.id : `t_${date}_${i}_${shares}_${price}`;
    out.push({ id, date, side, shares, price, code });
  });
  return out;
}

// 期初債券部位：對每一檔已知債券 ETF 找對應輸入（缺＝0）【增修I】
function sanitizeOpeningBonds(val) {
  const list = Array.isArray(val) ? val : [];
  return BOND_ETFS.map((b) => {
    const found = list.find((x) => x && typeof x === 'object' && x.code === b.code);
    return {
      code: b.code,
      shares: Math.max(0, safeNum(found && found.shares, 0)),
      avg_cost: Math.max(0, safeNum(found && found.avg_cost, 0)),
    };
  });
}

// 統一清洗＋重算衍生 shares/avg_cost/cash/bonds，回傳落地用物件
function sanitizeHoldings(body) {
  const b = body && typeof body === 'object' ? body : {};
  const trades = sanitizeTrades(b.trades);
  let opening;
  if (b.opening && typeof b.opening === 'object') {
    opening = {
      shares: Math.max(0, safeNum(b.opening.shares, 0)),
      avg_cost: Math.max(0, safeNum(b.opening.avg_cost, 0)),
      // 【增修H】遷移：opening 無 cash 時用頂層 cash 當期初現金
      cash: Math.max(0, safeNum(b.opening.cash, Math.max(0, safeNum(b.cash, 0)))),
      // 【增修I】遷移：opening 無 bonds 時補零持倉
      bonds: sanitizeOpeningBonds(b.opening.bonds),
    };
  } else {
    // 遷移：無 opening 時用頂層 shares/avg_cost/cash 當期初
    opening = {
      shares: Math.max(0, safeNum(b.shares, 0)),
      avg_cost: Math.max(0, safeNum(b.avg_cost, 0)),
      cash: Math.max(0, safeNum(b.cash, 0)),
      bonds: sanitizeOpeningBonds(undefined),
    };
  }

  const positions = { [ETF_CODE]: { shares: opening.shares, avg_cost: opening.avg_cost } };
  for (const ob of opening.bonds) positions[ob.code] = { shares: ob.shares, avg_cost: ob.avg_cost };
  const agg = aggregatePortfolio({ cash: opening.cash, positions }, trades);

  // 頂層債券持倉：shares/avg_cost 衍生、price 沿用輸入（手動/抓價）【增修I】
  const bondsIn = Array.isArray(b.bonds) ? b.bonds : [];
  const bonds = BOND_ETFS.map((bd) => {
    const found = bondsIn.find((x) => x && typeof x === 'object' && x.code === bd.code);
    const pos = agg.positions[bd.code];
    return {
      code: bd.code,
      shares: pos ? pos.shares : 0,
      avg_cost: pos ? pos.avg_cost : 0,
      price: Math.max(0, safeNum(found && found.price, 0)),
    };
  });

  const etfPos = agg.positions[ETF_CODE];
  return {
    shares: etfPos ? etfPos.shares : 0,       // 衍生（告警腳本讀這個）
    avg_cost: etfPos ? etfPos.avg_cost : 0,   // 衍生
    price: Math.max(0, safeNum(b.price, 0)),
    cash: Math.max(0, agg.cash), // 衍生【增修H/I】（告警腳本讀這個；負值 clamp 0）
    bonds,                       // 【增修I】告警腳本也讀（β 分母含債券市值）
    cash_reserve: Math.max(0, safeNum(b.cash_reserve, DEFAULT_CASH_RESERVE)),
    bond_split: Math.min(1, Math.max(0, safeNum(b.bond_split, DEFAULT_BOND_SPLIT))),
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
