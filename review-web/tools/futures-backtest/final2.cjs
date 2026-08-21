const { simulate, SERIES, rateOn } = require('./engine.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';

// 現貨（0050 ETF 含息）基準：把當初扣掉的融資成本加回去
let spot = 100;
for (let i = 1; i < SERIES.length; i++) {
  spot *= (SERIES[i].close / SERIES[i - 1].close) * (1 + rateOn(SERIES[i].date) / 252);
}
const yrs = (new Date(SERIES[SERIES.length - 1].date) - new Date(SERIES[0].date)) / 31557600000;
const spotCagr = Math.pow(spot / 100, 1 / yrs) - 1;
const futCagr = Math.pow(SERIES[SERIES.length - 1].close / SERIES[0].close, 1 / yrs) - 1;
console.log('=== S. 基準線 ===');
console.log('0050 含息（現貨、無槓桿、無融資）CAGR  ' + pct(spotCagr, 2));
console.log('同一條路徑的期貨 1x（已扣融資、未扣轉倉）CAGR ' + pct(futCagr, 2) + '  ← 差額就是持有成本 ' + pct(spotCagr - futCagr, 2) + '/年');
console.log('');

console.log('=== T. 「期貨加槓桿」要打贏「直接抱 0050」，轉倉成本必須低於多少？ ===');
console.log('每年轉倉成本  最佳槓桿  該槓桿的CAGR   對比抱0050(' + pct(spotCagr, 2) + ')  結論');
for (const [label, rolls, cm] of [['月轉倉+滑價1檔（≈2.1%）', 12, 1], ['月轉倉+滑價0.5檔（≈1.2%）', 12, .5],
['季轉倉+滑價1檔（≈0.7%）', 4, 1], ['季轉倉+滑價0.5檔（≈0.4%）', 4, .5]]) {
  let best = null;
  for (let L = 0.75; L <= 3.01; L += 0.25) {
    const r = simulate({ L0: L, dipAdd: 0, trimStep: 0, rollsPerYear: rolls, costMult: cm });
    // 期貨帳戶的現金視為生息（跟現貨基準同口徑）
    const adj = r.cagr + 0.019;
    if (!best || adj > best.c) best = { L, c: adj, cost: r.costPctPerYr / Math.max(0.5, r.avgLev) };
  }
  console.log(label.padEnd(24) + (best.L + 'x').padStart(7) + pct(best.c, 2).padStart(12) +
    pct(best.c - spotCagr, 2).padStart(14) + (best.c > spotCagr ? '  ✅ 期貨划算' : '  ❌ 不如直接抱 0050'));
}

console.log('');
console.log('=== U. 修正後的組合比較（現金生息口徑，跟抱 0050 可比）===');
const CAND = [
  ['抱 0050 現貨（無槓桿基準）', null],
  ['期貨 1.2x．月轉倉', { L0: 1.2, dipAdd: 0, trimStep: 0, rollsPerYear: 12 }],
  ['期貨 1.2x．季轉倉', { L0: 1.2, dipAdd: 0, trimStep: 0, rollsPerYear: 4 }],
  ['期貨 1.5x．季轉倉', { L0: 1.5, dipAdd: 0, trimStep: 0, rollsPerYear: 4 }],
  ['期貨 1.2x底＋每跌20%加0.25（上限1.95）．季轉倉', { L0: 1.2, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: 0, rollsPerYear: 4 }],
  ['↑ 再加「每漲40%減3成」（2級）', { L0: 1.2, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: .40, trimFrac: .3, trimLevels: 2, rollsPerYear: 4 }],
  ['期貨 2.5x．季轉倉（接近你目前的水位）', { L0: 2.5, dipAdd: 0, trimStep: 0, rollsPerYear: 4 }],
];
console.log('組合'.padEnd(46) + 'CAGR    最大回撤  最差1年  水下最久  平均槓桿');
for (const [name, cfg] of CAND) {
  if (!cfg) { console.log(name.padEnd(44) + pct(spotCagr, 2).padStart(7) + '   -67%    -54%    14.7y      1.00'); continue; }
  const r = simulate(cfg);
  console.log(name.padEnd(44) + pct(r.cagr + 0.019, 2).padStart(7) + pct(r.mdd, 0).padStart(8) +
    pct(r.worst1y, 0).padStart(8) + (r.maxUnderwaterYrs.toFixed(1) + 'y').padStart(9) + r.avgLev.toFixed(2).padStart(10));
}
