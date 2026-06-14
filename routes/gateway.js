/**
 * gateway.js — 階段 6 統一 API gateway（前綴 /api）。
 *
 * 對前端吐統一 REST：內部**代理 engine**（lib/engine）+ **讀 reports/ 檔案系統**（lib/reports）。
 * 這層只組合/轉發/降級，**不重算分數、不重做融合、不碰回測邏輯**——數字一律吃 engine 與 reports/。
 *
 * | 端點 | 來源 | 契約 |
 * |---|---|---|
 * | GET  /api/health            | gateway + 探 engine            | — |
 * | GET  /api/dashboard         | /puhui/view + /watchlist + regime | DailySnapshot |
 * | GET  /api/stocks/:code      | /signal(swing+daytrade) + /signal/blended + /puhui/view | StockSignal×2 + blended |
 * | GET  /api/stocks/:code/ohlcv| /data/ohlcv 透傳（日K；?adjust=1 → /data/ohlcv_adj yfinance 還原）| — |
 * | GET  /api/stocks/:code/book | /data/book 透傳（即時五檔，TWSE MIS 預設）| — |
 * | GET  /api/stocks/:code/intraday | /data/intraday 透傳（盤中分K，富果）| — |
 * | GET  /api/watchlist         | /watchlist 透傳                | Watchlist[] |
 * | GET  /api/reports/list      | 純 FS                          | — |
 * | GET  /api/reports           | 純 FS                          | — |
 * | POST /api/backtest          | /backtest 透傳                 | BacktestResult |
 * | POST /api/backtest/grid     | /backtest/grid 透傳            | — |
 * | POST /api/agents/decide     | /agents/decide 透傳（很貴）    | agent 決策 |
 */
'use strict';

const express = require('express');
const { baseUrl, engineGet, enginePost, engineHealthy } = require('../lib/engine');
const { sendError, httpError } = require('../lib/errors');
const { listReports, getReport } = require('../lib/reports');
const { readCache, cnToFraction, fractionToText } = require('../lib/puhui_cache');

const router = express.Router();

// per-端點 timeout（ms）。多因子/多股計算偏重；agents 每股 7×LLM ≈187s → 放很寬。
const T = {
  health: 5000,
  signal: 60000,
  watchlist: 90000,
  puhui: 30000,
  backtest: 180000,
  agents: 1200000,
  ohlcv: 60000,   // FinMind 一年日K（有 parquet 快取，首抓較久）
  book: 15000,    // 即時五檔 live snapshot（TWSE MIS，快）
  intraday: 45000, // 富果盤中分K
};

const dateParams = (date) => (date ? { date } : {});

// ── GET /api/health ──────────────────────────────────────────────────────────
router.get('/api/health', async (req, res) => {
  const up = await engineHealthy(T.health);
  res.json({
    gateway: 'ok',
    engine: up ? 'up' : 'down',
    engine_base_url: baseUrl(),
    time: new Date().toISOString(),
  });
});

// ── GET /api/dashboard?date= ── DailySnapshot（engine down → degraded 讀 cache）──
function degradedDashboard(date) {
  const cache = readCache();
  const base = {
    market_regime: null,
    watchlist: [],
    degraded: true,
    generated_at: new Date().toISOString(),
  };
  if (!cache) {
    return {
      date: date || null, as_of_date: null,
      water_level: null, water_level_text: null, puhui_sentiment: null,
      ...base,
      notes: ['engine 不可用，且無 data/puhui_cache.json 快取 → 僅回空殼（無水位/情緒/清單）'],
    };
  }
  const waterNum = cnToFraction(cache.water_level);
  let sentiment = null;
  if (cache.market_sentiment) {
    const s = cache.market_sentiment.score;
    // cache score 為 1~10 → ×10 對齊 engine 的 0~100 量綱
    sentiment = { label: cache.market_sentiment.label, score: typeof s === 'number' ? s * 10 : null };
  }
  return {
    date: cache.date || date || null,
    as_of_date: cache.date || null,
    water_level: waterNum,
    water_level_text: cache.water_level || fractionToText(waterNum),
    puhui_sentiment: sentiment,
    ...base,
    notes: [
      'engine 不可用 → 退讀 data/puhui_cache.json（僅全域 water_level/sentiment，無個股清單）',
      'cache 的 stocks 僅含股名+emoji（無代號/無買賣訊號）→ 不納入 watchlist',
    ],
  };
}

router.get('/api/dashboard', async (req, res) => {
  const date = req.query.date || null;
  const p = dateParams(date);
  try {
    // engine 不可用時 /watchlist 會丟 503 → 進 degraded
    const watchlist = await engineGet('/watchlist', p, T.watchlist);

    // 老王觀點：容忍 404（fallback 視窗內無報告），但 503 要往上丟
    let puhui = null;
    try {
      puhui = await engineGet('/puhui/view', p, T.puhui);
    } catch (e) {
      if (e.status === 503) throw e;
      puhui = null;
    }

    // 大盤環境：取代表股 swing 訊號的 regime 欄位（market-wide，不重算）
    let market_regime = null;
    const repCode = (watchlist.items && watchlist.items[0] && watchlist.items[0].code) || '2330';
    try {
      const sig = await engineGet('/signal', { code: repCode, mode: 'swing', ...p }, T.signal);
      market_regime = sig.regime || null;
    } catch (e) {
      if (e.status === 503) throw e;
      // regime 取不到不致命 → 留 null
    }

    const waterNum = puhui && typeof puhui.water_level === 'number' ? puhui.water_level : null;
    res.json({
      date: (puhui && puhui.requested_date) || watchlist.date || date || null,
      as_of_date: (puhui && puhui.as_of_date) || watchlist.as_of_date || null,
      market_regime,
      water_level: waterNum,
      water_level_text: fractionToText(waterNum),
      puhui_sentiment: (puhui && puhui.market_sentiment) || null,
      watchlist: watchlist.items || [],
      degraded: false,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 503) return res.json(degradedDashboard(date));
    sendError(res, err);
  }
});

// ── GET /api/stocks/:code?date=&backtest=0 ── swing + daytrade + blended + 老王 ──
router.get('/api/stocks/:code', async (req, res) => {
  const code = req.params.code;
  const date = req.query.date || null;
  const withBacktest = ['1', 'true', 'yes', 'on'].includes(String(req.query.backtest || '').toLowerCase());
  const p = dateParams(date);
  try {
    // swing + blended 為主體：任一丟 503 → 整體 503（符合 degradation 規格）
    const [swing, blended] = await Promise.all([
      engineGet('/signal', { code, mode: 'swing', ...p }, T.signal),
      engineGet('/signal/blended', { code, ...p }, T.signal),
    ]);

    // daytrade 盤後常無盤口 → 容忍其錯誤（非 503），不拖垮整體
    const daytrade = await engineGet('/signal', { code, mode: 'daytrade', ...p }, T.signal)
      .catch((e) => {
        if (e.status === 503) throw e;
        return { mode: 'daytrade', unavailable: true, reason: e.message };
      });

    // 老王觀點該股：404 = 老王未提及 → null
    let puhui = null;
    try {
      puhui = await engineGet('/puhui/view', { code, ...p }, T.puhui);
    } catch (e) {
      if (e.status === 503) throw e;
      puhui = null;
    }

    const out = {
      code,
      name: swing.name || (blended && blended.name) || null,
      date: swing.date || date || null,
      swing,
      daytrade,
      blended,
      puhui,
    };

    if (withBacktest) {
      out.backtest = await enginePost('/backtest', { codes: [code], ...(date ? { end: date } : {}) }, T.backtest)
        .catch((e) => {
          if (e.status === 503) throw e;
          return { unavailable: true, reason: e.message };
        });
    }
    out.generated_at = new Date().toISOString();
    res.json(out);
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/stocks/:code/ohlcv?start=&end=&adjust= ── 日K 透傳（缺口A：K線圖資料）──
// 預設走 /data/ohlcv（FinMind **未還原價**：含分割/除權的個股如 0050 會失真）；
// `adjust=1` → 走 /data/ohlcv_adj（yfinance 還原，含除權息/分割，前端 K 線正確）。
// 仍只轉發、不重算。engine 掛掉 → engineGet 丟 503。
router.get('/api/stocks/:code/ohlcv', async (req, res) => {
  const { start, end } = req.query;
  const adjust = ['1', 'true', 'yes', 'on'].includes(String(req.query.adjust || '').toLowerCase());
  const params = { code: req.params.code };
  if (start) params.start = start;
  if (end) params.end = end;
  try {
    res.json(await engineGet(adjust ? '/data/ohlcv_adj' : '/data/ohlcv', params, T.ohlcv));
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/stocks/:code/book ── 即時最佳五檔 透傳（缺口A：當沖盤口；TWSE MIS 預設）──
// live-only：盤後/非交易時段資料可能為空殼或 502（數據源錯誤），由 engine 決定。
router.get('/api/stocks/:code/book', async (req, res) => {
  try {
    res.json(await engineGet('/data/book', { code: req.params.code }, T.book));
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/stocks/:code/intraday?date=&timeframe= ── 盤中分K 透傳（缺口A：盤中圖）──
// 富果源：今日/省略=live；過去日=歷史（受富果回溯限制）。
router.get('/api/stocks/:code/intraday', async (req, res) => {
  const { date, timeframe } = req.query;
  const params = { code: req.params.code };
  if (date) params.date = date;
  if (timeframe) params.timeframe = timeframe;
  try {
    res.json(await engineGet('/data/intraday', params, T.intraday));
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/watchlist?date= ── 透傳 ───────────────────────────────────────────
router.get('/api/watchlist', async (req, res) => {
  try {
    res.json(await engineGet('/watchlist', dateParams(req.query.date), T.watchlist));
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/reports/list ── 純檔案系統（engine 無關）─────────────────────────
router.get('/api/reports/list', (req, res) => {
  const reports = listReports();
  res.json({
    count: reports.length,
    dates: reports.map((r) => r.date),
    latest: reports.length ? reports[0].date : null,
    reports,
  });
});

// ── GET /api/reports?date= ── 讀當日報告 markdown（純檔案系統）───────────────
router.get('/api/reports', (req, res) => {
  const date = req.query.date || null;
  const r = getReport(date);
  if (!r) {
    return sendError(res, httpError(404, 'REPORT_NOT_FOUND',
      `找不到老王報告${date ? `（${date}）` : ''}`));
  }
  res.json({
    ...r,
    // 🚨 提醒前端：老王報告 emoji 與股市紅綠相反
    emoji_semantics: '🔴=看多 / 🟢=看空 / 🟠=中性觀望（與股市紅漲綠跌相反）',
  });
});

// ── POST /api/backtest ── 透傳 engine（body 原樣）─────────────────────────────
router.post('/api/backtest', async (req, res) => {
  try {
    res.json(await enginePost('/backtest', req.body || {}, T.backtest));
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/backtest/grid ── 透傳（可選）───────────────────────────────────
router.post('/api/backtest/grid', async (req, res) => {
  try {
    res.json(await enginePost('/backtest/grid', req.body || {}, T.backtest));
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/agents/decide ── 透傳（很貴：每股 7×LLM ≈187s，只在明確請求時呼叫）──
router.post('/api/agents/decide', async (req, res) => {
  try {
    res.json(await enginePost('/agents/decide', req.body || {}, T.agents));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
