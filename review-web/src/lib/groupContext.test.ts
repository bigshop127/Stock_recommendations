import { describe, it, expect } from 'vitest';
import { buildGroupContext, buildGroupPeriodStat, edgeCut } from './groupContext';
import { STOCK_GROUPS, UNCLASSIFIED } from './stockGroups';
import { buildStockBrief } from './stockBrief';
import type { GroupContext, GroupPeriodStat } from './groupContext';
import type { HeatmapStock, StockHeatmap } from './api';

// 取前 12 個至少 3 檔的族群當測資：第 i 個族群的成分股漲跌固定在 i%（第一檔再 +1、第二檔再 −1）
const groups = Object.values(STOCK_GROUPS)
  .flatMap((g) => Object.entries(g))
  .filter(([, codes]) => codes.length >= 3)
  .slice(0, 12);

const makeHeatmap = (override: (code: string, change: number) => number | null = (_c, v) => v): StockHeatmap => {
  const stocks: HeatmapStock[] = [];
  groups.forEach(([, codes], i) => {
    codes.forEach((code, j) => {
      const base = i + (j === 0 ? 1 : j === 1 ? -1 : 0);
      stocks.push({ code, name: code, sector: 'x', close: 100, change_pct: override(code, base), turnover: 1000 });
    });
  });
  return { date: '2026-09-26', period: 'day', base_date: '2026-09-26', market: 'TWSE', stocks, source: 'test' };
};

describe('buildGroupPeriodStat', () => {
  it('族群依平均漲跌排名（1＝最強），並算出本股在族群內的名次', () => {
    const [topName, topCodes] = groups[11];
    const stat = buildGroupPeriodStat(topCodes[0], makeHeatmap())!;
    expect(stat.rank).toBe(1);
    expect(stat.total).toBe(12);
    expect(stat.avg).toBeCloseTo(11, 10); // +1、−1 互相抵銷
    expect(stat.stockChange).toBe(12);
    expect(stat.stockRankInGroup).toBe(1);
    expect(stat.validCount).toBe(topCodes.length);
    expect(topName).toBeTruthy();

    const bottom = buildGroupPeriodStat(groups[0][1][1], makeHeatmap())!;
    expect(bottom.rank).toBe(12);
    expect(bottom.stockChange).toBe(-1);
    expect(bottom.stockRankInGroup).toBe(groups[0][1].length);
  });

  it('族群只剩 1 檔有報價 → 不排名，也不佔其他族群的名次', () => {
    const [, codes] = groups[11];
    const hm = makeHeatmap((code, v) => (codes.includes(code) && code !== codes[0] ? null : v));
    const stat = buildGroupPeriodStat(codes[0], hm)!;
    expect(stat.rank).toBeNull();
    expect(stat.total).toBe(11);
    expect(buildGroupPeriodStat(groups[10][1][0], hm)!.rank).toBe(1);
  });

  it('沒收錄族群、沒有熱力圖資料 → null', () => {
    expect(buildGroupPeriodStat(UNCLASSIFIED[0], makeHeatmap())).toBeNull();
    expect(buildGroupPeriodStat(groups[0][1][0], null)).toBeNull();
  });
});

describe('buildGroupContext', () => {
  it('帶出族群名/大類，今日與近一月各自計算；沒收錄 → null', () => {
    const code = groups[5][1][0];
    const ctx = buildGroupContext(code, makeHeatmap(), null)!;
    expect(ctx.group).toBe(groups[5][0]);
    expect(ctx.day?.rank).toBe(7);
    expect(ctx.month).toBeNull();
    expect(buildGroupContext(UNCLASSIFIED[0], makeHeatmap(), makeHeatmap())).toBeNull();
  });

  it('前段/後段門檻＝前 10%，至少 3 名', () => {
    expect(edgeCut(12)).toBe(3);
    expect(edgeCut(120)).toBe(12);
    expect(edgeCut(141)).toBe(15);
  });
});

describe('buildStockBrief × 族群連動', () => {
  const stat = (rank: number, avg: number, total = 120): GroupPeriodStat => ({
    avg, rank, total, upCount: 3, validCount: 5, stockChange: 1, stockRankInGroup: 1, date: '2026-09-26', baseDate: '2026-08-26',
  });
  const brief = (group: GroupContext | null) =>
    buildStockBrief({ blended: null, dailyOhlcv: null, chips: null, fundamentals: null, news: null, group });

  it('近一月族群前 10% 且上漲 → 加分；今日後 10% 且下跌 → 扣分', () => {
    const b = brief({ group: 'ABF載板', category: '電子零組件', month: stat(2, 8.4), day: stat(119, -2.1) });
    expect(b.plus.map((x) => x.text)).toEqual(['所屬族群「ABF載板」近一月強勢（平均 +8.4%，第 2/120 名）']);
    expect(b.plus[0].category).toBe('industry');
    expect(b.plus[0].provenance).toContain('2026-08-26～2026-09-26');
    expect(b.minus.map((x) => x.text)).toEqual(['所屬族群「ABF載板」今日弱勢（平均 -2.1%，倒數第 2 名）']);
    expect(b.group?.group).toBe('ABF載板');
  });

  it('排名在中段、方向不符或族群數 < 10 → 不加因素', () => {
    const b = brief({
      group: 'X', category: 'Y',
      month: stat(60, 5),          // 中段
      day: stat(1, -0.5),          // 第一名但下跌
    });
    expect(b.plus).toEqual([]);
    expect(b.minus).toEqual([]);
    const few = brief({ group: 'X', category: 'Y', month: stat(1, 9, 8), day: null });
    expect(few.plus).toEqual([]);
  });

  it('沒傳 group（舊呼叫端）→ group 為 null、不影響其他欄位', () => {
    const b = buildStockBrief({ blended: null, dailyOhlcv: null, chips: null, fundamentals: null, news: null });
    expect(b.group).toBeNull();
  });
});
