// boot.js — 區塊自助抽樣（block bootstrap）：檢驗結論是不是只在 2000–2026 這一條路徑上成立
const { simulate, SERIES } = require('./engine.cjs');
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';

// 把歷史序列轉成「日報酬 + 當日最低/最高相對前收」的三元組
const R = [];
for (let i = 1; i < SERIES.length; i++) {
  const p = SERIES[i - 1].close, c = SERIES[i];
  R.push([c.close / p - 1, Math.min(c.low, c.close) / p - 1, Math.max(c.high, c.close) / p - 1]);
}

// 固定日期軸（20 年），bootstrap 路徑共用；inAcct=1 所以引擎不會用到利率
const YEARS = 20, N = 252 * YEARS, BLOCK = 40;
const DATES = [];
{
  const d = new Date('2000-01-03T00:00:00Z');
  for (let i = 0; i < N + 1; i++) { DATES.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + Math.round(365.25 / 252 * 100) / 100 >= 1 ? 1 : 1); }
}
// 用等距日曆日鋪滿 20 年，讓 CAGR 的年數換算正確
for (let i = 0; i < DATES.length; i++) {
  const t = new Date('2000-01-03T00:00:00Z').getTime() + i * (YEARS * 365.25 * 86400000) / N;
  DATES[i] = new Date(t).toISOString().slice(0, 10);
}

let seed = 20260821;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function makePath() {
  const rows = [{ date: DATES[0], close: 100, low: 100, high: 100 }];
  let px = 100, k = 0;
  while (k < N) {
    let s = Math.floor(rnd() * (R.length - BLOCK));
    for (let j = 0; j < BLOCK && k < N; j++, k++) {
      const [ret, lo, hi] = R[s + j];
      const prev = px; px = prev * (1 + ret);
      rows.push({ date: DATES[k + 1], close: px, low: prev * (1 + lo), high: prev * (1 + hi) });
    }
  }
  return rows;
}

const PATHS = [];
const NP = Number(process.argv[2] || 400);
for (let i = 0; i < NP; i++) PATHS.push(makePath());
{
  const cagrs = PATHS.map(p => Math.pow(p[p.length - 1].close / 100, 1 / YEARS) - 1).sort((a, b) => a - b);
  console.log('bootstrap 路徑 ' + NP + ' 條、每條 ' + YEARS + ' 年、區塊 ' + BLOCK + ' 日');
  console.log('底層(1倍)CAGR 分佈：5% ' + pct(cagrs[Math.floor(NP * .05)], 1) + '  中位 ' + pct(cagrs[Math.floor(NP * .5)], 1) + '  95% ' + pct(cagrs[Math.floor(NP * .95)], 1));
}

function evalCfg(cfg) {
  const cagrs = [], mdds = []; let ruin = 0, liq = 0;
  for (const path of PATHS) {
    const r = simulate(Object.assign({}, cfg, { series: path }));
    cagrs.push(r.cagr); mdds.push(r.mdd); if (r.ruined) ruin++; liq += r.liquidations;
  }
  cagrs.sort((a, b) => a - b); mdds.sort((a, b) => a - b);
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  return {
    med: q(cagrs, .5), p05: q(cagrs, .05), p25: q(cagrs, .25), p95: q(cagrs, .95),
    mddMed: q(mdds, .5), mddP05: q(mdds, .05),
    pRuin: ruin / PATHS.length, pLiq: liq / PATHS.length,
    pNeg: cagrs.filter(c => c < 0).length / cagrs.length,
    pBad: mdds.filter(m => m < -0.5).length / mdds.length,
    // 期末財富的中位數倍數，直觀一點
    medMult: Math.pow(1 + q(cagrs, .5), YEARS),
  };
}

console.log('');
console.log('=== K. 純固定槓桿（bootstrap，' + YEARS + ' 年）===');
console.log('L0    中位CAGR  5%分位  95%分位  賠錢機率  回撤中位  回撤5%  超過-50%機率  斷頭機率  20年中位倍數');
for (const L0 of [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]) {
  const s = evalCfg({ L0, dipAdd: 0, trimStep: 0 });
  console.log(String(L0).padEnd(6) + pct(s.med, 2).padStart(8) + pct(s.p05, 1).padStart(9) + pct(s.p95, 1).padStart(9) +
    pct(s.pNeg, 0).padStart(9) + pct(s.mddMed, 0).padStart(9) + pct(s.mddP05, 0).padStart(8) +
    pct(s.pBad, 0).padStart(13) + pct(s.pRuin, 1).padStart(10) + s.medMult.toFixed(2).padStart(13));
}
