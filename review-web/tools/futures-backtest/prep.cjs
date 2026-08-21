// prep.js — 把 Yahoo 原始檔整理成「小型0050期貨」的合成價格路徑
const fs = require('fs');
const path = require('path');
const D = __dirname + path.sep;

// Yahoo 的日線 JSON。抓不到就報錯而不是靜靜用舊檔——序列錯了整份回測都是錯的。
async function fetchChart(symbol, file) {
  const dest = D + file;
  if (fs.existsSync(dest) && !process.env.REFETCH) return;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?period1=852000000&period2=9999999999&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(symbol + ' 抓取失敗：HTTP ' + res.status);
  const body = await res.text();
  if (!body.includes('"timestamp"')) throw new Error(symbol + ' 回傳沒有時間序列');
  fs.writeFileSync(dest, body);
  console.log('已下載 ' + symbol + ' → ' + file);
}

function load(file) {
  const r = JSON.parse(fs.readFileSync(D + file, 'utf8')).chart.result[0];
  const t = r.timestamp, q = r.indicators.quote[0];
  const a = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : null;
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (q.close[i] == null) continue;
    out.push({
      date: new Date(t[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
      adj: a ? a[i] : q.close[i],
    });
  }
  return out;
}

// 分割修正：Yahoo 這份 0050 沒有回溯調整 1:4 分割，close 與 adjclose 同時斷崖。
// 做法＝找出單日 |報酬|>25% 且比例接近整數倍的那天，把之前所有價格除以該倍數。
function fixSplits(rows) {
  const splits = [];
  for (let i = 1; i < rows.length; i++) {
    const ratio = rows[i - 1].close / rows[i].close;
    if (ratio > 1.6 || ratio < 0.625) {
      const round = [2, 3, 4, 5, 10].find((k) => Math.abs(ratio - k) / k < 0.05 || Math.abs(1 / ratio - k) / k < 0.05);
      if (round) splits.push({ i, date: rows[i].date, k: Math.abs(ratio - round) / round < 0.05 ? round : 1 / round });
    }
  }
  for (const s of splits) {
    for (let i = 0; i < s.i; i++) {
      rows[i].open /= s.k; rows[i].high /= s.k; rows[i].low /= s.k;
      rows[i].close /= s.k; rows[i].adj /= s.k;
    }
  }
  return splits;
}

async function main() {
const f0050 = load('y0050.json');
const twii = load('ytwii.json');
const splits = fixSplits(f0050);
console.log('0050 splits fixed:', JSON.stringify(splits));

// ── 台灣短期利率（融資成本）階梯，用來把「現貨總報酬」轉成「期貨超額報酬」──
// 期貨多單的總報酬 ≈ 現貨總報酬 − 無風險利率（持有成本），這是股票期貨的標準結果：
// F = S·e^((r−q)T)，配息由基差吸收，多單不領息但也不付息，淨效果就是少賺一個 r。
const RATE_STEPS = [
  ['2000-01-01', 0.0475], ['2001-01-01', 0.0425], ['2001-07-01', 0.0300],
  ['2002-01-01', 0.0210], ['2002-07-01', 0.0175], ['2003-01-01', 0.0140],
  ['2004-07-01', 0.0150], ['2005-01-01', 0.0180], ['2006-01-01', 0.0240],
  ['2007-01-01', 0.0300], ['2008-01-01', 0.0345], ['2008-10-01', 0.0200],
  ['2009-01-01', 0.0125], ['2010-07-01', 0.0140], ['2011-01-01', 0.0180],
  ['2015-10-01', 0.0165], ['2016-07-01', 0.0140], ['2020-03-01', 0.0110],
  ['2022-04-01', 0.0140], ['2023-04-01', 0.0190], ['2024-04-01', 0.0210],
  ['2025-01-01', 0.0200],
];
function rateOn(date) {
  let r = RATE_STEPS[0][1];
  for (const [d, v] of RATE_STEPS) { if (date >= d) r = v; else break; }
  return r;
}

// 2000–2009 沒有 0050：用加權指數當代理。
//   風險用「重疊期實測 beta」放大（0050 是大型股子集，波動略高於大盤），
//   報酬**不**外加 alpha（不把 2009 後台積電的後見之明搬到過去）。
//   配息用固定殖利率假設補上（TAIEX 是價格指數，不含息）。
const TWII_DIV_YIELD = 0.030;

const idx = new Map(twii.map((r) => [r.date, r]));
const overlap = [];
for (let i = 1; i < f0050.length; i++) {
  const a = idx.get(f0050[i].date), b = idx.get(f0050[i - 1].date);
  if (!a || !b) continue;
  overlap.push([b.close === 0 ? 0 : a.close / b.close - 1, f0050[i].adj / f0050[i - 1].adj - 1]);
}
const mx = overlap.reduce((s, p) => s + p[0], 0) / overlap.length;
const my = overlap.reduce((s, p) => s + p[1], 0) / overlap.length;
let cov = 0, varx = 0;
for (const [x, y] of overlap) { cov += (x - mx) * (y - my); varx += (x - mx) ** 2; }
const beta = cov / varx;
const corr = cov / Math.sqrt(varx * overlap.reduce((s, p) => s + (p[1] - my) ** 2, 0));
console.log('overlap n=' + overlap.length, 'beta=' + beta.toFixed(4), 'corr=' + corr.toFixed(4));

// ── 組出連續的「期貨合成價格」序列 ──
const START = '2000-01-01';
const spliceEnd = f0050[0].date;               // 0050 實際資料的第一天
const rows = [];
let px = 100;                                  // 指數化起點，之後再縮放到真實價位

function pushRow(date, ret, dayLow, dayHigh) {
  const r = rateOn(date);
  const net = ret - r / 252;                   // 扣掉持有成本＝期貨超額報酬
  const prev = px;
  px = px * (1 + net);
  rows.push({ date, close: px, low: prev * (1 + (dayLow ?? net)), high: prev * (1 + (dayHigh ?? net)), src: date < spliceEnd ? 'twii' : '0050' });
}

const pre = twii.filter((r) => r.date >= START && r.date < spliceEnd);
for (let i = 1; i < pre.length; i++) {
  const c = pre[i], p = pre[i - 1];
  const pr = c.close / p.close - 1;
  const tr = pr * beta + TWII_DIV_YIELD / 252;
  const lo = (c.low / p.close - 1) * beta + TWII_DIV_YIELD / 252 - rateOn(c.date) / 252;
  const hi = (c.high / p.close - 1) * beta + TWII_DIV_YIELD / 252 - rateOn(c.date) / 252;
  pushRow(c.date, tr, lo, hi);
}
for (let i = 1; i < f0050.length; i++) {
  const c = f0050[i], p = f0050[i - 1];
  const tr = c.adj / p.adj - 1;
  const div = c.adj / c.close;                 // 當日的股息調整因子
  const lo = (c.low * div) / (p.adj) - 1 - rateOn(c.date) / 252;
  const hi = (c.high * div) / (p.adj) - 1 - rateOn(c.date) / 252;
  pushRow(c.date, tr, lo, hi);
}

// 縮放到真實價位：讓最後一天等於今天的 0050 收盤
const scale = f0050[f0050.length - 1].close / rows[rows.length - 1].close;
for (const r of rows) { r.close *= scale; r.low *= scale; r.high *= scale; }

fs.writeFileSync(D + 'series.json', JSON.stringify(rows));
console.log('rows=' + rows.length, rows[0].date, '→', rows[rows.length - 1].date);
console.log('合成期貨價 起點', rows[0].close.toFixed(2), '終點', rows[rows.length - 1].close.toFixed(2));
const yrs = (new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / 31557600000;
console.log('年數', yrs.toFixed(2), '無槓桿期貨 CAGR', (((rows[rows.length - 1].close / rows[0].close) ** (1 / yrs) - 1) * 100).toFixed(2) + '%');
}

fetchChart('0050.TW', 'y0050.json')
  .then(() => fetchChart('^TWII', 'ytwii.json'))
  .then(main)
  .catch((e) => { console.error(e.message); process.exit(1); });
