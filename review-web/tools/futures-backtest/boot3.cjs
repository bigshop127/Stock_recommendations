// boot3.cjs — 區塊自助抽樣：把「正二＋現金」與「期貨」放在同一批隨機路徑上比
// 回答的是「換一段歷史，這個結論還成不成立」，以及期貨獨有的歸零風險有多大。
const { simulate, SERIES, rateOn } = require('./engine.cjs');
const { simulateETF } = require('./etf.cjs');
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
      const [ret, lo, hi] = R[s + j];
      const prev = px; px = prev * (1 + ret);
      rows.push({ date: DATES[k + 1], close: px, low: prev * (1 + lo), high: prev * (1 + hi) });
    }
  }
  return rows;
}
// 同一條路徑轉成正二的日報酬（現貨總報酬 = 期貨超額報酬 + 無風險利率）
function etfRows(path, drag) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const rs = i > 0 ? (path[i].close / path[i - 1].close) * (1 + rateOn(path[i].date) / 252) - 1 : 0;
    out.push({ date: path[i].date, etfRet: i > 0 ? 2 * rs - drag / 252 : 0, px: path[i].close });
  }
  return out;
}

const NP = Number(process.argv[2] || 400);
const PATHS = []; for (let i = 0; i < NP; i++) PATHS.push(makePath());
const ETFP = PATHS.map((p) => etfRows(p, 0.03));

const FUT = { trimStep: 0, dipAdd: 0, rollsPerYear: 4, bandAbs: 0.05, idleRate: 1, capital0: 1e8 };
const CASES = [
  ['正二 β1.30（不可能歸零）', 'etf', { targetBeta: 1.3, crash: false }],
  ['正二 β1.50', 'etf', { targetBeta: 1.5, crash: false }],
  ['正二 β1.30＋崩盤滿倉', 'etf', { targetBeta: 1.3 }],
  ['全倉正二 β2.0', 'etf', { targetBeta: 2.0, crash: false, band: 999 }],
  ['期貨 1.30x 維持槓桿', 'fut', { L0: 1.3 }],
  ['期貨 1.50x 維持槓桿', 'fut', { L0: 1.5 }],
  ['期貨 1.75x 維持槓桿', 'fut', { L0: 1.75 }],
  ['期貨 2.00x 維持槓桿', 'fut', { L0: 2.0 }],
  ['期貨 1.30x＋崩盤滿倉2.0', 'fut', { L0: 1.3, dipStep: 0.28, dipAdd: 0.7, dipLevels: 1, holdUntilAth: true }],
  ['期貨 1.50x＋崩盤滿倉2.0', 'fut', { L0: 1.5, dipStep: 0.28, dipAdd: 0.5, dipLevels: 1, holdUntilAth: true }],
  ['期貨 1.20x＋逢低階梯(上限1.95)', 'fut', { L0: 1.2, dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, Lmax: 1.95 }],
  ['期貨 1.50x＋逢低階梯(上限1.95)', 'fut', { L0: 1.5, dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, Lmax: 1.95 }],
  ['期貨 1.30x 只加不減', 'fut', { L0: 1.3, dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, Lmax: 1.95, noCut: true }],
  ['期貨 1.30x 買了就放著', 'fut', { L0: 1.3, rebalance: false }],
  ['P4 1.50x＋跌28%拉1.95', 'fut', { L0: 1.5, dipStep: 0.28, dipAdd: 0.45, dipLevels: 1, Lmax: 1.95, holdUntilAth: true }],
  ['P5 1.75x＋跌28%拉1.95', 'fut', { L0: 1.75, dipStep: 0.28, dipAdd: 0.20, dipLevels: 1, Lmax: 1.95, holdUntilAth: true }],
  ['P1 1.2x階梯＋減碼(現行)', 'fut', { L0: 1.2, dipStep: 0.20, dipAdd: 0.25, dipLevels: 3, Lmax: 1.95, trimStep: 0.40, trimFrac: 0.3, trimLevels: 2 }],
];

const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
console.log('區塊自助抽樣 ' + NP + ' 條 × 20 年（40 日區塊）\n');
console.log('策略'.padEnd(30) + '中位年化   5%分位   贏β1.3機率  中位回撤  歸零率  斷頭率');
const ref = [];
for (const [name, kind, cfg] of CASES) {
  const cagrs = [], mdds = []; let ruin = 0, liq = 0;
  for (let i = 0; i < NP; i++) {
    const r = kind === 'etf'
      ? simulateETF(Object.assign({ rows: ETFP[i], capital0: 1e8 }, cfg))
      : simulate(Object.assign({ series: PATHS[i] }, FUT, cfg));
    cagrs.push(r.cagr); mdds.push(r.mdd);
    if (r.final < 1e8 * 0.05) ruin++;
    if (r.liquidations) liq++;
  }
  if (!ref.length) for (const c of cagrs) ref.push(c);
  let win = 0; for (let i = 0; i < NP; i++) if (cagrs[i] > ref[i]) win++;
  console.log(name.padEnd(28) + pct(q(cagrs, 0.5), 2).padStart(9) + pct(q(cagrs, 0.05), 2).padStart(9)
    + pct(win / NP, 0).padStart(11) + pct(q(mdds, 0.5), 0).padStart(10) + pct(ruin / NP, 1).padStart(8) + pct(liq / NP, 1).padStart(8));
}
