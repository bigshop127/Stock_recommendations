import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEE_RATES,
  detectKind,
  stockRealizedBreakdown,
  monthOf,
  inDateRange,
  type StockRealizedTrade,
} from './stockRealized';

function trade(overrides: Partial<StockRealizedTrade> = {}): StockRealizedTrade {
  return {
    id: 't1',
    symbol: '2330',
    name: '台積電',
    kind: 'stock',
    side: 'long',
    qty: 1000,
    buy_price: 500,
    sell_price: 550,
    buy_date: '2026-08-01',
    sell_date: '2026-08-10',
    fee: null,
    tax: null,
    ...overrides,
  };
}

describe('detectKind', () => {
  it('00 開頭視為 ETF', () => {
    expect(detectKind('0050')).toBe('etf');
    expect(detectKind('00631L')).toBe('etf');
  });
  it('其餘視為個股', () => {
    expect(detectKind('2330')).toBe('stock');
    expect(detectKind('006208')).toBe('etf'); // 仍是 00 開頭
    expect(detectKind('1101')).toBe('stock');
  });
});

describe('stockRealizedBreakdown — 現股多單', () => {
  it('用費率設定推估手續費與證交稅（個股稅率 0.3%，只收賣方）', () => {
    const t = trade();
    const b = stockRealizedBreakdown(t, DEFAULT_FEE_RATES);
    const expectedGross = (550 - 500) * 1000;
    const expectedFee = (500 + 550) * 1000 * DEFAULT_FEE_RATES.fee_rate * DEFAULT_FEE_RATES.fee_discount;
    const expectedTax = 550 * 1000 * DEFAULT_FEE_RATES.stock_tax_rate;
    expect(b.gross).toBeCloseTo(expectedGross);
    expect(b.fee).toBeCloseTo(expectedFee);
    expect(b.tax).toBeCloseTo(expectedTax);
    expect(b.net).toBeCloseTo(expectedGross - expectedFee - expectedTax);
    expect(b.actual_cost).toBe(false);
  });

  it('ETF 用較低的證交稅率（0.1%）', () => {
    const t = trade({ symbol: '0050', kind: 'etf' });
    const b = stockRealizedBreakdown(t, DEFAULT_FEE_RATES);
    expect(b.tax).toBeCloseTo(550 * 1000 * DEFAULT_FEE_RATES.etf_tax_rate);
  });

  it('券商實收費用有值就直接採用，不再推估', () => {
    const t = trade({ fee: 100, tax: 200 });
    const b = stockRealizedBreakdown(t, DEFAULT_FEE_RATES);
    expect(b.fee).toBe(100);
    expect(b.tax).toBe(200);
    expect(b.actual_cost).toBe(true);
    expect(b.net).toBeCloseTo((550 - 500) * 1000 - 100 - 200);
  });
});

describe('stockRealizedBreakdown — 融券空單', () => {
  it('buy_price/sell_price 依交易類型命名，跟現股共用同一條公式', () => {
    // 融券：100 賣出（放空），90 買進回補 → 賺 10 * qty，跟現股「低買高賣」同一個式子
    const t = trade({ side: 'short', buy_price: 90, sell_price: 100 });
    const b = stockRealizedBreakdown(t, DEFAULT_FEE_RATES);
    expect(b.gross).toBeCloseTo((100 - 90) * 1000);
    // 證交稅收賣方那一腿＝sell_price，跟 side 無關
    const expectedTax = 100 * 1000 * DEFAULT_FEE_RATES.stock_tax_rate;
    expect(b.tax).toBeCloseTo(expectedTax);
  });

  it('回補價高於放空價（虧損）時，毛損益與淨損益都是負的', () => {
    const t = trade({ side: 'short', buy_price: 110, sell_price: 100 });
    const b = stockRealizedBreakdown(t, DEFAULT_FEE_RATES);
    expect(b.gross).toBeCloseTo((100 - 110) * 1000);
    expect(b.net).toBeLessThan(0);
  });
});

describe('monthOf / inDateRange', () => {
  it('monthOf 抓年月，格式不對回空字串', () => {
    expect(monthOf('2026-08-10')).toBe('2026-08');
    expect(monthOf('bad-date')).toBe('');
  });
  it('inDateRange 兩端留空代表不限制那一側', () => {
    expect(inDateRange('2026-08-10', '', '')).toBe(true);
    expect(inDateRange('2026-08-10', '2026-08-01', '2026-08-31')).toBe(true);
    expect(inDateRange('2026-08-10', '2026-08-11', '')).toBe(false);
    expect(inDateRange('2026-08-10', '', '2026-08-09')).toBe(false);
    expect(inDateRange('not-a-date', '', '')).toBe(false);
  });
});
