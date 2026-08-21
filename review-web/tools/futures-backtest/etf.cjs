// etf.cjs — 「00631L 正二＋現金、目標 Beta」策略的模擬器，期貨的對照組。
// 兩種驅動來源：
//   buildModelled()  由 series.json（跟期貨模擬同一條路徑）算出的合成正二，能回推到 2000 年
//   buildReal()      直接吃 Yahoo 的真實 00631L 還原價，只有 2014-10 之後
const fs = require('fs');
const { SERIES, rateOn } = require('./engine.cjs');

function loadYahoo(file) {
  const r = JSON.parse(fs.readFileSync(__dirname + '/' + file, 'utf8')).chart.result[0];
  const t = r.timestamp, q = r.indicators.quote[0];
  const a = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : null;
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (q.close[i] == null) continue;
    out.push({ date: new Date(t[i] * 1000).toISOString().slice(0, 10), close: q.close[i], adj: a ? a[i] : q.close[i] });
  }
  return out;
}

// 現貨含息總報酬：SERIES 是期貨超額報酬（已扣無風險利率），加回去就還原成現貨
const SPOT = [];
{
  let v = 100;
  for (let i = 0; i < SERIES.length; i++) {
    if (i > 0) v *= (SERIES[i].close / SERIES[i - 1].close) * (1 + rateOn(SERIES[i].date) / 252);
    SPOT.push({ date: SERIES[i].date, tr: v, px: SERIES[i].close });
  }
}

// 合成正二：日報酬 = 2 × 現貨日報酬 − 每日攤提的年化拖累
function buildModelled(drag) {
  const rows = [];
  for (let i = 0; i < SPOT.length; i++) {
    const rs = i > 0 ? SPOT[i].tr / SPOT[i - 1].tr - 1 : 0;
    rows.push({ date: SPOT[i].date, etfRet: i > 0 ? 2 * rs - drag / 252 : 0, px: SPOT[i].px });
  }
  return rows;
}

// 真實正二：Yahoo 00631L 還原價的日報酬；崩盤訊號仍用同一條 0050 路徑，兩邊訊號一致。
// 起點刻意切在 2015-01-05：Yahoo 這份資料在該日有一個 21.9 倍的尺度斷點（非任何真實除權息，
// 前後兩段單位不同），而 2014-10 上市後那兩個多月的日報酬又跟 0050 對不上（明顯落後一天）。
// 直接丟掉那段，剩下的 11.6 年仍涵蓋 2015 中國股災／2018／COVID／2022 熊市／2024／2025 關稅。
const REAL_FROM = '2015-01-05';
function buildReal() {
  const L = loadYahoo('y631L.json').filter((r) => r.date >= REAL_FROM);
  const pxMap = new Map(SPOT.map((r) => [r.date, r.px]));
  const rows = [];
  let prevAdj = null;
  for (let i = 0; i < L.length; i++) {
    if (!pxMap.has(L[i].date)) continue;
    rows.push({ date: L[i].date, etfRet: prevAdj == null ? 0 : L[i].adj / prevAdj - 1, px: pxMap.get(L[i].date) });
    prevAdj = L[i].adj;
  }
  return rows;
}

const ETF_DEFAULTS = {
  etfBeta: 2.0,       // 00631L 追蹤台灣50「日報酬」的兩倍
  targetBeta: 1.30,
  band: 0.10,         // 投組 β 偏離目標超過這個絕對值才再平衡（沿用 opt10 的 abs 口徑預設 0.1）
  crashDd: 0.28,      // 0050 自歷史高點回撤到這裡 → 現金全數加碼拉滿 β
  crashBeta: 2.0,
  cost: 0.0020,       // ETF 單邊成本（手續費＋賣出交易稅的混合估計）
  capital0: 1000000,
  crash: true,
};

function simulateETF(opts) {
  const p = Object.assign({}, ETF_DEFAULTS, opts || {});
  const src = p.rows || buildModelled(p.drag == null ? 0.03 : p.drag);
  const rows = src.slice(p.startIdx || 0, p.endIdx == null ? src.length : p.endIdx);
  if (rows.length < 30) return null;

  let etf = 0, cash = p.capital0;
  let peak = rows[0].px, inCrash = false, trades = 0, totalCost = 0;
  const eq = [];

  function setWeight(w, hard) {
    const total = etf + cash;
    const want = total * w, d = want - etf;
    if (!hard && Math.abs(d) < total * 0.005) return;
    const c = Math.abs(d) * p.cost;
    etf = want; cash = total - want - c; totalCost += c; trades++;
  }
  setWeight(Math.min(1, p.targetBeta / p.etfBeta), true);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], rf = rateOn(r.date);
    if (i > 0) { etf *= 1 + r.etfRet; if (etf < 0) etf = 0; cash *= 1 + rf / 252; }
    peak = Math.max(peak, r.px);
    const dd = r.px / peak - 1;
    if (p.crash) {
      if (!inCrash && dd <= -p.crashDd) { inCrash = true; setWeight(Math.min(1, p.crashBeta / p.etfBeta), true); }
      else if (inCrash && r.px >= peak) { inCrash = false; setWeight(Math.min(1, p.targetBeta / p.etfBeta), true); }
    }
    const total = etf + cash;
    if (!inCrash && total > 0) {
      const curBeta = (etf / total) * p.etfBeta;
      if (Math.abs(curBeta - p.targetBeta) > p.band) setWeight(Math.min(1, p.targetBeta / p.etfBeta), false);
    }
    eq.push({ date: r.date, cap: etf + cash, beta: total > 0 ? (etf / total) * p.etfBeta : 0 });
  }

  const n = eq.length;
  const years = (new Date(eq[n - 1].date) - new Date(eq[0].date)) / 31557600000;
  let pk = 0, mdd = 0, uw = 0, cur = 0;
  for (const e of eq) {
    if (e.cap > pk) { pk = e.cap; cur = 0; } else cur++;
    if (cur > uw) uw = cur;
    const d = e.cap / pk - 1; if (d < mdd) mdd = d;
  }
  let worst1y = 0;
  for (let i = 252; i < n; i++) worst1y = Math.min(worst1y, eq[i].cap / eq[i - 252].cap - 1);
  const cagr = Math.pow(eq[n - 1].cap / p.capital0, 1 / years) - 1;
  const avgCap = eq.reduce((s, e) => s + e.cap, 0) / n;
  return Object.assign({}, p, { trades, totalCost, avgCap, costPctPerYr: totalCost / avgCap / years,
    years, final: eq[n - 1].cap, cagr, mdd, worst1y,
    maxUnderwaterYrs: uw / 252, avgLev: eq.reduce((s, e) => s + e.beta, 0) / n,
    calmar: mdd < 0 ? cagr / -mdd : Infinity, eq: p.keepEq ? eq : null, rows: null });
}

const idxOf = (rows, date) => { const i = rows.findIndex((r) => r.date >= date); return i < 0 ? rows.length - 1 : i; };
module.exports = { simulateETF, buildModelled, buildReal, SPOT, ETF_DEFAULTS, idxOf, loadYahoo, REAL_FROM };
