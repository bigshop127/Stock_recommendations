/**
 * twse_gate.js — 證交所「逐日報表」請求的共用排隊閘門。
 *
 * 證交所對同一 IP 短時間內大量請求會暫時封鎖。三大法人日報（T86）、每日收盤行情（MI_INDEX）這類
 * 要一天一天回補的請求全部排同一條隊：前一個「開始」之後至少隔 gapMs 才放下一個，
 * 不管是哪一條路由要的（資料夾卡片牆的法人 5 日、資金潮汐的回補）。
 */
'use strict';

let tail = Promise.resolve();
let lastStart = 0;

/** await twseSlot() 之後才發請求；回傳的 promise 不會 reject */
function twseSlot(gapMs = 1500) {
  const turn = tail.then(async () => {
    const wait = lastStart + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  tail = turn;
  return turn;
}

module.exports = { twseSlot };
