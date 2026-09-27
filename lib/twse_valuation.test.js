// node --test lib/twse_valuation.test.js
// 測資是 2026-09-27 實際抓的回應縮減版（BWIBBU_d／BWIBBU_ALL／t187ap17_L 各取幾家）：
// 台泥、中鋼本益比是「-」（近四季虧損或無意義）；國泰金不在營益分析表（金融業另一張表）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  toIsoDate,
  parseRocQuarter,
  parseBwibbu,
  parseBwibbuOpenApi,
  parseMarginAnalysis,
  buildStockMetrics,
  parseCodes,
} = require('./twse_valuation');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `${name}.json`), 'utf-8'));

test('日期與季別', () => {
  assert.equal(toIsoDate('20260924'), '2026-09-24');
  assert.equal(toIsoDate('1150924'), '2026-09-24');
  assert.equal(toIsoDate(''), null);
  assert.deepEqual(parseRocQuarter('115/2'), { year: 2026, quarter: 2, label: '2026-Q2' });
  assert.equal(parseRocQuarter('-'), null);
});

test('BWIBBU_d：本益比「-」→ null，反推近四季 EPS 與每股淨值', () => {
  const v = parseBwibbu(fx('twse_bwibbu_d'));
  assert.equal(v.date, '2026-09-24');
  assert.equal(v.eps_period.label, '2026-Q2');
  const tsmc = v.rows['2330'];
  assert.equal(tsmc.close, 2475);
  assert.equal(tsmc.pe, 28.69);
  assert.equal(tsmc.pb, 9.98);
  assert.equal(tsmc.dy, 0.89);
  assert.equal(tsmc.eps_ttm, 86.27); // 2475 ÷ 28.69；engine 用 FinMind 四季加總是 86.28
  assert.equal(tsmc.bvps, 248.0);
  assert.equal(v.rows['1101'].pe, null);
  assert.equal(v.rows['1101'].eps_ttm, null);
  assert.equal(v.rows['1101'].pb, 0.82);
  assert.equal(parseBwibbu({ stat: '很抱歉，沒有符合條件的資料!' }), null);
});

test('BWIBBU_ALL 備援：同樣的估值、沒有收盤價', () => {
  const v = parseBwibbuOpenApi(fx('twse_bwibbu_all'));
  assert.equal(v.date, '2026-09-24');
  assert.equal(v.rows['2330'].pe, 28.69);
  assert.equal(v.rows['2330'].close, null);
  assert.equal(v.rows['2330'].eps_ttm, null);
  assert.equal(parseBwibbuOpenApi([]), null);
});

test('營益分析：今年累計的三率、營收換成元', () => {
  const m = parseMarginAnalysis(fx('twse_t187ap17_L'));
  assert.equal(m.period, '2026-Q2');
  assert.equal(m.rows['2330'].gross_margin, 67.03);
  assert.equal(m.rows['2330'].operating_margin, 59.29);
  assert.equal(m.rows['2330'].net_margin, 53.22);
  assert.equal(m.rows['2330'].revenue_ytd, 2404483.69e6);
  assert.equal(m.rows['2882'], undefined);
});

test('合併：照 codes 順序、查不到的略過、營收只取最新月', () => {
  const valuation = parseBwibbu(fx('twse_bwibbu_d'));
  const margins = parseMarginAnalysis(fx('twse_t187ap17_L'));
  const revenueCompanies = [
    { code: '2330', name: '台積電', current: true, month: '2026-08', yoy_pct: 53.32012, cum_yoy_pct: 40.1 },
    { code: '6274', name: '台燿', current: true, month: '2026-08', yoy_pct: 80.5, cum_yoy_pct: 60 },
    { code: '2383', name: '台光電', current: false, month: '2026-07', yoy_pct: 99, cum_yoy_pct: 99 },
  ];
  const items = buildStockMetrics({ valuation, margins, revenueCompanies, codes: ['2383', '2330', '6274', '9999'] });
  assert.deepEqual(items.map((i) => i.code), ['2383', '2330', '6274']);
  const [tgd, tsmc, otc] = items;
  assert.equal(tgd.rev_yoy, null); // 不是最新月的列不用
  assert.equal(tgd.gross_margin, 32.03);
  assert.equal(tsmc.rev_yoy, 53.32);
  assert.equal(tsmc.margin_period, '2026-Q2');
  assert.equal(otc.pe, null); // 上櫃沒有估值，但營收照給
  assert.equal(otc.rev_yoy, 80.5);
  assert.equal(otc.name, '台燿');

  const all = buildStockMetrics({ valuation, margins, revenueCompanies: [], codes: [] });
  assert.equal(all.length, Object.keys(valuation.rows).length);
});

test('codes 參數清洗', () => {
  assert.deepEqual(parseCodes('2330, 2383,2330,abc;,00631L,<x>'), ['2330', '2383', '00631L']);
  assert.deepEqual(parseCodes(''), []);
  assert.equal(parseCodes(Array.from({ length: 500 }, (_, i) => String(1000 + i)).join(',')).length, 400);
});
