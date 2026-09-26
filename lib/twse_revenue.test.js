// node --test lib/twse_revenue.test.js
// 測資是 2026-09-26 實際抓的回應縮減版：上市取電腦及週邊／半導體／金融保險／存託憑證全部公司
// ＋兩家沒有去年營收的生技股；上櫃取半導體業。產業數字要跟證交所臺股儀表板公布的逐位相同。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  rocYm,
  rocYmd,
  growthPct,
  parseCompanyRows,
  buildMarket,
  industryRank,
  parseTpexTrend,
} = require('./twse_revenue');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `${name}.json`), 'utf-8'));
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

test('日期與成長率小工具', () => {
  assert.equal(rocYm('11508'), '2026-08');
  assert.equal(rocYm('9912'), '2010-12');
  assert.equal(rocYmd('1150917'), '2026-09-17');
  assert.equal(rocYm(''), null);
  assert.equal(round(growthPct(120, 100)), 20);
  assert.equal(growthPct(120, 0), null);
  assert.equal(growthPct(null, 100), null);
});

test('上市：產業加總跟證交所儀表板一致，存託憑證不列入產業', () => {
  const m = buildMarket(parseCompanyRows(fx('twse_t187ap05_L_subset'), 'listed'));
  assert.equal(m.month, '2026-08');
  assert.equal(m.published, '2026-09-17');
  const ind = Object.fromEntries(m.industries.map((i) => [i.name, i]));
  assert.equal(ind['存託憑證'], undefined);
  // 儀表板：電腦及週邊 15,965.70 億 vs 8,377.09 億 → +90.5877%
  assert.equal(round(ind['電腦及週邊設備業'].revenue / 1e8, 2), 15965.7);
  assert.equal(round(ind['電腦及週邊設備業'].last_year / 1e8, 2), 8377.09);
  assert.equal(round(ind['電腦及週邊設備業'].yoy_pct), 90.5877);
  assert.equal(round(ind['半導體業'].yoy_pct), 61.2997);
  assert.equal(round(ind['金融保險業'].yoy_pct), -34.8798);
  assert.equal(ind['半導體業'].count, 96);
  // 依營收大到小
  for (let i = 1; i < m.industries.length; i++) assert.ok(m.industries[i - 1].revenue >= m.industries[i].revenue);
  // share 加總 100%
  assert.equal(round(m.industries.reduce((a, b) => a + b.share_pct, 0), 6), 100);
});

test('公司層級：單位換成元、沒有去年營收的年增率是 null', () => {
  const rows = parseCompanyRows(fx('twse_t187ap05_L_subset'), 'listed');
  const tsmc = rows.find((c) => c.code === '2330');
  assert.equal(tsmc.name, '台積電');
  assert.equal(tsmc.industry, '半導體業');
  assert.equal(tsmc.market, 'listed');
  assert.ok(tsmc.revenue > 1e11, '台積電單月營收應以元計、超過千億');
  assert.ok(tsmc.yoy_pct !== null && tsmc.mom_pct !== null && tsmc.cum_yoy_pct !== null);
  const noLy = rows.find((c) => c.code === '6838');
  assert.equal(noLy.yoy_pct, null);
  assert.ok(noLy.revenue !== null);
});

test('產業內年增率名次', () => {
  const m = buildMarket(parseCompanyRows(fx('twse_t187ap05_L_subset'), 'listed'));
  const semis = m.companies.filter((c) => c.industry === '半導體業' && c.yoy_pct !== null);
  const best = semis.reduce((a, b) => (b.yoy_pct > a.yoy_pct ? b : a));
  assert.deepEqual(industryRank(m, best.code), { rank: 1, of: semis.length });
  const r = industryRank(m, '2330');
  assert.ok(r.rank >= 1 && r.rank <= r.of);
  assert.equal(industryRank(m, '6838'), null, '沒有年增率不排名');
  assert.equal(industryRank(m, '9999'), null);
});

test('申報期間混兩個月份：只拿最新月份加總', () => {
  const rows = [
    { 出表日期: '1151005', 資料年月: '11509', 公司代號: '1111', 公司名稱: 'A', 產業別: '半導體業', '營業收入-當月營收': '200', '營業收入-上月營收': '100', '營業收入-去年當月營收': '100', '累計營業收入-當月累計營收': '900', '累計營業收入-去年累計營收': '800', 備註: '-' },
    { 出表日期: '1150917', 資料年月: '11508', 公司代號: '2222', 公司名稱: 'B', 產業別: '半導體業', '營業收入-當月營收': '999', '營業收入-上月營收': '1', '營業收入-去年當月營收': '1', '累計營業收入-當月累計營收': '1', '累計營業收入-去年累計營收': '1', 備註: '-' },
  ];
  const m = buildMarket(parseCompanyRows(rows, 'listed'));
  assert.equal(m.month, '2026-09');
  assert.equal(m.overview.count, 1);
  assert.equal(m.overview.yoy_pct, 100);
  assert.equal(m.companies.find((c) => c.code === '2222').current, false);
  assert.equal(industryRank(m, '2222'), null);
});

test('上櫃同格式', () => {
  const m = buildMarket(parseCompanyRows(fx('tpex_t187ap05_O_subset'), 'otc'));
  assert.equal(m.month, '2026-08');
  assert.equal(m.industries.length, 1);
  assert.equal(m.industries[0].name, '半導體業');
  assert.ok(m.companies.every((c) => c.market === 'otc'));
});

test('櫃買趨勢：億元換成元、月份補零', () => {
  const t = parseTpexTrend(fx('tpex_revenue_change_T'));
  assert.equal(t.length, 12);
  assert.deepEqual(t[t.length - 1], { month: '2026-08', revenue: 58916.61 * 1e8 });
  assert.equal(t[0].month, '2025-09');
  const semi = parseTpexTrend(fx('tpex_revenue_industryTrend_semi'));
  assert.equal(semi[semi.length - 1].month, '2026-08');
  assert.equal(semi[semi.length - 1].mom_pct, 9.4255);
  assert.equal(parseTpexTrend({ stat: '很抱歉，沒有符合條件的資料!' }), null);
});
