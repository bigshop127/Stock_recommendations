import { describe, it, expect } from 'vitest';
import { buildPeerValuation, peerCodesFor, quantile, PEER_METRICS } from './peerValuation';
import type { StockMetric, HeatmapStock } from './api';

const metric = (code: string, over: Partial<StockMetric> = {}): StockMetric => ({
  code,
  name: `股${code}`,
  close: 100,
  pe: 20,
  pb: 2,
  dy: 3,
  eps_ttm: 5,
  bvps: 50,
  gross_margin: 30,
  operating_margin: 15,
  net_margin: 10,
  margin_period: '2026-Q2',
  rev_yoy: 10,
  rev_cum_yoy: 8,
  revenue_month: '2026-08',
  ...over,
});

const GROUPS = {
  電子零組件: {
    CCL: ['A', 'B', 'C', 'D', 'E'],
    小族群: ['S', 'T'],
    其他: ['X', 'Y', 'Z'],
  },
};

describe('quantile', () => {
  it('線性內插', () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('buildPeerValuation', () => {
  const metrics = [
    metric('A', { close: 500, pe: 50, eps_ttm: 10, pb: 10, bvps: 50, rev_yoy: 120, gross_margin: 33 }),
    metric('B', { pe: 20, pb: 3, rev_yoy: 40 }),
    metric('C', { pe: 30, pb: 4, rev_yoy: 60 }),
    metric('D', { pe: 40, pb: 5, rev_yoy: -5 }),
    metric('E', { pe: null, eps_ttm: null, pb: 1, rev_yoy: 5 }), // 虧損
  ];
  const heat: HeatmapStock[] = [
    { code: 'A', name: '股A', sector: '', close: 510, change_pct: 1, turnover: 9e9 },
    { code: 'B', name: '股B', sector: '', close: 100, change_pct: 1, turnover: 1e9 },
  ];

  it('本益比法：同業中位數 × 近四季 EPS，區間用 25～75 百分位，差距對現價', () => {
    const v = buildPeerValuation('A', { group: 'CCL', category: '電子零組件' }, GROUPS, metrics, heat, 400)!;
    expect(v.scope).toBe('group');
    expect(v.scopeName).toBe('CCL');
    expect(v.rows.map((r) => r.code)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // 同業本益比（E 虧損不算）：20、30、40 → 中位數 30、p25 25、p75 35
    expect(v.pe!.peers).toBe(3);
    expect(v.pe!.median).toBe(30);
    expect(v.pe!.fair).toBe(300);
    expect(v.pe!.low).toBe(250);
    expect(v.pe!.high).toBe(350);
    expect(v.pe!.gapPct).toBeCloseTo(-25, 6); // 300 ÷ 400 − 1
    // 淨值比：3、4、5、1 → 中位數 3.5 × 50
    expect(v.pb!.fair).toBe(175);
    expect(v.price).toBe(400);
  });

  it('排名：本益比越低越前面、營收年增越高越前面，成交值取熱力圖', () => {
    const v = buildPeerValuation('A', { group: 'CCL', category: '電子零組件' }, GROUPS, metrics, heat, null)!;
    const byKey = Object.fromEntries(v.ranks.map((r) => [r.def.key, r]));
    expect(byKey.pe.rank).toBe(4);      // 20、30、40、50 → 第 4 低
    expect(byKey.pe.total).toBe(4);
    expect(byKey.rev_yoy.rank).toBe(1);
    expect(byKey.rev_yoy.total).toBe(5);
    expect(byKey.rev_yoy.median).toBe(40);
    expect(byKey.turnover.rank).toBe(1);
    expect(byKey.turnover.total).toBe(2);
    expect(byKey.pe.sorted.map((s) => s.value)).toEqual([20, 30, 40, 50]);
    expect(v.price).toBe(500); // 沒給現價 → 證交所收盤
    expect(v.ranks).toHaveLength(PEER_METRICS.length);
  });

  it('虧損股不估本益比法，改說原因；淨值比法照算', () => {
    const v = buildPeerValuation('E', { group: 'CCL', category: '電子零組件' }, GROUPS, metrics, null, 100)!;
    expect(v.pe).toBeNull();
    expect(v.peReason).toContain('虧損');
    expect(v.pb).not.toBeNull();
    expect(v.ranks.find((r) => r.def.key === 'pe')!.rank).toBeNull();
  });

  it('族群同業不足 3 檔 → 整張卡改用大類', () => {
    const ms = [metric('S'), metric('T'), metric('X', { pe: 10 }), metric('Y', { pe: 12 }), metric('Z', { pe: 14 })];
    const v = buildPeerValuation('S', { group: '小族群', category: '電子零組件' }, GROUPS, ms, null, 100)!;
    expect(v.scope).toBe('category');
    expect(v.scopeName).toBe('電子零組件');
    expect(v.rows.map((r) => r.code).sort()).toEqual(['S', 'T', 'X', 'Y', 'Z']);
    expect(v.pe!.peers).toBe(4); // T 20、X 10、Y 12、Z 14
    expect(v.pe!.median).toBe(13);
  });

  it('大類也不夠 → 不估、講清楚只有幾檔', () => {
    const ms = [metric('S'), metric('T')];
    const v = buildPeerValuation('S', { group: '小族群', category: '電子零組件' }, GROUPS, ms, null, 100)!;
    expect(v.pe).toBeNull();
    expect(v.peReason).toBe('有本益比的同業只有 1 檔，不足 3 檔不估');
  });

  it('沒有族群或本股沒資料（上櫃／ETF）→ null', () => {
    expect(buildPeerValuation('A', undefined, GROUPS, metrics, null, 1)).toBeNull();
    expect(buildPeerValuation('Q', { group: 'CCL', category: '電子零組件' }, GROUPS, metrics, null, 1)).toBeNull();
  });
});

describe('peerCodesFor', () => {
  it('族群夠大只要族群；太小連大類一起要', () => {
    expect(peerCodesFor('A', { group: 'CCL', category: '電子零組件' }, { 電子零組件: { CCL: ['A', 'B', 'C', 'D', 'E', 'F'] } })).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(peerCodesFor('S', { group: '小族群', category: '電子零組件' }, GROUPS).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'S', 'T', 'X', 'Y', 'Z']);
    expect(peerCodesFor('Q', undefined, GROUPS)).toEqual(['Q']);
  });
});
