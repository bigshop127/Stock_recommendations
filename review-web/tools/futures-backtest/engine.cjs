// engine.js — 小型0050期貨（SRF）槓桿部位的逐日模擬
const SERIES = require('./series.json');

// 契約規格：保證金用「佔契約價值的百分比」而非固定元數。
// Why：期交所會隨標的價格調整保證金級距，2000 年用今天的 7,900 元/口去套，
// 會讓當年（合成價 12 元）的槓桿上限失真。用今天的比例回推才是同一種風險。
const PRICE_NOW = 104.65;
const IM_PCT = 7900 / (PRICE_NOW * 1000);   // 原始保證金 ≈ 7.55%
const MM_PCT = 6100 / (PRICE_NOW * 1000);   // 維持保證金 ≈ 5.83%
const LIQ = 0.25;                            // 風險指標 = 權益數/原始保證金，<25% → 盤中代沖銷

// 單邊交易成本（佔名目金額）：手續費 40 元/口 + 期交稅 0.002% + 滑價 1 檔
const COST_SIDE = 40 / (PRICE_NOW * 1000) + 0.00002 + 0.05 / PRICE_NOW;

const RATE_STEPS = [['2000-01-01', .0475], ['2001-01-01', .0425], ['2001-07-01', .03], ['2002-01-01', .021],
['2002-07-01', .0175], ['2003-01-01', .014], ['2004-07-01', .015], ['2005-01-01', .018], ['2006-01-01', .024],
['2007-01-01', .03], ['2008-01-01', .0345], ['2008-10-01', .02], ['2009-01-01', .0125], ['2010-07-01', .014],
['2011-01-01', .018], ['2015-10-01', .0165], ['2016-07-01', .014], ['2020-03-01', .011], ['2022-04-01', .014],
['2023-04-01', .019], ['2024-04-01', .021], ['2025-01-01', .02]];
function rateOn(d) { let r = RATE_STEPS[0][1]; for (const [k, v] of RATE_STEPS) { if (d >= k) r = v; else break; } return r; }

const DEFAULTS = {
  L0: 1.5,          // 平常維持的槓桿（名目曝險 ÷ 總資金）
  dipStep: 0.10,    // 每跌這麼多就加一級
  dipAdd: 0.5,      // 每一級加多少倍槓桿
  dipLevels: 3,     // 最多加幾級
  Lmax: 99,         // 硬上限
  peakWin: 0,       // 回撤基準：0＝歷史新高，>0＝近 N 交易日高點
  trimStep: 0,      // 從「上一次加碼成本」起漲多少就減碼一級（0＝關閉）
  trimFrac: 0.20,   // 每級減掉目前部位的幾成
  trimLevels: 3,
  band: 0.20,       // 槓桿偏離目標多少才動手（相對值）
  inAcct: 1.0,      // 總資金放在保證金專戶的比例（其餘在外部，隔日才匯得進來）
  rollsPerYear: 12, // 轉倉次數（近月月轉＝12，季月轉＝4）
  capital0: 1000000,
  costMult: 1.0,
  carry: 0,          // 每年額外的基差紅利（台指期長年逆價差→多單轉倉會賺）
  rebalance: true, // false＝只在開場建倉，之後不再平衡（買了就放著）
};

function simulate(opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const SRC = p.series || SERIES;
  const rows = SRC.slice(p.startIdx || 0, p.endIdx == null ? SRC.length : p.endIdx);
  if (rows.length < 30) return null;
  const cost = COST_SIDE * p.costMult;

  let acct = p.capital0 * p.inAcct;        // 保證金專戶權益數（含已結算損益）
  let ext = p.capital0 * (1 - p.inAcct);   // 帳戶外閒置資金（生息，但盤中救不了你）
  let lots = 0, basis = rows[0].close;
  let trimCut = 0, trimLvl = 0, dipLvlHeld = 0;
  let liquidations = 0, marginCalls = 0, forcedCuts = 0, totalCost = 0, rollCost = 0;
  let peak = rows[0].close;
  const equity = [];
  const peakWin = p.peakWin;
  const rollEvery = p.rollsPerYear > 0 ? Math.round(252 / p.rollsPerYear) : 0;

  function trade(dLots, price) {             // dLots>0 買進、<0 賣出
    const c = Math.abs(dLots) * price * 1000 * cost;
    acct -= c; totalCost += c;
    if (dLots > 0) basis = (lots + dLots) > 0 ? (basis * lots + price * dLots) / (lots + dLots) : price;
    lots += dLots;
    if (lots <= 0) { lots = 0; basis = price; }
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1].close : r.close;
    const rf = rateOn(r.date);

    // 1) 逐日洗價：未實現損益每天真的進出保證金專戶
    if (i > 0 && lots > 0) acct += lots * 1000 * (r.close - prev) + (p.carry ? lots * 1000 * r.close * p.carry / 252 : 0);
    ext *= 1 + rf / 252;

    // 2) 盤中強制平倉檢查（用當日最低價，這是唯一救不回來的事件）
    if (lots > 0) {
      const low = i > 0 ? Math.min(r.low, r.close) : r.close;
      const acctAtLow = acct - lots * 1000 * (r.close - low);
      if (acctAtLow < LIQ * lots * IM_PCT * low * 1000) {
        const c = lots * low * 1000 * cost;
        acct = acctAtLow - c; totalCost += c;
        lots = 0; basis = r.close; liquidations++; trimCut = 0; trimLvl = 0; dipLvlHeld = 0;
      }
    }

    // 3) 轉倉成本（平近月 + 開次月＝兩邊）
    if (rollEvery && lots > 0 && i > 0 && i % rollEvery === 0) {
      const c = lots * r.close * 1000 * cost * 2;
      acct -= c; totalCost += c; rollCost += c;
    }

    // 4) 保證金追繳：權益數低於維持保證金 → 補到原始保證金，補不足就砍倉
    if (lots > 0 && acct < lots * MM_PCT * r.close * 1000) {
      marginCalls++;
      const need = lots * IM_PCT * r.close * 1000 - acct;
      const wire = Math.min(Math.max(0, need), ext);
      acct += wire; ext -= wire;
      while (lots > 0 && acct < lots * IM_PCT * r.close * 1000) {
        const d = Math.min(Math.max(1, Math.ceil(lots * 0.1)), lots);
        trade(-d, r.close); forcedCuts++;
      }
    }

    const capital = acct + ext;
    equity.push({ date: r.date, cap: capital, lots: lots, px: r.close });
    if (capital <= p.capital0 * 0.02) {                 // 實質歸零，後面補平
      for (let k = i + 1; k < rows.length; k++) equity.push({ date: rows[k].date, cap: capital, lots: 0, px: rows[k].close });
      return summarize(equity, { liquidations, marginCalls, forcedCuts, totalCost, rollCost, ruined: true }, p);
    }

    // 5) 策略：算出目標槓桿
    if (peakWin > 0) { peak = 0; for (let k = Math.max(0, i - peakWin); k <= i; k++) peak = Math.max(peak, rows[k].close); }
    else peak = Math.max(peak, r.close);
    const dd = r.close / peak - 1;
    const dipLvl = Math.min(p.dipLevels, Math.floor(-dd / p.dipStep));

    // 跌破新的一級 → 新的一輪加碼：把減碼過的部位放回來，獲利階梯歸零、成本重設
    if (dipLvl > dipLvlHeld) { trimCut = 0; trimLvl = 0; basis = r.close; }
    dipLvlHeld = dipLvl;

    // 獲利減碼：從上一次加碼成本起算，每漲 trimStep 減一級（棘輪，不會漲回去又加）
    if (p.trimStep > 0 && lots > 0) {
      const gain = r.close / basis - 1;
      const lvl = Math.min(p.trimLevels, Math.floor(gain / p.trimStep));
      if (lvl > trimLvl) { trimLvl = lvl; trimCut = Math.min(0.9, 1 - Math.pow(1 - p.trimFrac, lvl)); }
    }

    const targetL = Math.min(p.Lmax, p.L0 + dipLvl * p.dipAdd) * (1 - trimCut);
    const lotValue = r.close * 1000;
    let want = Math.round((capital * targetL) / lotValue);
    const affordable = Math.floor(acct / (IM_PCT * lotValue));   // 保證金押得起的上限
    want = Math.max(0, Math.min(want, affordable));

    // 6) 帶狀再平衡：偏離目標超過 band 才動手（省成本，也避免每天亂動）
    const curL = (lots * lotValue) / Math.max(1, capital);
    const off = targetL > 0 ? Math.abs(curL - targetL) / targetL : (lots > 0 ? 1 : 0);
    const may = lots === 0 ? true : (p.rebalance && off > p.band);
    if (want !== lots && may) trade(want - lots, r.close);
  }
  return summarize(equity, { liquidations, marginCalls, forcedCuts, totalCost, rollCost, ruined: false }, p);
}

function summarize(eq, ev, p) {
  const n = eq.length;
  const years = (new Date(eq[n - 1].date) - new Date(eq[0].date)) / 31557600000;
  const cagr = years > 0 ? Math.pow(eq[n - 1].cap / p.capital0, 1 / years) - 1 : 0;
  let pk = 0, mdd = 0, mddDate = '', uwDays = 0, cur = 0;
  for (const e of eq) {
    if (e.cap > pk) { pk = e.cap; cur = 0; } else { cur++; }
    if (cur > uwDays) uwDays = cur;
    const dd = e.cap / pk - 1;
    if (dd < mdd) { mdd = dd; mddDate = e.date; }
  }
  let worst1y = 0;
  for (let i = 252; i < n; i++) worst1y = Math.min(worst1y, eq[i].cap / eq[i - 252].cap - 1);
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(eq[i].cap / Math.max(1, eq[i - 1].cap) - 1);
  const m = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce(function (s, r) { return s + Math.pow(r - m, 2); }, 0) / rets.length) * Math.sqrt(252);
  const avgLev = eq.reduce(function (s, e) { return s + (e.lots * e.px * 1000) / Math.max(1, e.cap); }, 0) / n;
  return Object.assign({}, p, ev, {
    years: years, final: eq[n - 1].cap, cagr: cagr, mdd: mdd, mddDate: mddDate,
    maxUnderwaterYrs: uwDays / 252, worst1y: worst1y, vol: sd,
    calmar: mdd < 0 ? cagr / -mdd : Infinity, avgLev: avgLev,
    costPctPerYr: ev.totalCost / p.capital0 / Math.max(0.1, years), eq: p.keepEq ? eq : null,
  });
}

module.exports = { simulate: simulate, SERIES: SERIES, DEFAULTS: DEFAULTS, IM_PCT: IM_PCT, MM_PCT: MM_PCT, COST_SIDE: COST_SIDE, PRICE_NOW: PRICE_NOW, rateOn: rateOn };
