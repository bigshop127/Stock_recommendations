// node --test lib/twse_credit.test.js
// 測資是 2026-09-26 從證交所實際抓下來的回應（lib/__fixtures__/twse_*.json）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  rocToIso,
  ymdToIso,
  parseCreditSeries,
  parseCreditHistory,
  parseDefaultDisclosures,
} = require('./twse_credit');

const fx = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', `twse_${name}.json`), 'utf-8'));

test('日期格式：西元 8 碼與民國年點／斜線', () => {
  assert.equal(ymdToIso('20260924'), '2026-09-24');
  assert.equal(ymdToIso('2026-09-24'), null);
  assert.equal(rocToIso('115.09.21'), '2026-09-21');
  assert.equal(rocToIso('115/09/21'), '2026-09-21');
  assert.equal(rocToIso('99.1.5'), '2010-01-05');
  assert.equal(rocToIso('總計'), null);
});

test('信用序列：兩條趨勢依日期合併、單位換成元', () => {
  const s = parseCreditSeries(fx('BFIJ3U_TREND'), fx('MI_MARGN_TREND'));
  // 融資趨勢 7/02 起、維持率 8/03 起 → 合併後從 7/02 開始，8/03 前沒有維持率
  assert.equal(s[0].date, '2026-07-02');
  assert.equal(s[0].keep_rate, null);
  assert.ok(s[0].margin_balance > 0);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].date < s[i].date, '要依日期遞增');

  const last = s[s.length - 1];
  assert.equal(last.date, '2026-09-24');
  assert.equal(last.keep_rate, 193.94);
  assert.equal(last.below_130_accounts, 145);
  assert.equal(last.disposal_accounts, 30);
  assert.equal(last.disposal_amount, 20787605);
  // 融資 615,103,402 千元 → 6,151.03 億；市值 1,570,759.99 億
  assert.equal(Math.round(last.margin_balance / 1e6) / 100, 6151.03);
  assert.equal(Math.round(last.market_value / 1e6) / 100, 1570759.99);
  assert.equal(last.short_shares, 202008);
  // 對得上儀表板顯示的「融資餘額占市值比重 0.39%」
  assert.equal(Math.round((last.margin_balance / last.market_value) * 10000) / 100, 0.39);

  const firstKeep = s.find((r) => r.keep_rate !== null);
  assert.equal(firstKeep.date, '2026-08-03');
});

test('信用序列：上游回錯誤訊息或缺資料時不炸、只回有的部分', () => {
  const bad = { stat: '很抱歉，沒有符合條件的資料!' };
  assert.deepEqual(parseCreditSeries(bad, bad), []);
  const onlyMargin = parseCreditSeries(bad, fx('MI_MARGN_TREND'));
  assert.equal(onlyMargin.length, 60);
  assert.ok(onlyMargin.every((r) => r.keep_rate === null));
  assert.deepEqual(parseCreditSeries(null, undefined), []);
});

test('年度歷史：2000 年起每年一筆', () => {
  const h = parseCreditHistory(fx('MI_MARGN_HISTORY'));
  assert.equal(h[0].year, '2000');
  assert.equal(h[0].margin_ratio, 2.31);
  assert.equal(h[h.length - 1].label, '2026/08');
  assert.equal(h.length, 27);
  assert.deepEqual(parseCreditHistory({ stat: 'x' }), []);
});

test('違約揭露：略過總計列、拆券商、新到舊排序', () => {
  const { items, daily } = parseDefaultDisclosures(fx('BFIGTU'));
  assert.ok(items.length > 0);
  assert.ok(items.every((it) => /^\d{4,6}[A-Z]?$/.test(it.code)), '不能混進總計列');
  assert.equal(items[0].date, '2026-09-21');
  assert.equal(items[0].code, '6213');
  assert.equal(items[0].name, '聯茂');
  assert.deepEqual(items[0].brokers, ['北城']);
  assert.equal(items[0].amount, 319306000);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].date >= items[i].date);
  // 同一檔可以多次上榜（2408 近一年上榜多次）
  assert.ok(items.filter((it) => it.code === '2408').length >= 2);
  // 多家券商：換行拆開、每家名稱內的排版空白拿掉
  const multi = items.find((it) => it.brokers.length > 1);
  assert.ok(multi && multi.brokers.every((b) => !/\s/.test(b)));

  assert.ok(daily.length > 200);
  const d = daily.find((r) => r.date === '2026-09-24');
  assert.deepEqual(d, { date: '2026-09-24', total_amount: 54462835, net_amount: 1973045, people: 16 });
});

test('違約揭露：當期沒有個股上榜、或上游錯誤時回空陣列', () => {
  const empty = {
    stat: 'OK',
    tables: [
      { fields: ['申報日期', '買進、賣出合計總金額', '買進、賣出相抵後金額', ''], data: [['115/09/22', '24,403,142', '183,242', '10']] },
      { fields: ['申報日期', '證券代號', '證券名稱', '證券商名稱', '個股違約總金額(註1)'], data: [] },
    ],
  };
  const r = parseDefaultDisclosures(empty);
  assert.deepEqual(r.items, []);
  assert.equal(r.daily.length, 1);
  assert.deepEqual(parseDefaultDisclosures({ stat: 'x' }), { items: [], daily: [] });
});
