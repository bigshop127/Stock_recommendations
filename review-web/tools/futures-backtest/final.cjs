const { simulate, SERIES } = require('./engine.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';
const P = 104.65, UNIT = 1000, IM = 7900, MM = 6100, LIQ = 0.25;

console.log('=== O. 槓桿 ↔ 風險指標 ↔ 撐得住的跌幅（現價 ' + P + '，原始 ' + IM + '／維持 ' + MM + '，口數固定不減碼）===');
console.log('槓桿  100萬本金口數  名目曝險   佔用保證金  風險指標   追繳跌幅  追繳價   斷頭跌幅  斷頭價');
for (const L of [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0]) {
  const cap = 1000000;
  const lots = (cap * L) / (P * UNIT);
  const notional = lots * P * UNIT;
  const im = lots * IM;
  const risk = cap / im;
  const dCall = (1 - (MM / (P * UNIT)) * L) / L;
  const dLiq = (1 - LIQ * (IM / (P * UNIT)) * L) / L;
  console.log(
    (L + 'x').padEnd(6) + lots.toFixed(1).padStart(10) + '口' +
    (notional / 10000).toFixed(1).padStart(10) + '萬' +
    (im / 10000).toFixed(1).padStart(10) + '萬' +
    pct(risk, 0).padStart(10) +
    pct(-dCall, 1).padStart(10) + (P * (1 - dCall)).toFixed(1).padStart(8) +
    pct(-dLiq, 1).padStart(10) + (P * (1 - dLiq)).toFixed(1).padStart(8));
}

console.log('');
console.log('=== P. 歷史上真的發生過的跌幅（合成 SRF 序列）→ 哪些槓桿會被追繳／斷頭 ===');
const CRASH = [['2000-02 網科泡沫', '2000-02-18', '2001-10-03'], ['2008 金融海嘯', '2007-10-29', '2008-11-20'],
['2011 歐債', '2011-02-08', '2011-12-19'], ['2015 中國股災', '2015-04-28', '2015-08-24'],
['2020 COVID', '2020-01-15', '2020-03-19'], ['2022 升息', '2022-01-18', '2022-10-25'],
['2024-08 日圓套利平倉', '2024-07-12', '2024-08-05'], ['2025-04 關稅', '2025-01-08', '2025-04-09']];
const at = (d) => { const r = SERIES.find(x => x.date >= d); return r ? r.close : null; };
console.log('事件'.padEnd(24) + '跌幅   1x跌完剩  被追繳的最低槓桿  被斷頭的最低槓桿');
for (const [name, a, b] of CRASH) {
  const pa = at(a), pb = at(b), d = pb / pa - 1;
  const lCall = 1 / (-d + MM / (P * UNIT));
  const lLiq = 1 / (-d + LIQ * IM / (P * UNIT));
  console.log(name.padEnd(22) + pct(d, 1).padStart(7) + pct(1 + d, 0).padStart(10) +
    (lCall > 20 ? '  >20x（撐得住）' : ('  ' + lCall.toFixed(2) + 'x')).padStart(18) +
    (lLiq > 20 ? '  >20x' : ('  ' + lLiq.toFixed(2) + 'x')).padStart(18));
}

console.log('');
console.log('=== Q. 建議組合 vs 常見做法（歷史路徑 2000-2026 全期）===');
const CAND = [
  ['① 完全不用期貨（1x 現貨等價）', { L0: 1.0, dipAdd: 0, trimStep: 0, rollsPerYear: 0, costMult: 0 }],
  ['② 固定 1.2x，不加碼不減碼', { L0: 1.2, dipAdd: 0, trimStep: 0 }],
  ['③【建議】1.2x 底倉＋每跌20%加0.25（上限1.95）', { L0: 1.2, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
  ['④【建議+獲利減碼】③再加每漲40%減3成(2級)', { L0: 1.2, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: .40, trimFrac: .3, trimLevels: 2 }],
  ['⑤ 常見做法：固定 2.5x 不動', { L0: 2.5, dipAdd: 0, trimStep: 0 }],
  ['⑥ 危險做法：2.5x 買了放著不再平衡', { L0: 2.5, dipAdd: 0, trimStep: 0, rebalance: false }],
  ['⑦ 危險做法：1.5x 但每跌10%加0.5（上限3x）', { L0: 1.5, dipStep: .10, dipAdd: .5, dipLevels: 3, trimStep: 0 }],
];
console.log('組合'.padEnd(46) + 'CAGR   最大回撤 最差1年 水下最久 平均槓桿 成本/年 斷頭 追繳  末值(萬)');
for (const [name, cfg] of CAND) {
  const r = simulate(cfg);
  console.log(name.padEnd(44) + pct(r.cagr, 2).padStart(7) + pct(r.mdd, 0).padStart(8) + pct(r.worst1y, 0).padStart(7) +
    (r.maxUnderwaterYrs.toFixed(1) + 'y').padStart(8) + r.avgLev.toFixed(2).padStart(8) + pct(r.costPctPerYr, 2).padStart(8) +
    String(r.liquidations).padStart(5) + String(r.marginCalls).padStart(5) + (r.final / 10000).toFixed(0).padStart(10));
}

console.log('');
console.log('=== R. 建議組合在各段行情的表現 ===');
const idxOf = (d) => { const i = SERIES.findIndex(r => r.date >= d); return i < 0 ? SERIES.length - 1 : i; };
const PERIODS = [['2000-01→2003-06 網科泡沫', '2000-01-01', '2003-07-01'], ['2003-07→2007-10 多頭', '2003-07-01', '2007-11-01'],
['2007-11→2009-03 海嘯', '2007-11-01', '2009-04-01'], ['2009-04→2016-12 盤整', '2009-04-01', '2017-01-01'],
['2017-01→2021-12 AI多頭', '2017-01-01', '2022-01-01'], ['2022-01→2022-10 熊市', '2022-01-01', '2022-11-01'],
['2022-11→2026-08 大多頭', '2022-11-01', '2026-09-01']];
console.log('期間'.padEnd(28) + '②固定1.2x   ③建議   ④建議+減碼   ⑤固定2.5x');
for (const [n, a, b] of PERIODS) {
  let line = n.padEnd(26);
  for (const [, cfg] of [CAND[1], CAND[2], CAND[3], CAND[4]]) {
    const r = simulate(Object.assign({}, cfg, { startIdx: idxOf(a), endIdx: idxOf(b) }));
    line += pct(r.final / 1000000 - 1, 0).padStart(11);
  }
  console.log(line);
}
