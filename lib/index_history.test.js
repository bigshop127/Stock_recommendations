// node --test lib/index_history.test.js
// 測資是 2026-11-08 從各資料源實際抓下來再裁短的回應（lib/__fixtures__/）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const h = require('./index_history');

const fxPath = (name) => path.join(__dirname, '__fixtures__', name);
const fxJson = (name) => JSON.parse(fs.readFileSync(fxPath(name), 'utf-8'));

test('九個方塊：台股三檔在前、國際六檔照原本順序', () => {
  assert.deepEqual(h.INDEX_CHART_DEFS.map((d) => d.key), ['TWSE', 'OTC', 'TX', 'DJI', 'GSPC', 'IXIC', 'SOX', 'N225', 'KS11']);
});

test('Yahoo 日線：時間戳換成交易所當地日期、收盤照順序', () => {
  const j = fxJson('yahoo_TWII_1mo_1d.json');
  const { points, partialLast } = h.parseYahooDaily(j, Date.UTC(2026, 10, 8, 14, 0)); // 週日，沒在交易
  assert.ok(points.length >= 15);
  assert.equal(points[points.length - 1][0], '2026-11-06');
  assert.equal(points[points.length - 1][1], j.chart.result[0].meta.regularMarketPrice);
  assert.equal(partialLast, false);
  for (let i = 1; i < points.length; i++) assert.ok(points[i - 1][0] < points[i][0]);
});

test('Yahoo 日線：美股時間戳（UTC 14:30）不會被算成隔天', () => {
  const { points } = h.parseYahooDaily(fxJson('yahoo_DJI_1mo_1d.json'), 0);
  assert.equal(points[points.length - 1][0], '2026-11-06');
});

test('Yahoo 日線：盤中最後一根是今天的半根 → partialLast', () => {
  const j = fxJson('yahoo_TWII_1mo_1d.json');
  const reg = j.chart.result[0].meta.currentTradingPeriod.regular; // 11/06 09:00–13:30
  assert.equal(h.parseYahooDaily(j, (reg.start + 3600) * 1000).partialLast, true);
  assert.equal(h.parseYahooDaily(j, (reg.end + 3600) * 1000).partialLast, false);
});

test('Yahoo 5 分鐘線：取有收盤的點、日期是最後一點的當地日期', () => {
  const r = h.parseYahooIntraday(fxJson('yahoo_KS11_1d_5m.json'));
  assert.ok(r.t.length > 10);
  assert.equal(r.t.length, r.c.length);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.c.every((v) => v > 0));
});

test('櫃買指數月查詢：日期轉 ISO、取收市', () => {
  const pts = h.parseTpexMonth(fxJson('tpex_inx_202610.json'));
  assert.equal(pts.length, 19);
  assert.deepEqual(pts[0], ['2026-10-01', 418.82]);
  assert.deepEqual(pts[1], ['2026-10-02', 426.93]);
  assert.deepEqual(h.parseTpexMonth({}), []);
});

test('期交所日行情：只取一般時段、單月契約、最近到期那個', () => {
  const text = new TextDecoder('big5').decode(fs.readFileSync(fxPath('taifex_futDataDown_TX_sample.csv')));
  const pts = h.parseTaifexDailyCsv(text);
  const by = Object.fromEntries(pts);
  assert.equal(by['2026-10-01'], 48685); // 202610 一般時段收盤（盤後 48298、價差單都不要）
  assert.equal(by['2026-10-21'] !== undefined, true);
  // 10/21 是 10 月契約結算日（第三個星期三），當天仍取 202610；10/22 起換 202611
  assert.equal(h.thirdWednesday(2026, 10), 21);
  const lines = text.split(/\r?\n/);
  const pick = (date, month) => {
    const l = lines.find((x) => x.startsWith(date) && x.split(',')[2].trim() === month && x.includes('一般'));
    return l ? Number(l.split(',')[6]) : null;
  };
  assert.equal(by['2026-10-21'], pick('2026/10/21', '202610'));
  assert.equal(by['2026-10-22'], pick('2026/10/22', '202611'));
  assert.throws(() => h.parseTaifexDailyCsv('<!DOCTYPE html><html>'), /HTML/);
});

test('證交所 MIS 每分鐘指數：日期從 key 來、時間戳是毫秒', () => {
  const r = h.parseMisOhlc(fxJson('twse_mis_ohlc_OTC.json'));
  assert.equal(r.date, '2026-11-06');
  assert.equal(r.c[r.c.length - 1], 304.02);
  assert.equal(new Date(r.t[r.t.length - 1]).toISOString(), '2026-11-06T05:30:00.000Z'); // 13:30 台北
});

test('期交所 MIS 每分鐘台指期：台北時間轉 UTC、取收盤', () => {
  const r = h.parseTaifexChart1M(fxJson('taifex_chart1m_TXFK6.json'));
  assert.equal(r.date, '2026-11-06');
  assert.equal(new Date(r.t[0]).toISOString(), '2026-11-06T00:46:00.000Z'); // 08:46 台北
  assert.equal(r.c[r.c.length - 1], 39786);
});

test('近月台指期代號：過了第三個星期三換下個月、跨年', () => {
  const tpe = (y, m, d, hh = 10) => Date.UTC(y, m - 1, d, hh - 8);
  assert.deepEqual(h.nearMonthSymbols(tpe(2026, 11, 8)), ['TXFK6-F', 'TXFL6-F']);
  assert.deepEqual(h.nearMonthSymbols(tpe(2026, 11, 18)), ['TXFK6-F', 'TXFL6-F']); // 11/18 結算日當天
  assert.deepEqual(h.nearMonthSymbols(tpe(2026, 11, 19)), ['TXFL6-F', 'TXFA7-F']);
  assert.deepEqual(h.nearMonthSymbols(tpe(2026, 12, 20)), ['TXFA7-F', 'TXFB7-F']);
});

test('月份切段、月底、合併', () => {
  assert.deepEqual(h.monthStarts('2026-10-15', '2027-01-02'), ['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']);
  assert.equal(h.monthEnd('2026-02-01'), '2026-02-28');
  assert.equal(h.monthEnd('2028-02-01'), '2028-02-29');
  assert.deepEqual(h.mergePoints([['2026-01-02', 1], ['2026-01-03', 2]], [['2026-01-03', 5], ['2026-01-01', 0.5]]),
    [['2026-01-01', 0.5], ['2026-01-02', 1], ['2026-01-03', 5]]);
  assert.deepEqual(h.maxPoint([['a', 1], ['b', 3], ['c', 3]]), { value: 3, date: 'b' });
});
