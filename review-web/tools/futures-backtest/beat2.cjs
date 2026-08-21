// beat2.cjs — 上漲怎麼做、下跌怎麼做：把七種操作紀律各自掃一遍平時槓桿
const { simulate, SERIES } = require('./engine.cjs');
const { simulateETF, buildReal, buildModelled } = require('./etf.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';

const REAL = buildReal();
const F_REAL = SERIES.findIndex((r) => r.date >= REAL[0].date);
const MODEL = buildModelled(0.03);
const BASE = { trimStep: 0, dipAdd: 0, rollsPerYear: 4, bandAbs: 0.05, idleRate: 1, capital0: 1e8 };

const PLAYS = [
  ['① 買了就放著（不再平衡）', { rebalance: false }],
  ['② 維持槓桿（漲加碼、跌減碼）', {}],
  ['③ 維持＋崩盤滿倉（跌28%→2.0，創新高收）', { dipStep: 0.28, dipLevels: 1, holdUntilAth: true, CRASH: true }],
  ['④ 維持＋分級逢低加碼（每跌20%+0.25，上限1.95）', { dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, LMAX195: true }],
  ['⑤ ④再加獲利減碼（每漲40%減三成）', { dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, LMAX195: true, trimStep: 0.40, trimFrac: 0.30, trimLevels: 2 }],
  ['⑥ 只加不減（跌了加碼、漲了不減）', { dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, LMAX195: true, noCut: true }],
  ['⑦ 只減不加（漲上去就讓槓桿自己稀釋）', { noAdd: true }],
];

function runOne(L, play, startIdx) {
  const o = Object.assign({ startIdx, L0: L }, BASE, play);
  if (o.CRASH) { o.dipAdd = Math.max(0, 2.0 - L); delete o.CRASH; }
  if (o.LMAX195) { o.Lmax = 1.95; delete o.LMAX195; }
  return simulate(o);
}

function table(title, startIdx, etfRows, cmpLines) {
  console.log('\n████ ' + title + ' ████');
  for (const [n, v] of cmpLines) console.log('  對照線 ' + n.padEnd(30) + pct(v));
  console.log('');
  console.log('操作紀律'.padEnd(42) + '平時槓桿'.padEnd(6) + ' 年化    最大回撤   最差1年  平均曝險  斷頭');
  for (const [name, play] of PLAYS) {
    let first = true;
    for (const L of [1.0, 1.3, 1.5, 1.75, 2.0]) {
      const r = runOne(L, play, startIdx);
      const beats = cmpLines.map(([n, v]) => (r.cagr > v ? ' ✅' + n.slice(0, 6) : '')).join('');
      console.log((first ? name : '').padEnd(40) + (L.toFixed(2) + 'x').padStart(7) + pct(r.cagr).padStart(9)
        + pct(r.mdd, 1).padStart(9) + pct(r.worst1y, 1).padStart(9) + r.avgLev.toFixed(2).padStart(9)
        + String(r.liquidations).padStart(5) + beats);
      first = false;
    }
    console.log('');
  }
}

const e13 = simulateETF({ rows: REAL, targetBeta: 1.3, capital0: 1e8 });
const e20 = simulateETF({ rows: REAL, targetBeta: 2.0, crash: false, band: 999, capital0: 1e8 });
table('真實 00631L 區間 2015-01 ~ 2026-08（11.6 年）', F_REAL, REAL,
  [['正二β1.3＋崩盤加碼', e13.cagr], ['全倉正二', e20.cagr]]);

const m13 = simulateETF({ rows: MODEL, targetBeta: 1.3, capital0: 1e8 });
const m13n = simulateETF({ rows: MODEL, targetBeta: 1.3, crash: false, capital0: 1e8 });
const m20 = simulateETF({ rows: MODEL, targetBeta: 2.0, crash: false, band: 999, capital0: 1e8 });
console.log('\n（合成正二對照：β1.3＋崩盤加碼 ' + pct(m13.cagr) + ' / β1.3 不加碼 ' + pct(m13n.cagr) + ' / 全倉正二 ' + pct(m20.cagr) + '）');
table('合成區間 2000-01 ~ 2026-08（26.6 年，含網科泡沫 −67% 與金融海嘯 −59%）', 0, MODEL,
  [['正二β1.3＋崩盤加碼', m13.cagr], ['全倉正二', m20.cagr]]);
