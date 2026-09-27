/**
 * fred.js — 聖路易聯準銀行 FRED 的 CSV 解析（免金鑰：fredgraph.csv?id=...）。
 *
 * 再平衡頁「宏觀 regime 指標」原本只有 ^IRX，標成「聯準會利率」，但 ^IRX 是 13 週美國國庫券
 * 殖利率——市場利率，會提前反映對升降息的預期，跟聯準會公布的政策利率不是同一個數字
 * （2026-09-25：^IRX 4.07%，官方目標區間 3.75–4.00%、有效聯邦資金利率 3.88%）。
 * regime 判斷仍用 ^IRX（回測就是用它、而且它領先），官方數字另外抓來並排顯示。
 *
 *   DFEDTARU／DFEDTARL＝聯邦資金利率目標區間上限／下限（每天一筆，假日也有）
 *   DFF＝有效聯邦資金利率（營業日）
 * CSV 格式：第一行標題 `observation_date,DFF`，之後 `2026-09-24,3.88`；缺值是 `.`。
 */
'use strict';

/** CSV → 最後一筆有數值的 { date, value }；沒有任何數值回 null */
function parseFredCsvLatest(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/,/.test(lines[0])) return null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, raw] = lines[i].split(',');
    const value = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && raw !== '.' && raw !== '' && Number.isFinite(value)) {
      return { date, value };
    }
  }
  return null;
}

/** 上下限＋有效利率組成顯示用物件；上下限缺一個就整個不給（區間只寫一邊會誤導） */
function buildFedTarget(upper, lower, effective) {
  if (!upper || !lower) return null;
  return {
    upper: upper.value,
    lower: lower.value,
    effective: effective ? effective.value : null,
    effective_date: effective ? effective.date : null,
    as_of: upper.date > lower.date ? upper.date : lower.date,
  };
}

module.exports = { parseFredCsvLatest, buildFedTarget };
