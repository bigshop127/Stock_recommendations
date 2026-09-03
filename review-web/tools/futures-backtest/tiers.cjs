// tiers.cjs — 把 owndd.cjs 已經確認「TAIEX 觸發優於00631L自身觸發」這件事往下延伸一步：
// 現行只有兩個作用中的門檻（tier2/tier3），細分成四階（−15/−20/−25/−28%）、每階各自
// 調不同幅度的β，回測起來到底有沒有比較好？沿用同一份真實00631L資料與同一套引擎精神
// （見 owndd.cjs 開頭註解），這裡把狀態機從「3態」推廣成「N態」，每一階都是各自的
// β 目標；只有最深那一階（真正的「股災來臨」）維持「創新高才退出」的舊紀律——中間各階
// 隨回撤深淺自由升降，不強制等到新高（這幾階本來就只是警戒，不是真崩盤）。
const { loadYahoo } = require('./etf.cjs');
const REAL_FROM = '2015-01-05';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';

const L = loadYahoo('y631L.json').filter((r) => r.date >= REAL_FROM);
const T = loadYahoo('ytwii.json');
const tMap = new Map(T.map((r) => [r.date, r.adj]));
const bars = [];
for (const r of L) {
  const taiex = tMap.get(r.date);
  if (taiex == null) continue;
  bars.push({ date: r.date, etf: r.adj, taiex });
}
console.log(`對齊後 ${bars.length} 筆交易日：${bars[0].date} ~ ${bars[bars.length - 1].date}（TAIEX 觸發，已由 owndd.cjs 驗證優於00631L自身觸發）`);

// ── N 階狀態機：tiers＝依 dd 升冪排序的 [{dd, beta}]，最後一階＝「股災來臨」（創新高才退出）──
function simulateTiers(p) {
  const tiers = p.tiers;
  const crashIdx = tiers.length - 1;
  const targetWeight = clamp(p.targetBeta / p.etfBeta, 0, 1);
  const upper = p.targetBeta + p.band, lower = Math.max(p.targetBeta - p.band, 0);
  const costRate = p.costBps / 10000;

  let etfUnits = (targetWeight * p.capital0) / bars[0].etf;
  let cash = (1 - targetWeight) * p.capital0;
  let peakDd = bars[0].taiex;
  let curTier = -1; // -1＝正常
  let inCrash = false;
  let curCrash = null;
  const crashEvents = [];
  const eq = [];
  let trades = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.taiex > peakDd) peakDd = bar.taiex;
    const dd = peakDd > 0 ? (peakDd - bar.taiex) / peakDd : 0;
    const etfValue = etfUnits * bar.etf;
    const total = etfValue + cash;
    const curBeta = total > 0 ? (etfValue / total) * p.etfBeta : 0;

    if (i > 0 && total > 0) {
      const tradeTo = (desiredValue) => {
        const traded = desiredValue - etfValue;
        const cost = Math.abs(traded) * costRate;
        etfUnits = desiredValue / bar.etf;
        cash = cash - traded - cost;
        trades++;
      };
      if (inCrash) {
        if (dd <= 1e-9) {
          tradeTo(targetWeight * total);
          inCrash = false; curTier = -1;
          if (curCrash) { curCrash.exit = bar.date; crashEvents.push(curCrash); curCrash = null; }
        } else if (curCrash && dd > curCrash.maxDd) curCrash.maxDd = dd;
      } else {
        let natural = -1;
        for (let j = 0; j < tiers.length; j++) { if (dd >= tiers[j].dd) natural = j; else break; }
        if (natural === crashIdx) {
          tradeTo(1.0 * total);
          inCrash = true; curTier = crashIdx;
          curCrash = curCrash ? curCrash : { enter: bar.date, exit: null, maxDd: dd };
          if (dd > curCrash.maxDd) curCrash.maxDd = dd;
        } else if (natural !== curTier) {
          const desiredBeta = natural === -1 ? p.targetBeta : tiers[natural].beta;
          tradeTo((desiredBeta / p.etfBeta) * total);
          if (natural !== -1 && curTier === -1) curCrash = { enter: bar.date, exit: null, maxDd: dd };
          if (natural === -1 && curCrash) { curCrash.exit = bar.date; crashEvents.push(curCrash); curCrash = null; }
          if (curCrash && dd > curCrash.maxDd) curCrash.maxDd = dd;
          curTier = natural;
        } else if (curTier === -1 && (curBeta > upper || curBeta < lower)) {
          tradeTo(targetWeight * total);
        }
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
  return { cagr, mdd, worst1y, calmar: mdd < 0 ? cagr / -mdd : Infinity, final: eq[n - 1].value, trades, crashEvents };
}

const BASE = { etfBeta: 2.0, band: 0.10, costBps: 20, capital0: 1e8 };
function printRow(label, tiers, r) {
  const tierStr = tiers.map((t) => `−${pct(t.dd, 0)}→β${t.beta.toFixed(2)}`).join(' ');
  console.log(`  ${label.padEnd(10)} ${tierStr.padEnd(46)} 年化${pct(r.cagr).padStart(8)}  MDD${pct(r.mdd, 1).padStart(8)}  最差1年${pct(r.worst1y, 1).padStart(8)}  Calmar${r.calmar.toFixed(2).padStart(6)}  交易${String(r.trades).padStart(3)}次  股災事件${r.crashEvents.length}次`);
}

// ── Test A：使用者指定的四階固定門檻 −15/−20/−25/−28%，網格搜尋每階的β幅度 ──
for (const targetBeta of [1.0, 1.3]) {
  console.log(`\n████ Test A：四階固定門檻 −15/−20/−25/−28%，網格搜尋各階β（target_beta=${targetBeta}） ████`);
  const fracs = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
  let rows = [];
  for (const f1 of fracs) for (const f2 of fracs) for (const f3 of fracs) {
    if (!(f1 < f2 && f2 < f3)) continue;
    const b1 = targetBeta + (2.0 - targetBeta) * f1;
    const b2 = targetBeta + (2.0 - targetBeta) * f2;
    const b3 = targetBeta + (2.0 - targetBeta) * f3;
    const tiers = [{ dd: 0.15, beta: b1 }, { dd: 0.20, beta: b2 }, { dd: 0.25, beta: b3 }, { dd: 0.28, beta: 2.0 }];
    const r = simulateTiers(Object.assign({}, BASE, { targetBeta, tiers }));
    rows.push({ tiers, r });
  }
  rows.sort((a, b) => b.r.calmar - a.r.calmar);
  console.log('── Calmar 最佳 top3 ──');
  rows.slice(0, 3).forEach((x, i) => printRow(`#${i + 1}`, x.tiers, x.r));
  const byCagr = [...rows].sort((a, b) => b.r.cagr - a.r.cagr)[0];
  console.log('── CAGR 最佳 ──');
  printRow('best', byCagr.tiers, byCagr.r);

  // 對照組：同一 target_beta 下的 2 階版本（現行上線 −15/−20 與 owndd.cjs 找到的最佳 −25/−28）
  console.log('── 對照：同 target_beta 的 2 階版本 ──');
  const cur2 = simulateTiers(Object.assign({}, BASE, { targetBeta, tiers: [{ dd: 0.15, beta: 1.75 }, { dd: 0.20, beta: 2.0 }] }));
  printRow('現行2階', [{ dd: 0.15, beta: 1.75 }, { dd: 0.20, beta: 2.0 }], cur2);
  const best2beta = targetBeta + (2.0 - targetBeta) * 0.5;
  const opt2 = simulateTiers(Object.assign({}, BASE, { targetBeta, tiers: [{ dd: 0.25, beta: best2beta }, { dd: 0.28, beta: 2.0 }] }));
  printRow('優化2階', [{ dd: 0.25, beta: best2beta }, { dd: 0.28, beta: 2.0 }], opt2);
}

// ── Test B：控制起訖點相同（10%起、crash門檻相同），比較「2階」vs「4階」誰的風險調整後報酬好 ──
// 4階＝在10%~crash之間均勻插入兩個中繼門檻，β也用同一組 frac 網格找最佳單調遞增組合。
console.log('\n████ Test B：起訖點固定，只比「切幾階」本身有沒有價值（target_beta=1.3） ████');
{
  const targetBeta = 1.3;
  for (const crashDd of [0.20, 0.28]) {
    console.log(`\n── crash門檻＝−${pct(crashDd, 0)}（其餘門檻在 10%~crash 之間均勻分配） ──`);
    // 2 階：中繼門檻 = crash 門檻的中點
    const mid2Dd = 0.10 + (crashDd - 0.10) * 0.5;
    let best2 = null;
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const b = targetBeta + (2.0 - targetBeta) * f;
      const tiers = [{ dd: mid2Dd, beta: b }, { dd: crashDd, beta: 2.0 }];
      const r = simulateTiers(Object.assign({}, BASE, { targetBeta, tiers }));
      if (!best2 || r.calmar > best2.r.calmar) best2 = { tiers, r };
    }
    printRow('2階最佳', best2.tiers, best2.r);

    // 4 階：10%~crash 均勻切 4 段的 3 個中繼門檻
    const d1 = 0.10 + (crashDd - 0.10) * 0.25;
    const d2 = 0.10 + (crashDd - 0.10) * 0.50;
    const d3 = 0.10 + (crashDd - 0.10) * 0.75;
    let best4 = null;
    const fracs = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    for (const f1 of fracs) for (const f2 of fracs) for (const f3 of fracs) {
      if (!(f1 < f2 && f2 < f3)) continue;
      const tiers = [
        { dd: d1, beta: targetBeta + (2.0 - targetBeta) * f1 },
        { dd: d2, beta: targetBeta + (2.0 - targetBeta) * f2 },
        { dd: d3, beta: targetBeta + (2.0 - targetBeta) * f3 },
        { dd: crashDd, beta: 2.0 },
      ];
      const r = simulateTiers(Object.assign({}, BASE, { targetBeta, tiers }));
      if (!best4 || r.calmar > best4.r.calmar) best4 = { tiers, r };
    }
    printRow('4階最佳', best4.tiers, best4.r);
  }
}
