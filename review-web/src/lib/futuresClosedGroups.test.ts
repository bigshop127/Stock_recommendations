import { describe, it, expect } from 'vitest';
import { closedBreakdown, DEFAULT_SPEC } from './futures';
import type { ClosedTrade } from './futures';
import { groupClosedTrades, sortClosedGroups } from './futuresClosedGroups';
import type { ClosedRowView } from './futuresClosedGroups';

// 用實收費用固定下來，淨損益好手算：毛損益 = (出場 − 進場) × 1000 × 口數
let seq = 0;
const trade = (o: Partial<ClosedTrade>): ClosedRowView => {
  const t: ClosedTrade = {
    id: `t${++seq}`,
    product: 'SRF',
    month: '202609',
    side: 'long',
    lots: 1,
    entry_price: 100,
    exit_price: 101,
    exit_date: '2026-09-01',
    fee: 80,
    tax: 0,
    ...o,
  };
  return { t, b: closedBreakdown(t, DEFAULT_SPEC) };
};

describe('groupClosedTrades 依平倉日', () => {
  it('同一天的拆單併成一組，合計與口數加權均價正確', () => {
    const rows = [
      trade({ exit_date: '2026-09-01', lots: 1, entry_price: 105.75, exit_price: 106.45 }),
      trade({ exit_date: '2026-09-01', lots: 2, entry_price: 105.75, exit_price: 106.45 }),
      trade({ exit_date: '2026-09-01', lots: 1, entry_price: 104.75, exit_price: 106.45 }),
      trade({ exit_date: '2026-09-07', lots: 1, entry_price: 108.95, exit_price: 110.15 }),
    ];
    const groups = groupClosedTrades(rows, 'exit_date');
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.key === '2026-09-01')!;
    expect(g.rows).toHaveLength(3);
    expect(g.lots).toBe(4);
    // 毛損益：0.7×1000×1 + 0.7×1000×2 + 1.7×1000×1 = 700 + 1400 + 1700
    expect(g.gross).toBeCloseTo(3800, 6);
    expect(g.cost).toBe(240);
    expect(g.net).toBeCloseTo(3560, 6);
    expect(g.wins).toBe(3);
    // 進場加權 (105.75×3 + 104.75×1) / 4
    expect(g.avgEntry).toBeCloseTo(105.5, 10);
    expect(g.avgExit).toBeCloseTo(106.45, 10);
    expect(g.exitDate).toBe('2026-09-01');
    expect(g.product).toBe('SRF');
    // 組內同一天依進場價由低到高
    expect(g.rows.map((r) => r.t.entry_price)).toEqual([104.75, 105.75, 105.75]);
  });

  it('同一天混了兩個商品：商品與均價都不給（不同商品的價格加權沒意義）', () => {
    const rows = [
      trade({ exit_date: '2026-08-31', product: 'SRF', entry_price: 104, exit_price: 106 }),
      trade({ exit_date: '2026-08-31', product: 'CCF', entry_price: 125, exit_price: 133 }),
    ];
    const [g] = groupClosedTrades(rows, 'exit_date');
    expect(g.product).toBeNull();
    expect(g.avgEntry).toBeNull();
    expect(g.avgExit).toBeNull();
    expect(g.lots).toBe(2);
  });

  it('多空混在一起也不算均價；費用有一筆是推估就標出來', () => {
    const rows = [
      trade({ exit_date: '2026-09-10', side: 'long' }),
      trade({ exit_date: '2026-09-10', side: 'short', entry_price: 101, exit_price: 100, fee: undefined, tax: undefined }),
    ];
    const [g] = groupClosedTrades(rows, 'exit_date');
    expect(g.side).toBeNull();
    expect(g.avgEntry).toBeNull();
    expect(g.anyEstimated).toBe(true);
  });
});

describe('groupClosedTrades 依合約', () => {
  it('商品＋月份＋方向一組，跨很多天；最新／最早平倉日正確', () => {
    const rows = [
      trade({ month: '202608', exit_date: '2026-08-11' }),
      trade({ month: '202608', exit_date: '2026-08-11' }),
      trade({ month: '202609', exit_date: '2026-08-18' }),
      trade({ month: '202609', exit_date: '2026-09-07' }),
      trade({ month: '202609', exit_date: '2026-08-27', side: 'short' }),
    ];
    const groups = groupClosedTrades(rows, 'contract');
    expect(groups.map((g) => g.key).sort()).toEqual(['SRF|202608|long', 'SRF|202609|long', 'SRF|202609|short']);
    const sep = groups.find((g) => g.key === 'SRF|202609|long')!;
    expect(sep.latestDate).toBe('2026-09-07');
    expect(sep.earliestDate).toBe('2026-08-18');
    expect(sep.exitDate).toBeNull();
    expect(sep.month).toBe('202609');
    // 組內新的在前
    expect(sep.rows[0].t.exit_date).toBe('2026-09-07');
  });

  it('負口數當 0 口：不讓髒資料把均價算成負的', () => {
    const rows = [trade({ lots: -1 }), trade({ lots: 2, entry_price: 102, exit_price: 103 })];
    const [g] = groupClosedTrades(rows, 'contract');
    expect(g.lots).toBe(2);
    expect(g.avgEntry).toBe(102);
  });

  it('全部口數都是 0：均價給 null 不除以零', () => {
    const [g] = groupClosedTrades([trade({ lots: 0 })], 'contract');
    expect(g.avgEntry).toBeNull();
  });
});

describe('sortClosedGroups', () => {
  const rows = [
    trade({ exit_date: '2026-08-11', entry_price: 100, exit_price: 105 }), // +5000−80
    trade({ exit_date: '2026-09-07', entry_price: 100, exit_price: 101 }), // +1000−80
    trade({ exit_date: '2026-08-27', entry_price: 107, exit_price: 106 }), // −1000−80
  ];
  const groups = groupClosedTrades(rows, 'exit_date');

  it('日期新→舊／舊→新', () => {
    expect(sortClosedGroups(groups, 'date_desc').map((g) => g.key)).toEqual(['2026-09-07', '2026-08-27', '2026-08-11']);
    expect(sortClosedGroups(groups, 'date_asc').map((g) => g.key)).toEqual(['2026-08-11', '2026-08-27', '2026-09-07']);
  });

  it('金額大→小／小→大看組的淨損益', () => {
    expect(sortClosedGroups(groups, 'amount_desc').map((g) => g.key)).toEqual(['2026-08-11', '2026-09-07', '2026-08-27']);
    expect(sortClosedGroups(groups, 'amount_asc').map((g) => g.key)).toEqual(['2026-08-27', '2026-09-07', '2026-08-11']);
  });

  it('不改動傳入的陣列', () => {
    const before = groups.map((g) => g.key);
    sortClosedGroups(groups, 'amount_asc');
    expect(groups.map((g) => g.key)).toEqual(before);
  });
});
