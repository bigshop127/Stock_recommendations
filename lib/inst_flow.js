/**
 * inst_flow.js — 資金潮汐（法人資金流向）用的純解析與整理（不發請求、不碰磁碟，方便測試）。
 *
 * 兩張證交所日報合成「每檔股票每天、三大法人各買賣超多少錢」：
 *   T86       https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALLBUT0999&response=json
 *             三大法人買賣超日報，單位是「股」，外資／投信／自營商分欄
 *   MI_INDEX  https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json
 *             每日收盤行情：成交股數、成交金額、收盤價、漲跌
 *
 * 證交所沒有公布「個股的法人買賣超金額」，所以金額＝買賣超股數 × 當日成交均價（成交金額 ÷ 成交股數；
 * 沒有成交均價才退收盤價）。這是估算值，跟券商軟體各自估的數字會有小落差。
 *
 * 一天的資料整理成「欄位陣列」（codes 一條、各數值各一條，index 對齊），比一檔一個物件省一半以上的傳輸量。
 * 金額單位一律「百萬元」（0.01 億）取整數。
 */
'use strict';

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 'YYYYMMDD' → 'YYYY-MM-DD' */
const ymdIso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
/** 'YYYY-MM-DD' → 'YYYYMMDD' */
const isoYmd = (s) => s.replace(/-/g, '');

/** 普通股：四碼數字、不是 00 開頭（ETF）。特別股（2881A）、六碼 ETF／存託憑證都不算 */
const isCommonStock = (code) => /^\d{4}$/.test(code) && !code.startsWith('00');

const isNoData = (stat) => String(stat || '').includes('沒有符合條件');

/**
 * T86 → { date, inst: { [code]: [外資股數, 投信股數, 自營商股數] }, noData }
 * 外資＝外陸資（不含外資自營商）＋外資自營商；自營商＝自行買賣＋避險。
 * 沒開盤／還沒產出回 noData:true；格式不認得丟錯（不能被當成沒開盤記起來）。
 */
function parseT86Inst(body) {
  if (!body || typeof body !== 'object') throw new Error('T86 回應不是 JSON 物件');
  const stat = String(body.stat || '');
  if (stat.toUpperCase() !== 'OK') {
    if (isNoData(stat)) return { date: null, inst: null, noData: true };
    throw new Error(`T86 stat=${stat || '(空)'}`);
  }
  const fields = body.fields;
  if (!Array.isArray(fields) || !Array.isArray(body.data)) throw new Error('T86 缺 fields/data');
  const idx = (name) => fields.indexOf(name);
  const iCode = idx('證券代號');
  const iForeign = idx('外陸資買賣超股數(不含外資自營商)') >= 0 ? idx('外陸資買賣超股數(不含外資自營商)') : idx('外資買賣超股數');
  const iForeignDealer = idx('外資自營商買賣超股數');
  const iTrust = idx('投信買賣超股數');
  const iDealer = idx('自營商買賣超股數');
  const iDealerSelf = idx('自營商買賣超股數(自行買賣)');
  const iDealerHedge = idx('自營商買賣超股數(避險)');
  if (iCode < 0 || iForeign < 0 || iTrust < 0 || (iDealer < 0 && iDealerSelf < 0)) {
    throw new Error('T86 欄位改版：找不到證券代號或外資／投信／自營商買賣超股數');
  }
  const inst = {};
  for (const r of body.data) {
    const code = String(r[iCode] || '').trim();
    if (!code) continue;
    const f = (num(r[iForeign]) || 0) + (iForeignDealer >= 0 ? num(r[iForeignDealer]) || 0 : 0);
    const t = num(r[iTrust]) || 0;
    const d = iDealer >= 0
      ? num(r[iDealer]) || 0
      : (num(r[iDealerSelf]) || 0) + (iDealerHedge >= 0 ? num(r[iDealerHedge]) || 0 : 0);
    inst[code] = [f, t, d];
  }
  const date = /^\d{8}$/.test(String(body.date || '')) ? ymdIso(String(body.date)) : null;
  return { date, inst, noData: false };
}

/**
 * MI_INDEX（ALLBUT0999）→ { date, quotes: { [code]: { name, close, chg, vol, val } }, noData }
 * 只留普通股。chg＝漲跌幅 %（除權息當天證交所標 X、不比價 → null）；vol＝成交股數、val＝成交金額（元）。
 */
function parseMiQuotes(body) {
  if (!body || typeof body !== 'object') throw new Error('MI_INDEX 回應不是 JSON 物件');
  const stat = String(body.stat || '');
  if (stat.toUpperCase() !== 'OK') {
    if (isNoData(stat)) return { date: null, quotes: null, noData: true };
    throw new Error(`MI_INDEX stat=${stat || '(空)'}`);
  }
  const table = (Array.isArray(body.tables) ? body.tables : []).find(
    (t) => t && typeof t.title === 'string' && t.title.includes('每日收盤行情'),
  );
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data)) {
    throw new Error('MI_INDEX 找不到「每日收盤行情」表');
  }
  const idx = (name) => table.fields.indexOf(name);
  const iCode = idx('證券代號');
  const iName = idx('證券名稱');
  const iVol = idx('成交股數');
  const iVal = idx('成交金額');
  const iClose = idx('收盤價');
  const iDir = idx('漲跌(+/-)');
  const iDiff = idx('漲跌價差');
  if ([iCode, iName, iVol, iVal, iClose, iDir, iDiff].some((i) => i < 0)) {
    throw new Error('MI_INDEX 欄位改版：每日收盤行情缺欄位');
  }
  const quotes = {};
  for (const r of table.data) {
    const code = String(r[iCode] || '').trim();
    if (!isCommonStock(code)) continue;
    const close = num(r[iClose]);
    const diff = num(r[iDiff]);
    // 漲跌欄是 <p style= color:red>+</p> 這種 HTML，先去掉標籤再看符號
    const dir = String(r[iDir] || '').replace(/<[^>]+>/g, '').trim();
    let chg = null;
    if (close !== null && close > 0 && diff !== null && !dir.includes('X')) {
      const signed = dir.includes('-') ? -diff : dir.includes('+') ? diff : 0;
      const prev = close - signed;
      chg = prev > 0 ? Math.round((signed / prev) * 10000) / 100 : null;
    }
    quotes[code] = {
      name: String(r[iName] || '').trim(),
      close: close !== null && close > 0 ? close : null,
      chg,
      vol: num(r[iVol]) || 0,
      val: num(r[iVal]) || 0,
    };
  }
  const date = /^\d{8}$/.test(String(body.date || '')) ? ymdIso(String(body.date)) : null;
  return { date, quotes, noData: false };
}

const toMillion = (v) => Math.round(v / 1e6);

/**
 * 一天的兩張表 → 存檔用的日紀錄（欄位陣列，依代號排序）：
 *   { date, codes, names, f, t, d, val, close, chg, px }
 *   f/t/d＝外資／投信／自營商買賣超金額（百萬元）；val＝成交金額（百萬元）；
 *   px＝估金額用的價格（成交均價，沒成交退收盤價）——留著是為了日後重抓 T86 更正值時不必再抓行情。
 * 範圍＝當天收盤行情裡的全部普通股；T86 沒列到的（法人當天沒進出）金額記 0。
 */
function buildFlowDay(date, inst, quotes) {
  const codes = Object.keys(quotes).sort();
  const out = { date, codes, names: [], f: [], t: [], d: [], val: [], close: [], chg: [], px: [] };
  for (const code of codes) {
    const q = quotes[code];
    const px = q.vol > 0 && q.val > 0 ? q.val / q.vol : q.close || 0;
    out.names.push(q.name);
    out.val.push(toMillion(q.val));
    out.close.push(q.close);
    out.chg.push(q.chg);
    out.px.push(Math.round(px * 10000) / 10000);
  }
  return applyInst(out, inst);
}

/** 用（新的）T86 股數重算一天的 f/t/d；行情欄位原樣沿用。回傳新物件，不改原本那份 */
function applyInst(day, inst) {
  const f = [];
  const t = [];
  const d = [];
  for (let i = 0; i < day.codes.length; i++) {
    const row = inst[day.codes[i]];
    const px = day.px[i] || 0;
    f.push(row ? toMillion(row[0] * px) : 0);
    t.push(row ? toMillion(row[1] * px) : 0);
    d.push(row ? toMillion(row[2] * px) : 0);
  }
  return { ...day, f, t, d };
}

/**
 * 多天（舊到新）→ 給前端的一包：所有天共用同一條 codes，各天的數值陣列對齊到它。
 * 某天沒有這檔（還沒上市、已下市）金額補 0、行情補 null。
 * close／chg 只有畫面會顯示的最後 quoteDays 天才帶（其他天給 null），省傳輸量。
 */
function packWindow(daysAsc, quoteDays = 10) {
  const codeSet = new Set();
  for (const day of daysAsc) for (const c of day.codes) codeSet.add(c);
  const codes = [...codeSet].sort();
  const pos = new Map(codes.map((c, i) => [c, i]));
  const names = new Array(codes.length).fill('');
  const days = daysAsc.map((day, di) => {
    const withQuotes = di >= daysAsc.length - quoteDays;
    const n = codes.length;
    const o = {
      date: day.date,
      f: new Array(n).fill(0),
      t: new Array(n).fill(0),
      d: new Array(n).fill(0),
      val: new Array(n).fill(0),
      close: withQuotes ? new Array(n).fill(null) : null,
      chg: withQuotes ? new Array(n).fill(null) : null,
    };
    for (let i = 0; i < day.codes.length; i++) {
      const p = pos.get(day.codes[i]);
      o.f[p] = day.f[i];
      o.t[p] = day.t[i];
      o.d[p] = day.d[i];
      o.val[p] = day.val[i];
      if (withQuotes) {
        o.close[p] = day.close[i];
        o.chg[p] = day.chg[i];
      }
      if (day.names[i]) names[p] = day.names[i]; // 舊到新跑，最後留下的是最新的名字
    }
    return o;
  });
  return { dates: daysAsc.map((d) => d.date), codes, names, days };
}

/** 存下來的日紀錄長得對不對（磁碟檔壞掉、舊格式都當沒有，重抓） */
function isValidDay(day) {
  if (!day || typeof day !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) return false;
  if (!Array.isArray(day.codes) || !day.codes.length) return false;
  return ['names', 'f', 't', 'd', 'val', 'close', 'chg', 'px'].every(
    (k) => Array.isArray(day[k]) && day[k].length === day.codes.length,
  );
}

const DAY_MS = 86400 * 1000;

/**
 * 這天的法人資料算不算定案：抓的時間距離當天（台北 00:00）滿 3 天以上。
 * 當晚公布的數字事後可能更正，所以三天內抓的都還會再重抓。
 */
function isFinalFetch(dateIso, fetchedAtMs) {
  const dayStart = Date.parse(`${dateIso}T00:00:00+08:00`);
  return Number.isFinite(dayStart) && fetchedAtMs - dayStart >= 3 * DAY_MS;
}

/** 從 fromIso 往回數的平日（新到舊，含 fromIso），最多 maxCalendarDays 個日曆天 */
function weekdaysBack(fromIso, maxCalendarDays) {
  const out = [];
  const base = Date.parse(`${fromIso}T00:00:00Z`);
  for (let i = 0; i < maxCalendarDays; i++) {
    const d = new Date(base - i * DAY_MS);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

module.exports = {
  parseT86Inst,
  parseMiQuotes,
  buildFlowDay,
  applyInst,
  packWindow,
  isValidDay,
  isFinalFetch,
  weekdaysBack,
  isCommonStock,
  ymdIso,
  isoYmd,
};
