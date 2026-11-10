/**
 * routes/inst_flow.js — 資金潮汐（法人資金流向）的資料端點（opt54，2026-11-10）。
 *
 *   GET /api/market/inst-flow?days=30&quotes=10
 *     → { dates（舊到新）, codes, names, days: [{ date, f, t, d, val, close, chg }], … }
 *       全部上市普通股、每天一列，f/t/d＝外資／投信／自營商買賣超金額（百萬元，估算值），
 *       val＝成交金額（百萬元）；close／chg（收盤價、漲跌幅 %）只有最後 quotes 天才帶。
 *       各陣列的 index 對齊 codes。族群怎麼分、泡泡怎麼畫都在前端（族群表只有前端那一份）。
 *
 * 跟 /api/market/inst-net 一樣由 gateway 自己抓、不經 engine。解析與整理在 lib/inst_flow.js（有測試）。
 *
 * 資料一天兩個請求（T86＋MI_INDEX），抓到就存 data/inst_flow/YYYY-MM-DD.json，之後不再重抓——
 * 例外是「當天起算三天內抓的」：法人數字事後可能更正，所以隔 12 小時會再抓一次 T86 重算
 * （行情不重抓）。沒開盤的日子記在 _state.json，也不再問。
 *
 * 第一次使用要回補 30 個交易日（約 60 個請求、每 2 秒一個，兩分鐘多），所以：
 *   - 端點永遠立刻回應手上有的資料，回補在背景跑，回應裡的 refreshing／have／want 讓前端顯示進度；
 *   - 用過一次之後（_state.json 的 activated）開機 8 秒與之後每 20 分鐘自己檢查要不要補，
 *     平常只有收盤後補當天那一筆，打開頁面不用等。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { sendError } = require('../lib/errors');
const { twseSlot } = require('../lib/twse_gate');
const F = require('../lib/inst_flow');

const router = express.Router();

const TWSE_RWD = process.env.TWSE_RWD_BASE || 'https://www.twse.com.tw/rwd/zh';
const STORE_DIR = process.env.INST_FLOW_DIR || path.join(__dirname, '..', 'data', 'inst_flow');
const STATE_PATH = path.join(STORE_DIR, '_state.json');

const WANT_DAYS = 30;                       // 10 天播放 × 每天要往前 20 天（近 20 日累計）
const MAX_DAYS = 60;
const LOAD_NEWEST = 90;                     // 開機只載最近這麼多個日檔，更舊的留在磁碟
const LOOKBACK_CALENDAR_DAYS = 75;          // 30 個交易日約 44 個日曆天，留連假的餘裕
const GAP_MS = 2000;                        // 證交所請求間隔
const TODAY_OPEN_MINUTES = 15 * 60 + 30;    // 台北 15:30 之後才問當天的（T86 約 16 點多產出）
const TODAY_RETRY_MS = 10 * 60 * 1000;
const REVISE_STALE_MS = 12 * 3600 * 1000;
const TICK_MS = 20 * 60 * 1000;

const errMsg = (e) => String((e && e.message) || e);
/** 台北現在：日期 YYYY-MM-DD 與當天第幾分鐘（VM 在 UTC，自己加 8 小時） */
function tpeNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// ── 磁碟存檔 ──────────────────────────────────────────────────────────
const days = new Map();              // 'YYYY-MM-DD' → 日紀錄（含 fetched_at 毫秒）
let state = { activated: false, nodata: {} };
let loaded = false;
let version = 0;                     // 有新日檔／更正就 +1，打包快取靠它判斷

function loadStore() {
  if (loaded) return;
  loaded = true;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    state = { activated: !!s.activated, nodata: s.nodata && typeof s.nodata === 'object' ? s.nodata : {} };
  } catch { /* 第一次用，沒有狀態檔 */ }
  let files = [];
  try {
    files = fs.readdirSync(STORE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-LOAD_NEWEST);
  } catch { /* 資料夾還沒建 */ }
  for (const f of files) {
    try {
      const day = JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf-8'));
      if (F.isValidDay(day) && `${day.date}.json` === f && Number.isFinite(day.fetched_at)) days.set(day.date, day);
    } catch { /* 壞檔當沒有，之後會重抓 */ }
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[inst-flow] 存檔失敗:', errMsg(e));
  }
}
const saveState = () => writeJson(STATE_PATH, state);
function putDay(day) {
  days.set(day.date, day);
  version += 1;
  writeJson(path.join(STORE_DIR, `${day.date}.json`), day);
}

// ── 抓資料 ────────────────────────────────────────────────────────────
async function twseJson(pathAndQuery) {
  await twseSlot(GAP_MS);
  const r = await fetch(`${TWSE_RWD}${pathAndQuery}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; puhui-review-web/1.0)' },
    signal: AbortSignal.timeout(40000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${pathAndQuery.split('?')[0]}`);
  return r.json();
}

async function fetchInst(iso) {
  const p = F.parseT86Inst(await twseJson(`/fund/T86?date=${F.isoYmd(iso)}&selectType=ALLBUT0999&response=json`));
  if (p.noData) return null;
  if (p.date !== iso) throw new Error(`T86 回的日期是 ${p.date}，不是 ${iso}`);
  return p.inst;
}

/** 回日紀錄；沒開盤／還沒產出回 null */
async function fetchDay(iso) {
  const inst = await fetchInst(iso);
  if (!inst) return null;
  const mi = F.parseMiQuotes(await twseJson(`/afterTrading/MI_INDEX?date=${F.isoYmd(iso)}&type=ALLBUT0999&response=json`));
  if (mi.noData) throw new Error('有法人日報但沒有收盤行情');
  if (mi.date !== iso) throw new Error(`MI_INDEX 回的日期是 ${mi.date}，不是 ${iso}`);
  return { ...F.buildFlowDay(iso, inst, mi.quotes), fetched_at: Date.now() };
}

// ── 回補／更新（同時只跑一輪）────────────────────────────────────────────
let refreshing = null;
let lastRun = { at: 0, errors: [] };

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    loadStore();
    const errors = [];
    let have = 0;
    let failsInARow = 0;
    for (const iso of F.weekdaysBack(tpeNow().date, LOOKBACK_CALENDAR_DAYS)) {
      if (have >= WANT_DAYS) break;
      const stored = days.get(iso);
      if (stored) {
        have += 1;
        if (!F.isFinalFetch(iso, stored.fetched_at) && Date.now() - stored.fetched_at > REVISE_STALE_MS) {
          try {
            const inst = await fetchInst(iso);
            if (inst) putDay({ ...F.applyInst(stored, inst), fetched_at: Date.now() });
          } catch (e) {
            errors.push(`${iso} 更正值：${errMsg(e)}`);
          }
        }
        continue;
      }
      const now = tpeNow();
      if (iso === now.date && now.minutes < TODAY_OPEN_MINUTES) continue;
      const nd = state.nodata[iso];
      if (nd && (nd.final || Date.now() - nd.at < TODAY_RETRY_MS)) continue;
      try {
        const day = await fetchDay(iso);
        if (day) {
          putDay(day);
          have += 1;
        } else {
          // 過去的日子沒資料＝沒開盤，記住不再問；當天沒資料只是還沒產出，過一陣子再問
          state.nodata[iso] = { at: Date.now(), final: iso < tpeNow().date };
          saveState();
          version += 1; // 「這天沒開盤」確定後，連續區間可能接得更長，打包快取要重算
        }
        failsInARow = 0;
      } catch (e) {
        errors.push(`${iso}：${errMsg(e)}`);
        failsInARow += 1;
        // 連續兩天都抓不到多半是被證交所擋或斷線，這一輪先停，下一輪再接著補
        if (failsInARow >= 2) break;
      }
    }
    lastRun = { at: Date.now(), errors };
    if (errors.length) console.warn('[inst-flow] 這一輪有抓不到的：', errors.join('；'));
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * 手上連續不斷的那一段（新到舊走，遇到「不知道有沒有開盤」的日子就停），回舊到新。
 * 中間有洞的話 5 日累計會算錯，寧可少給幾天。
 */
function contiguousDays(limit) {
  const newest = [...days.keys()].sort().pop();
  if (!newest) return [];
  const out = [];
  for (const iso of F.weekdaysBack(newest, LOOKBACK_CALENDAR_DAYS + 60)) {
    if (out.length >= limit) break;
    const day = days.get(iso);
    if (day) out.push(day);
    else if (!(state.nodata[iso] && state.nodata[iso].final)) break;
  }
  return out.reverse();
}

let packCache = { key: '', data: null };

router.get('/api/market/inst-flow', async (req, res) => {
  try {
    loadStore();
    if (!state.activated) {
      state.activated = true;
      saveState();
    }
    // 不等：有什麼先回什麼。剛跑過（一分鐘內）就不再起新的一輪
    if (!refreshing && Date.now() - lastRun.at > 60 * 1000) {
      refresh().catch((e) => console.warn('[inst-flow] 更新失敗:', errMsg(e)));
    }

    const want = Math.min(MAX_DAYS, Math.max(1, parseInt(req.query.days, 10) || WANT_DAYS));
    const quoteDays = Math.min(want, Math.max(1, parseInt(req.query.quotes, 10) || 10));
    const key = `${version}|${want}|${quoteDays}`;
    if (packCache.key !== key) {
      const window = contiguousDays(want);
      packCache = {
        key,
        data: {
          ...F.packWindow(window, quoteDays),
          fetched_at: window.length ? new Date(Math.max(...window.map((d) => d.fetched_at))).toISOString() : null,
        },
      };
    }
    const body = JSON.stringify({
      ...packCache.data,
      have: packCache.data.dates.length,
      want,
      refreshing: !!refreshing,
      errors: lastRun.errors.length ? lastRun.errors : undefined,
      unit: { amount: '百萬元', chg: '%' },
      source: 'twse-T86+MI_INDEX',
      note: '金額＝買賣超股數 × 當日成交均價（估算）；範圍為上市普通股',
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    // 一包約 700KB，沒有全域壓縮中介層，這裡自己壓（手機走 Tailscale 差很多）
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      const gz = await new Promise((resolve, reject) => {
        zlib.gzip(body, (err, buf) => (err ? reject(err) : resolve(buf)));
      });
      res.setHeader('Content-Encoding', 'gzip');
      return res.end(gz);
    }
    return res.end(body);
  } catch (err) {
    return sendError(res, err);
  }
});

// 用過這一頁的機器才在背景自己更新（沒用過的，例如只跑期貨頁的本機 gateway，不必白打證交所）
function tick() {
  loadStore();
  if (state.activated) refresh().catch((e) => console.warn('[inst-flow] 背景更新失敗:', errMsg(e)));
}
if (process.env.INST_FLOW_NO_TIMER !== '1') {
  setTimeout(tick, 8000).unref();
  setInterval(tick, TICK_MS).unref();
}

module.exports = router;
