/**
 * routes/market.js — Market routes gateway (Phase 1).
 *
 * Forwards market API requests to the Python engine.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { engineGet } = require('../lib/engine');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

// TWSE queries can be slow, 60s timeout
const T_MARKET = 60000;

// ── 加權指數（TAIEX）──────────────────────────────────────────────────────
//
// 期貨頁的「大盤點數換算」要靠這個。刻意不走 Python engine：期貨頁與再平衡頁
// 是本機 gateway（沒有 engine）唯一還能用的兩頁，把它掛到 engine 上等於讓
// 本機的「真實同步」直接壞掉。gateway 自己抓，跟 /api/futures/margins 同一個做法。
//
// 兩個資料源，先即時後每日：
//   MIS   https://mis.twse.com.tw/... 是看盤網頁自己在用的端點，盤中約每 5 秒更新，
//         但收盤後 z（成交價）會變成 '-'，且需要帶 Referer 才不會被擋。
//   OPEN  https://openapi.twse.com.tw/... 是官方 OpenAPI，只有每日收盤，作為退路。
const DATA_DIR = path.join(__dirname, '..', 'data');
const TAIEX_CACHE_PATH = path.join(DATA_DIR, 'twse_taiex.json');
const TAIEX_MIS_URL = process.env.TWSE_MIS_URL
  || 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0';
const TAIEX_OPENAPI_URL = process.env.TWSE_INDEX_URL
  || 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX';

// 盤中 30 秒：再短只是替 MIS 增加負擔，使用者按「真實同步」的間隔本來就遠大於此。
const TAIEX_TTL_MS = 30 * 1000;
// 非交易時段資料整天不會變，快取久一點。
const TAIEX_CLOSED_TTL_MS = 30 * 60 * 1000;
// 兩個源都掛掉時退回磁碟，但只認 5 分鐘——指數是用來算追繳價的，寧可讓前端再試。
const TAIEX_STALE_TTL_MS = 5 * 60 * 1000;

let taiexCache = { at: 0, data: null, stale: false };

const numOrNull = (v) => {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 台北時間的「現在是不是盤中」。VM 在 UTC，所以自己加 8 小時，不依賴系統時區。 */
function isTaiexSession(d = new Date()) {
  const tpe = new Date(d.getTime() + 8 * 3600 * 1000);
  const day = tpe.getUTCDay();
  if (day === 0 || day === 6) return false;          // 週末（國定假日不在這裡判，收盤值一樣正確）
  const mins = tpe.getUTCHours() * 60 + tpe.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 13 * 60 + 35;     // 09:00–13:35（含收盤試撮）
}

/** MIS 的日期是 YYYYMMDD */
const misDate = (s) => (/^\d{8}$/.test(String(s)) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : '');

/** OpenAPI 的日期是民國年 1150729 */
function rocDate(s) {
  const m = /^(\d{3})(\d{2})(\d{2})$/.exec(String(s));
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : '';
}

async function fetchTaiexFromMis() {
  const r = await fetch(TAIEX_MIS_URL, {
    headers: {
      Accept: 'application/json',
      // 少了 Referer 會被 MIS 擋掉（回 rtcode 5001），這不是可有可無的禮貌標頭
      Referer: 'https://mis.twse.com.tw/stock/index.jsp',
      'User-Agent': 'Mozilla/5.0 (compatible; puhui-review-web/1.0)',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`MIS HTTP ${r.status}`);

  const body = await r.json();
  if (body.rtcode !== '0000') throw new Error(`MIS rtcode ${body.rtcode}`);
  const row = Array.isArray(body.msgArray) ? body.msgArray[0] : null;
  if (!row) throw new Error('MIS 沒有回傳指數列');

  const prevClose = numOrNull(row.y);
  // z＝最新成交指數；收盤後或試撮前會是 '-'，此時退回昨收才不會回一個 null 出去
  const index = numOrNull(row.z) ?? prevClose;
  if (index === null) throw new Error('MIS 回應沒有可用的指數值');

  return {
    index,
    prev_close: prevClose,
    open: numOrNull(row.o),
    high: numOrNull(row.h),
    low: numOrNull(row.l),
    date: misDate(row.d),
    time: String(row.t || ''),
    source: 'twse-mis',
    // 只有「真的拿到成交價」才算即時；退回昨收的情況要誠實標成非即時
    intraday: numOrNull(row.z) !== null && isTaiexSession(),
  };
}

async function fetchTaiexFromOpenApi() {
  const r = await fetch(TAIEX_OPENAPI_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'puhui-review-web/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`OpenAPI HTTP ${r.status}`);

  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('OpenAPI 回應格式非預期');
  const row = rows.find((x) => String(x['指數']).trim() === '發行量加權股價指數');
  if (!row) throw new Error('OpenAPI 找不到發行量加權股價指數');

  const index = numOrNull(row['收盤指數']);
  if (index === null) throw new Error('OpenAPI 收盤指數無法解析');

  // 「漲跌」欄是 '+' / '-' / ' '，點數本身永遠是正的，要靠這欄還原正負
  const sign = String(row['漲跌']).trim() === '-' ? -1 : 1;
  const changePts = numOrNull(row['漲跌點數']);

  return {
    index,
    prev_close: changePts === null ? null : index - sign * changePts,
    open: null,
    high: null,
    low: null,
    date: rocDate(row['日期']),
    time: '',
    source: 'twse-openapi',
    intraday: false,
  };
}

router.get('/api/market/taiex', async (req, res) => {
  const now = Date.now();
  const ttl = taiexCache.stale
    ? TAIEX_STALE_TTL_MS
    : (isTaiexSession() ? TAIEX_TTL_MS : TAIEX_CLOSED_TTL_MS);

  if (taiexCache.data && now - taiexCache.at < ttl) {
    // stale 跟著記憶體快取一起帶出去（見 routes/futures.js 的同一個坑）
    return res.json({ ...taiexCache.data, cached: true, stale: taiexCache.stale });
  }

  const serveDisk = (reason) => {
    try {
      if (fs.existsSync(TAIEX_CACHE_PATH)) {
        const disk = JSON.parse(fs.readFileSync(TAIEX_CACHE_PATH, 'utf-8'));
        const data = { ...disk, stale_reason: reason };
        taiexCache = { at: now, data, stale: true };
        return res.json({ ...data, cached: false, stale: true });
      }
    } catch { /* 快取檔壞掉就當沒有 */ }
    return sendError(res, httpError(502, 'TWSE', '抓取加權指數失敗: ' + reason));
  };

  const reasons = [];
  for (const fetchOne of [fetchTaiexFromMis, fetchTaiexFromOpenApi]) {
    try {
      const got = await fetchOne();
      const change = got.prev_close === null ? null : got.index - got.prev_close;
      // cached / stale 是「這次回應」的性質，不落地
      const data = {
        ...got,
        change,
        change_pct: change === null || !got.prev_close ? null : change / got.prev_close,
        fetched_at: new Date().toISOString(),
      };
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = TAIEX_CACHE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, TAIEX_CACHE_PATH);
      } catch { /* 落地失敗不影響這次回應 */ }

      taiexCache = { at: now, data, stale: false };
      return res.json({ ...data, cached: false, stale: false });
    } catch (err) {
      reasons.push(err.message);
    }
  }
  return serveDisk(reasons.join('；'));
});

router.get('/api/market/indices', async (req, res) => {
  const { range } = req.query;
  try {
    const data = await engineGet('/market/indices', { range }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/breadth', async (req, res) => {
  const { date } = req.query;
  try {
    const data = await engineGet('/market/breadth', { date }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/sectors', async (req, res) => {
  const { date } = req.query;
  try {
    const data = await engineGet('/market/sectors', { date }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/institutional', async (req, res) => {
  const { date, days } = req.query;
  try {
    const data = await engineGet('/market/institutional', { date, days }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/capital-tide', async (req, res) => {
  const { date, universe } = req.query;
  try {
    const data = await engineGet('/market/capital-tide', { date, universe }, 120000);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/stock-heatmap', async (req, res) => {
  const { period, date } = req.query;
  try {
    const data = await engineGet('/market/stock-heatmap', { period, date }, 120000);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;

