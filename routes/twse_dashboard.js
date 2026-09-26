/**
 * routes/twse_dashboard.js — 證交所「臺股儀表板」資料（2026-09-26 新增）。
 *
 *   GET /api/market/credit               市場槓桿溫度：全市場擔保維持率、維持率<130% 戶數、
 *                                        處分（斷頭）戶數/金額、上市融資融券餘額、融資占市值年度歷史
 *   GET /api/market/default-disclosures  近一年「個股達違約資訊揭露標準」名單（個股頁／自選清單的警示）
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

const router = express.Router();

const TWSE_RWD = process.env.TWSE_RWD_BASE || 'https://www.twse.com.tw/rwd/zh';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function twseGet(pathAndQuery) {
  const r = await fetch(`${TWSE_RWD}${pathAndQuery}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; puhui-review-web/1.0)',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`TWSE HTTP ${r.status} ${pathAndQuery.split('?')[0]}`);
  return r.json();
}

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

module.exports = router;
