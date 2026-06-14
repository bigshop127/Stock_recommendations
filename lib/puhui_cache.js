/**
 * puhui_cache.js — degraded 後援：讀 `data/puhui_cache.json`（engine 掛掉時用）。
 *
 * 該檔由 Node 內容線 `scripts/puhui_daily.cjs` 每日覆寫、**gitignored、可能不在**。
 * schema：{ date, water_level:"五成"(中文字串), stocks:[{name,emoji}](無代號/無買賣),
 *          market_sentiment:{label, score:1-10}, sector_rotation, confidence_level }
 *
 * 🚨 與 engine `/puhui/view` 的型別分歧（gateway 對外正規化，見 docs/api.md）：
 *   - cache water_level 是中文字串「五成」；engine 是 float 0~1。→ cnToFraction 轉成數值。
 *   - cache sentiment.score 是 1~10；engine 是 0~100。→ 呼叫端 ×10 對齊。
 * 唯讀，不寫。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'puhui_cache.json');
const CN_DIGIT = { 零: 0, 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** 「五成」「7」「70%」之類 → 持股比例 0~1；無法解析回 null。 */
function cnToFraction(token) {
  if (token === null || token === undefined) return null;
  const t = String(token).trim();
  if (!t || t === '未知') return null;
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return round2(parseFloat(pct[1]) / 100);
  const cheng = t.match(/([零一兩二三四五六七八九十\d]+)\s*成/);
  if (cheng) {
    const g = cheng[1];
    const n = /^\d+$/.test(g) ? parseInt(g, 10) : CN_DIGIT[g];
    if (n !== undefined && n !== null) return round2(n / 10);
  }
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return round2(n <= 10 ? n / 10 : n / 100);
  }
  return null;
}

/** 持股比例 0~1 → 中文「X成」文字（供前端顯示）；null → null。 */
function fractionToText(f) {
  if (typeof f !== 'number' || Number.isNaN(f)) return null;
  const n = Math.max(0, Math.min(10, Math.round(f * 10)));
  return `${'零一二三四五六七八九十'[n]}成`;
}

/** 讀 puhui_cache.json；不存在或壞檔回 null。 */
function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { readCache, cnToFraction, fractionToText, round2, CACHE_PATH };
