const { simulate, SERIES } = require('./engine.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';
const idxOf = (d) => { let i = SERIES.findIndex(r => r.date >= d); return i < 0 ? SERIES.length - 1 : i; };

console.log('=== B. 分期表現（固定槓桿、無加碼減碼）===');
const PERIODS = [
  ['網科泡沫+SARS 2000-01→2003-06', '2000-01-01', '2003-07-01'],
  ['多頭 2003-07→2007-10', '2003-07-01', '2007-11-01'],
  ['金融海嘯 2007-11→2009-03', '2007-11-01', '2009-04-01'],
  ['復甦盤整 2009-04→2016-12', '2009-04-01', '2017-01-01'],
  ['AI 大多頭 2017-01→2021-12', '2017-01-01', '2022-01-01'],
  ['升息熊市 2022-01→2022-10', '2022-01-01', '2022-11-01'],
  ['2022-11→2026-08', '2022-11-01', '2026-09-01'],
];
let head = '槓桿 ';
for (const L0 of [1, 1.5, 2, 2.5, 3]) head += ('L=' + L0).padStart(9);
console.log('期間'.padEnd(34) + head.slice(3));
for (const [name, a, b] of PERIODS) {
  let line = name.padEnd(30);
  for (const L0 of [1, 1.5, 2, 2.5, 3]) {
    const r = simulate({ L0, dipAdd: 0, trimStep: 0, startIdx: idxOf(a), endIdx: idxOf(b) });
    const tot = r.final / r.capital0 - 1;
    line += pct(tot, 0).padStart(9);
  }
  console.log(line);
}

console.log('');
console.log('=== C. 滾動 10 年視窗（每 3 個月換一個起點，共看所有起點）===');
console.log('L0    起點數  CAGR中位  CAGR最差  CAGR最佳  賠錢視窗%  MDD中位  MDD最差  歸零次數');
const WIN = 252 * 10;
for (const L0 of [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]) {
  const cagrs = [], mdds = []; let ruin = 0;
  for (let s = 0; s + WIN < SERIES.length; s += 63) {
    const r = simulate({ L0, dipAdd: 0, trimStep: 0, startIdx: s, endIdx: s + WIN });
    cagrs.push(r.cagr); mdds.push(r.mdd); if (r.ruined) ruin++;
  }
  const sc = cagrs.slice().sort((a, b) => a - b), sm = mdds.slice().sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.floor((arr.length - 1) * f)];
  console.log(String(L0).padEnd(6) + String(cagrs.length).padStart(5) +
    pct(q(sc, .5), 1).padStart(10) + pct(sc[0], 1).padStart(10) + pct(sc[sc.length - 1], 1).padStart(10) +
    pct(cagrs.filter(c => c < 0).length / cagrs.length, 0).padStart(11) +
    pct(q(sm, .5), 1).padStart(9) + pct(sm[0], 1).padStart(9) + String(ruin).padStart(9));
}

console.log('');
console.log('=== D. 轉倉／成本敏感度（L0=1.5 固定槓桿，全期）===');
console.log('轉倉次數/年  滑價倍數  成本/年   CAGR    最大回撤');
for (const rolls of [12, 6, 4]) {
  for (const cm of [1.0, 0.5]) {
    const r = simulate({ L0: 1.5, dipAdd: 0, trimStep: 0, rollsPerYear: rolls, costMult: cm });
    console.log(String(rolls).padEnd(13) + String(cm).padEnd(10) + pct(r.costPctPerYr, 2).padStart(7) +
      pct(r.cagr, 2).padStart(9) + pct(r.mdd, 1).padStart(10));
  }
}

console.log('');
console.log('=== E. 再平衡帶寬的影響（L0=1.5）===');
console.log('band   CAGR    最大回撤  成本/年');
for (const band of [0.05, 0.10, 0.20, 0.35, 0.60, 9]) {
  const r = simulate({ L0: 1.5, dipAdd: 0, trimStep: 0, band });
  console.log((band === 9 ? '不平衡' : pct(band, 0)).padEnd(7) + pct(r.cagr, 2).padStart(7) +
    pct(r.mdd, 1).padStart(10) + pct(r.costPctPerYr, 2).padStart(9) +
    '  斷頭' + r.liquidations + ' 追繳' + r.marginCalls);
}
