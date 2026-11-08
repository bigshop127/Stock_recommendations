/**
 * lib/index_history.js — 大盤頁「期現貨與國際指數」九個方塊的線圖＋距高低點資料（opt53，2026-11-08）。
 *
 * 這裡只放「把各資料源回應轉成 [日期, 收盤]」的純函式，抓資料與快取在 routes/index_charts.js。
 *
 * 日收盤（畫 3 月／1 年線圖、算一年高低點、波段、歷史高）：
 *   - 加權、美日韓六檔：Yahoo chart API（range=2y&interval=1d）。歷史最高另用 period1=0 抓全部日線
 *     （range=max 會被 Yahoo 自動降成月線／季線，收盤不是每日的，不能用）。
 *   - 櫃買指數：Yahoo 沒有 ^TWOII → 櫃買中心「櫃買指數(月查詢)」JSON，一次一個月。
 *   - 台指期：期交所 futDataDown 每日行情 CSV（Big5，一次最多查一個月，超過回 HTML），
 *     取「一般時段、最近到期的月契約」收盤＝近月連續；換月那天會有一點價差跳動。
 * 當日分時（1 日線圖）：
 *   - 加權／櫃買：證交所 MIS mis_ohlc_TSE.txt／mis_ohlc_OTC.txt（每分鐘）。
 *   - 台指期：期交所 MIS getChartData1M（近月一般時段、每分鐘）。
 *   - 國際六檔：Yahoo range=1d&interval=5m。
 */
'use strict';

const { GLOBAL_INDEX_DEFS } = require('./global_indices');

/** 九個方塊的順序與資料源；key 要跟前端方塊（/market/indices 與 /market/global-indices）一致 */
const INDEX_CHART_DEFS = [
  { key: 'TWSE', name: '加權指數', daily: 'yahoo', symbol: '^TWII', intraday: 'mis', misFile: 'mis_ohlc_TSE.txt' },
  { key: 'OTC', name: '櫃買指數', daily: 'tpex', intraday: 'mis', misFile: 'mis_ohlc_OTC.txt' },
  { key: 'TX', name: '台指期', daily: 'taifex', intraday: 'taifex' },
  ...GLOBAL_INDEX_DEFS.map((d) => ({ key: d.key, name: d.name, daily: 'yahoo', symbol: d.symbol, intraday: 'yahoo' })),
];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const num = (s) => {
  const v = parseFloat(String(s ?? '').replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : null;
};
const pad2 = (n) => String(n).padStart(2, '0');
/** Yahoo 指標陣列是單精度（39701.64 會變 39701.640625），統一取兩位 */
const r2 = (v) => Math.round(v * 100) / 100;

/** epoch 秒＋交易所時差（秒）→ 交易所當地日期 YYYY-MM-DD */
function localDate(epochSec, gmtoffset) {
  const d = new Date((epochSec + (gmtoffset || 0)) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Yahoo 日線 → { points: [[YYYY-MM-DD, close]], partialLast }。
 * partialLast＝最後一根是「今天還在交易中」的半根（收盤價會跟著盤中變），前端用即時價取代它。
 * 同一天出現兩根（Yahoo 盤中偶爾會）只留最後一根。
 */
function parseYahooDaily(json, now = Date.now()) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error('no result');
  const meta = result.meta || {};
  const off = finite(meta.gmtoffset) ?? 0;
  const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
  const byDate = new Map();
  result.timestamp.forEach((t, i) => {
    const c = finite(closes[i]);
    if (c === null || c <= 0 || finite(t) === null) return;
    byDate.set(localDate(t, off), r2(c));
  });
  const points = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  let partialLast = false;
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const nowSec = Math.floor(now / 1000);
  if (points.length && reg && finite(reg.start) !== null && finite(reg.end) !== null
    && nowSec >= reg.start && nowSec <= reg.end) {
    partialLast = points[points.length - 1][0] === localDate(reg.start, off);
  }
  return { points, partialLast };
}

/** 一串 [日期, 收盤] 裡收盤最高的那一點（同值取較早） */
function maxPoint(points) {
  let best = null;
  for (const [d, c] of points) if (best === null || c > best.value) best = { value: c, date: d };
  return best;
}

/** 櫃買中心「櫃買指數(月查詢)」→ [[YYYY-MM-DD, 收市]] */
function parseTpexMonth(json) {
  const table = json && Array.isArray(json.tables) ? json.tables[0] : null;
  if (!table || !Array.isArray(table.data)) return [];
  const fields = table.fields || [];
  const iDate = Math.max(0, fields.indexOf('日期'));
  const iClose = fields.indexOf('收市') >= 0 ? fields.indexOf('收市') : 4;
  const out = [];
  for (const row of table.data) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(row[iDate] || '').trim());
    const c = num(row[iClose]);
    if (!m || c === null || c <= 0) continue;
    out.push([`${m[1]}-${pad2(m[2])}-${pad2(m[3])}`, c]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * 期交所 futDataDown 每日行情 CSV（已解成字串）→ 近月連續 [[YYYY-MM-DD, 收盤]]。
 * 只收：契約＝TX、到期月份是單一月份（價差單「202610/202611」不要）、交易時段＝一般。
 * 同一天取到期月份最小的那個（結算日當天仍是要結算的那個月，隔天自然換下一個月）。
 */
function parseTaifexDailyCsv(text, contract = 'TX') {
  if (!text || /^\s*</.test(text)) throw new Error('期交所回傳 HTML（查詢區間超過一個月或被擋），不是 CSV');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map((s) => s.trim());
  const col = (name) => head.findIndex((h) => h.includes(name));
  const iDate = col('交易日期');
  const iCon = col('契約');
  const iMonth = col('到期月份');
  const iClose = col('收盤價');
  const iSess = col('交易時段');
  if ([iDate, iCon, iMonth, iClose, iSess].some((i) => i < 0)) {
    throw new Error(`期交所 CSV 欄位非預期：${head.slice(0, 8).join(',')}`);
  }
  const best = new Map(); // date → { month, close }
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if ((c[iCon] || '').trim() !== contract) continue;
    if ((c[iSess] || '').trim() !== '一般') continue;
    const month = (c[iMonth] || '').trim();
    if (!/^\d{6}$/.test(month)) continue;
    const close = num(c[iClose]);
    const dm = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec((c[iDate] || '').trim());
    if (!dm || close === null || close <= 0) continue;
    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    const cur = best.get(date);
    if (!cur || month < cur.month) best.set(date, { month, close });
  }
  return [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, v.close]);
}

/** 證交所 MIS mis_ohlc_TSE/OTC.txt → { date, t: [epoch ms], c: [收盤] } */
function parseMisOhlc(json) {
  const arr = json && Array.isArray(json.ohlcArray) ? json.ohlcArray : [];
  const key = String((json && json.staticObj && json.staticObj.key) || '');
  const km = /_(\d{4})(\d{2})(\d{2})$/.exec(key);
  const t = [];
  const c = [];
  for (const p of arr) {
    const ms = num(p.t);
    const v = num(p.c);
    if (ms === null || v === null || v <= 0) continue;
    t.push(ms);
    c.push(v);
  }
  return { date: km ? `${km[1]}-${km[2]}-${km[3]}` : null, t, c };
}

/** 期交所 MIS getChartData1M → { date, t, c }（Ticks＝[HHMMSS, 開, 高, 低, 收, 量]，時間是台北時間） */
function parseTaifexChart1M(json) {
  const d = json && json.RtData;
  const ticks = d && Array.isArray(d.Ticks) ? d.Ticks : [];
  const cdate = String((d && d.Quote && d.Quote.CDate) || '');
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(cdate);
  if (!dm) return { date: null, t: [], c: [] };
  const [y, mo, da] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const t = [];
  const c = [];
  for (const row of ticks) {
    const hm = /^(\d{2})(\d{2})(\d{2})$/.exec(String(row[0] || ''));
    const close = num(row[4]);
    if (!hm || close === null || close <= 0) continue;
    t.push(Date.UTC(y, mo - 1, da, Number(hm[1]) - 8, Number(hm[2]), Number(hm[3])));
    c.push(close);
  }
  return { date: `${dm[1]}-${dm[2]}-${dm[3]}`, t, c };
}

/** Yahoo 5 分鐘線 → { date, t, c } */
function parseYahooIntraday(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error('no result');
  const off = finite((result.meta || {}).gmtoffset) ?? 0;
  const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
  const t = [];
  const c = [];
  result.timestamp.forEach((ts, i) => {
    const v = finite(closes[i]);
    if (v === null || v <= 0) return;
    t.push(ts * 1000);
    c.push(r2(v));
  });
  return { date: t.length ? localDate(t[t.length - 1] / 1000, off) : null, t, c };
}

const MONTH_CODES = 'ABCDEFGHIJKL';

/** 某年某月第三個星期三（台指期月契約最後交易日；遇假日順延的少數情況不處理，呼叫端會退到下個月） */
function thirdWednesday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=日
  const firstWed = 1 + ((3 - first + 7) % 7);
  return firstWed + 14;
}

/**
 * 現在（台北時間）的近月台指期 MIS 代號，例：2026-11-08 → TXFK6-F（-F＝一般時段）。
 * 過了當月第三個星期三就是下個月。第二個值是再下個月，近月查不到 Ticks 時退用。
 */
function nearMonthSymbols(now = Date.now()) {
  const tpe = new Date(now + 8 * 3600 * 1000);
  let y = tpe.getUTCFullYear();
  let m = tpe.getUTCMonth() + 1;
  if (tpe.getUTCDate() > thirdWednesday(y, m)) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const sym = (yy, mm) => `TXF${MONTH_CODES[mm - 1]}${yy % 10}-F`;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return [sym(y, m), sym(ny, nm)];
}

/** [start, end] 之間每個月的第一天（YYYY-MM-01），櫃買／期交所都是一個月查一次 */
function monthStarts(startDate, endDate) {
  const out = [];
  let [y, m] = startDate.slice(0, 7).split('-').map(Number);
  const [ey, em] = endDate.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}-01`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** 某月最後一天 */
function monthEnd(monthStart) {
  const [y, m] = monthStart.split('-').map(Number);
  return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** 把新抓到的 [日期, 收盤] 併進舊的（同一天以新的為準），依日期排序 */
function mergePoints(oldPts, newPts) {
  const m = new Map(oldPts || []);
  for (const [d, c] of newPts || []) m.set(d, c);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

module.exports = {
  INDEX_CHART_DEFS,
  parseYahooDaily,
  parseYahooIntraday,
  parseTpexMonth,
  parseTaifexDailyCsv,
  parseMisOhlc,
  parseTaifexChart1M,
  maxPoint,
  nearMonthSymbols,
  thirdWednesday,
  monthStarts,
  monthEnd,
  mergePoints,
  localDate,
};
