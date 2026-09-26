/**
 * routes/twse_dashboard.js — 證交所「臺股儀表板」資料（2026-09-26 新增）。
 *
 *   GET /api/market/credit               市場槓桿溫度：全市場擔保維持率、維持率<130% 戶數、
 *                                        處分（斷頭）戶數/金額、上市融資融券餘額、融資占市值年度歷史
 *   GET /api/market/default-disclosures  近一年「個股達違約資訊揭露標準」名單（個股頁／自選清單的警示）
 *   GET /api/market/revenue[...]         月營收：全體上市、32 個官方產業、單一公司 vs 產業（opt41，見檔尾）
 *
 * 跟 /api/market/taiex 一樣由 gateway 自己抓、不經 engine：再平衡頁的燈號卡也要用，
 * 而本機 gateway 沒有 engine。解析邏輯在 lib/twse_credit.js（有測試）。
 *
 * 信用資料證交所晚上才產出、違約名單一天一次，所以快取抓得比指數寬；
 * 上游失敗時退回磁碟上一份並標 stale，讓畫面照樣有東西、但看得出不是最新。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { sendError, httpError } = require('../lib/errors');
const {
  parseCreditSeries,
  parseCreditHistory,
  parseDefaultDisclosures,
} = require('../lib/twse_credit');
const {
  parseCompanyRows,
  buildMarket,
  industryRank,
  parseTpexTrend,
} = require('../lib/twse_revenue');

const router = express.Router();

const TWSE_RWD = process.env.TWSE_RWD_BASE || 'https://www.twse.com.tw/rwd/zh';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function getJson(url, timeoutMs = 15000) {
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; puhui-review-web/1.0)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}

const twseGet = (pathAndQuery) => getJson(`${TWSE_RWD}${pathAndQuery}`);

/** 台北日期 YYYYMMDD（VM 在 UTC，自己加 8 小時） */
function tpeYmd(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
const ymdIso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;

/**
 * 記憶體快取 → 上游 → 磁碟備援，兩條路由共用。
 * build() 丟錯＝上游整個失敗；stale 狀態只在記憶體留 5 分鐘，之後會再試上游。
 */
function makeCachedHandler({ label, diskFile, ttlMs, build }) {
  const diskPath = path.join(DATA_DIR, diskFile);
  const STALE_RETRY_MS = 5 * 60 * 1000;
  let cache = { at: 0, data: null, stale: false };

  return async (req, res) => {
    const now = Date.now();
    const force = req.query.force === '1';
    const ttl = cache.stale ? STALE_RETRY_MS : ttlMs;
    if (!force && cache.data && now - cache.at < ttl) {
      return res.json({ ...cache.data, cached: true, stale: cache.stale });
    }

    try {
      const data = { ...(await build()), fetched_at: new Date().toISOString() };
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = diskPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, diskPath);
      } catch { /* 落地失敗不影響這次回應 */ }
      cache = { at: now, data, stale: false };
      return res.json({ ...data, cached: false, stale: false });
    } catch (err) {
      try {
        if (fs.existsSync(diskPath)) {
          const data = { ...JSON.parse(fs.readFileSync(diskPath, 'utf-8')), stale_reason: err.message };
          cache = { at: now, data, stale: true };
          return res.json({ ...data, cached: false, stale: true });
        }
      } catch { /* 快取檔壞掉就當沒有 */ }
      return sendError(res, httpError(502, 'TWSE', `抓取${label}失敗: ${err.message}`));
    }
  };
}

// 年度歷史一個月才動一次，另外快取，不用每 30 分鐘跟著重抓
let historyCache = { at: 0, rows: [] };
const HISTORY_TTL_MS = 12 * 3600 * 1000;

router.get('/api/market/credit', makeCachedHandler({
  label: '信用交易資料',
  diskFile: 'twse_credit.json',
  ttlMs: 30 * 60 * 1000,
  build: async () => {
    // 依序抓，不併發：證交所對同一 IP 短時間內大量請求會暫時封鎖
    // days=250：維持率序列從 2026-08-03 才開始，一年內都能整段拿到；融資趨勢上游最多給約 60 天
    const errors = [];
    const keepTrend = await twseGet('/marginTrading/BFIJ3U_TREND?response=json&days=250')
      .catch((e) => { errors.push(e.message); return null; });
    const marginTrend = await twseGet('/marginTrading/MI_MARGN_TREND?response=json&days=60')
      .catch((e) => { errors.push(e.message); return null; });

    const series = parseCreditSeries(keepTrend, marginTrend);
    if (!series.length) throw new Error(errors.join('；') || '上游沒有回傳資料');

    if (!historyCache.rows.length || Date.now() - historyCache.at > HISTORY_TTL_MS) {
      try {
        const rows = parseCreditHistory(await twseGet('/marginTrading/MI_MARGN_HISTORY?response=json'));
        if (rows.length) historyCache = { at: Date.now(), rows };
      } catch (e) {
        errors.push(e.message); // 年度歷史抓不到只少一條參考線，不擋整張卡
      }
    }

    return {
      series,
      history: historyCache.rows,
      latest_date: series[series.length - 1].date,
      keep_rate_since: (series.find((r) => r.keep_rate !== null) || {}).date || null,
      partial_errors: errors.length ? errors : undefined,
      source: 'twse-dashboard',
    };
  },
}));

router.get('/api/market/default-disclosures', makeCachedHandler({
  label: '違約揭露名單',
  diskFile: 'twse_default_disclosures.json',
  ttlMs: 3 * 3600 * 1000,
  build: async () => {
    const from = tpeYmd(-365);
    const to = tpeYmd(0);
    const body = await twseGet(`/announcement/BFIGTU?response=json&startDate=${from}&endDate=${to}`);
    if (!body || String(body.stat).toUpperCase() !== 'OK') {
      throw new Error(`BFIGTU 回應異常: ${body && body.stat}`);
    }
    const { items } = parseDefaultDisclosures(body);
    return {
      from: ymdIso(from),
      to: ymdIso(to),
      threshold_note: '同一標的證券之當沖交易違約互抵淨額加計非當沖交易違約買賣總額合計達新臺幣 2,500 萬元',
      items,
      source: 'twse-BFIGTU',
    };
  },
}));

// ── 月營收（opt41）──────────────────────────────────────────────────────────
//
//   GET /api/market/revenue                 全體上市概況＋12 個月趨勢＋32 個官方產業加總（盤勢卡、熱力圖）
//   GET /api/market/revenue/company/:code   單一公司 vs 同市場同產業（個股頁產業分析分頁）
//   GET /api/market/revenue/industry?name=  單一產業：12 個月趨勢＋成分公司（熱力圖點下去）
//
// 三支共用同一份資料：證交所／櫃買 OpenAPI 的逐家月營收表（一次拿全部公司），
// 加上臺股儀表板背後的櫃買趨勢 API。解析與加總在 lib/twse_revenue.js（有測試）。
// 營收一個月才換一次，申報期間（每月 1～10 日）表會陸續更新，所以快取 6 小時。

const TWSE_OPENAPI = process.env.TWSE_OPENAPI_BASE || 'https://openapi.twse.com.tw/v1';
const TPEX_BASE = process.env.TPEX_BASE || 'https://www.tpex.org.tw';
const REVENUE_DISK = path.join(DATA_DIR, 'twse_revenue.json');
const REVENUE_TTL_MS = 6 * 3600 * 1000;
const REVENUE_STALE_RETRY_MS = 5 * 60 * 1000;

let revenueState = { at: 0, data: null, stale: false, stale_reason: null };
let revenueInflight = null;

async function buildRevenueDataset() {
  const errors = [];
  // 上市是主體，抓不到就整個算失敗（改退磁碟）；上櫃與趨勢只是加值，失敗照樣回上市
  const listed = buildMarket(parseCompanyRows(await getJson(`${TWSE_OPENAPI}/opendata/t187ap05_L`, 30000), 'listed'));
  if (!listed.month || !listed.industries.length) throw new Error('上市月營收表沒有資料');

  let otc = null;
  try {
    otc = buildMarket(parseCompanyRows(await getJson(`${TPEX_BASE}/openapi/v1/mopsfin_t187ap05_O`, 30000), 'otc'));
  } catch (e) {
    errors.push(`上櫃：${e.message}`);
  }

  let trend = null;
  try {
    trend = parseTpexTrend(await getJson(`${TPEX_BASE}/www/revenue/change?lang=zh-tw&market=T`));
    if (!trend) errors.push('趨勢：櫃買沒有回傳資料');
  } catch (e) {
    errors.push(`趨勢：${e.message}`);
  }

  return {
    listed,
    otc,
    trend,
    partial_errors: errors.length ? errors : undefined,
    fetched_at: new Date().toISOString(),
  };
}

/** 回 { data, stale, stale_reason }；同時多個請求進來只打一次上游 */
function getRevenueDataset(force = false) {
  const ttl = revenueState.stale ? REVENUE_STALE_RETRY_MS : REVENUE_TTL_MS;
  if (!force && revenueState.data && Date.now() - revenueState.at < ttl) {
    return Promise.resolve(revenueState);
  }
  if (!revenueInflight) {
    revenueInflight = (async () => {
      try {
        const data = await buildRevenueDataset();
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          const tmp = REVENUE_DISK + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data));
          fs.renameSync(tmp, REVENUE_DISK);
        } catch { /* 落地失敗不影響這次回應 */ }
        revenueState = { at: Date.now(), data, stale: false, stale_reason: null };
      } catch (err) {
        let fallback = revenueState.data;
        if (!fallback) {
          try {
            if (fs.existsSync(REVENUE_DISK)) fallback = JSON.parse(fs.readFileSync(REVENUE_DISK, 'utf-8'));
          } catch { /* 快取檔壞掉就當沒有 */ }
        }
        if (!fallback) throw httpError(502, 'TWSE', `抓取月營收失敗: ${err.message}`);
        revenueState = { at: Date.now(), data: fallback, stale: true, stale_reason: err.message };
      }
      return revenueState;
    })().finally(() => { revenueInflight = null; });
  }
  return revenueInflight;
}

const staleFields = (st) => ({
  fetched_at: st.data.fetched_at,
  stale: st.stale,
  ...(st.stale ? { stale_reason: st.stale_reason } : {}),
});

/** 公司列只留畫面會用到的欄位，避免整包丟給前端 */
const compactCompany = (c) => ({
  code: c.code,
  name: c.name,
  market: c.market,
  industry: c.industry,
  revenue: c.revenue,
  mom_pct: c.mom_pct,
  yoy_pct: c.yoy_pct,
  cum_yoy_pct: c.cum_yoy_pct,
  note: c.note,
});

router.get('/api/market/revenue', async (req, res) => {
  try {
    const st = await getRevenueDataset(req.query.force === '1');
    const { listed, otc, trend, partial_errors } = st.data;
    res.json({
      market: 'listed',
      month: listed.month,
      published: listed.published,
      overview: listed.overview,
      industries: listed.industries,
      trend,
      otc_overview: otc ? { month: otc.month, ...otc.overview } : null,
      partial_errors,
      source: 'twse-openapi-t187ap05',
      ...staleFields(st),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/revenue/company/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  try {
    const st = await getRevenueDataset();
    const { listed, otc } = st.data;
    let market = listed;
    let company = listed.companies.find((c) => c.code === code);
    if (!company && otc) {
      market = otc;
      company = otc.companies.find((c) => c.code === code);
    }
    if (!company) {
      return sendError(res, httpError(404, 'NOT_FOUND', `${code} 不在上市櫃月營收表（ETF、存託憑證或尚未申報）`));
    }
    const industry = market.industries.find((i) => i.name === company.industry) || null;
    res.json({
      month: market.month,
      published: market.published,
      company: { ...compactCompany(company), month: company.month, current: company.current },
      industry,
      rank: industryRank(market, code),
      ...staleFields(st),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// 單一產業 12 個月趨勢（櫃買 API 一次只給一個產業），依產業＋月份快取
const industryTrendCache = new Map();
const INDUSTRY_TREND_TTL_MS = 12 * 3600 * 1000;

async function getIndustryTrend(marketCode, name, month) {
  const key = `${marketCode}|${name}|${month}`;
  const hit = industryTrendCache.get(key);
  if (hit && Date.now() - hit.at < INDUSTRY_TREND_TTL_MS) return hit.trend;
  const [y, m] = month.split('-').map(Number);
  const url = `${TPEX_BASE}/www/revenue/industryTrend?lang=zh-tw&market=${marketCode}`
    + `&industry=${encodeURIComponent(name)}&year=${y}&month=${m}`;
  const trend = parseTpexTrend(await getJson(url));
  if (trend) industryTrendCache.set(key, { at: Date.now(), trend });
  return trend;
}

router.get('/api/market/revenue/industry', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const isOtc = req.query.market === 'otc';
  if (!name) return sendError(res, httpError(400, 'BAD_REQUEST', '缺少產業名稱 name'));
  try {
    const st = await getRevenueDataset();
    const market = isOtc ? st.data.otc : st.data.listed;
    if (!market) return sendError(res, httpError(502, 'TWSE', '上櫃月營收暫時抓不到'));
    const industry = market.industries.find((i) => i.name === name);
    if (!industry) return sendError(res, httpError(404, 'NOT_FOUND', `找不到產業「${name}」`));

    let trend = null;
    let trend_error;
    try {
      trend = await getIndustryTrend(isOtc ? 'O' : 'T', name, market.month);
    } catch (e) {
      trend_error = e.message; // 趨勢圖少一張而已，成分公司照樣回
    }

    res.json({
      market: isOtc ? 'otc' : 'listed',
      month: market.month,
      published: market.published,
      industry,
      trend,
      trend_error,
      companies: market.companies
        .filter((c) => c.current && c.industry === name)
        .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
        .map(compactCompany),
      ...staleFields(st),
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
