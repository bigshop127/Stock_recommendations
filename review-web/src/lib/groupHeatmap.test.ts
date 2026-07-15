import { describe, it, expect } from 'vitest';
import { aggregateGroups, selectTopGroups, isCuratedGroup } from './groupHeatmap';
import { CODE_TO_GROUP, STOCK_GROUPS } from './stockGroups';
import { SNAPSHOT_0714 } from './__fixtures__/heatmap0714';
import type { HeatmapStock } from './api';

describe('groupHeatmap module', () => {
  it('aggregates stocks to groups, skipping unlisted codes, and excluding valid_count===0 groups', () => {
    const mockStocks: HeatmapStock[] = [
      // 2330 -> 半導體/晶圓代工
      { code: '2330', name: '台積電', sector: '半導體業', close: 1000, change_pct: 2.5, turnover: 10000000 },
      // 2303 -> 半導體/晶圓代工
      { code: '2303', name: '聯電', sector: '半導體業', close: 50, change_pct: 0.5, turnover: 2000000 },
      // 6770 -> 半導體/晶圓代工 (change_pct is null, should be excluded from avg_change_pct but included in turnover and count)
      { code: '6770', name: '力積電', sector: '半導體業', close: 20, change_pct: null, turnover: 1000000 },
      // 2327 -> 電子零組件/被動元件
      { code: '2327', name: '國巨', sector: '電子零組件業', close: 600, change_pct: -1.0, turnover: 4000000 },
      // 4916 -> Not in stockGroups curated list, should be skipped
      { code: '4916', name: '事欣科', sector: '電腦及週邊設備業', close: 30, change_pct: 1.0, turnover: 5000000 },
      // 3008 -> 光電/光學鏡頭 (change_pct is null only, so valid_count = 0, should be excluded completely)
      { code: '3008', name: '大立光', sector: '光電業', close: 2500, change_pct: null, turnover: 3000000 },
    ];

    const result = aggregateGroups(mockStocks);

    // Total market turnover = 10M + 2M + 1M + 4M + 5M + 3M = 25M
    // 2330, 2303, 6770 belong to group "晶圓代工"
    //   turnover = 10M + 2M + 1M = 13M (share = 13/25 * 100 = 52%)
    //   count = 3
    //   valid_count = 2 (2330, 2303)
    //   avg_change_pct = (2.5 + 0.5) / 2 = 1.5%
    //   up_count = 2
    // 2327 belongs to group "被動元件"
    //   turnover = 4M (share = 4/25 * 100 = 16%)
    //   count = 1
    //   valid_count = 1
    //   avg_change_pct = -1.0%
    //   up_count = 0
    // 3008 belongs to group "光學鏡頭" but has valid_count = 0, so it's excluded.
    // 4916 is skipped entirely.

    expect(result).toHaveLength(2);

    const foundry = result.find((r) => r.group === '晶圓代工')!;
    expect(foundry).toBeDefined();
    expect(foundry.category).toBe('半導體');
    expect(foundry.avg_change_pct).toBe(1.5);
    expect(foundry.turnover).toBe(13000000);
    expect(foundry.turnover_share).toBe(52);
    expect(foundry.count).toBe(3);
    expect(foundry.valid_count).toBe(2);
    expect(foundry.up_count).toBe(2);

    const passive = result.find((r) => r.group === '被動元件')!;
    expect(passive).toBeDefined();
    expect(passive.category).toBe('電子零組件');
    expect(passive.avg_change_pct).toBe(-1.0);
    expect(passive.turnover).toBe(4000000);
    expect(passive.turnover_share).toBe(16);
    expect(passive.count).toBe(1);
    expect(passive.valid_count).toBe(1);
    expect(passive.up_count).toBe(0);

    const lens = result.find((r) => r.group === '光學鏡頭');
    expect(lens).toBeUndefined();
  });

  it('selectTopGroups sorts by turnover descending and limits correctly', () => {
    const groups = [
      { group: 'A', category: 'Cat', avg_change_pct: 1.0, turnover: 100, turnover_share: 10, count: 1, valid_count: 1, up_count: 1 },
      { group: 'B', category: 'Cat', avg_change_pct: 2.0, turnover: 500, turnover_share: 50, count: 1, valid_count: 1, up_count: 1 },
      { group: 'C', category: 'Cat', avg_change_pct: 3.0, turnover: 300, turnover_share: 30, count: 1, valid_count: 1, up_count: 1 },
    ];

    const tops = selectTopGroups(groups, 2);
    expect(tops).toHaveLength(2);
    expect(tops[0].group).toBe('B');
    expect(tops[1].group).toBe('C');
  });
});

describe('isCuratedGroup', () => {
  it('認得真實族群、拒絕不存在的名稱', () => {
    expect(isCuratedGroup('金控')).toBe(true);
    expect(isCuratedGroup('被動元件')).toBe(true);
    expect(isCuratedGroup('不存在的族群')).toBe(false);
    expect(isCuratedGroup('')).toBe(false);
  });

  it('不得把 Object 原型上的屬性名當成族群（`in` 會，hasOwnProperty 不會）', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      expect(isCuratedGroup(key)).toBe(false);
    }
  });
});

// opt22 §7 #4/#5：規格要求以 2026-07-14 真實快照驗收前 30 名單與順序。
// 這組斷言釘住 §4.2 的實測表，任何排序/FLOOR/口徑改動都會在此變紅。
describe('groupHeatmap — 2026-07-14 真實快照（opt22 §7 #4/#5）', () => {
  const stocks: HeatmapStock[] = SNAPSHOT_0714.map(([code, change_pct, turnover]) => ({
    code,
    name: code,
    sector: '',
    close: null,
    change_pct,
    turnover,
  }));

  it('universe 為 1082 檔上市，對照表零幽靈代號、成交值覆蓋 98.2%', () => {
    expect(stocks).toHaveLength(1082);

    const universe = new Set(stocks.map((s) => s.code));
    const ghosts = [...CODE_TO_GROUP.keys()].filter((c) => !universe.has(c));
    expect(ghosts).toEqual([]);

    let covered = 0;
    let total = 0;
    for (const s of stocks) {
      const t = s.turnover ?? 0;
      total += t;
      if (CODE_TO_GROUP.get(s.code)) covered += t;
    }
    expect((covered / total) * 100).toBeCloseTo(98.2, 1);
  });

  it('#4 成交值前 30 的名單與順序對得上 §4.2 實測表', () => {
    const tops = selectTopGroups(aggregateGroups(stocks), 30);
    expect(tops).toHaveLength(30);
    expect(tops.slice(0, 10).map((g) => g.group)).toEqual([
      '晶圓代工',
      '被動元件',
      '記憶體',
      'PCB印刷電路板',
      '塑化',
      'ABF載板',
      'IC設計·運算與網通',
      '封測',
      '面板',
      'AI伺服器與代工',
    ]);
    // 金融必須進得去——這是改用成交值排序（而非 |漲跌幅|）的全部理由（§4.2）
    expect(tops[13].group).toBe('金控');
    expect(tops[13].category).toBe('金融');
  });

  it('#5 前 30 涵蓋約 88.7% 成交值', () => {
    const tops = selectTopGroups(aggregateGroups(stocks), 30);
    const cover = tops.reduce((a, g) => a + g.turnover_share, 0);
    expect(cover).toBeGreaterThan(87.5);
    expect(cover).toBeLessThan(90);
  });

  it('#8 面積最大/最小約 24 倍、當日紅 3 綠 27', () => {
    const tops = selectTopGroups(aggregateGroups(stocks), 30);
    const areas = tops.map((g) => Math.max(Math.abs(g.avg_change_pct), 0.05));
    expect(Math.max(...areas) / Math.min(...areas)).toBeCloseTo(24, 0);

    const up = tops.filter((g) => g.avg_change_pct > 0).length;
    expect(up).toBe(3);
    expect(tops.length - up).toBe(27);
  });

  it('#3 真實資料下 avg_change_pct 永不為 NaN；valid_count===0 的族群被整組排除', () => {
    const all = aggregateGroups(stocks);
    for (const g of all) {
      expect(Number.isNaN(g.avg_change_pct)).toBe(false);
      expect(g.valid_count).toBeGreaterThan(0);
    }

    // 陸運 只有 2633 台灣高鐵，當日 change_pct=null（除權息）→ valid_count===0 → 整組排除，
    // 故 74 而非 75。這是 §5 的防線在真實資料上生效的實例。
    const groupNames = Object.values(STOCK_GROUPS).flatMap((g) => Object.keys(g));
    expect(groupNames).toHaveLength(75);
    expect(all).toHaveLength(74);
    expect(all.find((g) => g.group === '陸運')).toBeUndefined();
  });
});
