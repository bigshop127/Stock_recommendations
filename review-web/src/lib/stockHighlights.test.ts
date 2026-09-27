import { describe, it, expect } from 'vitest';
import { buildStockHighlights, netBuyStreak } from './stockHighlights';
import type { ChipRow, OhlcvRow, StockChips, StockFundamentals } from './api';

const chipRow = (i: number, foreign: number, trust: number, margin = 5000): ChipRow => ({
  date: `2026-09-${String(i + 1).padStart(2, '0')}`,
  foreign_holding_ratio: 50,
  investment_trust_net_buy_qty: trust,
  foreign_net_buy_qty: foreign,
  dealer_net_buy_qty: 0,
  total_net_buy_qty: foreign + trust,
  margin_balance: margin,
  margin_change: 0,
  short_balance: 0,
  short_change: 0,
});

const chips = (rows: ChipRow[]): StockChips => ({
  code: '2330', name: 'T', as_of: rows[rows.length - 1]?.date ?? null,
  unit: { net_buy_qty: '張', balance: '張', holding_ratio: '%' },
  data: rows, source: 'test',
});

const fundamentals = (over: Partial<StockFundamentals> = {}): StockFundamentals => ({
  code: '2330', name: 'T', as_of: '2026-09-26',
  summary: { pe_ratio: null, pb_ratio: null, dividend_yield: null, market_cap: null, eps_ttm: null },
  valuation: [], revenue: [], financials: [], dividend: [],
  unit: { revenue: '元', market_cap: '元', dividend: '元', ratio: '%' },
  source: 'test',
  ...over,
});

const months = (n: number, f: (i: number) => { revenue: number; yoy: number | null }) =>
  Array.from({ length: n }, (_, i) => {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return { month: `${y}-${String(m).padStart(2, '0')}`, mom: null, ...f(i) };
  });

const daily = (closes: number[], vol: (i: number) => number = () => 1000): OhlcvRow[] =>
  closes.map((c, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: c, high: c + 1, low: c - 1, close: c, volume: vol(i),
  }));

const texts = (input: Parameters<typeof buildStockHighlights>[0]) => buildStockHighlights(input).map((h) => h.text);
const empty = { dailyOhlcv: null, chips: null, fundamentals: null };

describe('netBuyStreak', () => {
  it('從最新一天往回數同號天數，遇 0 或反向就停', () => {
    const rows = [chipRow(0, 5, 0), chipRow(1, -3, 0), chipRow(2, 4, 0), chipRow(3, 1, 0), chipRow(4, 2, 0)];
    expect(netBuyStreak(rows, (r) => r.foreign_net_buy_qty)).toBe(3);
    const sells = [chipRow(0, 0, 0), chipRow(1, -1, 0), chipRow(2, -2, 0)];
    expect(netBuyStreak(sells, (r) => r.foreign_net_buy_qty)).toBe(-2);
    expect(netBuyStreak([chipRow(0, 1, 0), chipRow(1, 0, 0)], (r) => r.foreign_net_buy_qty)).toBe(0);
  });
});

describe('buildStockHighlights', () => {
  it('沒有任何資料 → 空陣列', () => {
    expect(buildStockHighlights(empty)).toEqual([]);
  });

  it('營收：年增 ≥50% 叫爆發、創新高、連續年增 6 個月以上', () => {
    const rev = months(24, (i) => ({ revenue: 100 + i, yoy: i >= 12 ? (i === 23 ? 93.6 : 10) : null }));
    const hs = buildStockHighlights({ ...empty, fundamentals: fundamentals({ revenue: rev }) });
    expect(hs.map((h) => h.text)).toEqual(['營收爆發 +93.6% YoY', '月營收創 24 個月新高', '營收連 12 個月以上年增']);
    expect(hs[0].tone).toBe('bull');
    expect(hs[0].detail).toContain('2025-12');
  });

  it('營收：年增 20~50% 與年減 ≤ −10% 的措辭；中間不標', () => {
    const mk = (yoy: number) => fundamentals({ revenue: months(3, () => ({ revenue: 1, yoy })) });
    expect(texts({ ...empty, fundamentals: mk(25) })).toEqual(['營收年增 +25.0%']);
    expect(texts({ ...empty, fundamentals: mk(-12.3) })).toEqual(['營收年減 -12.3%']);
    expect(texts({ ...empty, fundamentals: mk(5) })).toEqual([]);
  });

  it('營收連續年減只數到反向那個月為止（不加「以上」）', () => {
    const rev = months(10, (i) => ({ revenue: 100, yoy: i < 3 ? 5 : -3 }));
    expect(texts({ ...empty, fundamentals: fundamentals({ revenue: rev }) })).toEqual(['營收連 7 個月年減']);
  });

  it('近四季虧損；本益比位在近一年 90% 以上叫高檔', () => {
    const valuation = Array.from({ length: 200 }, (_, i) => ({ date: `d${i}`, pe_ratio: 10 + i * 0.1, pb_ratio: null, dividend_yield: null }));
    const hs = buildStockHighlights({
      ...empty,
      fundamentals: fundamentals({ summary: { pe_ratio: 29.5, pb_ratio: null, dividend_yield: null, market_cap: null, eps_ttm: -1.2 }, valuation }),
    });
    expect(hs.map((h) => [h.text, h.tone])).toEqual([
      ['近四季虧損', 'bear'],
      ['本益比在近一年高檔', 'warn'],
    ]);
  });

  it('本益比歷史不足 120 筆就不判斷位置', () => {
    const valuation = Array.from({ length: 50 }, (_, i) => ({ date: `d${i}`, pe_ratio: 10 + i, pb_ratio: null, dividend_yield: null }));
    expect(texts({ ...empty, fundamentals: fundamentals({ summary: { pe_ratio: 100, pb_ratio: null, dividend_yield: null, market_cap: null, eps_ttm: 5 }, valuation }) })).toEqual([]);
  });

  it('外資連買 3 日；投信整段 20 日都賣 → 加「以上」', () => {
    const rows = Array.from({ length: 20 }, (_, i) => chipRow(i, i >= 17 ? 100 : -50, -10));
    const hs = buildStockHighlights({ ...empty, chips: chips(rows) });
    expect(hs.map((h) => [h.text, h.tone])).toEqual([
      ['外資連買 3 日', 'bull'],
      ['投信連賣 20 日以上', 'bear'],
    ]);
  });

  it('融資 20 日增 ≥20% 標警示；底數 <1000 張不標', () => {
    const rows = Array.from({ length: 20 }, (_, i) => chipRow(i, 0, 0, i === 19 ? 6500 : 5000));
    expect(texts({ ...empty, chips: chips(rows) })).toEqual(['融資 20 日增 +30.0%']);
    const small = Array.from({ length: 20 }, (_, i) => chipRow(i, 0, 0, i === 19 ? 900 : 500));
    expect(texts({ ...empty, chips: chips(small) })).toEqual([]);
  });

  it('價格：收盤創一年新高＋均線多頭排列', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i);
    expect(texts({ ...empty, dailyOhlcv: daily(closes) })).toEqual(['收盤創一年新高', '均線多頭排列']);
  });

  it('價格：距一年高點 ≤ −20%、均線空頭排列', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 300 - i);
    // 最後一天正好是一年新低
    expect(texts({ ...empty, dailyOhlcv: daily(closes) })).toEqual(['收盤創一年新低', '均線空頭排列']);
    const bounced = [...closes.slice(0, 249), 120];
    // 近 240 日最高收盤＝第 10 天的 290 → (120−290)/290 = −58.6%
    expect(texts({ ...empty, dailyOhlcv: daily(bounced) })[0]).toBe('距一年高點 -58.6%');
  });

  it('量能：5 日均量 ≥ 2 倍 20 日均量', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const hs = buildStockHighlights({ ...empty, dailyOhlcv: daily(closes, (i) => (i >= 25 ? 5000 : 1000)) });
    // 5 日均 5000 ÷ 20 日均 (15×1000+5×5000)/20=2000 = 2.5
    expect(hs.map((h) => h.text)).toEqual(['量能放大 2.5×']);
  });

  it('最多 8 個標籤，順序＝營收 → 估值 → 籌碼 → 價格', () => {
    const rev = months(24, (i) => ({ revenue: 100 + i, yoy: i >= 12 ? 60 : null }));
    const valuation = Array.from({ length: 200 }, (_, i) => ({ date: `d${i}`, pe_ratio: 10 + i * 0.1, pb_ratio: null, dividend_yield: null }));
    const chipRows = Array.from({ length: 20 }, (_, i) => chipRow(i, 100, 100, i === 19 ? 7000 : 5000));
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i);
    const hs = buildStockHighlights({
      dailyOhlcv: daily(closes, (i) => (i >= 245 ? 9000 : 1000)),
      chips: chips(chipRows),
      fundamentals: fundamentals({ revenue: rev, valuation, summary: { pe_ratio: 40, pb_ratio: null, dividend_yield: null, market_cap: null, eps_ttm: -1 } }),
    });
    expect(hs).toHaveLength(8);
    expect(hs.map((h) => h.key)).toEqual(['rev-yoy', 'rev-high', 'rev-streak', 'eps-loss', 'pe-pos', 'foreign', 'trust', 'margin']);
  });
});

describe('除息倒數標籤（opt45）', () => {
  const baseFund = {
    code: '2330', name: '台積電', as_of: '2026-09-10',
    summary: { pe_ratio: null, pb_ratio: null, dividend_yield: null, market_cap: null, eps_ttm: null },
    valuation: [], revenue: [], financials: [], dividend: [],
    unit: { revenue: '元', market_cap: '元', dividend: '元/股', ratio: '%' }, source: 'FinMind',
    dividend_events: [{
      period: '115年第1季', base_date: '2026-09-22', cash_dividend: 7.00000137, stock_dividend: 0,
      announce_date: '2026-09-01', cash_ex_date: '2026-09-16', stock_ex_date: null, payment_date: '2026-10-08',
    }],
  };
  const tags = (today: string) =>
    buildStockHighlights({ dailyOhlcv: null, chips: null, fundamentals: baseFund, today }).filter((h) => h.key === 'dividend');

  it('14 天內標倒數、當天標今天、已除息或太遠不標', () => {
    expect(tags('2026-09-10')[0].text).toBe('6 天後除息');
    expect(tags('2026-09-10')[0].detail).toContain('現金 7 元');
    expect(tags('2026-09-16')[0].text).toBe('今天除息');
    expect(tags('2026-09-17')).toHaveLength(0);
    expect(tags('2026-08-20')).toHaveLength(0);
    expect(buildStockHighlights({ dailyOhlcv: null, chips: null, fundamentals: baseFund }).some((h) => h.key === 'dividend')).toBe(false);
  });
});
