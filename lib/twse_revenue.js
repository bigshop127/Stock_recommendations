/**
 * twse_revenue.js — 上市／上櫃月營收的純解析與產業加總（不發請求，方便測試）。
 *
 * 逐家資料（主要來源，一次拿到全部公司）：
 *   上市 https://openapi.twse.com.tw/v1/opendata/t187ap05_L   上市公司每月營業收入彙總表
 *   上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O 上櫃公司每月營業收入彙總表
 *   金額單位是「千元」，這裡一律換成「元」。
 * 趨勢（證交所臺股儀表板背後的櫃買 API，2026/8 營收起才有、只給最新月往回 12 個月）：
 *   https://www.tpex.org.tw/www/revenue/change?market=T             全體上市 12 個月營收
 *   https://www.tpex.org.tw/www/revenue/industryTrend?market=T&...  單一產業 12 個月營收
 *   金額單位是「億元」。
 *
 * 產業加總＝該產業各公司「當月營收合計 ÷ 去年同月合計 − 1」，排除「存託憑證」——
 * 這樣算出來跟證交所臺股儀表板公布的數字逐位相同（2026-08：1,084 家、58,916.61 億、年增 46.8118%）。
 * 產業分類是證交所官方現行 32 類，跟熱力圖「產業聚合」沿用的 FinMind 分類（有舊的「電子工業」大類）不同。
 */
'use strict';

const EXCLUDED_INDUSTRIES = new Set(['存託憑證']);

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 民國年月 '11508' → '2026-08' */
function rocYm(s) {
  const m = /^(\d{2,3})(\d{2})$/.exec(String(s || '').trim());
  return m ? `${Number(m[1]) + 1911}-${m[2]}` : null;
}

/** 民國年月日 '1150917' → '2026-09-17' */
function rocYmd(s) {
  const m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

/** (a / b − 1) × 100；分母不是正數就沒有意義 */
const growthPct = (a, b) => (a === null || b === null || !(b > 0) ? null : (a / b - 1) * 100);

/** 千元 → 元 */
const kToYuan = (v) => (v === null ? null : v * 1000);

function parseCompanyRows(rows, market) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const code = String(r['公司代號'] || '').trim();
    const month = rocYm(r['資料年月']);
    if (!code || !month) continue;
    const revenue = kToYuan(num(r['營業收入-當月營收']));
    const lastMonth = kToYuan(num(r['營業收入-上月營收']));
    const lastYear = kToYuan(num(r['營業收入-去年當月營收']));
    const cumRevenue = kToYuan(num(r['累計營業收入-當月累計營收']));
    const cumLastYear = kToYuan(num(r['累計營業收入-去年累計營收']));
    const note = String(r['備註'] || '').trim();
    out.push({
      code,
      name: String(r['公司名稱'] || '').trim(),
      market,
      industry: String(r['產業別'] || '').trim() || '其他',
      month,
      published: rocYmd(r['出表日期']),
      revenue,
      last_month: lastMonth,
      last_year: lastYear,
      mom_pct: growthPct(revenue, lastMonth),
      yoy_pct: growthPct(revenue, lastYear),
      cum_revenue: cumRevenue,
      cum_last_year: cumLastYear,
      cum_yoy_pct: growthPct(cumRevenue, cumLastYear),
      note: note === '-' || note === '無' ? '' : note,
    });
  }
  return out;
}

/**
 * 同一市場的公司 → { month, published, companies, industries, overview }。
 * 申報期間（每月 1～10 日）表上可能混著兩個月份：只拿最新月份的公司做加總，
 * 舊月份的公司保留在 companies 裡但標 current=false。
 */
function buildMarket(companies) {
  const months = companies.map((c) => c.month).filter(Boolean).sort();
  const month = months.length ? months[months.length - 1] : null;
  const published = companies.map((c) => c.published).filter(Boolean).sort().pop() || null;

  const byIndustry = new Map();
  const total = { count: 0, revenue: 0, last_month: 0, last_year: 0, cum_revenue: 0, cum_last_year: 0 };
  for (const c of companies) {
    c.current = c.month === month;
    if (!c.current || c.revenue === null || EXCLUDED_INDUSTRIES.has(c.industry)) continue;
    if (!byIndustry.has(c.industry)) {
      byIndustry.set(c.industry, { name: c.industry, count: 0, revenue: 0, last_month: 0, last_year: 0, cum_revenue: 0, cum_last_year: 0 });
    }
    for (const acc of [byIndustry.get(c.industry), total]) {
      acc.count += 1;
      acc.revenue += c.revenue;
      acc.last_month += c.last_month || 0;
      acc.last_year += c.last_year || 0;
      acc.cum_revenue += c.cum_revenue || 0;
      acc.cum_last_year += c.cum_last_year || 0;
    }
  }

  const finish = (a) => ({
    ...a,
    mom_pct: growthPct(a.revenue, a.last_month),
    yoy_pct: growthPct(a.revenue, a.last_year),
    cum_yoy_pct: growthPct(a.cum_revenue, a.cum_last_year),
  });

  const industries = [...byIndustry.values()]
    .map((a) => ({ ...finish(a), share_pct: total.revenue > 0 ? (a.revenue / total.revenue) * 100 : null }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    month,
    published,
    overview: finish(total),
    industries,
    companies,
  };
}

/** 本公司在同市場同產業裡的年增率名次（1＝最高），沒有年增率的公司不列入 */
function industryRank(market, code) {
  const self = market.companies.find((c) => c.code === code);
  if (!self || !self.current || self.yoy_pct === null) return null;
  const peers = market.companies.filter(
    (c) => c.current && c.industry === self.industry && c.yoy_pct !== null,
  );
  return {
    rank: peers.filter((c) => c.yoy_pct > self.yoy_pct).length + 1,
    of: peers.length,
  };
}

/** 櫃買儀表板 API 的趨勢陣列（億元）→ [{ month:'YYYY-MM', revenue: 元, mom_pct? }] */
function parseTpexTrend(body) {
  if (!body || String(body.stat).toLowerCase() !== 'ok' || !Array.isArray(body.trend)) return null;
  return body.trend
    .map((t) => {
      const y = Number(t.year);
      const m = Number(t.month);
      const yi = num(t.monthly);
      if (!y || !m || yi === null) return null;
      const row = { month: `${y}-${String(m).padStart(2, '0')}`, revenue: yi * 1e8 };
      const mom = num(t.momChangePct);
      if (mom !== null) row.mom_pct = mom;
      return row;
    })
    .filter(Boolean);
}

module.exports = {
  EXCLUDED_INDUSTRIES,
  rocYm,
  rocYmd,
  growthPct,
  parseCompanyRows,
  buildMarket,
  industryRank,
  parseTpexTrend,
};
