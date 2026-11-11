import { describe, expect, it } from 'vitest';
import { holdingsToNewStocks } from './realSync';

const pos = (code: string, shares: number, name?: string) => ({ code, name, shares, avg_cost: 10, market_price: 10, value: shares * 10 });

describe('holdingsToNewStocks', () => {
  it('只收股數>0、同代號只留一筆（整股＋零股）、略過已在資料夾裡的', () => {
    const r = holdingsToNewStocks(
      [pos('3711', 1000, '日月光投控'), pos('3711', 5, '日月光投控'), pos('2308', 0), pos('3037', 2000, '欣興'), pos('', 5)],
      ['3037'],
      '2026-11-11T00:00:00.000Z',
    );
    expect(r).toEqual([{ code: '3711', name: '日月光投控', added_at: '2026-11-11T00:00:00.000Z' }]);
  });

  it('舊快照沒股名 → name 空字串（之後由前端查名補上）', () => {
    expect(holdingsToNewStocks([pos('2330', 1000)], [])[0].name).toBe('');
  });
});
