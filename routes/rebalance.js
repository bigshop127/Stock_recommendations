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
const { spawn } = require('child_process');
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
// 【regime-aware 2026-07-25】宏觀 regime 門檻預設（與 review-web/src/lib/rebalance.ts 對齊）
const DEFAULT_MACRO_THRESHOLDS = { fed_rate_rise: 1.0, treasury_yield_rise: 0.75, fx_rise_pct: 5 };

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

// 在途交割款快照（由真實同步腳本 scripts/sync_fugle_holdings.py 帶入）：非使用者
// 可編輯欄位，屬「上次真實同步」的 metadata，存成頂層 _settlement、GET 以 settlement
// 回傳。缺欄位/型別不符一律 clamp，rows 逐筆清洗。回傳 null 代表沒有可用快照。
function sanitizeSettlement(v) {
  if (!v || typeof v !== 'object') return null;
  const rowsIn = Array.isArray(v.rows) ? v.rows : [];
  const rows = rowsIn
    .map((r) => (r && typeof r === 'object'
      ? {
          trade_date: typeof r.trade_date === 'string' ? r.trade_date : '',
          settle_date: typeof r.settle_date === 'string' ? r.settle_date : '',
          amount: safeNum(r.amount, 0),
        }
      : null))
    .filter((r) => r !== null);
  return {
    as_of: typeof v.as_of === 'string' ? v.as_of : '',
    net: safeNum(v.net, 0),
    receivable: safeNum(v.receivable, 0),
    payable: safeNum(v.payable, 0),
    rows,
  };
}

// 完整庫存快照（由真實同步腳本 scripts/sync_fugle_holdings.py 帶入，opt「資產變化圖」
// 新增）：get_inventories() 回傳的整個帳戶持倉市值總和，不像 sanitizeHoldings 主體只追
// 蹤 00631L/00687B/00953B 三檔——淨資產頁要算「股市所有錢」需要整戶市值，不是只有這三
// 檔。跟 _settlement 同一個處理方式：非使用者可編輯欄位，屬 metadata，POST 沒帶就沿用
// 上次快照（見下方 POST handler），GET 以獨立的 full_inventory 回傳、不混進 holdings。
function sanitizeFullInventory(v) {
  if (!v || typeof v !== 'object') return null;
  const positionsIn = Array.isArray(v.positions) ? v.positions : [];
  const positions = positionsIn
    .slice(0, 200)
    .map((p) => (p && typeof p === 'object' && typeof p.code === 'string' && p.code
      ? {
          code: p.code.slice(0, 12),
          shares: Math.max(0, safeNum(p.shares, 0)),
          avg_cost: Math.max(0, safeNum(p.avg_cost, 0)),
          market_price: Math.max(0, safeNum(p.market_price, 0)),
          value: Math.max(0, safeNum(p.value, 0)),
        }
      : null))
    .filter((p) => p !== null);
  if (positions.length === 0 && !(safeNum(v.total_value, 0) > 0)) return null;
  return {
    total_value: Math.max(0, safeNum(v.total_value, 0)),
    positions,
    synced_at: typeof v.synced_at === 'string' ? v.synced_at : '',
  };
}

// 【regime-aware】變現優先順序 / 宏觀 regime 設定的清洗（與 store 對齊；告警腳本忽略這些欄位）
function safeBondPriority(v) {
  return v === 'bond1_first' || v === 'bond2_first' ? v : 'regime_aware';
}
function safeCombination(v) {
  return v === 'majority' || v === 'all' ? v : 'any';
}
function sanitizeMacroIndicator(v) {
  if (!v || typeof v !== 'object') return undefined;
  const cur = typeof v.current === 'number' && Number.isFinite(v.current) ? v.current : null;
  const ref = typeof v.reference === 'number' && Number.isFinite(v.reference) ? v.reference : null;
  if (cur === null && ref === null) return undefined;
  const out = { current: cur, reference: ref };
  if (typeof v.as_of === 'string') out.as_of = v.as_of;
  if (typeof v.ref_date === 'string') out.ref_date = v.ref_date;
  return out;
}
function sanitizeMacro(v) {
  const o = v && typeof v === 'object' ? v : {};
  const t = o.thresholds && typeof o.thresholds === 'object' ? o.thresholds : {};
  const macro = {
    thresholds: {
      fed_rate_rise: Math.max(0, safeNum(t.fed_rate_rise, DEFAULT_MACRO_THRESHOLDS.fed_rate_rise)),
      treasury_yield_rise: Math.max(0, safeNum(t.treasury_yield_rise, DEFAULT_MACRO_THRESHOLDS.treasury_yield_rise)),
      fx_rise_pct: Math.max(0, safeNum(t.fx_rise_pct, DEFAULT_MACRO_THRESHOLDS.fx_rise_pct)),
    },
    combination: safeCombination(o.combination),
  };
  const fed = sanitizeMacroIndicator(o.fed_rate);
  const ty = sanitizeMacroIndicator(o.treasury_yield);
  const fx = sanitizeMacroIndicator(o.fx);
  if (fed) macro.fed_rate = fed;
  if (ty) macro.treasury_yield = ty;
  if (fx) macro.fx = fx;
  if (typeof o.fetched_at === 'string') macro.fetched_at = o.fetched_at;
  return macro;
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
    bond_priority: safeBondPriority(b.bond_priority),
    macro: sanitizeMacro(b.macro),
    locked: {
      cash: !!(b.locked && b.locked.cash === true),
      bonds: BOND_ETFS.reduce((acc, bd) => {
        acc[bd.code] = !!(b.locked && b.locked.bonds && b.locked.bonds[bd.code] === true);
        return acc;
      }, {}),
    },
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
      return res.json({ exists: false, holdings: null, saved_at: null });
    }
    const raw = fs.readFileSync(HOLDINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return res.json({
      exists: true,
      holdings: sanitizeHoldings(parsed),
      saved_at: typeof parsed._saved_at === 'string' ? parsed._saved_at : null,
      settlement: sanitizeSettlement(parsed._settlement),
      full_inventory: sanitizeFullInventory(parsed._full_inventory),
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取持倉檔失敗: ' + err.message));
  }
});

router.post('/api/rebalance/holdings', (req, res) => {
  try {
    const clean = sanitizeHoldings(req.body);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 保留範本 _readme（若原檔有）以利手動編輯者理解；在途交割 _settlement 只有真實
    // 同步腳本會帶入，手動存檔（不帶 settlement）時沿用上次快照，不清掉。
    let readme;
    let settlement = sanitizeSettlement(req.body.settlement);
    let full_inventory = sanitizeFullInventory(req.body.full_inventory);
    try {
      const prev = JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf-8'));
      if (prev && typeof prev._readme === 'string') readme = prev._readme;
      if (!settlement && prev && prev._settlement) settlement = sanitizeSettlement(prev._settlement);
      if (!full_inventory && prev && prev._full_inventory) full_inventory = sanitizeFullInventory(prev._full_inventory);
    } catch (_) { /* 無舊檔或壞檔就略過 */ }
    const saved_at = new Date().toISOString();
    const toWrite = {
      ...(readme ? { _readme: readme } : {}),
      ...clean,
      ...(settlement ? { _settlement: settlement } : {}),
      ...(full_inventory ? { _full_inventory: full_inventory } : {}),
      _saved_at: saved_at,
    };
    const tmp = HOLDINGS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
    fs.renameSync(tmp, HOLDINGS_PATH);
    return res.json({ ok: true, holdings: clean, saved_at, full_inventory });
  } catch (err) {
    return sendError(res, httpError(400, 'BAD_REQUEST', '儲存持倉失敗: ' + err.message));
  }
});

// ── 真實同步（玉山證券）────────────────────────────────────────────────────
// 【2026-07-29 改版】原本是 gateway → GitHub workflow_dispatch → 使用者本機的
// self-hosted runner，好處是憑證留在本機，代價是「電腦沒開機就同步不了」。
// 現在改成直接在這台 VM 上跑 deploy/sync_holdings_vm.sh（amd64 容器 + qemu，因為
// 玉山 SDK 沒有 linux-aarch64 wheel），憑證改放 VM 的 ~/.fugle（chmod 600）。
// 附帶好處：VM 公網 IP 固定，玉山金鑰 IP 白名單設一次就不會再飄（AGA0002 絕跡），
// 且 VM 時間由 chrony 校時，不會再有本機時鐘飄移造成的 AWA0005。
//
// 立即回 202；實際結果寫進 data/sync_holdings_status.json，前端輪詢 status 端點，
// 失敗時能顯示真正的錯誤（例如 AGA0002），不再只是一句「逾時」。
const SYNC_SCRIPT = path.join(__dirname, '..', 'deploy', 'sync_holdings_vm.sh');
const SYNC_STATUS_PATH = path.join(DATA_DIR, 'sync_holdings_status.json');
const SYNC_TIMEOUT_MS = 180000; // 容器在 qemu 模擬下啟動較慢，抓 3 分鐘

let syncRunning = false;

function writeSyncStatus(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SYNC_STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, SYNC_STATUS_PATH);
  } catch (_) { /* 狀態檔寫不進去不該影響同步本身 */ }
}

// 從腳本輸出擷取「人看得懂的失敗原因」。玉山的錯誤碼是判斷故障類型的關鍵：
//   AGA0002 = IP 不在白名單、AWA0005 = 機器時鐘偏移、FUGLE_CONFIG_PATH = 憑證檔不見。
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

router.post('/api/rebalance/sync-holdings-trigger', (req, res) => {
  if (syncRunning) {
    return sendError(res, httpError(409, 'BUSY', '同步已在進行中，請等它跑完'));
  }
  if (!fs.existsSync(SYNC_SCRIPT)) {
    return sendError(res, httpError(500, 'CONFIG',
      `找不到同步腳本 ${SYNC_SCRIPT}（真實同步只能在 Oracle VM 上執行）`));
  }

  const started_at = new Date().toISOString();
  syncRunning = true;
  writeSyncStatus({ state: 'running', started_at, finished_at: null, message: null });
  res.status(202).json({ ok: true, triggered_at: started_at });

  const child = spawn('/bin/bash', [SYNC_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    timeout: SYNC_TIMEOUT_MS,
  });
  let output = '';
  const collect = (buf) => { output = (output + buf.toString()).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const finish = (code, err) => {
    if (!syncRunning) return; // close 與 error 都會觸發，只認第一個
    syncRunning = false;
    const ok = !err && code === 0;
    writeSyncStatus({
      state: ok ? 'ok' : 'error',
      started_at,
      finished_at: new Date().toISOString(),
      exit_code: typeof code === 'number' ? code : null,
      message: ok ? null : summarizeFailure(err ? String(err.message) : output),
      log_tail: output.slice(-2000),
    });
  };
  child.on('close', (code) => finish(code, null));
  child.on('error', (err) => finish(null, err));
});

// 真實同步的最近一次結果（前端輪詢用；沒跑過就回 idle）
router.get('/api/rebalance/sync-holdings-status', (req, res) => {
  if (!fs.existsSync(SYNC_STATUS_PATH)) {
    return res.json({ state: 'idle' });
  }
  try {
    return res.json(JSON.parse(fs.readFileSync(SYNC_STATUS_PATH, 'utf-8')));
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '讀取同步狀態失敗: ' + err.message));
  }
});

// ── 宏觀 regime 指標同步【regime-aware 2026-07-25】────────────────────────────
// GET /api/rebalance/macro-indicators —— 直接抓 Yahoo Finance（公開市場資料、無憑證需求，
// 與「真實同步」不同：不觸發本機 runner、不碰任何交易帳戶），回傳三個指標的 current + reference
// （回看 lookback 交易日前的值）。前端據此算變動、與門檻比較，決定股災變現先賣哪一檔。
const YF_HOSTS = ['query1', 'query2'];
const MACRO_DEFS = [
  { key: 'fed_rate', symbol: '^IRX', lookback: 126, label: '聯準會利率（13週國庫券殖利率）' },
  { key: 'treasury_yield', symbol: '^TYX', lookback: 60, label: '長天期美債殖利率（30年）' },
  { key: 'fx', symbol: 'TWD=X', lookback: 60, label: '美元兌台幣匯率' },
];

async function fetchYahooSeries(symbol) {
  const enc = encodeURIComponent(symbol);
  let lastErr;
  for (const host of YF_HOSTS) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${enc}?range=1y&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) { lastErr = new Error('no result'); continue; }
      const ts = res.timestamp || [];
      const q = res.indicators && res.indicators.quote && res.indicators.quote[0];
      const closes = (q && q.close) || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const v = closes[i];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: v });
        }
      }
      if (out.length) return out;
      lastErr = new Error('empty series');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

router.get('/api/rebalance/macro-indicators', async (req, res) => {
  try {
    const entries = await Promise.all(
      MACRO_DEFS.map(async (d) => {
        try {
          const series = await fetchYahooSeries(d.symbol);
          const last = series[series.length - 1];
          const ref = series[Math.max(0, series.length - 1 - d.lookback)];
          return [d.key, {
            symbol: d.symbol, label: d.label, lookback_days: d.lookback,
            current: last.value, reference: ref.value,
            as_of: last.date, ref_date: ref.date, ok: true,
          }];
        } catch (e) {
          return [d.key, {
            symbol: d.symbol, label: d.label, lookback_days: d.lookback,
            current: null, reference: null, as_of: null, ref_date: null,
            ok: false, error: String((e && e.message) || e),
          }];
        }
      }),
    );
    const out = { fetched_at: new Date().toISOString() };
    for (const [k, v] of entries) out[k] = v;
    return res.json(out);
  } catch (err) {
    return sendError(res, httpError(502, 'YAHOO', '抓取宏觀指標失敗: ' + err.message));
  }
});

module.exports = router;
