/**
 * routes/futures_ocr.js — 券商 App 截圖辨識（opt30，2026-08-19 新增）。
 *
 *   POST /api/futures/ocr  —— 收 base64 圖片 → 視覺模型辨識 → 回結構化的成交/部位列
 *
 * 為什麼是 gateway 做而不是瀏覽器做：辨識要 API key，key 不能進前端 bundle
 * （這站是無登入自用站，但 bundle 是靜態檔，放進去等於公開）。另外手機瀏覽器跑
 * 本地 OCR（tesseract）要下載十幾 MB 模型，對這種密集中文表格的準確度也不夠看。
 *
 * 模型＝Google Gemini 2.5（沿用 scripts/puhui_daily.cjs 已經在跑的 3 把 key 輪換，
 * 零新依賴、零新帳號）。**圖片不落地也不記 log**：只在記憶體裡轉手一次就丟掉。
 *
 * 這支只負責「把畫面變成資料」，不碰任何檔案、不做任何會計判斷——
 * 「這些成交要怎麼併進部位與平倉紀錄」在前端的 lib/futuresImport.ts，那裡有測試。
 * 分這一刀是為了讓辨識錯誤與帳務錯誤不會混在一起查。
 */
'use strict';

const express = require('express');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MAX_IMAGES = 4;
const MAX_B64_CHARS = 8 * 1024 * 1024; // 約 6MB 原圖；前端會先縮圖，這是最後一道防線
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const PROMPT = `你是台灣期貨券商 App 的截圖判讀器。看這張截圖，只輸出一個 JSON 物件，不要任何說明文字、不要 markdown code fence。

先判斷這是哪一種畫面，填在 kind：
- "open"   ：未平倉查詢／未沖銷部位（欄位有「口數 / 成交均價 / 市價 / 未平倉損益」）
- "closed" ：平倉查詢／已結算損益（欄位有「平倉日期 / 交易日期 / 平倉損益 / 手續費 / 交易稅 / 淨損益」，每一列有上下兩行）
- "fills"  ：成交回報／今日成交（欄位有「成交時間 / 成交口數 / 成交均價 / 倉別」）
- "unknown"：不是上述三種

輸出格式（用不到的陣列給空陣列，讀不到的數字給 null）：
{
  "kind": "open",
  "title": "畫面標題文字",
  "totals": { "pnl": 估總損益或總損益的數字, "count": 留倉筆數或成交筆數 },
  "open_rows": [
    { "product": "商品名稱原文", "month": "YYYYMM", "direction": "買進|賣出",
      "lots": 口數, "avg_price": 成交均價, "market_price": 市價, "pnl": 未平倉損益 }
  ],
  "closed_rows": [
    { "product": "商品名稱原文", "month": "YYYYMM", "lots": 口數,
      "close_date": "YYYY/MM/DD",
      "close_leg": { "direction": "買進|賣出", "date": "YYYY/MM/DD", "price": 成交價, "fee": 手續費, "tax": 交易稅, "order_id": "委託書號" },
      "open_leg":  { "direction": "買進|賣出", "date": "YYYY/MM/DD", "price": 成交價, "fee": 手續費, "tax": 交易稅, "order_id": "委託書號" },
      "pnl": 平倉損益, "net_pnl": 淨損益 }
  ],
  "fill_rows": [
    { "product": "商品名稱原文", "month": "YYYYMM", "datetime": "YYYY/MM/DD HH:MM:SS",
      "direction": "買進|賣出", "open_close": "新倉|平倉", "lots": 成交口數,
      "price": 成交均價, "order_id": "委託書號" }
  ]
}

規則（很重要，錯了會算錯錢）：
1. month 是商品名稱結尾的六位數到期月份，例如「小型元大台灣50ETF期202609」→ "202609"。找不到就給 ""。
2. 平倉查詢每一列有兩行：**上面那行是平倉腿（它的交易日期等於平倉日期），下面那行是建倉腿**。分別填進 close_leg 與 open_leg，不要弄反。
3. 手續費與交易稅是**每一行各自**的金額，各自填在自己那一腿，不要相加。
4. 數字去掉千分位逗號，只輸出數字本身，不要引號、不要單位、不要正負號以外的符號。損失是負數。
5. 一列都沒有的畫面，陣列就給 []。看不清楚的欄位給 null，**不要猜**。
6. 不要輸出帳號、姓名或任何截圖上的個人資料。`;

function keys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
}

// ── 解析工具（模型輸出一律當成不可信的字串處理）─────────────────────────────

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.replace(/[,\s$]/g, '').replace(/[（(]([\d.]+)[)）]/, '-$1');
    const p = parseFloat(s);
    if (Number.isFinite(p)) return p;
  }
  return null;
}
function pos(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** '2026/08/11'、'2026-8-1'、'2026年8月11日' → '2026-08-11'；認不出來回 '' */
function isoDate(v) {
  const s = str(v);
  const m = s.match(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

function isoTime(v) {
  const m = str(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}:${(m[3] || '00').padStart(2, '0')}`;
}

/**
 * 到期月份。模型自己給的 month 優先，格式不對才從商品名稱撈。
 * 商品名稱裡可能同時有「50」「0050」這種數字，所以只認 20xxxx 且取最後一個。
 */
function monthOf(rawMonth, product) {
  const m = str(rawMonth).replace(/[^0-9]/g, '');
  if (/^\d{6}$/.test(m) && /^20\d{2}(0[1-9]|1[0-2])$/.test(m)) return m;
  const hits = str(product).match(/20\d{2}(?:0[1-9]|1[0-2])/g);
  return hits && hits.length ? hits[hits.length - 1] : '';
}

function dirOf(v) {
  const s = str(v);
  if (/買|多|B$|^B/i.test(s)) return 'buy';
  if (/賣|空|S$|^S/i.test(s)) return 'sell';
  return '';
}

function actionOf(v) {
  const s = str(v);
  if (/平/.test(s)) return 'close';
  if (/新|開/.test(s)) return 'open';
  return '';
}

function kindOf(v, obj) {
  const s = str(v).toLowerCase();
  if (['open', 'closed', 'fills', 'unknown'].includes(s)) return s;
  // 模型有時把 kind 寫成中文標題；用哪個陣列有東西反推
  if (Array.isArray(obj.closed_rows) && obj.closed_rows.length) return 'closed';
  if (Array.isArray(obj.fill_rows) && obj.fill_rows.length) return 'fills';
  if (Array.isArray(obj.open_rows) && obj.open_rows.length) return 'open';
  return 'unknown';
}

/** 模型偶爾還是會包 markdown code fence；剝掉再 parse */
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型回傳的不是 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

// ── 正規化成前端 lib/futuresImport.ts 的 ScanScreen ─────────────────────────

function normalizeOpen(raw, warnings) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const product = str(r && r.product);
    const month = monthOf(r && r.month, product);
    const direction = dirOf(r && r.direction);
    const lots = pos(r && r.lots);
    const avg = pos(r && r.avg_price);
    if (!month || !direction || !lots || !avg) {
      warnings.push(`未平倉有一列讀不完整，已略過：${product || '(無商品名)'}`);
      continue;
    }
    out.push({
      product,
      month,
      side: direction === 'buy' ? 'long' : 'short',
      lots,
      avg_price: avg,
      market_price: pos(r.market_price),
      pnl: num(r.pnl),
    });
  }
  return out;
}

function leg(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    direction: dirOf(o.direction),
    date: isoDate(o.date),
    price: pos(o.price),
    fee: num(o.fee),
    tax: num(o.tax),
    order_id: str(o.order_id),
  };
}

function normalizeClosed(raw, warnings) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const product = str(r && r.product);
    const month = monthOf(r && r.month, product);
    const lots = pos(r && r.lots);
    let close = leg(r && r.close_leg);
    let open = leg(r && r.open_leg);
    const closeDate = isoDate(r && r.close_date) || close.date;

    if (!month || !lots || !close.price || !open.price) {
      warnings.push(`平倉查詢有一列讀不完整，已略過：${product || '(無商品名)'}`);
      continue;
    }
    // 兩腿被寫反的話（建倉日期比平倉日期晚），照日期把它轉回來
    if (open.date && close.date && open.date > close.date) {
      const t = open; open = close; close = t;
      warnings.push(`平倉查詢有一列的兩腿順序像是相反的（建倉日晚於平倉日），已依日期修正：${product}`);
    }
    if (!open.direction) {
      warnings.push(`平倉查詢有一列讀不出買賣別，先當多單處理，請自行核對：${product}`);
    }
    if (open.date && close.date && open.date === close.date) {
      warnings.push(`${product} 有一列的建倉與平倉同一天（當沖），方向是用「下面那行＝建倉腿」判定的，請自行核對多空。`);
    }
    const side = open.direction === 'sell' ? 'short' : 'long';
    const fee = open.fee !== null || close.fee !== null ? (open.fee || 0) + (close.fee || 0) : null;
    const tax = open.tax !== null || close.tax !== null ? (open.tax || 0) + (close.tax || 0) : null;
    const exit_date = closeDate || close.date || open.date;
    out.push({
      product,
      month,
      side,
      lots,
      entry_price: open.price,
      entry_date: open.date,
      exit_price: close.price,
      exit_date,
      pnl: num(r.pnl),
      fee,
      tax,
      net_pnl: num(r.net_pnl),
      // 去重指紋：平倉日 + 兩張委託書號 + 口數 + 兩腿價格，同一列再截一次圖也會一樣
      ref: `c|${exit_date}|${close.order_id}|${open.order_id}|${lots}|${open.price}|${close.price}`,
    });
  }
  return out;
}

function normalizeFills(raw, warnings) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const product = str(r && r.product);
    const month = monthOf(r && r.month, product);
    const direction = dirOf(r && r.direction);
    const action = actionOf(r && r.open_close);
    const lots = pos(r && r.lots);
    const price = pos(r && r.price);
    const date = isoDate(r && r.datetime);
    const time = isoTime(r && r.datetime);
    if (!month || !direction || !action || !lots || !price || !date) {
      warnings.push(`成交回報有一列讀不完整，已略過：${product || '(無商品名)'}`);
      continue;
    }
    out.push({
      product,
      month,
      direction,
      action,
      lots,
      price,
      date,
      time,
      ref: `f|${date} ${time}|${str(r.order_id)}|${direction}|${action}|${lots}|${price}`,
    });
  }
  return out;
}

function normalizeScreen(obj) {
  const warnings = [];
  const o = obj && typeof obj === 'object' ? obj : {};
  const kind = kindOf(o.kind, o);
  const totalsRaw = o.totals && typeof o.totals === 'object' ? o.totals : {};
  const screen = {
    kind,
    title: str(o.title),
    open_rows: kind === 'open' ? normalizeOpen(o.open_rows, warnings) : [],
    closed_rows: kind === 'closed' ? normalizeClosed(o.closed_rows, warnings) : [],
    fill_rows: kind === 'fills' ? normalizeFills(o.fill_rows, warnings) : [],
    totals: { pnl: num(totalsRaw.pnl), count: num(totalsRaw.count) },
    warnings,
  };
  const parsed = screen.open_rows.length + screen.closed_rows.length + screen.fill_rows.length;
  if (screen.totals.count !== null && screen.totals.count !== parsed) {
    warnings.push(`截圖上寫有 ${screen.totals.count} 筆，但只認出 ${parsed} 筆——請確認截圖沒有被裁切或需要往下捲。`);
  }
  if (kind === 'unknown') {
    warnings.push('這張認不出是未平倉查詢、平倉查詢或成交回報，已略過。');
  }
  return screen;
}

// ── Gemini 呼叫（3 把 key × 2 個模型輪換，與 puhui_daily.cjs 同一套）────────

async function scanOne(image) {
  const apiKeys = keys();
  if (apiKeys.length === 0) throw new Error('伺服器未設定 GEMINI_API_KEY，無法辨識截圖');
  let lastError = null;

  for (const apiKey of apiKeys) {
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      let data;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: image.mime, data: image.data } },
              ],
            }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
              // 這是抄寫任務不是推理任務；關掉 thinking 讓輸出穩定、也不會被吃掉 token
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
        data = await r.json();
      } catch (err) {
        lastError = new Error(`${model}: ${err.message}`);
        continue;
      }
      if (data && data.error) {
        lastError = new Error(`${model}: ${String(data.error.message || '').slice(0, 160)}`);
        // key 本身無效就換 key，配額類的先換模型
        if (data.error.code === 400 || data.error.status === 'INVALID_ARGUMENT') break;
        continue;
      }
      const cand = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
      const text = cand && cand.content && Array.isArray(cand.content.parts)
        ? cand.content.parts.map((p) => p.text || '').join('')
        : '';
      if (!text) {
        lastError = new Error(`${model}: 沒有輸出（finishReason=${cand ? cand.finishReason : 'none'}）`);
        continue;
      }
      try {
        return { screen: normalizeScreen(parseJson(text)), model };
      } catch (err) {
        lastError = new Error(`${model}: ${err.message}`);
        continue;
      }
    }
  }
  throw lastError || new Error('所有辨識模型都失敗');
}

router.post('/api/futures/ocr', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const raw = Array.isArray(body.images) ? body.images : [];
    if (raw.length === 0) return sendError(res, httpError(400, 'BAD_REQUEST', '沒有收到圖片'));
    if (raw.length > MAX_IMAGES) {
      return sendError(res, httpError(400, 'BAD_REQUEST', `一次最多 ${MAX_IMAGES} 張截圖`));
    }

    const images = [];
    for (const it of raw) {
      const o = it && typeof it === 'object' ? it : {};
      const mime = String(o.mime || 'image/jpeg').toLowerCase();
      // 前端可能連 data URL 一起送，這裡一律剝掉前綴只留 base64 本體
      const data = String(o.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
      if (!ALLOWED_MIME.has(mime)) {
        return sendError(res, httpError(400, 'BAD_REQUEST', `不支援的圖片格式：${mime}`));
      }
      if (!data || data.length > MAX_B64_CHARS) {
        return sendError(res, httpError(400, 'BAD_REQUEST', '圖片是空的或太大（單張上限約 6MB）'));
      }
      images.push({ mime, data });
    }

    // 一張一次呼叫：好對應（第 N 張對第 N 個結果），一張失敗也不會拖垮其他張
    const settled = await Promise.all(images.map((img) => scanOne(img).catch((e) => ({ error: e.message }))));
    const screens = [];
    const warnings = [];
    const models = new Set();
    settled.forEach((r, i) => {
      if (r.error) {
        warnings.push(`第 ${i + 1} 張辨識失敗：${r.error}`);
        return;
      }
      models.add(r.model);
      screens.push(r.screen);
    });
    if (screens.length === 0) {
      return sendError(res, httpError(502, 'UPSTREAM', `截圖辨識失敗：${warnings.join('；') || '未知原因'}`));
    }
    return res.json({
      ok: true,
      screens,
      warnings,
      model: [...models].join('、'),
      scanned_at: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '截圖辨識失敗: ' + err.message));
  }
});

// 給測試用（前端 vitest 直接 require 這支，驗正規化不必打網路）
router.normalizeScreen = normalizeScreen;
router.normalizeClosed = normalizeClosed;
router.normalizeFills = normalizeFills;
router.normalizeOpen = normalizeOpen;
router.monthOf = monthOf;
router.isoDate = isoDate;
router.parseJson = parseJson;

module.exports = router;
