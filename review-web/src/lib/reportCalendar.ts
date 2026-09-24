/**
 * reportCalendar.ts — 報告月曆的日期運算（純函式，可單測）。
 * 日期一律是 'YYYY-MM-DD' 字串（台北日期），月份是 'YYYY-MM'；全程用 UTC 運算，
 * 不經過本機時區，避免跨時區裝置看到差一天。
 */

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 2026-09-24 → 2026-09-24（四） */
export function formatReportDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${date}（${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 'YYYY-MM' 往前/後推 delta 個月。 */
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function monthTitle(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${y} 年 ${m} 月`;
}

/**
 * 某月的月曆格子（週日開頭）：該月每一天填 'YYYY-MM-DD'，前後補 null 湊滿整週。
 * 長度必為 7 的倍數。
 */
export function buildMonthCells(ym: string): (string | null)[] {
  const [y, m] = ym.split('-').map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
