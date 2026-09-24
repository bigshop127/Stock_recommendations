import { describe, it, expect } from 'vitest';
import { buildMonthCells, formatReportDate, monthOf, monthTitle, shiftMonth } from './reportCalendar';

describe('reportCalendar', () => {
  it('2026 年 9 月：9/1 是週二，前面補 2 格、後面補到滿週', () => {
    const cells = buildMonthCells('2026-09');
    expect(cells.length % 7).toBe(0);
    expect(cells.slice(0, 3)).toEqual([null, null, '2026-09-01']);
    expect(cells.filter((c) => c !== null)).toHaveLength(30);
    expect(cells.filter((c) => c !== null).at(-1)).toBe('2026-09-30');
    // 9/24 是週四 → 第 4 週（index 3）的第 5 格
    expect(cells.indexOf('2026-09-24') % 7).toBe(4);
  });

  it('閏年二月有 29 天；剛好從週日開頭的月份前面不補格', () => {
    expect(buildMonthCells('2028-02').filter(Boolean)).toHaveLength(29);
    expect(buildMonthCells('2026-02')[0]).toBe('2026-02-01'); // 2026-02-01 是週日
    expect(buildMonthCells('2026-02')).toHaveLength(28);      // 剛好 4 週
  });

  it('shiftMonth 可跨年往前後推', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-09', 0)).toBe('2026-09');
    expect(shiftMonth('2026-09', -9)).toBe('2025-12');
  });

  it('日期格式化與月份工具', () => {
    expect(formatReportDate('2026-09-24')).toBe('2026-09-24（四）');
    expect(formatReportDate('2026-09-20')).toBe('2026-09-20（日）');
    expect(monthOf('2026-09-24')).toBe('2026-09');
    expect(monthTitle('2026-09')).toBe('2026 年 9 月');
  });
});
