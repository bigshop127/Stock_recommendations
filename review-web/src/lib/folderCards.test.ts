import { describe, it, expect } from 'vitest';
import { cardMetrics, sortCards, runPool, SPARK_BARS } from './folderCards';
import type { CardItem } from './folderCards';
import type { ChipRow, OhlcvRow } from './api';

const bar = (i: number, close: number, volume = 1000): OhlcvRow => {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  return { date: d, open: close, high: close + 1, low: close - 1, close, volume } as OhlcvRow;
};

const chip = (date: string, total: number): ChipRow => ({
  date, foreign_holding_ratio: null, investment_trust_net_buy_qty: 0, foreign_net_buy_qty: total,
  dealer_net_buy_qty: 0, total_net_buy_qty: total, margin_balance: 0, margin_change: 0, short_balance: 0, short_change: 0,
});

describe('cardMetrics', () => {
  it('漲跌、量比、月線、60 日高點', () => {
    // 80 根：前 75 根量 1000、最後 5 根量 3000；收盤 100…179
    const rows = Array.from({ length: 80 }, (_, i) => bar(i, 100 + i, i >= 75 ? 3000 : 1000));
    const m = cardMetrics(rows, null);
    expect(m.bars).toHaveLength(SPARK_BARS);
    expect(m.bars[0].close).toBe(120);
    expect(m.close).toBe(179);
    expect(m.changePct).toBeCloseTo((179 / 178 - 1) * 100, 6);
    // 5 日均量 3000、20 日均量 (15×1000+5×3000)/20＝1500
    expect(m.volRatio).toBeCloseTo(2, 6);
    // 最後一根的月線＝160～179 平均
    expect(m.ma20[m.ma20.length - 1]).toBeCloseTo(169.5, 6);
    expect(m.fromHigh60).toBeCloseTo((179 / 180 - 1) * 100, 6);
    expect(m.inst5).toBeNull();
  });

  it('資料太少：月線前段 null、量比 null；壞 K 棒濾掉', () => {
    const rows = [bar(0, 10), bar(1, 11), { ...bar(2, 12), close: null as unknown as number }];
    const m = cardMetrics(rows, null);
    expect(m.bars).toHaveLength(2);
    expect(m.volRatio).toBeNull();
    expect(m.ma20).toEqual([null, null]);
  });

  it('法人 5 日：取最近 5 天加總（不管傳進來的順序）', () => {
    const chips = ['2026-09-18', '2026-09-24', '2026-09-17', '2026-09-23', '2026-09-22', '2026-09-19'].map((d, i) => chip(d, (i + 1) * 100));
    const m = cardMetrics([], chips);
    // 最近 5 天＝09-18,19,22,23,24 → 100+600+500+400+200
    expect(m.inst5).toBe(1800);
    expect(m.instDays).toBe(5);
    expect(m.close).toBeNull();
  });
});

describe('sortCards', () => {
  const item = (code: string, order: number, change: number | null, rev: number | null): CardItem => ({
    code, name: code, order,
    metrics: change === null ? null : ({ changePct: change } as CardItem['metrics']),
    stock: rev === null ? null : ({ rev_yoy: rev } as CardItem['stock']),
  });
  const items = [item('A', 0, 1, 50), item('B', 1, -2, null), item('C', 2, null, 80), item('D', 3, 5, 10)];

  it('加入順序、數值大到小、沒資料排最後', () => {
    expect(sortCards(items, 'order').map((c) => c.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(sortCards(items, 'change').map((c) => c.code)).toEqual(['D', 'A', 'B', 'C']);
    expect(sortCards(items, 'revYoy').map((c) => c.code)).toEqual(['C', 'A', 'D', 'B']);
  });
});

describe('runPool', () => {
  it('限制同時數量、保留順序、失敗不影響其他', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (i === 3) throw new Error('boom');
      return i * 10;
    });
    const res = await runPool(tasks, 3);
    expect(peak).toBe(3);
    expect(res.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([0, 10, 20, 'x', 40, 50, 60]);
  });
});
