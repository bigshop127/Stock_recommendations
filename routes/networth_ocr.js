/**
 * routes/networth_ocr.js — 銀行 App 餘額截圖辨識（2026-08-28 新增，資產變化圖用）。
 *
 *   POST /api/networth/bank-ocr —— 收 base64 圖片 → 視覺模型辨識 → 回辨識出的帳戶餘額
 *
 * 沿用 routes/stock_realized_ocr.js／routes/futures_ocr.js 的整套設計（key 不能進
 * 前端 bundle、圖片不落地也不記 log）。銀行帳戶完全沒有 API，這是唯一能省手動輸入
 * 的路——但跟已實現損益不同，辨識結果只是「填進銀行總額欄位」的建議值，不會自動
 * 存檔，使用者仍要自己確認/微調後按「更新今天快照」，避免看錯一個數字就整個誤植。
 *
 * 銀行 App 常見版型是「多帳戶列表＋合計」（活存/外幣/其他），所以辨識目標是一組
 * accounts + 可能存在的 total_balance，前端把多張截圖（可能不同銀行）的建議值加總。
 */
'use strict';

const express = require('express');
const { sendError, httpError } = require('../lib/errors');

const router = express.Router();

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MAX_IMAGES = 4;
const MAX_B64_CHARS = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const PROMPT = `你是台灣銀行 App 的截圖判讀器。看這張截圖，只輸出一個 JSON 物件，不要任何說明文字、不要 markdown code fence。

先判斷這是不是「帳戶餘額／存款總覽」畫面，填在 kind：
- "balance"  ：帳戶餘額查詢、存款總覽、我的帳戶列表等，畫面上能看到至少一個新台幣或外幣的
              帳戶餘額數字。
- "unknown"  ：不是這種畫面（例如交易明細、轉帳頁面、廣告頁等）

輸出格式（用不到的陣列給空陣列，用不到的欄位給 null，讀不到的數字給 null）：
{
  "kind": "balance",
  "bank_name": "銀行名稱，讀不到給 null",
  "total_balance": 畫面上明確顯示的「總計/合計/總資產」數字（如果有），沒有就 null,
  "accounts": [
    { "label": "帳戶別名或帳號末幾碼，例如「薪轉帳戶」或「****1234」", "balance": 該帳戶餘額數字 }
  ]
}

規則（很重要，錯了會算錯錢）：
1. 數字去掉千分位逗號，只輸出數字本身，不要引號、不要單位、不要正負號以外的符號。
2. 只認新台幣帳戶；外幣帳戶（美元/日圓等）看不出即時匯率換算就不要硬換算，該帳戶的
   balance 給 null 並在 label 註明幣別，前端會忽略 balance 為 null 的項目。
3. 畫面上如果只有一個總額數字、看不出逐筆帳戶，accounts 給空陣列、total_balance 填那個數字。
4. 畫面上如果有逐筆帳戶但沒有總計，total_balance 給 null，accounts 逐筆列出（前端會自己加總）。
5. 不要輸出帳號全碼、姓名或任何其他個人資料，帳號只能用末幾碼。
6. kind 是 "unknown" 時 accounts 給 []、total_balance 給 null。`;

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
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function kindOf(v, obj) {
  const s = str(v).toLowerCase();
  if (s === 'balance' || s === 'unknown') return s;
  if ((Array.isArray(obj.accounts) && obj.accounts.length) || num(obj.total_balance) !== null) return 'balance';
  return 'unknown';
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型回傳的不是 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

function normalizeAccounts(raw) {
  const out = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    const o = a && typeof a === 'object' ? a : {};
    const label = str(o.label).slice(0, 40);
    const balance = num(o.balance);
    if (balance === null) continue; // 外幣或讀不到的帳戶，前端不需要看到一筆看不懂的 null
    out.push({ label: label || '(未標示帳戶)', balance });
  }
  return out;
}

function normalizeScreen(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const kind = kindOf(o.kind, o);
  const accounts = kind === 'balance' ? normalizeAccounts(o.accounts) : [];
  const total_balance = kind === 'balance' ? num(o.total_balance) : null;
  // 建議值：畫面自己給的合計優先，沒有合計才用逐筆帳戶加總
  const suggested = total_balance !== null ? total_balance : accounts.reduce((s, a) => s + a.balance, 0);
  const warnings = [];
  if (kind !== 'balance') warnings.push('這張認不出是「帳戶餘額」畫面，已略過。');
  return {
    kind,
    bank_name: str(o.bank_name) || null,
    total_balance,
    accounts,
    suggested,
    warnings,
  };
}

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
              maxOutputTokens: 4096,
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

router.post('/api/networth/bank-ocr', async (req, res) => {
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
      warnings.push(...r.screen.warnings);
    });
    if (screens.length === 0) {
      return sendError(res, httpError(502, 'UPSTREAM', `截圖辨識失敗：${warnings.join('；') || '未知原因'}`));
    }
    const total_suggested = screens.reduce((s, sc) => s + sc.suggested, 0);
    return res.json({
      ok: true,
      screens,
      total_suggested,
      warnings,
      model: [...models].join('、'),
      scanned_at: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, httpError(500, 'INTERNAL', '截圖辨識失敗: ' + err.message));
  }
});

// 給測試用（直接 require 這支，驗正規化不必打網路）
router.normalizeScreen = normalizeScreen;
router.normalizeAccounts = normalizeAccounts;
router.parseJson = parseJson;

module.exports = router;
