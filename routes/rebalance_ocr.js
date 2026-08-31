/**
 * routes/rebalance_ocr.js — 再平衡計算機「庫存查詢」截圖辨識（2026-08-31 新增）。
 *
 *   POST /api/rebalance/holdings-ocr —— 收 base64 圖片 → 視覺模型辨識 → 回結構化的庫存列
 *
 * 沿用 routes/stock_realized_ocr.js 的整套設計（key 不進前端 bundle、圖片不落地也不記
 * log）。辨識目標不同：這裡認的是券商 App 的「庫存查詢／持股明細」畫面（目前持有的股數
 * 與平均成本），用來直接帶入再平衡計算機的期初部位（00631L／00687B／00953B），不是逐筆
 * 交易紀錄——比對哪些代號要用交給前端 lib/rebalanceHoldingsImport.ts。
 *
 * 模型＝Google Gemini 2.5（沿用同一套 key 輪換）。
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

先判斷這是不是「庫存查詢／持股明細」畫面，填在 kind：
- "holdings" ：庫存查詢／持股明細／庫存損益。列出目前持有的股票／ETF，欄位通常有「股票代號/
              名稱、股數（或張數）、平均成本、現價、市值」等——是**目前還持有的部位**，不是
              已實現損益、不是成交回報、不是單一整戶總覽數字。
- "unknown"  ：不是這種畫面（例如已實現損益查詢、成交回報、大盤資訊、帳戶總覽權益數等）

輸出格式（用不到的陣列給空陣列，讀不到的數字給 null）：
{
  "kind": "holdings",
  "title": "畫面標題文字",
  "cash": 畫面上若有清楚顯示現金／可用餘額／交割款可動用金額就填數字，沒顯示就給 null,
  "rows": [
    {
      "symbol": "股票代號，例如 00631L 或 2330",
      "name": "股票名稱原文",
      "shares": 股數（不是張數，1 張＝1000 股，畫面若只寫「張」要換算成股數）,
      "avg_cost": 平均成本／每股成本（讀不到給 null，不要用 0 代替不確定）,
      "market_price": 現價／市價（讀不到給 null）
    }
  ]
}

規則（很重要，錯了會算錯部位）：
1. 數字去掉千分位逗號，只輸出數字本身，不要引號、不要單位。
2. 股數如果畫面寫的是「張」，要 ×1000 換算成股數再輸出；畫面本來就是股數（例如零股）就直接輸出。
3. 一列都沒有的畫面，rows 就給 []。看不清楚的欄位給 null，**不要猜**。
4. 不要輸出帳號、姓名或任何截圖上的個人資料。
5. kind 是 "unknown" 時 rows 一律給 []、cash 一律給 null。`;

function keys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
}

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
function safeSymbol(v) {
  return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
function kindOf(v, obj) {
  const s = str(v).toLowerCase();
  if (s === 'holdings' || s === 'unknown') return s;
  return Array.isArray(obj.rows) && obj.rows.length ? 'holdings' : 'unknown';
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
    const shares = pos(o.shares);
    if (!symbol || !shares) {
      warnings.push(`庫存有一列讀不完整，已略過：${name || symbol || '(無代號)'}`);
      continue;
    }
    out.push({ symbol, name: name || symbol, shares, avg_cost: pos(o.avg_cost), market_price: pos(o.market_price) });
  }
  return out;
}

function normalizeScreen(obj) {
  const warnings = [];
  const o = obj && typeof obj === 'object' ? obj : {};
  const kind = kindOf(o.kind, o);
  const rows = kind === 'holdings' ? normalizeRows(o.rows, warnings) : [];
  const screen = { title: str(o.title), rows, cash: kind === 'holdings' ? num(o.cash) : null, warnings };
  if (kind !== 'holdings') {
    warnings.push('這張認不出是「庫存查詢／持股明細」畫面，已略過。');
  }
  return screen;
}

// ── Gemini 呼叫（3 把 key × 2 個模型輪換，與 stock_realized_ocr.js 同一套）────
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

router.post('/api/rebalance/holdings-ocr', async (req, res) => {
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
router.parseJson = parseJson;

module.exports = router;
