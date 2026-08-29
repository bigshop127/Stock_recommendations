#!/usr/bin/env node
/**
 * 信用卡電子帳單自動記帳（2026-08-29 新增，資產變化圖「每月信用卡帳單」用）。
 * ---------------------------------------------------------------------------
 * 每天檢查兩張卡（台新 Richart商務御璽卡／玉山熊本熊雙幣卡）的電子帳單信箱，抓到
 * 新一期帳單就下載 PDF 附件、用密碼解密、抽文字、丟給 Gemini 結構化成 JSON，
 * 寫進 data/monthly_bills.json（畫「每月支出」歷史用）。
 *
 * 設計原則（比照 scripts/futures_alert.cjs／scripts/rebalance_alert.cjs，刻意獨立）：
 *   - Google OAuth／Gmail 手法複製自 futures_alert.cjs 那份（各腳本各自帶一份，
 *     這個 repo 一貫不為兩三支 cron script 抽共用 lib）。
 *   - Gemini 結構化抽取的 keys()/models fallback 手法複製自 routes/networth_ocr.js。
 *   - PDF 解密＋抽字用 pdfjs-dist（純 JS legacy build，不需要 qpdf/pikepdf 這類系統
 *     相依，VM 上沒裝也不用裝）。
 *   - 去重用 Gmail message id（不是月份字串）：處理過的 id 記在 store 裡，重跑不會
 *     重複寫入，也不怕使用者把信件從 Trash 徹底清掉後 id 對不上——反正只會漏抓，
 *     不會重複抓。
 *   - 使用者習慣讀完帳單信就刪，玉山那封常常已經在 Trash 裡，Gmail 搜尋預設只找
 *     inbox，這裡刻意用 `in:anywhere` 涵蓋 Trash（垃圾桶 30 天內都撈得到）。
 *   - 只認帳單裡寫的民國年原始字串、程式碼自己 +1911 換算西元，不信任 LLM 算日期。
 *
 * 用法：
 *   node scripts/fetch_credit_card_bills.cjs             正常執行（cron 用）
 *   node scripts/fetch_credit_card_bills.cjs --dry-run   只印出結果，不寫檔
 *
 * 排程（VM crontab，時間任選——帳單抵達日期每月不同，一天檢查一次即可）：
 *   30 8 * * * cd /home/ubuntu/Stock_recommendations && /usr/bin/node scripts/fetch_credit_card_bills.cjs >> data/bills_fetch.log 2>&1
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 先載入 .env（cron 環境通常沒有 export）──────────────────────────
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(p, 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch (_) { /* 無 .env 就靠既有環境變數 */ }
}
loadEnvFile();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const DATA_DIR = path.join(__dirname, '..', 'data');
// 可覆寫路徑：測試時指到別的檔案，免得動到 production 那份（前端會從它載入）
const BILLS_PATH = process.env.MONTHLY_BILLS_PATH || path.join(DATA_DIR, 'monthly_bills.json');
const LOG_PATH = path.join(DATA_DIR, 'bills_fetch.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

// ── 帳單來源設定（寫死兩筆，不做成通用多銀行框架——目前就只有這兩張卡）────
const SOURCES = [
  {
    bank: '台新',
    from: 'webmaster@bhurecv.taishinbank.com.tw',
    subjectContains: '信用卡電子帳單',
    passwordEnv: 'TAISHIN_BILL_PDF_PASSWORD',
  },
  {
    bank: '玉山',
    from: 'estatement@esunbank.com',
    subjectContains: '信用卡電子帳單',
    passwordEnv: 'ESUN_BILL_PDF_PASSWORD',
  },
];

// ── Google OAuth（沿用 futures_alert.cjs 手法，獨立複製一份）────────────
async function getAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  }).then((res) => res.json());
  return r && r.access_token ? r.access_token : null;
}

async function gmailGet(token, path_) {
  const res = await fetch(`https://gmail.googleapis.com${path_}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** 找該來源最新一封信的 message id；`in:anywhere` 涵蓋 Trash（使用者習慣讀完就刪）。 */
async function findLatestMessageId(token, source) {
  const q = `in:anywhere from:${source.from} subject:(${source.subjectContains})`;
  const body = await gmailGet(token, `/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  return body.messages[0].id; // Gmail 列表預設新到舊
}

function walkParts(payload, out) {
  if (!payload) return;
  out.push({ filename: payload.filename, attachmentId: payload.body && payload.body.attachmentId });
  if (Array.isArray(payload.parts)) for (const p of payload.parts) walkParts(p, out);
}

/** 抓信件裡的 PDF 附件，回傳解碼後的 Buffer；找不到回 null。 */
async function fetchPdfAttachment(token, msgId) {
  const full = await gmailGet(token, `/gmail/v1/users/me/messages/${msgId}?format=full`);
  const parts = [];
  walkParts(full.payload, parts);
  const pdfPart = parts.find((p) => p.filename && p.filename.toLowerCase().endsWith('.pdf') && p.attachmentId);
  if (!pdfPart) return null;
  const att = await gmailGet(token, `/gmail/v1/users/me/messages/${msgId}/attachments/${pdfPart.attachmentId}`);
  const b64 = String(att.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/** 用密碼解密 PDF、逐頁抽純文字串起來。純 JS，不需要 qpdf/pikepdf。 */
async function decryptAndExtractText(buf, password) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), password }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join('') + '\n';
  }
  return text;
}

// ── Gemini 結構化抽取（keys()/models fallback 手法複製自 routes/networth_ocr.js）──
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
function geminiKeys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
}

const EXTRACT_PROMPT = `你是台灣信用卡電子帳單的文字判讀器。以下是從 PDF 抽出的純文字（版面可能因抽取工具跑位，但數字與文字本身正確）。只輸出一個 JSON 物件，不要任何說明文字、不要 markdown code fence。

輸出格式：
{
  "card_name": "卡片名稱，例如「Richart商務御璽卡」，讀不到給 null",
  "card_last4": "卡號末四碼，讀不到給 null",
  "statement_date_roc": "帳單結帳日，維持文件上的民國年原始格式，例如「115/08/20」，讀不到給 null",
  "due_date_roc": "繳款截止日，維持民國年原始格式，例如「115/09/07」，讀不到給 null",
  "lines": [
    { "currency": "TWD", "amount_due": 本期應繳總金額數字, "minimum_due": 本期最低應繳金額數字 }
  ]
}

規則（很重要，錯了會算錯錢）：
1. lines 陣列每個幣別一筆——大多數帳單只有 TWD 一筆；雙幣卡會同時有 TWD 與 JPY（或其他外幣）兩筆，兩筆都要列出，不要只列一筆。
2. 金額去掉千分位逗號與貨幣符號，只留數字本身（可以有小數點），不要輸出成字串。
3. 日期一律維持文件上的民國年原始字串（例如「115/08/20」），不要自己換算西元年，也不要重新排版或補零以外的更動。
4. 完全讀不到任何應繳金額就回傳 lines: []，不要瞎猜。
5. 繳款截止日的找法：優先找明確標示「繳款截止日」的欄位。如果沒有這個標籤，改找類似
   「本行將於ＯＯ日依您的約定帳號…扣款」這種自動扣款說明句——那個「ＯＯ日」就是
   繳款截止日的「日」，月份要用帳單結帳日（statement_date_roc）之後最近的那個月，
   不要跟「循環利率適用年月」「額度到期年月」這類無關的年月欄位搞混，那些不是繳款
   截止日。如果两种方法都找不到、或找到的候選有兩個以上互相矛盾，due_date_roc 給 null，
   不要用猜的——寧可留白讓使用者自己核對，也不要給錯的日期害使用者繳款遲到。
6. 帳單結帳日通常比繳款截止日早（結帳後才開始算繳款期限，一般相差兩到三週）。如果
   文件裡沒有明確標示「帳單結帳日」的欄位、只看到兩個相近的日期擠在一起（例如
   「115/08/24」與「115/08/07」相鄰出現），**較早的那個日期是帳單結帳日，較晚的
   才是繳款截止日**，兩者不會是同一天；找不到就給 null，不要照抄成跟繳款截止日一樣。`;

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型回傳的不是 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const p = parseFloat(v.replace(/[,\s$]/g, '')); if (Number.isFinite(p)) return p; }
  return null;
}
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

async function extractStructured(billText) {
  const keys = geminiKeys();
  if (keys.length === 0) throw new Error('未設定 GEMINI_API_KEY，無法結構化抽取');
  let lastErr = null;
  for (const apiKey of keys) {
    for (const model of GEMINI_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${EXTRACT_PROMPT}\n\n--- 帳單文字 ---\n${billText.slice(0, 6000)}` }] }],
            generationConfig: {
              temperature: 0, maxOutputTokens: 2048,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
        const data = await res.json();
        if (data && data.error) { lastErr = new Error(`${model}: ${String(data.error.message || '').slice(0, 160)}`); continue; }
        const cand = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
        const text = cand && cand.content && Array.isArray(cand.content.parts)
          ? cand.content.parts.map((p) => p.text || '').join('')
          : '';
        if (!text) { lastErr = new Error(`${model}: 沒有輸出`); continue; }
        const obj = parseJson(text);
        const lines = (Array.isArray(obj.lines) ? obj.lines : [])
          .map((l) => ({ currency: str(l.currency) || 'TWD', amount_due: num(l.amount_due), minimum_due: num(l.minimum_due) }))
          .filter((l) => l.amount_due !== null);
        return {
          card_name: str(obj.card_name),
          card_last4: str(obj.card_last4),
          statement_date_roc: str(obj.statement_date_roc),
          due_date_roc: str(obj.due_date_roc),
          lines,
        };
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr || new Error('所有抽取模型都失敗');
}

/** 民國年「115/08/20」→ 西元「2026-08-20」。程式碼自己算，不信任模型算術。 */
function rocToIso(rocStr) {
  const m = String(rocStr || '').match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BILLS_PATH, 'utf-8'));
    return {
      bills: Array.isArray(parsed.bills) ? parsed.bills : [],
      processed_message_ids: Array.isArray(parsed.processed_message_ids) ? parsed.processed_message_ids : [],
    };
  } catch (_) {
    return { bills: [], processed_message_ids: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BILLS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updated_at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, BILLS_PATH);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = await getAccessToken();
  if (!token) { log('無法取得 Google access token，檢查 .env 的 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN'); process.exitCode = 1; return; }

  const store = loadStore();
  let added = 0;

  for (const source of SOURCES) {
    try {
      const msgId = await findLatestMessageId(token, source);
      if (!msgId) { log(`[${source.bank}] 找不到符合的帳單信`); continue; }
      if (store.processed_message_ids.includes(msgId)) { log(`[${source.bank}] 最新一封已處理過，略過`); continue; }

      const password = process.env[source.passwordEnv];
      if (!password) { log(`[${source.bank}] 未設定 ${source.passwordEnv}，略過`); continue; }

      const pdfBuf = await fetchPdfAttachment(token, msgId);
      if (!pdfBuf) { log(`[${source.bank}] 信件裡找不到 PDF 附件`); continue; }

      const billText = await decryptAndExtractText(pdfBuf, password);
      const structured = await extractStructured(billText);
      if (structured.lines.length === 0) { log(`[${source.bank}] 解析不出應繳金額，可能是版面變了或密碼錯誤`); continue; }

      const statementDate = rocToIso(structured.statement_date_roc);
      const dueDate = rocToIso(structured.due_date_roc);
      const importedAt = new Date().toISOString();

      for (const line of structured.lines) {
        store.bills.push({
          id: `bill_${source.bank}_${msgId}_${line.currency}`,
          bank: source.bank,
          card_name: structured.card_name,
          card_last4: structured.card_last4,
          statement_date: statementDate,
          due_date: dueDate,
          currency: line.currency,
          amount_due: line.amount_due,
          minimum_due: line.minimum_due,
          source: 'auto',
          gmail_message_id: msgId,
          imported_at: importedAt,
        });
      }
      store.processed_message_ids.push(msgId);
      added += structured.lines.length;
      log(`[${source.bank}] 新增 ${structured.lines.length} 筆：${structured.lines.map((l) => `${l.currency} ${l.amount_due}`).join('、')}，繳款截止 ${dueDate || '未知'}`);
    } catch (err) {
      log(`[${source.bank}] 失敗：${err.message}`);
    }
  }

  if (added === 0) { log('沒有新帳單'); return; }
  if (dryRun) { log(`[dry-run] 共會新增 ${added} 筆，未寫檔`); return; }
  saveStore(store);
  log(`共新增 ${added} 筆，已寫入 ${BILLS_PATH}`);
}

main().catch((err) => { log('致命錯誤：' + err.stack); process.exitCode = 1; });
