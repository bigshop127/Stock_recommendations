// node --test lib/fred.test.js
// CSV 樣本照 2026-09-28 實際抓的 fredgraph.csv 格式（DFF 的週末沒有列；缺值是「.」）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFredCsvLatest, buildFedTarget } = require('./fred');

test('parseFredCsvLatest：取最後一筆有數值的列', () => {
  const csv = 'observation_date,DFF\n2026-09-22,3.88\n2026-09-23,3.88\n2026-09-24,3.88\n';
  assert.deepEqual(parseFredCsvLatest(csv), { date: '2026-09-24', value: 3.88 });
});

test('parseFredCsvLatest：跳過缺值「.」、CRLF 也吃', () => {
  const csv = 'observation_date,DTB3\r\n2026-09-24,4.08\r\n2026-09-25,.\r\n';
  assert.deepEqual(parseFredCsvLatest(csv), { date: '2026-09-24', value: 4.08 });
});

test('parseFredCsvLatest：只有標題、HTML 錯誤頁、空字串都回 null', () => {
  assert.equal(parseFredCsvLatest('observation_date,DFF\n'), null);
  assert.equal(parseFredCsvLatest('<html><body>Error</body></html>'), null);
  assert.equal(parseFredCsvLatest(''), null);
});

test('buildFedTarget：上下限＋有效利率；上下限缺一個就不給', () => {
  const t = buildFedTarget(
    { date: '2026-09-27', value: 4 },
    { date: '2026-09-27', value: 3.75 },
    { date: '2026-09-24', value: 3.88 },
  );
  assert.deepEqual(t, { upper: 4, lower: 3.75, effective: 3.88, effective_date: '2026-09-24', as_of: '2026-09-27' });
  assert.equal(buildFedTarget(null, { date: '2026-09-27', value: 3.75 }, null), null);
  assert.equal(buildFedTarget({ date: '2026-09-27', value: 4 }, { date: '2026-09-27', value: 3.75 }, null).effective, null);
});
