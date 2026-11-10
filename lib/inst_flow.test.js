// node --test lib/inst_flow.test.js
// 測資是 2026-11-10 實際抓的 T86 與 MI_INDEX（只留幾檔：台泥、鴻海、台積電、沒成交的台揚、
// 兩檔 ETF、一檔特別股），沒資料那天沿用 twse_t86_nodata.json。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  parseT86Inst,
  parseMiQuotes,
  buildFlowDay,
  applyInst,
  packWindow,
  isValidDay,
  isFinalFetch,
  weekdaysBack,
  isCommonStock,
} = require('./inst_flow');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf-8'));
const t86 = () => fixture('twse_t86_inst.json');
const mi = () => fixture('twse_mi_index_quotes.json');

test('parseT86Inst：外資／投信／自營商分開取，三者相加＝三大法人買賣超', () => {
  const body = t86();
  const r = parseT86Inst(body);
  assert.equal(r.noData, false);
  assert.equal(r.date, '2026-11-10');
  assert.deepEqual(r.inst['2330'], [-8181770, 5634335, -766472]);
  assert.deepEqual(r.inst['1101'], [8275972, -4058000, -415095]);
  const iNet = body.fields.indexOf('三大法人買賣超股數');
  for (const row of body.data) {
    const [f, t, d] = r.inst[row[0].trim()];
    assert.equal(f + t + d, Number(String(row[iNet]).replace(/,/g, '')));
  }
});

test('parseT86Inst：外資自營商要併進外資', () => {
  const body = t86();
  const iFd = body.fields.indexOf('外資自營商買賣超股數');
  body.data.find((r) => r[0].trim() === '2317')[iFd] = '1,000';
  assert.equal(parseT86Inst(body).inst['2317'][0], 2303453 + 1000);
});

test('parseT86Inst：沒有「自營商買賣超股數」合計欄時用自行買賣＋避險', () => {
  const body = t86();
  const i = body.fields.indexOf('自營商買賣超股數');
  body.fields[i] = '（改名）';
  assert.equal(parseT86Inst(body).inst['2330'][2], -766472);
});

test('parseT86Inst：沒開盤＝noData；格式不認得要丟錯', () => {
  assert.deepEqual(parseT86Inst(fixture('twse_t86_nodata.json')), { date: null, inst: null, noData: true });
  assert.throws(() => parseT86Inst(null));
  assert.throws(() => parseT86Inst({ stat: '查詢日期大於今日，請重新查詢!' }));
  assert.throws(() => parseT86Inst({ stat: 'OK', fields: ['證券代號'], data: [] }));
});

test('parseMiQuotes：只留普通股，漲跌幅用收盤與漲跌價差還原', () => {
  const r = parseMiQuotes(mi());
  assert.equal(r.date, '2026-11-10');
  assert.deepEqual(Object.keys(r.quotes).sort(), ['1101', '2314', '2317', '2330']);
  assert.deepEqual(r.quotes['2330'], { name: '台積電', close: 2285, chg: 2.24, vol: 36575797, val: 82847295812 });
  assert.equal(r.quotes['1101'].chg, 1.87); // 27.30，漲 0.50 → 前一天 26.80
  // 沒成交：收盤價是 --
  assert.deepEqual(r.quotes['2314'], { name: '台揚', close: null, chg: null, vol: 0, val: 0 });
});

test('parseMiQuotes：下跌取負號、平盤 0、除權息（X）不比價', () => {
  const body = mi();
  const table = body.tables[1];
  const iDir = table.fields.indexOf('漲跌(+/-)');
  const row = (code) => table.data.find((r) => r[0] === code);
  row('2330')[iDir] = '<p style= color:green>-</p>';
  row('2317')[iDir] = '<p> </p>';
  row('1101')[iDir] = '<p>X</p>';
  const q = parseMiQuotes(body).quotes;
  assert.equal(q['2330'].chg, -2.14); // 2285，跌 50 → 前一天 2335
  assert.equal(q['2317'].chg, 0);
  assert.equal(q['1101'].chg, null);
});

test('parseMiQuotes：沒資料＝noData；找不到收盤行情表要丟錯', () => {
  assert.equal(parseMiQuotes({ stat: '很抱歉，沒有符合條件的資料!' }).noData, true);
  assert.throws(() => parseMiQuotes({ stat: 'OK', tables: [{ title: '大盤統計資訊', fields: [], data: [] }] }));
  assert.throws(() => parseMiQuotes('<html>'));
});

test('buildFlowDay：金額＝股數 × 成交均價，單位百萬元；法人沒進出的記 0', () => {
  const day = buildFlowDay('2026-11-10', parseT86Inst(t86()).inst, parseMiQuotes(mi()).quotes);
  assert.deepEqual(day.codes, ['1101', '2314', '2317', '2330']);
  assert.ok(isValidDay(day));
  const i = day.codes.indexOf('2330');
  // 均價 82,847,295,812 ÷ 36,575,797 ≈ 2265.0852；外資 −8,181,770 股 ≈ −185.3 億
  assert.equal(day.px[i], 2265.0852);
  assert.equal(day.f[i], -18532);
  assert.equal(day.t[i], 12762);
  assert.equal(day.d[i], -1736);
  assert.equal(day.val[i], 82847);
  assert.equal(day.names[i], '台積電');
  // 台揚當天沒成交、T86 也沒列
  const j = day.codes.indexOf('2314');
  assert.deepEqual([day.f[j], day.t[j], day.d[j], day.val[j], day.close[j], day.px[j]], [0, 0, 0, 0, null, 0]);
});

test('applyInst：法人數字更正後重算金額，行情不動、不改原物件', () => {
  const inst = parseT86Inst(t86()).inst;
  const day = buildFlowDay('2026-11-10', inst, parseMiQuotes(mi()).quotes);
  const fixed = applyInst(day, { ...inst, 2330: [1000000, 0, 0] });
  const i = day.codes.indexOf('2330');
  assert.equal(fixed.f[i], 2265);
  assert.equal(fixed.t[i], 0);
  assert.equal(day.f[i], -18532);
  assert.equal(fixed.close, day.close);
});

test('packWindow：各天對齊同一條代號，缺的補 0／null，行情只帶最後幾天', () => {
  const mk = (date, codes, base) => ({
    date,
    codes,
    names: codes.map((c) => `名${c}${date.slice(-2)}`),
    f: codes.map((_, i) => base + i),
    t: codes.map(() => 1),
    d: codes.map(() => -1),
    val: codes.map(() => 5),
    close: codes.map(() => 10),
    chg: codes.map(() => 0.5),
    px: codes.map(() => 10),
  });
  const p = packWindow([
    mk('2026-11-06', ['1101', '2330'], 100),
    mk('2026-11-09', ['2330', '6999'], 200),
    mk('2026-11-10', ['1101', '2330', '6999'], 300),
  ], 2);
  assert.deepEqual(p.dates, ['2026-11-06', '2026-11-09', '2026-11-10']);
  assert.deepEqual(p.codes, ['1101', '2330', '6999']);
  assert.deepEqual(p.days[0].f, [100, 101, 0]);
  assert.deepEqual(p.days[1].f, [0, 200, 201]);
  assert.deepEqual(p.days[2].f, [300, 301, 302]);
  assert.equal(p.days[0].close, null); // 三天只帶最後兩天的行情
  assert.deepEqual(p.days[1].close, [null, 10, 10]);
  assert.deepEqual(p.days[1].chg, [null, 0.5, 0.5]);
  assert.deepEqual(p.names, ['名110110', '名233010', '名699910']); // 名字取最新一天的
  assert.equal(p.days[0].px, undefined); // 估價用的均價不外送
});

test('isValidDay：欄位長度對不上、缺欄位都不算', () => {
  const day = buildFlowDay('2026-11-10', parseT86Inst(t86()).inst, parseMiQuotes(mi()).quotes);
  assert.equal(isValidDay({ ...day, f: day.f.slice(1) }), false);
  assert.equal(isValidDay({ ...day, px: undefined }), false);
  assert.equal(isValidDay({ ...day, date: '20261110' }), false);
  assert.equal(isValidDay(null), false);
});

test('isFinalFetch：當天起算滿三天才算定案', () => {
  const at = (s) => Date.parse(s);
  assert.equal(isFinalFetch('2026-11-10', at('2026-11-10T17:00:00+08:00')), false);
  assert.equal(isFinalFetch('2026-11-10', at('2026-11-12T23:59:00+08:00')), false);
  assert.equal(isFinalFetch('2026-11-10', at('2026-11-13T00:00:00+08:00')), true);
});

test('weekdaysBack：新到舊、跳過週末', () => {
  // 2026-11-10 是週二
  assert.deepEqual(weekdaysBack('2026-11-10', 7), ['2026-11-10', '2026-11-09', '2026-11-06', '2026-11-05', '2026-11-04']);
});

test('isCommonStock：ETF、特別股、六碼的都不算', () => {
  assert.deepEqual(['2330', '0050', '00878', '2881A', '020012', '9105'].map(isCommonStock), [true, false, false, false, false, true]);
});
