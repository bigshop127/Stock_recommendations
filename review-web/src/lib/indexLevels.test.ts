import { describe, expect, it } from 'vitest';
import { computeIndexLevels, fmtLevelDate, fmtPct, lastSwing, shiftMonths, sliceRange, withLive } from './indexLevels';
import type { Pt } from './indexLevels';

const series = (closes: number[], start = '2026-01-01'): Pt[] =>
  closes.map((c, i) => {
    const t = new Date(`${start}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + i);
    return { d: t.toISOString().slice(0, 10), c };
  });

describe('shiftMonths', () => {
  it('月底夾到該月最後一天、跨年', () => {
    expect(shiftMonths('2026-05-31', -3)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-15', -2)).toBe('2025-11-15');
    expect(shiftMonths('2026-11-06', -12)).toBe('2025-11-06');
  });
});

describe('withLive', () => {
  it('盤中半根換成即時價，日期不變', () => {
    const p = withLive(['2026-11-05', '2026-11-06'], [100, 101], 103, true);
    expect(p).toEqual([{ d: '2026-11-05', c: 100 }, { d: '2026-11-06', c: 103 }]);
  });
  it('即時價跟最後收盤不同 → 接在後面當最新；相同就不接', () => {
    expect(withLive(['2026-11-05'], [100], 98, false)).toEqual([{ d: '2026-11-05', c: 100 }, { d: null, c: 98 }]);
    expect(withLive(['2026-11-05'], [100], 100, false)).toHaveLength(1);
    expect(withLive(['2026-11-05'], [100], null, false)).toHaveLength(1);
  });
});

describe('lastSwing（5% 換段）', () => {
  it('一路漲、回檔沒到 5% → 上漲段，起點是最低點', () => {
    const s = lastSwing(series([100, 98, 104, 110, 107, 112]));
    expect(s?.dir).toBe('up');
    expect(s?.pivot.c).toBe(98);
  });
  it('從高點跌超過 5% → 下跌段，起點是高點', () => {
    const s = lastSwing(series([100, 110, 120, 118, 112, 113]));
    expect(s?.dir).toBe('down');
    expect(s?.pivot.c).toBe(120);
  });
  it('跌完又從低點反彈超過 5% → 上漲段，起點是那個低點', () => {
    const s = lastSwing(series([100, 120, 100, 95, 101, 104]));
    expect(s?.dir).toBe('up');
    expect(s?.pivot.c).toBe(95);
  });
  it('反彈沒到 5% → 還算下跌段', () => {
    const s = lastSwing(series([100, 120, 100, 95, 99]));
    expect(s?.dir).toBe('down');
    expect(s?.pivot.c).toBe(120);
  });
  it('整段波動都不到 5% → null', () => {
    expect(lastSwing(series([100, 102, 99, 101]))).toBeNull();
  });
});

describe('computeIndexLevels', () => {
  it('一年高低只看近一年、% 用最後一點（即時價）算', () => {
    const pts: Pt[] = [
      { d: '2025-01-10', c: 500 }, // 超過一年，不算進一年高
      { d: '2025-12-01', c: 200 },
      { d: '2026-03-02', c: 300 },
      { d: '2026-11-06', c: 240 },
      { d: null, c: 270 },
    ];
    const lv = computeIndexLevels(pts, { value: 500, date: '2025-01-10' })!;
    expect(lv.last).toBe(270);
    expect(lv.high1y).toMatchObject({ value: 300, date: '2026-03-02' });
    expect(lv.high1y.pct).toBeCloseTo(-10, 6);
    expect(lv.low1y).toMatchObject({ value: 200, date: '2025-12-01' });
    expect(lv.low1y.pct).toBeCloseTo(35, 6);
    expect(lv.ath).toMatchObject({ value: 500, date: '2025-01-10' });
    expect(lv.ath!.pct).toBeCloseTo(-46, 6);
    expect(lv.athIsHigh1y).toBe(false);
  });
  it('即時價創新高 → 一年高、歷史高都是「最新」、0%', () => {
    const lv = computeIndexLevels([{ d: '2026-11-05', c: 100 }, { d: '2026-11-06', c: 105 }, { d: null, c: 110 }], {
      value: 108,
      date: '2026-01-01',
    })!;
    expect(lv.high1y).toMatchObject({ value: 110, date: null, pct: 0 });
    expect(lv.athIsHigh1y).toBe(true);
    expect(lv.ath).toMatchObject({ value: 110, pct: 0 });
  });
  it('沒有歷史最高資料 → ath null，其他照算', () => {
    const lv = computeIndexLevels(series([100, 90]), null)!;
    expect(lv.ath).toBeNull();
    expect(lv.swing?.dir).toBe('down');
    expect(lv.swing?.pivot.pct).toBeCloseTo(-10, 6);
  });
});

describe('sliceRange / 格式', () => {
  it('3 月只留最後一個交易日往前三個月，即時價保留', () => {
    const pts: Pt[] = [{ d: '2026-07-01', c: 1 }, { d: '2026-08-06', c: 2 }, { d: '2026-11-06', c: 3 }, { d: null, c: 4 }];
    expect(sliceRange(pts, '3m').map((p) => p.c)).toEqual([2, 3, 4]);
    expect(sliceRange(pts, '1y')).toHaveLength(4);
  });
  it('日期：同一年 M/D、其他年份帶年（去年 11/21 不能只寫 11/21）、即時價寫最新', () => {
    expect(fmtLevelDate('2026-10-30', '2026-11-06')).toBe('10/30');
    expect(fmtLevelDate('2025-11-21', '2026-11-06')).toBe('2025/11/21');
    expect(fmtLevelDate('2024-03-05', '2026-11-06')).toBe('2024/3/5');
    expect(fmtLevelDate(null, '2026-11-06')).toBe('最新');
    expect(fmtPct(-8.24)).toBe('−8.2%');
    expect(fmtPct(35.1)).toBe('+35.1%');
  });
});
