const { simulate, SERIES } = require('./engine.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';

const R = [];
for (let i = 1; i < SERIES.length; i++) {
  const p = SERIES[i - 1].close, c = SERIES[i];
  R.push([c.close / p - 1, Math.min(c.low, c.close) / p - 1, Math.max(c.high, c.close) / p - 1]);
}
const YEARS = 20, N = 252 * YEARS, BLOCK = 40;
const DATES = [];
for (let i = 0; i < N + 1; i++) {
  DATES.push(new Date(new Date('2000-01-03T00:00:00Z').getTime() + i * (YEARS * 365.25 * 86400000) / N).toISOString().slice(0, 10));
}
let seed = 20260821;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function makePath() {
  const rows = [{ date: DATES[0], close: 100, low: 100, high: 100 }];
  let px = 100, k = 0;
  while (k < N) {
    const s = Math.floor(rnd() * (R.length - BLOCK));
    for (let j = 0; j < BLOCK && k < N; j++, k++) {
      const [ret, lo, hi] = R[s + j]; const prev = px; px = prev * (1 + ret);
      rows.push({ date: DATES[k + 1], close: px, low: prev * (1 + lo), high: prev * (1 + hi) });
    }
  }
  return rows;
}
const NP = Number(process.argv[2] || 400);
const PATHS = []; for (let i = 0; i < NP; i++) PATHS.push(makePath());

function evalCfg(cfg) {
  const cagrs = [], mdds = [], levs = []; let ruin = 0, liq = 0;
  for (const path of PATHS) {
    const r = simulate(Object.assign({}, cfg, { series: path }));
    cagrs.push(r.cagr); mdds.push(r.mdd); levs.push(r.avgLev); if (r.ruined) ruin++; liq += r.liquidations;
  }
  cagrs.sort((a, b) => a - b); mdds.sort((a, b) => a - b);
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  const hist = simulate(cfg);
  return {
    med: q(cagrs, .5), p05: q(cagrs, .05), p25: q(cagrs, .25),
    mddMed: q(mdds, .5), mddP05: q(mdds, .05), pRuin: ruin / NP,
    pNeg: cagrs.filter(c => c < 0).length / cagrs.length,
    avgLev: levs.reduce((a, b) => a + b, 0) / levs.length,
    histCagr: hist.cagr, histMdd: hist.mdd,
  };
}

const CFG = [
  ['固定 1.0x（不加碼不減碼）', { L0: 1.0, dipAdd: 0, trimStep: 0 }],
  ['固定 1.25x', { L0: 1.25, dipAdd: 0, trimStep: 0 }],
  ['固定 1.5x', { L0: 1.5, dipAdd: 0, trimStep: 0 }],
  ['固定 2.0x', { L0: 2.0, dipAdd: 0, trimStep: 0 }],
  ['1.0x +每跌20%加0.25（上限1.75）', { L0: 1.0, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
  ['1.0x +每跌15%加0.25（上限1.75）', { L0: 1.0, dipStep: .15, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
  ['1.0x +每跌10%加0.25（上限1.75）', { L0: 1.0, dipStep: .10, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
  ['1.0x +每跌20%加0.5（上限2.5）', { L0: 1.0, dipStep: .20, dipAdd: .5, dipLevels: 3, trimStep: 0 }],
  ['1.0x +每跌10%加0.5（上限2.5）', { L0: 1.0, dipStep: .10, dipAdd: .5, dipLevels: 3, trimStep: 0 }],
  ['0.8x +每跌20%加0.3（上限1.7）', { L0: 0.8, dipStep: .20, dipAdd: .3, dipLevels: 3, trimStep: 0 }],
  ['1.25x+每跌20%加0.25（上限2.0）', { L0: 1.25, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
  ['1.5x +每跌20%加0.25（上限2.25）', { L0: 1.5, dipStep: .20, dipAdd: .25, dipLevels: 3, trimStep: 0 }],
];
console.log('=== L. 加碼階梯 vs 同等固定槓桿（bootstrap ' + NP + ' 條 × 20 年）===');
console.log('策略'.padEnd(30) + '平均槓桿 中位CAGR  5%分位 賠錢機率 回撤中位 回撤5%  斷頭機率 | 歷史路徑CAGR 歷史MDD');
for (const [name, cfg] of CFG) {
  const s = evalCfg(cfg);
  console.log(name.padEnd(28) + s.avgLev.toFixed(2).padStart(7) + pct(s.med, 2).padStart(9) + pct(s.p05, 1).padStart(8) +
    pct(s.pNeg, 0).padStart(8) + pct(s.mddMed, 0).padStart(8) + pct(s.mddP05, 0).padStart(8) + pct(s.pRuin, 1).padStart(9) +
    ' | ' + pct(s.histCagr, 2).padStart(9) + pct(s.histMdd, 0).padStart(9));
}

console.log('');
console.log('=== M. 獲利減碼階梯（底子＝1.0x + 每跌20%加0.25，上限1.75）===');
const B = { L0: 1.0, dipStep: .20, dipAdd: .25, dipLevels: 3 };
const CFG2 = [
  ['不減碼', { trimStep: 0 }],
  ['每漲20%減2成（最多3級）', { trimStep: .20, trimFrac: .2, trimLevels: 3 }],
  ['每漲25%減2成（最多3級）', { trimStep: .25, trimFrac: .2, trimLevels: 3 }],
  ['每漲25%減3成（最多3級）', { trimStep: .25, trimFrac: .3, trimLevels: 3 }],
  ['每漲30%減2成（最多3級）', { trimStep: .30, trimFrac: .2, trimLevels: 3 }],
  ['每漲30%減3成（最多3級）', { trimStep: .30, trimFrac: .3, trimLevels: 3 }],
  ['每漲40%減3成（最多3級）', { trimStep: .40, trimFrac: .3, trimLevels: 3 }],
  ['每漲50%減3成（最多2級）', { trimStep: .50, trimFrac: .3, trimLevels: 2 }],
  ['每漲25%減5成（最多2級）', { trimStep: .25, trimFrac: .5, trimLevels: 2 }],
];
console.log('減碼規則'.padEnd(28) + '平均槓桿 中位CAGR  5%分位 賠錢機率 回撤中位 回撤5%  斷頭機率 | 歷史路徑CAGR 歷史MDD');
for (const [name, t] of CFG2) {
  const s = evalCfg(Object.assign({}, B, t));
  console.log(name.padEnd(26) + s.avgLev.toFixed(2).padStart(7) + pct(s.med, 2).padStart(9) + pct(s.p05, 1).padStart(8) +
    pct(s.pNeg, 0).padStart(8) + pct(s.mddMed, 0).padStart(8) + pct(s.mddP05, 0).padStart(8) + pct(s.pRuin, 1).padStart(9) +
    ' | ' + pct(s.histCagr, 2).padStart(9) + pct(s.histMdd, 0).padStart(9));
}
