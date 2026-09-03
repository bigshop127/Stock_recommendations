// owndd.cjs — 崩盤觸發訊號改用「00631L 自己的回撤」而非「大盤（TAIEX/0050）回撤」，
// 真的划算嗎？網格搜尋 target_beta × tier2/tier3 觸發門檻 × 中繼β，三種訊號來源互比。
//
// 沿用 opt20（已下架的 crashBacktest.ts，git show 9719dda 撈回來看過邏輯）的三層狀態機：
// 正常模式 β 漂出容忍區間即再平衡；dd 觸及 tier2 門檻 → 加碼到 beta_mid；觸及 tier3 門檻
// → 全倉拉滿 etf_beta；觸發來源創新高 → 退出、re-balance 回 target_beta。這裡簡化成純現金
// 防守端（不模擬債券），因為要回答的問題只跟「用什麼當回撤訊號」有關，防守端內部配置是
// 另一個已經定案的正交問題（見 rebalance.ts 的 regime-aware waterfall）。
//
// 三種 dd_source：
//   taiex — 現行上線設定（TAIEX 自己的收盤）
//   mkt50 — 舊制（0050 還原價，opt20 之前用這個，已知漏掉 2025 關稅崩盤）
//   own   — 這次要測的新提案：00631L 自己的還原價回撤
const fs = require('fs');
const { loadYahoo, buildModelled } = require('./etf.cjs');

const REAL_FROM = '2015-01-05'; // 00631L 還原價可信起點（見 etf.cjs 註解，之前有 21.9 倍尺度斷點）

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ── 1. 讀資料、對齊 ──────────────────────────────────────────────
const L = loadYahoo('y631L.json').filter((r) => r.date >= REAL_FROM);
const T = loadYahoo('ytwii.json');
const M = loadYahoo('y0050.json');
const tMap = new Map(T.map((r) => [r.date, r.adj]));
const mMap = new Map(M.map((r) => [r.date, r.adj]));

const bars = [];
for (const r of L) {
  const taiex = tMap.get(r.date);
  const mkt50 = mMap.get(r.date);
  if (taiex == null || mkt50 == null) continue;
  bars.push({ date: r.date, etf: r.adj, taiex, mkt50 });
}
console.log(`對齊後 ${bars.length} 筆交易日：${bars[0].date} ~ ${bars[bars.length - 1].date}`);

// ── 2. 模擬引擎（單一標的00631L＋現金，三層狀態機，dd_source 可切換）──────
const DD_FIELD = { taiex: 'taiex', mkt50: 'mkt50', own: 'etf' }; // 'own' 訊號讀 bar.etf（00631L 自己的還原價）

function simulate(bars, p) {
  const ddKey = DD_FIELD[p.ddSource];
  const targetWeight = clamp(p.targetBeta / p.etfBeta, 0, 1);
  const upper = p.targetBeta + p.band;
  const lower = Math.max(p.targetBeta - p.band, 0);
  const costRate = p.costBps / 10000;

  let etfUnits = (targetWeight * p.capital0) / bars[0].etf;
  let cash = (1 - targetWeight) * p.capital0;
  let peakDd = bars[0][ddKey];
  let inCrash = false, inTier2 = false;
  let curCrash = null;
  const crashEvents = [];
  const eq = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar[ddKey] > peakDd) peakDd = bar[ddKey];
    const dd = peakDd > 0 ? (peakDd - bar[ddKey]) / peakDd : 0;
    const etfValue = etfUnits * bar.etf;
    const total = etfValue + cash;
    const curBeta = total > 0 ? (etfValue / total) * p.etfBeta : 0;

    if (i > 0 && total > 0) {
      const trade = (desiredValue) => {
        const traded = desiredValue - etfValue;
        const cost = Math.abs(traded) * costRate;
        etfUnits = desiredValue / bar.etf;
        cash = cash - traded - cost;
      };
      if (!inCrash && dd >= p.tier3Dd) {
        trade(1.0 * total);
        inCrash = true; inTier2 = false;
        if (curCrash) curCrash.tier3 = bar.date;
        else curCrash = { enter: bar.date, exit: null, maxDd: dd, tier3: bar.date };
      } else if (!inCrash && !inTier2 && dd >= p.tier2Dd) {
        trade((p.betaMid / p.etfBeta) * total);
        inTier2 = true;
        curCrash = { enter: bar.date, exit: null, maxDd: dd, tier3: null };
      } else if (inCrash && dd <= 1e-9) {
        trade(targetWeight * total);
        inCrash = false;
        if (curCrash) { curCrash.exit = bar.date; crashEvents.push(curCrash); curCrash = null; }
      } else if (inTier2 && dd < p.tier2Dd) {
        trade(targetWeight * total);
        inTier2 = false;
        if (curCrash) { curCrash.exit = bar.date; crashEvents.push(curCrash); curCrash = null; }
      } else if (inCrash || inTier2) {
        if (curCrash && dd > curCrash.maxDd) curCrash.maxDd = dd;
      } else if (curBeta > upper || curBeta < lower) {
        trade(targetWeight * total);
      }
    }
    eq.push({ date: bar.date, value: etfUnits * bar.etf + cash });
  }
  if (curCrash) crashEvents.push(curCrash);

  const n = eq.length;
  const yrs = (new Date(eq[n - 1].date) - new Date(eq[0].date)) / 31557600000;
  let pk = 0, mdd = 0;
  for (const e of eq) { if (e.value > pk) pk = e.value; const d = pk > 0 ? e.value / pk - 1 : 0; if (d < mdd) mdd = d; }
  let worst1y = 0;
  for (let i = 252; i < n; i++) worst1y = Math.min(worst1y, eq[i].value / eq[i - 252].value - 1);
  const cagr = Math.pow(eq[n - 1].value / p.capital0, 1 / yrs) - 1;
  return { cagr, mdd, worst1y, calmar: mdd < 0 ? cagr / -mdd : Infinity, final: eq[n - 1].value, crashEvents, eq };
}

// ── 3. 網格搜尋 ──────────────────────────────────────────────────
const BASE = { etfBeta: 2.0, band: 0.10, costBps: 20, capital0: 1e8 };
const range = (from, to, step) => { const a = []; for (let v = from; v <= to + 1e-9; v += step) a.push(+v.toFixed(4)); return a; };

const SOURCES = {
  taiex: { tier3: range(0.12, 0.32, 0.02), gaps: [0.03, 0.05, 0.08] },
  mkt50: { tier3: range(0.12, 0.32, 0.02), gaps: [0.03, 0.05, 0.08] },
  own: { tier3: range(0.22, 0.62, 0.04), gaps: [0.06, 0.10, 0.16] },
};
const TARGET_BETAS = range(1.0, 2.0, 0.1);
const MID_FRACS = [0.4, 0.6, 0.8];

let results = {};
for (const [src, cfg] of Object.entries(SOURCES)) {
  const rows = [];
  for (const targetBeta of TARGET_BETAS) {
    for (const tier3Dd of cfg.tier3) {
      for (const gap of cfg.gaps) {
        const tier2Dd = +(tier3Dd - gap).toFixed(4);
        if (tier2Dd <= 0.02) continue;
        for (const frac of MID_FRACS) {
          const betaMid = clamp(targetBeta + (BASE.etfBeta - targetBeta) * frac, targetBeta, BASE.etfBeta);
          const r = simulate(bars, Object.assign({}, BASE, { ddSource: src, targetBeta, tier2Dd, tier3Dd, betaMid }));
          rows.push({ targetBeta, tier2Dd, tier3Dd, betaMid, ...r });
        }
      }
    }
  }
  results[src] = rows;
}

// ── 4. 報表 ──────────────────────────────────────────────────────
const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';
function topN(rows, key, n) {
  return [...rows].sort((a, b) => b[key] - a[key]).slice(0, n);
}
function printRow(r) {
  console.log(
    `  β${r.targetBeta.toFixed(1)}  tier2−${pct(r.tier2Dd, 0)} tier3−${pct(r.tier3Dd, 0)} βmid${r.betaMid.toFixed(2)}` +
    `  年化${pct(r.cagr).padStart(8)}  MDD${pct(r.mdd, 1).padStart(8)}  最差1年${pct(r.worst1y, 1).padStart(8)}` +
    `  Calmar${r.calmar.toFixed(2).padStart(6)}  倍數${(r.final / BASE.capital0).toFixed(1)}x  觸發${r.crashEvents.length}次`
  );
}

for (const [src, rows] of Object.entries(results)) {
  console.log(`\n████ 訊號來源＝${src === 'taiex' ? 'TAIEX（現行上線）' : src === 'mkt50' ? '0050（舊制，已知漏掉2025關稅崩盤）' : '00631L 自身（本次提案）'} ████`);
  console.log('── 年化報酬最高 top5 ──');
  topN(rows, 'cagr', 5).forEach(printRow);
  console.log('── 風險調整後（Calmar＝年化/最大回撤）最高 top5 ──');
  topN(rows, 'calmar', 5).forEach(printRow);
}

// ── 5. 現行上線設定 vs 本次最佳提案 直接對照 ─────────────────────
console.log('\n████ 對照：現行上線設定（TAIEX, β1.3, tier2−15% tier3−20% βmid1.75）████');
const current = simulate(bars, Object.assign({}, BASE, { ddSource: 'taiex', targetBeta: 1.3, tier2Dd: 0.15, tier3Dd: 0.20, betaMid: 1.75 }));
printRow({ targetBeta: 1.3, tier2Dd: 0.15, tier3Dd: 0.20, betaMid: 1.75, ...current });
console.log('  觸發事件：' + current.crashEvents.map((e) => `${e.enter}~${e.exit ?? '(仍在崩盤)'} 最深${pct(e.maxDd, 1)}${e.tier3 ? '(有到tier3)' : '(僅tier2)'}`).join('；'));

// ── 5b. 固定 target_beta，三種訊號來源互比（隔離「訊號來源」這個變因，不被 target_beta 干擾）──
console.log('\n████ 固定 target_beta，只比訊號來源（同一 β 下誰的 tier 設計比較好）████');
for (const tb of [1.0, 1.3, 1.5, 1.75, 2.0]) {
  console.log(`\n── target_beta = ${tb.toFixed(1)} ──`);
  for (const [src, rows] of Object.entries(results)) {
    const sameBeta = rows.filter((r) => Math.abs(r.targetBeta - tb) < 1e-6);
    if (sameBeta.length === 0) continue;
    const best = topN(sameBeta, 'calmar', 1)[0];
    const label = src === 'taiex' ? 'TAIEX ' : src === 'mkt50' ? '0050  ' : '00631L';
    console.log(`  ${label}  ` + `tier2−${pct(best.tier2Dd, 0).padStart(4)} tier3−${pct(best.tier3Dd, 0).padStart(4)} βmid${best.betaMid.toFixed(2)}` +
      `  年化${pct(best.cagr).padStart(8)}  MDD${pct(best.mdd, 1).padStart(8)}  最差1年${pct(best.worst1y, 1).padStart(8)}  Calmar${best.calmar.toFixed(2).padStart(6)}  觸發${best.crashEvents.length}次`);
  }
}

console.log('\n████ 對照：全倉00631L 買了不動（β恆≈2.0，上限）████');
const holdAll = simulate(bars, Object.assign({}, BASE, { ddSource: 'taiex', targetBeta: 2.0, tier2Dd: 999, tier3Dd: 999, betaMid: 2.0, band: 999 }));
printRow({ targetBeta: 2.0, tier2Dd: 999, tier3Dd: 999, betaMid: 2.0, ...holdAll });

// ── 6. 實證：TAIEX 跌到 −10%/−15%/−20% 那天，00631L 同步自己的回撤是多少？──
console.log('\n████ 實證：TAIEX 觸及各回撤門檻當天，00631L 自身回撤同步是多少 ████');
let peakT = bars[0].taiex, peakE = bars[0].etf;
const milestones = [0.10, 0.15, 0.20, 0.25, 0.30];
let hit = new Set();
console.log('日期         TAIEX回撤    00631L同步回撤   倍數');
for (const bar of bars) {
  peakT = Math.max(peakT, bar.taiex);
  peakE = Math.max(peakE, bar.etf);
  const ddT = 1 - bar.taiex / peakT;
  const ddE = 1 - bar.etf / peakE;
  for (const m of milestones) {
    const key = m + '@' + bar.date.slice(0, 7); // 同一個月同門檻只記一次，避免同一次股災洗版
    if (ddT >= m && !hit.has(m + '_active')) {
      console.log(`${bar.date}   −${pct(m, 0).padStart(4)}      −${pct(ddE, 1).padStart(6)}        ${(ddE / m).toFixed(2)}x`);
      hit.add(m + '_active');
    }
  }
  if (ddT < 0.02) hit = new Set(); // 回到接近新高，重置里程碑追蹤，準備抓下一次崩盤
}

// ── 7. 穩健性複查：26 年合成序列（含 2000 網科 −67%、2008 海嘯 −59%，真實00631L資料沒有這兩段）──
// 只用來確認「TAIEX/大盤觸發 ≥ 00631L自身觸發」這個結論不是 2015-2026 這段歷史路徑獨有的巧合。
console.log('\n████ 穩健性複查：合成序列 2000-01 ~ 2026-08（26.6年，多兩段真實00631L資料沒有的大崩盤）████');
const MODEL = buildModelled(0.03); // { date, etfRet, px }[]；px＝市場代理(0050/TAIEX proxy)，etfRet＝合成正二日報酬
{
  let ownIdx = 100;
  const synthBars = MODEL.map((r, i) => {
    if (i > 0) ownIdx *= (1 + r.etfRet);
    return { date: r.date, etf: ownIdx, taiex: r.px, mkt50: r.px };
  });
  const synthResults = {};
  for (const src of ['taiex', 'own']) {
    const cfg = SOURCES[src];
    const rows = [];
    for (const targetBeta of [1.0, 1.3, 1.5, 2.0]) {
      for (const tier3Dd of cfg.tier3) {
        for (const gap of cfg.gaps) {
          const tier2Dd = +(tier3Dd - gap).toFixed(4);
          if (tier2Dd <= 0.02) continue;
          for (const frac of MID_FRACS) {
            const betaMid = clamp(targetBeta + (BASE.etfBeta - targetBeta) * frac, targetBeta, BASE.etfBeta);
            const r = simulate(synthBars, Object.assign({}, BASE, { ddSource: src, targetBeta, tier2Dd, tier3Dd, betaMid }));
            rows.push({ targetBeta, tier2Dd, tier3Dd, betaMid, ...r });
          }
        }
      }
    }
    synthResults[src] = rows;
  }
  for (const tb of [1.0, 1.3, 1.5, 2.0]) {
    console.log(`\n── 合成序列 target_beta = ${tb.toFixed(1)}（風險調整後最佳） ──`);
    for (const src of ['taiex', 'own']) {
      const sameBeta = synthResults[src].filter((r) => Math.abs(r.targetBeta - tb) < 1e-6);
      const best = topN(sameBeta, 'calmar', 1)[0];
      const label = src === 'taiex' ? '大盤代理' : '00631L  ';
      console.log(`  ${label}  tier2−${pct(best.tier2Dd, 0).padStart(4)} tier3−${pct(best.tier3Dd, 0).padStart(4)} βmid${best.betaMid.toFixed(2)}` +
        `  年化${pct(best.cagr).padStart(8)}  MDD${pct(best.mdd, 1).padStart(8)}  最差1年${pct(best.worst1y, 1).padStart(8)}  Calmar${best.calmar.toFixed(2).padStart(6)}  觸發${best.crashEvents.length}次`);
    }
  }
}
