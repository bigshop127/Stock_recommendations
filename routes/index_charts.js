/**
 * routes/index_charts.js — 大盤頁指數方塊的線圖＋距高低點資料（opt53，2026-11-08）。
 *
 *   GET /api/market/index-history   九檔日收盤（近兩年）＋歷史最高，30 分鐘快取
 *   GET /api/market/index-intraday  九檔當日分時，有市場在交易時 1 分鐘快取、否則 10 分鐘
 *
 * 跟 /api/market/global-indices 一樣由 gateway 自己抓、不經 engine。各資料源說明見 lib/index_history.js。
 * 一檔抓不到只標 ok:false，不擋其他檔。
 *
 * 櫃買指數、台指期的歷史要一個月一個月抓，第一次補兩年（約 25 次請求），之後存在
 * data/index_history.json、只補最新的月份。這兩檔的「歷史最高」就用存下來的資料算：
 * 2026-11-08 查過，櫃買在 2024-11 以前最高約 297（2000/03），台指期 2024 年以前沒超過 25,000，
 * 都比存下來這段的高點低很多，所以存下來這段的最高點就是歷史最高。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { sendError, httpError } = require('../lib/errors');
const h = require('../lib/index_history');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'index_history.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YF_HOSTS = ['query1', 'query2'];

const DAILY_TTL_MS = 30 * 60 * 1000;
const ATH_TTL_MS = 24 * 3600 * 1000;
const INTRADAY_OPEN_TTL_MS = 60 * 1000;
const INTRADAY_CLOSED_TTL_MS = 10 * 60 * 1000;
const BACKFILL_MONTHS = 24;
const SEND_YEARS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tpeToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const yearsAgo = (iso, n) => `${Number(iso.slice(0, 4)) - n}${iso.slice(4)}`;
function monthsAgo(iso, n) {
  let y = Number(iso.slice(0, 4));
  let m = Number(iso.slice(5, 7)) - n;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}
const errMsg = (e) => String((e && e.message) || e);

// ── 磁碟存檔：櫃買／台指期的日收盤、Yahoo 各檔的歷史最高 ─────────────────────
let store = null;
let storeDirty = false;
function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    store = {};
  }
  store.series = store.series || {};
  store.ath = store.ath || {};
  return store;
}
function saveStore() {
  if (!storeDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
    storeDirty = false;
  } catch (e) {
    console.error('[index-history] 存檔失敗:', errMsg(e));
  }
}

// ── 抓資料 ──────────────────────────────────────────────────────────────────
async function fetchYahoo(symbol, query) {
  const enc = encodeURIComponent(symbol);
  let lastErr;
  for (const host of YF_HOSTS) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${enc}?${query}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

async function tpexMonth(monthStart) {
  const [y, m] = monthStart.split('-');
  const url = `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${y}%2F${m}%2F01&response=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`櫃買中心 HTTP ${r.status}`);
  return h.parseTpexMonth(await r.json());
}

async function taifexMonth(monthStart) {
  const today = tpeToday();
  const end = h.monthEnd(monthStart) < today ? h.monthEnd(monthStart) : today;
  const body = new URLSearchParams({
    down_type: '1', commodity_id: 'TX', commodity_id2: '',
    queryStartDate: monthStart.replace(/-/g, '/'), queryEndDate: end.replace(/-/g, '/'),
  });
  const r = await fetch('https://www.taifex.com.tw/cht/3/futDataDown', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.taifex.com.tw/cht/3/futDataDown',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`期交所 HTTP ${r.status}`);
  const text = new TextDecoder('big5').decode(Buffer.from(await r.arrayBuffer()));
  return h.parseTaifexDailyCsv(text);
}

/**
 * 一個月一個月抓的資料（櫃買、台指期）：沒有存檔或上次沒補完 → 補兩年；否則只抓最後一筆那個月到這個月。
 * 有一個月失敗就記成沒補完，下次再整段補（已存的會合併，不會重複）。
 */
const monthlyInflight = {};
function refreshMonthly(kind, fetchMonth) {
  if (!monthlyInflight[kind]) {
    monthlyInflight[kind] = (async () => {
      loadStore();
      const rec = store.series[kind] || { points: [], complete: false };
      const today = tpeToday();
      const from = rec.complete && rec.points.length
        ? rec.points[rec.points.length - 1][0]
        : monthsAgo(today, BACKFILL_MONTHS);
      const months = h.monthStarts(from, today);
      let fetched = [];
      let errors = 0;
      let lastErr = null;
      for (const ms of months) {
        try {
          fetched = fetched.concat(await fetchMonth(ms));
        } catch (e) {
          errors += 1;
          lastErr = e;
        }
        if (months.length > 2) await sleep(300); // 補資料時客氣一點
      }
      if (errors === months.length && !rec.points.length) throw lastErr || new Error('抓不到');
      rec.points = h.mergePoints(rec.points, fetched);
      rec.complete = rec.complete || errors === 0;
      rec.at = Date.now();
      store.series[kind] = rec;
      storeDirty = true;
      return rec.points;
    })().finally(() => { delete monthlyInflight[kind]; });
  }
  return monthlyInflight[kind];
}

/** Yahoo 的歷史最高：一天抓一次全部日線；抓不到就用上次存的；兩年內出現更高的就用新的 */
async function yahooAth(symbol, recentPoints) {
  loadStore();
  let rec = store.ath[symbol] || null;
  if (!rec || Date.now() - (rec.at || 0) > ATH_TTL_MS) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const { points } = h.parseYahooDaily(await fetchYahoo(symbol, `period1=0&period2=${now}&interval=1d`));
      const m = h.maxPoint(points);
      if (m) {
        rec = { ...m, at: Date.now() };
        store.ath[symbol] = rec;
        storeDirty = true;
      }
    } catch (e) {
      console.warn(`[index-history] ${symbol} 歷史最高抓不到:`, errMsg(e));
    }
  }
  if (!rec) return null; // 只有近兩年的資料時不冒充歷史最高
  const recent = h.maxPoint(recentPoints);
  if (recent && recent.value > rec.value) return recent;
  return { value: rec.value, date: rec.date };
}

async function buildDaily() {
  const cut = yearsAgo(tpeToday(), SEND_YEARS);
  const items = await Promise.all(h.INDEX_CHART_DEFS.map(async (def) => {
    try {
      let points;
      let partialLast = false;
      let ath;
      let source;
      if (def.daily === 'yahoo') {
        const r = h.parseYahooDaily(await fetchYahoo(def.symbol, 'range=2y&interval=1d'));
        points = r.points;
        partialLast = r.partialLast;
        ath = await yahooAth(def.symbol, points);
        source = `Yahoo ${def.symbol}`;
      } else if (def.daily === 'tpex') {
        points = await refreshMonthly('tpex', tpexMonth);
        ath = h.maxPoint(points);
        source = '櫃買中心';
      } else {
        points = await refreshMonthly('taifex', taifexMonth);
        ath = h.maxPoint(points);
        source = '期交所近月';
      }
      const sent = points.filter((p) => p[0] >= cut);
      if (!sent.length) throw new Error('沒有資料');
      return {
        key: def.key, name: def.name, ok: true, source,
        d: sent.map((p) => p[0]), c: sent.map((p) => p[1]),
        partial_last: partialLast, ath,
      };
    } catch (e) {
      return { key: def.key, name: def.name, ok: false, error: errMsg(e), d: [], c: [], partial_last: false, ath: null };
    }
  }));
  saveStore();
  if (!items.some((i) => i.ok)) {
    throw httpError(502, 'INDEX_HISTORY', '指數歷史全部抓不到: ' + items.map((i) => `${i.key} ${i.error}`).join('；'));
  }
  return { items, fetched_at: new Date().toISOString() };
}

let dailyCache = { at: 0, data: null };
let dailyInflight = null;
function refreshDaily() {
  if (!dailyInflight) {
    dailyInflight = buildDaily()
      .then((data) => { dailyCache = { at: Date.now(), data }; return data; })
      .finally(() => { dailyInflight = null; });
  }
  return dailyInflight;
}

// 快取過期時先回舊的、背景重抓（日線本來就不是即時，前端會接上方塊的即時價），
// 只有開機後完全沒資料、或按「重新整理」帶 force=1 才等新的。
router.get('/api/market/index-history', async (req, res) => {
  const fresh = dailyCache.data && Date.now() - dailyCache.at < DAILY_TTL_MS;
  if (req.query.force !== '1' && dailyCache.data) {
    if (!fresh) refreshDaily().catch((e) => console.warn('[index-history] 背景重抓失敗:', errMsg(e)));
    return res.json({ ...dailyCache.data, cached: true, refreshing: !fresh });
  }
  try {
    res.json({ ...(await refreshDaily()), cached: false });
  } catch (err) {
    if (dailyCache.data) return res.json({ ...dailyCache.data, cached: true, stale: true, stale_reason: errMsg(err) });
    sendError(res, err);
  }
});

// 開機先抓一次：第一個打開大盤頁的人不用等十幾秒
setTimeout(() => {
  refreshDaily().catch((e) => console.warn('[index-history] 開機預抓失敗:', errMsg(e)));
}, 5000).unref();

// ── 當日分時 ────────────────────────────────────────────────────────────────
async function intradayOf(def) {
  if (def.intraday === 'mis') {
    const r = await fetch(`https://mis.twse.com.tw/stock/data/${def.misFile}`, {
      headers: { 'User-Agent': UA, Referer: 'https://mis.twse.com.tw/stock/index.jsp' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`證交所 MIS HTTP ${r.status}`);
    return { ...h.parseMisOhlc(await r.json()), source: '證交所 MIS' };
  }
  if (def.intraday === 'taifex') {
    let last = { date: null, t: [], c: [] };
    for (const symbol of h.nearMonthSymbols()) {
      const r = await fetch('https://mis.taifex.com.tw/futures/api/getChartData1M', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://mis.taifex.com.tw/futures/' },
        body: JSON.stringify({ SymbolID: symbol }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`期交所 MIS HTTP ${r.status}`);
      last = { ...h.parseTaifexChart1M(await r.json()), source: `期交所 MIS ${symbol.replace('-F', '')}` };
      if (last.t.length) return last;
    }
    return last;
  }
  return { ...h.parseYahooIntraday(await fetchYahoo(def.symbol, 'range=1d&interval=5m')), source: 'Yahoo 5 分鐘' };
}

let intraCache = { at: 0, ttl: 0, data: null };
let intraInflight = null;
router.get('/api/market/index-intraday', async (req, res) => {
  const now = Date.now();
  if (req.query.force !== '1' && intraCache.data && now - intraCache.at < intraCache.ttl) {
    return res.json({ ...intraCache.data, cached: true });
  }
  if (!intraInflight) {
    intraInflight = (async () => {
      const items = await Promise.all(h.INDEX_CHART_DEFS.map(async (def) => {
        try {
          const r = await intradayOf(def);
          return { key: def.key, ok: r.t.length > 1, date: r.date, t: r.t, c: r.c, source: r.source };
        } catch (e) {
          return { key: def.key, ok: false, date: null, t: [], c: [], error: errMsg(e) };
        }
      }));
      if (!items.some((i) => i.ok)) {
        throw httpError(502, 'INDEX_INTRADAY', '指數分時全部抓不到: ' + items.map((i) => `${i.key} ${i.error || '無資料'}`).join('；'));
      }
      // 最後一筆在 10 分鐘內＝那個市場正在交易
      const live = items.some((i) => i.t.length && Date.now() - i.t[i.t.length - 1] < 10 * 60 * 1000);
      const data = { items, fetched_at: new Date().toISOString() };
      intraCache = { at: Date.now(), ttl: live ? INTRADAY_OPEN_TTL_MS : INTRADAY_CLOSED_TTL_MS, data };
      return data;
    })().finally(() => { intraInflight = null; });
  }
  try {
    res.json({ ...(await intraInflight), cached: false });
  } catch (err) {
    if (intraCache.data) return res.json({ ...intraCache.data, cached: true, stale: true, stale_reason: errMsg(err) });
    sendError(res, err);
  }
});

module.exports = router;
