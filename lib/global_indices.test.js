// node --test lib/global_indices.test.js
// 測資是 2026-09-27 從 Yahoo 實際抓下來的回應（lib/__fixtures__/yahoo_*.json）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GLOBAL_INDEX_DEFS, parseYahooQuote } = require('./global_indices');

const fx = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `yahoo_${name}.json`), 'utf-8'));
const def = (key) => GLOBAL_INDEX_DEFS.find((d) => d.key === key);

test('六個指數：美股三大＋費城半導體＋日經＋韓股', () => {
  assert.deepEqual(GLOBAL_INDEX_DEFS.map((d) => d.symbol), ['^DJI', '^GSPC', '^IXIC', '^SOX', '^N225', '^KS11']);
});

test('道瓊：漲跌用前一交易日收盤（previousClose）算', () => {
  const j = fx('DJI');
  const r = parseYahooQuote(j, def('DJI'));
  const m = j.chart.result[0].meta;
  assert.equal(r.price, m.regularMarketPrice);
  assert.equal(r.prev_close, m.previousClose);
  assert.ok(Math.abs(r.change - (m.regularMarketPrice - m.previousClose)) < 1e-9);
  assert.ok(Math.abs(r.change_pct - ((m.regularMarketPrice / m.previousClose - 1) * 100)) < 1e-9);
  assert.equal(r.name, '道瓊工業');
  assert.equal(r.ok, true);
  assert.match(r.as_of, /^\d{4}-\d{2}-\d{2}T/);
});

test('盤中／已收盤依 currentTradingPeriod.regular 判斷', () => {
  const j = fx('KS11');
  const reg = j.chart.result[0].meta.currentTradingPeriod.regular;
  assert.equal(parseYahooQuote(j, def('KS11'), (reg.start + 60) * 1000).session, 'open');
  assert.equal(parseYahooQuote(j, def('KS11'), (reg.end + 60) * 1000).session, 'closed');
});

test('缺 previousClose 時退用 chartPreviousClose；兩個都沒有就不算漲跌', () => {
  const base = fx('DJI');
  const m = base.chart.result[0].meta;
  const noPrev = { chart: { result: [{ meta: { ...m, previousClose: undefined } }] } };
  assert.equal(parseYahooQuote(noPrev, def('DJI')).prev_close, m.chartPreviousClose);
  const none = { chart: { result: [{ meta: { ...m, previousClose: undefined, chartPreviousClose: undefined } }] } };
  const r = parseYahooQuote(none, def('DJI'));
  assert.equal(r.change, null);
  assert.equal(r.change_pct, null);
});

test('沒有結果或沒有現價就丟錯', () => {
  assert.throws(() => parseYahooQuote({ chart: { result: null } }, def('DJI')), /no result/);
  assert.throws(
    () => parseYahooQuote({ chart: { result: [{ meta: { regularMarketPrice: null } }] } }, def('DJI')),
    /no price/,
  );
});
