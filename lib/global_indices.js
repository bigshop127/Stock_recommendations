/**
 * lib/global_indices.js — 國際股市指數（美股三大指數＋日經＋韓股）解析（2026-09-27 新增）。
 *
 * 資料源是 Yahoo Finance chart API（公開市場資料、免金鑰），跟再平衡頁的宏觀指標同一個來源。
 * 抓 range=1d&interval=5m：meta.previousClose 是「前一交易日收盤」，可以直接算今天的漲跌；
 * range 拉長時 chartPreviousClose 會變成整段區間之前的收盤，不能拿來算日漲跌。
 */
'use strict';

const GLOBAL_INDEX_DEFS = [
  { key: 'DJI', symbol: '^DJI', name: '道瓊工業', region: '美股' },
  { key: 'GSPC', symbol: '^GSPC', name: 'S&P 500', region: '美股' },
  { key: 'IXIC', symbol: '^IXIC', name: '那斯達克', region: '美股' },
  { key: 'N225', symbol: '^N225', name: '日經 225', region: '日股' },
  { key: 'KS11', symbol: '^KS11', name: '韓國綜合', region: '韓股' },
];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 把一檔指數的 Yahoo 回應轉成畫面要的一列。拿不到現價就丟錯，讓呼叫端標成 ok:false。
 * now 可注入，方便測試「盤中／已收盤」判斷。
 */
function parseYahooQuote(json, def, now = Date.now()) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  const meta = result && result.meta;
  if (!meta) throw new Error('no result');

  const price = finite(meta.regularMarketPrice);
  if (price === null || price <= 0) throw new Error('no price');
  const prev = finite(meta.previousClose) ?? finite(meta.chartPreviousClose);
  const change = prev !== null && prev > 0 ? price - prev : null;
  const change_pct = change !== null ? (change / prev) * 100 : null;

  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const nowSec = Math.floor(now / 1000);
  const open = !!reg && finite(reg.start) !== null && finite(reg.end) !== null
    && nowSec >= reg.start && nowSec <= reg.end;

  const t = finite(meta.regularMarketTime);
  return {
    key: def.key,
    symbol: def.symbol,
    name: def.name,
    region: def.region,
    price,
    prev_close: prev,
    change,
    change_pct,
    as_of: t !== null ? new Date(t * 1000).toISOString() : null,
    session: open ? 'open' : 'closed',
    ok: true,
  };
}

module.exports = { GLOBAL_INDEX_DEFS, parseYahooQuote };
