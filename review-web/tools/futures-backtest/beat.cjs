// beat.cjs — 「要贏過正二的回測報酬，期貨要開幾倍」的三張核心表
const { simulate, SERIES } = require('./engine.cjs');
const { simulateETF, buildReal, buildModelled } = require('./etf.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';

const REAL = buildReal();
const F_REAL = SERIES.findIndex((r) => r.date >= REAL[0].date);
const YRS = (new Date(REAL[REAL.length - 1].date) - new Date(REAL[0].date)) / 31557600000;
const FUT = { dipAdd: 0, trimStep: 0, rollsPerYear: 4, bandAbs: 0.1, idleRate: 1, startIdx: F_REAL };
const fut = (L, x) => simulate(Object.assign({ L0: L }, FUT, x || {}));

// 二分找出「期貨要開幾倍才追平某個年化」
function solveL(targetCagr, extra) {
  let lo = 0.5, hi = 4.0;
  for (let k = 0; k < 34; k++) { const m = (lo + hi) / 2; const r = fut(m, extra); if (r && r.cagr < targetCagr) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

console.log('════ 區間 ' + REAL[0].date + ' ~ ' + REAL[REAL.length - 1].date + '（' + YRS.toFixed(1) + ' 年，真實 00631L 價格）════');
console.log('口徑：兩邊同一條 0050 路徑、同樣 ±0.1 曝險帶再平衡、期貨季轉倉並讓超額保證金生息\n');

console.log('=== 1. 同樣的名目曝險，兩種工具各拿到多少？（都不做崩盤加碼）===');
console.log('曝險      正二＋現金   期貨      差       期貨成本/年   正二內含拖累');
for (const e of [1.0, 1.2, 1.3, 1.4, 1.5, 1.75, 2.0]) {
  const a = simulateETF({ rows: REAL, targetBeta: e, crash: false });
  const b = fut(e);
  console.log((e.toFixed(2) + 'x').padEnd(10) + pct(a.cagr).padStart(9) + pct(b.cagr).padStart(10)
    + (pct(b.cagr - a.cagr)).padStart(9) + pct(b.costPctPerYr).padStart(12)
    + pct(a.totalCost / a.avgCap / a.years + 0.023 * Math.min(1, e / 2)).padStart(14));
}

console.log('\n=== 2. 要追平「之前的回測」，期貨要開幾倍 ===');
const goals = [
  ['正二 β1.3＋崩盤加碼（網站現行策略）', simulateETF({ rows: REAL, targetBeta: 1.3 })],
  ['正二 β1.3 純再平衡（不做崩盤加碼）', simulateETF({ rows: REAL, targetBeta: 1.3, crash: false })],
  ['正二 β1.5＋崩盤加碼', simulateETF({ rows: REAL, targetBeta: 1.5 })],
  ['全倉正二 buy & hold（β2.0）', simulateETF({ rows: REAL, targetBeta: 2.0, crash: false, band: 999 })],
];
console.log('對照組'.padEnd(34) + '年化      期貨純槓桿要開   期貨＋同樣崩盤加碼要開');
for (const [name, g] of goals) {
  const plain = solveL(g.cagr);
  const withCrash = solveL(g.cagr, { dipStep: 0.28, dipAdd: 0.7, dipLevels: 1, holdUntilAth: true });
  console.log(name.padEnd(32) + pct(g.cagr).padStart(8) + (plain.toFixed(2) + 'x').padStart(15) + (withCrash.toFixed(2) + 'x').padStart(20));
}

console.log('\n=== 3. 這些槓桿在 2000–2026（含網科泡沫、金融海嘯）會發生什麼事 ===');
const MODEL = buildModelled(0.03);
console.log('策略'.padEnd(32) + '年化   最大回撤   最差1年   斷頭  追繳  被迫砍倉');
for (const L of [1.0, 1.3, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0]) {
  const r = simulate({ startIdx: 0, L0: L, dipAdd: 0, trimStep: 0, rollsPerYear: 4, bandAbs: 0.1, idleRate: 1 });
  console.log(('期貨 ' + L.toFixed(2) + 'x（維持槓桿）').padEnd(30) + pct(r.cagr).padStart(8) + pct(r.mdd, 1).padStart(9)
    + pct(r.worst1y, 1).padStart(9) + String(r.liquidations).padStart(6) + String(r.marginCalls).padStart(6) + String(r.forcedCuts).padStart(8));
}
for (const b of [1.0, 1.3, 1.5, 2.0]) {
  const r = simulateETF({ rows: MODEL, targetBeta: b, crash: false });
  console.log(('正二 β' + b.toFixed(2) + '（不可能斷頭）').padEnd(30) + pct(r.cagr).padStart(8) + pct(r.mdd, 1).padStart(9) + pct(r.worst1y, 1).padStart(9) + '     0     0       0');
}
