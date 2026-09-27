// node --test lib/twse_inst.test.js
// 測資是 2026-09-28 實際抓的 T86（2026-09-24，只留 5 檔）與 9/25 沒資料那天的原始回應。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { parseT86, sumInstNet } = require('./twse_inst');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf-8'));

test('parseT86：取三大法人買賣超股數、日期轉 ISO', () => {
  const r = parseT86(fixture('twse_t86.json'));
  assert.equal(r.noData, false);
  assert.equal(r.date, '2026-09-24');
  assert.equal(r.net['2330'], -5712849);
  assert.equal(r.net['2383'], -300201);
  assert.equal(r.net['0050'], -20885053);
  assert.equal(Object.keys(r.net).length, 5);
});

test('parseT86：沒開盤／還沒產出＝noData，不丟錯', () => {
  const r = parseT86(fixture('twse_t86_nodata.json'));
  assert.deepEqual(r, { date: null, net: null, noData: true });
});

test('parseT86：格式不認得要丟錯（不能被當成沒開盤快取起來）', () => {
  assert.throws(() => parseT86(null));
  assert.throws(() => parseT86({ stat: '查詢日期大於今日，請重新查詢!' }));
  assert.throws(() => parseT86({ stat: 'OK', fields: ['證券代號'], data: [] }));
});

test('sumInstNet：多天加總換成張、記錄實際天數、沒出現的代號不列', () => {
  const days = [
    { date: '2026-09-24', net: { 2330: -5712849, 2383: -300201 } },
    { date: '2026-09-23', net: { 2330: 1200000 } },
    { date: '2026-09-22', net: { 2330: 800500, 2383: 100000 } },
  ];
  const r = sumInstNet(days, ['2330', '2383', '6488']);
  assert.deepEqual(r['2330'], { net_lots: Math.round((-5712849 + 1200000 + 800500) / 1000), days: 3 });
  assert.deepEqual(r['2383'], { net_lots: -200, days: 2 });
  assert.equal(r['6488'], undefined);
});

test('sumInstNet：codes 空陣列＝全部代號', () => {
  const r = sumInstNet([{ date: '2026-09-24', net: { 1101: 1000, 2330: -2000 } }], []);
  assert.deepEqual(Object.keys(r).sort(), ['1101', '2330']);
  assert.equal(r['2330'].net_lots, -2);
});
