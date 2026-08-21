// plan.cjs — 收斂成幾套「可以照著做」的紀律，三個視角一起看
const { simulate, SERIES, IM_PCT } = require('./engine.cjs');
const { simulateETF, buildReal, buildModelled } = require('./etf.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';
const REAL = buildReal(); const F_REAL = SERIES.findIndex((r) => r.date >= REAL[0].date);
const MODEL = buildModelled(0.03);
const BASE = { trimStep: 0, dipAdd: 0, rollsPerYear: 4, bandAbs: 0.1, idleRate: 1, capital0: 1e8 };

const PLANS = [
  ['P1 保守：1.2x底＋每跌20%加0.25(上限1.95)＋每漲40%減三成', { L0: 1.2, dipStep: .20, dipAdd: .25, dipLevels: 3, Lmax: 1.95, trimStep: .40, trimFrac: .3, trimLevels: 2 }],
  ['P2 平衡：1.3x 維持槓桿，漲了補、跌了砍，不做別的', { L0: 1.3 }],
  ['P3 追平：1.5x 維持槓桿', { L0: 1.5 }],
  ['P4 追平＋抄底：1.5x底，跌28%拉到1.95，創新高才收回', { L0: 1.5, dipStep: .28, dipAdd: .45, dipLevels: 1, Lmax: 1.95, holdUntilAth: true }],
  ['P5 進攻：1.75x底，跌28%拉到1.95，創新高才收回', { L0: 1.75, dipStep: .28, dipAdd: .20, dipLevels: 1, Lmax: 1.95, holdUntilAth: true }],
  ['P6 全開：2.0x 維持槓桿', { L0: 2.0 }],
];

function show(title, startIdx, rows, cmp) {
  console.log('\n████ ' + title + ' ████');
  for (const [n, v] of cmp) console.log('   對照 ' + n.padEnd(26) + pct(v.cagr) + '   回撤 ' + pct(v.mdd, 1));
  console.log('');
  console.log('紀律'.padEnd(54) + '年化    最大回撤   最差1年  平均曝險  斷頭  追繳');
  for (const [name, cfg] of PLANS) {
    const r = simulate(Object.assign({ startIdx }, BASE, cfg));
    const w = cmp.map(([n, v]) => (r.cagr > v.cagr ? ' ✅贏' + n.slice(0, 8) : '')).join('');
    console.log(name.padEnd(52) + pct(r.cagr).padStart(8) + pct(r.mdd, 1).padStart(9) + pct(r.worst1y, 1).padStart(9)
      + r.avgLev.toFixed(2).padStart(9) + String(r.liquidations).padStart(6) + String(r.marginCalls).padStart(6) + w);
  }
}
show('真實 00631L 區間 2015-01 ~ 2026-08（11.6 年）', F_REAL, REAL, [
  ['正二 β1.3＋崩盤加碼', simulateETF({ rows: REAL, targetBeta: 1.3, capital0: 1e8 })],
  ['全倉正二 β2.0', simulateETF({ rows: REAL, targetBeta: 2.0, crash: false, band: 999, capital0: 1e8 })]]);
show('合成區間 2000-01 ~ 2026-08（26.6 年，含 −67% 與 −59% 兩次崩盤）', 0, MODEL, [
  ['正二 β1.3＋崩盤加碼', simulateETF({ rows: MODEL, targetBeta: 1.3, capital0: 1e8 })],
  ['全倉正二 β2.0', simulateETF({ rows: MODEL, targetBeta: 2.0, crash: false, band: 999, capital0: 1e8 })]]);

console.log('\n████ 「崩盤時你完全不動作」的斷頭跌幅（靜態部位，不補錢不減碼）████');
console.log('槓桿    斷頭跌幅    2000網科 −66.6%  2008海嘯 −58.5%  2022熊市 −33.7%  2020疫情 −27.6%');
for (const L of [1.0, 1.2, 1.3, 1.5, 1.75, 1.95, 2.0, 2.5, 2.88]) {
  const d = (1 - 0.25 * IM_PCT * L) / (L - 0.25 * IM_PCT * L);
  const k = (x) => (x > d ? '  ☠️斷頭' : '   撐得住');
  console.log((L.toFixed(2) + 'x').padEnd(8) + ('−' + pct(d, 1)).padStart(9) + k(0.666).padStart(16) + k(0.585).padStart(16) + k(0.337).padStart(16) + k(0.276).padStart(16));
}
