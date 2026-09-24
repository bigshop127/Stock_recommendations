import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarPanel } from './ReportCalendar';

// 2026-09：9/1 週二。有報告：週一到週五，但 9/25（五）老王休假、週末都沒有。
const DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-08-31'];

const html = (selected: string) =>
  renderToStaticMarkup(createElement(CalendarPanel, { selected, dates: DATES, onSelect: () => {} }));

/** 抓出某天的按鈕 HTML。 */
function cell(out: string, date: string): string {
  const m = out.match(new RegExp(`<button[^>]*aria-label="${date.replace(/-/g, '-')}（[^"]*"[^>]*>\\d+</button>`));
  if (!m) throw new Error(`找不到 ${date} 的格子`);
  return m[0];
}

describe('CalendarPanel', () => {
  const out = html('2026-09-24');

  it('有報告的日子底色淡綠、可點', () => {
    const c = cell(out, '2026-09-22');
    expect(c).toContain('bg-emerald-500/20');
    expect(c).not.toContain('disabled');
  });

  it('沒報告的日子（週末、老王休假）維持原樣：無綠底、不可點', () => {
    for (const d of ['2026-09-20', '2026-09-25', '2026-09-26']) {
      const c = cell(out, d);
      expect(c).not.toContain('emerald');
      expect(c).toContain('disabled');
    }
  });

  it('目前選中的那天加強標示，並標 aria-current', () => {
    const c = cell(out, '2026-09-24');
    expect(c).toContain('ring-primary');
    expect(c).toContain('aria-current="date"');
    expect(cell(out, '2026-09-23')).not.toContain('aria-current');
  });

  it('月曆打開先顯示選中日期所在的月份，並顯示當月篇數', () => {
    expect(out).toContain('2026 年 9 月');
    expect(out).toContain('4 篇');
    expect(html('2026-08-31')).toContain('2026 年 8 月');
  });

  it('只能翻到有報告的最早月～最新月：最早月的「上個月」停用、最新月的「下個月」停用', () => {
    const latest = html('2026-09-24');
    expect(latest).toMatch(/<button[^>]*disabled=""[^>]*aria-label="下個月"/);
    expect(latest).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="上個月"/);
    const earliest = html('2026-08-31');
    expect(earliest).toMatch(/<button[^>]*disabled=""[^>]*aria-label="上個月"/);
  });
});
