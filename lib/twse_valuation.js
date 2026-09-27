/**
 * twse_valuation.js — 上市個股估值與獲利率的純解析（不發請求，方便測試）。opt45 合理價＋同業排名用。
 *
 *   估值（每日收盤後）：https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?selectType=ALL&response=json
 *     欄位：證券代號、證券名稱、收盤價、殖利率(%)、股利年度、本益比、股價淨值比、財報年/季
 *     本益比用近四季 EPS，虧損或無意義時是「-」。收盤價 ÷ 本益比＝證交所採用的近四季 EPS。
 *   備援：https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL（同一份資料，沒有收盤價與財報季別）
 *   獲利率（每季）：https://openapi.twse.com.tw/v1/opendata/t187ap17_L 上市公司營益分析
 *     是「今年累計到該季」的毛利率／營業利益率／稅前／稅後純益率，營收單位百萬元。
 *
 * 只有上市（證交所）；上櫃要另接櫃買的表，細分族群目前也只收上市，所以先不做。
 */
'use strict';

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** '20260924' → '2026-09-24'；民國 '1150924' → '2026-09-24' */
function toIsoDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  return null;
}

/** 財報年/季 '115/2' → { year: 2026, quarter: 2, label: '2026-Q2' } */
function parseRocQuarter(s) {
  const m = /^(\d{2,3})\/(\d)$/.exec(String(s || '').trim());
  if (!m) return null;
  const year = Number(m[1]) + 1911;
  const quarter = Number(m[2]);
  return { year, quarter, label: `${year}-Q${quarter}` };
}

/** 本益比／淨值比要是正數才有意義；反推的 EPS、每股淨值跟著算 */
function valuationRow(code, name, close, pe, pb, dy) {
  const validPe = pe !== null && pe > 0 ? pe : null;
  const validPb = pb !== null && pb > 0 ? pb : null;
  return {
    code,
    name,
    close,
    pe: validPe,
    pb: validPb,
    dy,
    eps_ttm: close !== null && validPe ? round(close / validPe, 2) : null,
    bvps: close !== null && validPb ? round(close / validPb, 2) : null,
  };
}

/** BWIBBU_d（rwd）→ { date, eps_period, rows: { [code]: row } }；格式不對回 null */
function parseBwibbu(body) {
  if (!body || String(body.stat).toUpperCase() !== 'OK' || !Array.isArray(body.data) || !Array.isArray(body.fields)) {
    return null;
  }
  const idx = (name) => body.fields.indexOf(name);
  const iCode = idx('證券代號');
  const iName = idx('證券名稱');
  const iClose = idx('收盤價');
  const iDy = idx('殖利率(%)');
  const iPe = idx('本益比');
  const iPb = idx('股價淨值比');
  const iPeriod = idx('財報年/季');
  if (iCode < 0 || iPe < 0 || iPb < 0) return null;

  const rows = {};
  const periods = new Map();
  for (const r of body.data) {
    const code = String(r[iCode] || '').trim();
    if (!code) continue;
    rows[code] = valuationRow(
      code,
      String(r[iName] || '').trim(),
      iClose >= 0 ? num(r[iClose]) : null,
      num(r[iPe]),
      num(r[iPb]),
      iDy >= 0 ? num(r[iDy]) : null,
    );
    const p = iPeriod >= 0 ? String(r[iPeriod] || '').trim() : '';
    if (p) periods.set(p, (periods.get(p) || 0) + 1);
  }
  // 大多數公司採用的財報季別（少數公司晚交或會計年度不同）
  const topPeriod = [...periods.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    date: toIsoDate(body.date),
    eps_period: topPeriod ? parseRocQuarter(topPeriod[0]) : null,
    rows,
  };
}

/** BWIBBU_ALL（OpenAPI 備援）→ 同上格式，沒有收盤價所以沒有反推 EPS */
function parseBwibbuOpenApi(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const rows = {};
  let date = null;
  for (const r of list) {
    const code = String(r.Code || '').trim();
    if (!code) continue;
    date = date || toIsoDate(r.Date);
    rows[code] = valuationRow(code, String(r.Name || '').trim(), null, num(r.PEratio), num(r.PBratio), num(r.DividendYield));
  }
  return { date, eps_period: null, rows };
}

/** t187ap17_L 營益分析 → { period, rows: { [code]: {...} } } */
function parseMarginAnalysis(list) {
  if (!Array.isArray(list)) return null;
  const rows = {};
  const periods = new Map();
  for (const r of list) {
    const code = String(r['公司代號'] || '').trim();
    if (!code) continue;
    const year = num(r['年度']);
    const quarter = num(r['季別']);
    const key = year && quarter ? `${year + 1911}-Q${quarter}` : null;
    if (key) periods.set(key, (periods.get(key) || 0) + 1);
    const revenueM = num(r['營業收入(百萬元)']);
    rows[code] = {
      period: key,
      revenue_ytd: revenueM === null ? null : revenueM * 1e6,
      gross_margin: num(r['毛利率(%)(營業毛利)/(營業收入)']),
      operating_margin: num(r['營業利益率(%)(營業利益)/(營業收入)']),
      pretax_margin: num(r['稅前純益率(%)(稅前純益)/(營業收入)']),
      net_margin: num(r['稅後純益率(%)(稅後純益)/(營業收入)']),
    };
  }
  const top = [...periods.entries()].sort((a, b) => b[1] - a[1])[0];
  return { period: top ? top[0] : null, rows };
}

/**
 * 合併成每檔一列。codes 給了就只回那些（順序照 codes）；沒給就回全部上市估值表的公司。
 * revenueCompanies：twse_revenue.parseCompanyRows 的結果（上市＋上櫃都可以），拿最新月的年增率。
 */
function buildStockMetrics({ valuation, margins, revenueCompanies, codes }) {
  const valRows = (valuation && valuation.rows) || {};
  const marginRows = (margins && margins.rows) || {};
  const revByCode = new Map();
  for (const c of revenueCompanies || []) {
    if (!c || !c.code || !c.current) continue;
    revByCode.set(c.code, c);
  }
  const wanted = codes && codes.length ? codes : Object.keys(valRows);
  const items = [];
  for (const code of wanted) {
    const v = valRows[code];
    const m = marginRows[code];
    const rev = revByCode.get(code);
    if (!v && !m && !rev) continue;
    items.push({
      code,
      name: (v && v.name) || (rev && rev.name) || '',
      close: v ? v.close : null,
      pe: v ? v.pe : null,
      pb: v ? v.pb : null,
      dy: v ? v.dy : null,
      eps_ttm: v ? v.eps_ttm : null,
      bvps: v ? v.bvps : null,
      gross_margin: m ? m.gross_margin : null,
      operating_margin: m ? m.operating_margin : null,
      net_margin: m ? m.net_margin : null,
      margin_period: m ? m.period : null,
      rev_yoy: rev ? round(rev.yoy_pct, 2) : null,
      rev_cum_yoy: rev ? round(rev.cum_yoy_pct, 2) : null,
      revenue_month: rev ? rev.month : null,
    });
  }
  return items;
}

/** ?codes=2330,2383 → ['2330','2383']（只收 4~6 碼英數，最多 400 檔） */
function parseCodes(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(',')) {
    const c = part.trim().toUpperCase();
    if (/^[0-9A-Z]{4,6}$/.test(c) && !out.includes(c)) out.push(c);
    if (out.length >= 400) break;
  }
  return out;
}

module.exports = {
  num,
  toIsoDate,
  parseRocQuarter,
  parseBwibbu,
  parseBwibbuOpenApi,
  parseMarginAnalysis,
  buildStockMetrics,
  parseCodes,
};
