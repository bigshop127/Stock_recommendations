/**
 * twse_inst.js — 證交所「三大法人買賣超日報」（T86）的純解析（不發請求，方便測試）。
 *
 *   https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALLBUT0999&response=json
 *   欄位：證券代號、證券名稱、外陸資…、投信…、自營商…、三大法人買賣超股數（單位：股）
 *   沒開盤或還沒產出時 stat 是「很抱歉，沒有符合條件的資料!」
 *
 * 資料夾卡片牆（opt45）原本每張卡各打一次個股籌碼（engine 背後是三支 FinMind：法人、融資券、
 * 外資持股），一個 20 檔的資料夾一天就吃掉 60 次 FinMind 額度。T86 一天一個請求涵蓋全部上市，
 * 卡片牆的「法人 5 日」改用它；上櫃不在這張表，前端照舊逐檔抓。
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

/**
 * T86 回應 → { date: 'YYYY-MM-DD', net: { [code]: 股數 } }
 * 當天沒有資料（假日、還沒產出）回 { date: null, net: null, noData: true }；
 * 格式不認得（改版、被擋回 HTML 轉的 JSON）丟錯，讓呼叫端不要把它當成「沒開盤」快取起來。
 */
function parseT86(body) {
  if (!body || typeof body !== 'object') throw new Error('T86 回應不是 JSON 物件');
  const stat = String(body.stat || '');
  if (stat.toUpperCase() !== 'OK') {
    if (stat.includes('沒有符合條件')) return { date: null, net: null, noData: true };
    throw new Error(`T86 stat=${stat || '(空)'}`);
  }
  if (!Array.isArray(body.fields) || !Array.isArray(body.data)) throw new Error('T86 缺 fields/data');
  const iCode = body.fields.indexOf('證券代號');
  const iNet = body.fields.indexOf('三大法人買賣超股數');
  if (iCode < 0 || iNet < 0) throw new Error('T86 欄位改版：找不到證券代號或三大法人買賣超股數');
  const net = {};
  for (const r of body.data) {
    const code = String(r[iCode] || '').trim();
    const v = num(r[iNet]);
    if (code && v !== null) net[code] = v;
  }
  const date = /^\d{8}$/.test(String(body.date || '')) ? ymdIso(String(body.date)) : null;
  return { date, net, noData: false };
}

/**
 * 多天加總：days＝[{ date, net }]（新到舊，只放有資料的交易日）；codes 為空＝全部。
 * 回 { [code]: { net_lots, days } }——net_lots 換成張（÷1000，跟個股頁籌碼同單位），
 * days＝這檔實際有幾天資料（新上市、暫停交易會少於請求天數）。整段都沒出現的代號不列。
 */
function sumInstNet(days, codes) {
  const want = codes && codes.length ? codes : null;
  const out = {};
  const pool = want || [...new Set(days.flatMap((d) => Object.keys(d.net)))];
  for (const code of pool) {
    let sum = 0;
    let n = 0;
    for (const d of days) {
      const v = d.net[code];
      if (typeof v === 'number') {
        sum += v;
        n += 1;
      }
    }
    if (n > 0) out[code] = { net_lots: Math.round(sum / 1000), days: n };
  }
  return out;
}

module.exports = { parseT86, sumInstNet, ymdIso };
