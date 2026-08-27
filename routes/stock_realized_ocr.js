/**
 * routes/stock_realized_ocr.js — 個股／ETF 券商 App 截圖辨識（opt36，2026-08-27 新增）。
 *
 *   POST /api/stocks/realized-ocr —— 收 base64 圖片 → 視覺模型辨識 → 回結構化的已實現損益列
 *
 * 沿用 routes/futures_ocr.js 的整套設計（同一組理由：key 不能進前端 bundle、
 * 圖片不落地也不記 log、辨識與帳務判斷分開）。差異只在辨識目標：台股券商的
 * 「已實現損益查詢」畫面每一列都已經是券商算好的完整交易（買賣雙腿＋手續費＋
 * 證交稅＋損益都在同一列），不像期貨要拆兩腿再湊，所以只有一種畫面 kind。
 *
 * 模型＝Google Gemini 2.5（沿用 futures_ocr.js 同一套 3 把 key 輪換）。
 */
'use strict';

const express = require('express');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MAX_IMAGES = 4;
const MAX_B64_CHARS = 8 * 1024 * 1024; // 約 6MB 原圖；前端會先縮圖，這是最後一道防線
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const PROMPT = `你是台灣證券商 App 的截圖判讀器。看這張截圖，只輸出一個 JSON 物件，不要任何說明文字、不要 markdown code fence。

先判斷這是不是「已實現損益查詢」畫面，填在 kind：
- "realized" ：已實現損益查詢／已實現損益明細。欄位通常有「股票代號/名稱、買進日期、
              賣出日期、股數/數量、買進均價、賣出均價、手續費、交易稅、損益、報酬率」，
              每一列是**一筆已經結算完成的交易**（不是還在持有的庫存）。
- "unknown"  ：不是這種畫面（例如未實現損益、庫存查詢、成交回報、大盤資訊等）

輸出格式（用不到的陣列給空陣列，用不到的物件給 null，讀不到的數字給 null）：
{
  "kind": "realized",
  "title": "畫面標題文字",
  "totals": { "pnl": 畫面上顯示的損益合計數字, "count": 畫面上顯示的筆數 },
  "rows": [
    {
      "symbol": "股票代號，例如 2330 或 0050",
      "name": "股票名稱原文",
      "margin_type": "現股｜融資｜融券｜當沖，讀不到就填「現股」",
      "buy_date": "YYYY/MM/DD 或 YYYY-MM-DD，讀不到給 null",
      "sell_date": "YYYY/MM/DD 或 YYYY-MM-DD",
      "qty": 股數（不是張數，1 張＝1000 股，畫面若只寫「張」要換算成股數）,
      "buy_price": 買進均價,
      "sell_price": 賣出均價,
      "fee": 手續費（讀不到給 null，不要用 0 代替不確定）,
      "tax": 交易稅（讀不到給 null）,
      "pnl": 損益（畫面上顯示的淨損益數字，虧損是負數）
    }
  ]
}

規則（很重要，錯了會算錯錢）：
1. 數字去掉千分位逗號，只輸出數字本身，不要引號、不要單位、不要正負號以外的符號。虧損是負數。
2. 股數如果畫面寫的是「張」，要 ×1000 換算成股數再輸出；畫面本來就是股數（例如零股）就直接輸出。
3. 一列都沒有的畫面，rows 就給 []。看不清楚的欄位給 null，**不要猜**。
4. 不要輸出帳號、姓名或任何截圖上的個人資料。
5. kind 是 "unknown" 時 rows 一律給 []、totals 一律給 {"pnl": null, "count": null}。
6. 同一列如果賣出日期比買進日期早，代表兩個日期欄位可能認反了，請依常理修正（賣出日應晚於或等於買進日）。`;

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

function safeSymbol(v) {
  return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/** 台股 ETF 代號慣例＝'00' 開頭（含槓桿/反向 00xxxL/00xxxR），其餘視為個股 */
function detectKind(symbol) {
  return /^00\d/.test(symbol) ? 'etf' : 'stock';
}

/** 融券＝先賣後買，比照期貨 side 語意算 short；現股/融資/當沖一律當 long */
function sideOf(v) {
  return /融券/.test(str(v)) ? 'short' : 'long';
}

function kindOf(v, obj) {
  const s = str(v).toLowerCase();
  if (s === 'realized' || s === 'unknown') return s;
  if (Array.isArray(obj.rows) && obj.rows.length) return 'realized';
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

function normalizeRows(raw, warnings) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = r && typeof r === 'object' ? r : {};
    const symbol = safeSymbol(o.symbol);
    const name = str(o.name);
    const qty = pos(o.qty);
    const buy_price = pos(o.buy_price);
    const sell_price = pos(o.sell_price);
    const sell_date = isoDate(o.sell_date);
    const buy_date = isoDate(o.buy_date);
    if (!symbol || !qty || !buy_price || !sell_price || !sell_date) {
      warnings.push(`已實現損益有一列讀不完整，已略過：${name || symbol || '(無代號)'}`);
      continue;
    }
    // 融券是先賣（放空）後買（回補），buy_date 晚於 sell_date 是正常現象，不是
    // 讀反了；只有現股/融資/當沖（先買後賣）才需要提醒買進日期看起來不合理。
    const side = sideOf(o.margin_type);
    if (side === 'long' && buy_date && buy_date > sell_date) {
      warnings.push(`${name || symbol} 有一列的買進日期晚於賣出日期，數字仍會照樣計算，請自行核對。`);
    }
    out.push({
      symbol,
      name: name || symbol,
      kind: detectKind(symbol),
      side,
      qty,
      buy_price,
      sell_price,
      buy_date,
      sell_date,
      fee: num(o.fee),
      tax: num(o.tax),
      net_pnl: num(o.pnl),
      // 去重指紋：代號 + 賣出日 + 股數 + 買賣均價，同一列再截一次圖也會一樣
      ref: `s|${symbol}|${sell_date}|${qty}|${buy_price}|${sell_price}`,
    });
  }
  return out;
}

function normalizeScreen(obj) {
  const warnings = [];
  const o = obj && typeof obj === 'object' ? obj : {};
  const kind = kindOf(o.kind, o);
  const totalsRaw = o.totals && typeof o.totals === 'object' ? o.totals : {};
  const rows = kind === 'realized' ? normalizeRows(o.rows, warnings) : [];
  const screen = {
    title: str(o.title),
    rows,
    totals: { pnl: num(totalsRaw.pnl), count: num(totalsRaw.count) },
    warnings,
  };
  if (kind !== 'realized') {
    warnings.push('這張認不出是「已實現損益查詢」畫面，已略過。');
  } else if (screen.totals.count !== null && screen.totals.count !== rows.length) {
    warnings.push(`截圖上寫有 ${screen.totals.count} 筆，但只認出 ${rows.length} 筆——請確認截圖沒有被裁切或需要往下捲。`);
  }
  return screen;
}

// ── Gemini 呼叫（3 把 key × 2 個模型輪換，與 futures_ocr.js 同一套）────────

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

router.post('/api/stocks/realized-ocr', async (req, res) => {
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
      const data = String(o.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
      if (!ALLOWED_MIME.has(mime)) {
        return sendError(res, httpError(400, 'BAD_REQUEST', `不支援的圖片格式：${mime}`));
      }
      if (!data || data.length > MAX_B64_CHARS) {
        return sendError(res, httpError(400, 'BAD_REQUEST', '圖片是空的或太大（單張上限約 6MB）'));
      }
      images.push({ mime, data });
    }

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
router.normalizeRows = normalizeRows;
router.detectKind = detectKind;
router.sideOf = sideOf;
router.isoDate = isoDate;
router.parseJson = parseJson;

module.exports = router;
