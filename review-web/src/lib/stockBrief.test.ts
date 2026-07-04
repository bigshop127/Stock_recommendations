import { describe, it, expect } from 'vitest';
import { buildStockBrief } from './stockBrief';
import type { StockBriefInput } from './stockBrief';
import type { StockSignal, OhlcvRow, StockChips, StockFundamentals, StockNews } from './api';

describe('buildStockBrief', () => {
  const mockBlended: StockSignal = {
    code: '2330',
    name: '台積電',
    date: '2026-06-19',
    mode: 'blended',
    action: 'BUY',
    score: 85,
    confidence: 0.9,
    factors: [
      { key: 'technical', name: '技術面', score: 80, weight: 0.3 },
      { key: 'chips', name: '籌碼面', score: 75, weight: 0.3 },
      { key: 'sentiment', name: '情緒面', score: 70, weight: 0.2 },
    ],
    agreement: 'aligned',
  };

  const mockDailyOhlcv: OhlcvRow[] = Array.from({ length: 65 }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i,
    high: 105 + i,
    low: 99 + i,
    close: 100 + i * 2, // Upward trend: MA5 > MA20 > MA60
    volume: 1000 + i * 10,
  }));

  const mockChips: StockChips = {
    code: '2330',
    name: '台積電',
    as_of: '2026-06-19',
    unit: { net_buy_qty: '張', balance: '張', holding_ratio: '%' },
    data: Array.from({ length: 10 }, (_, i) => ({
      date: `2026-06-${10 + i}`,
      foreign_holding_ratio: 75,
      investment_trust_net_buy_qty: 300,
      foreign_net_buy_qty: 500,
      dealer_net_buy_qty: 100,
      total_net_buy_qty: 900,
      margin_balance: 1000,
      margin_change: 10,
      short_balance: 50,
      short_change: 0,
    })),
    source: 'test',
  };

  const mockFundamentals: StockFundamentals = {
    code: '2330',
    name: '台積電',
    as_of: '2026-06-19',
    summary: { pe_ratio: 20, pb_ratio: 5, dividend_yield: 2.5, market_cap: 100000, eps_ttm: 40 },
    valuation: [],
    revenue: [
      { month: '2026-04', revenue: 200000, yoy: 15.0, mom: 2.0 },
      { month: '2026-05', revenue: 220000, yoy: 25.0, mom: 10.0 },
    ],
    financials: [
      { quarter: '2025-Q4', eps: 8.0, gross_margin: 52, operating_margin: 40, net_margin: 35 },
      { quarter: '2026-Q1', eps: 10.0, gross_margin: 55, operating_margin: 42, net_margin: 38 },
    ],
    dividend: [],
    unit: { revenue: '元', market_cap: '元', dividend: '元', ratio: '%' },
    source: 'test',
  };

  const mockNews: StockNews = {
    code: '2330',
    name: '台積電',
    as_of: '2026-06-19',
    summary: {
      overall_label: 'positive',
      overall_score: 82,
      positive: 4,
      negative: 0,
      neutral: 1,
      total: 5,
    },
    items: [],
  };

  it('calculates complete stock brief correctly', () => {
    const input: StockBriefInput = {
      blended: mockBlended,
      dailyOhlcv: mockDailyOhlcv,
      chips: mockChips,
      fundamentals: mockFundamentals,
      news: mockNews,
    };

    const brief = buildStockBrief(input);

    expect(brief.degraded).toBe(false);
    expect(brief.overall).toBe(85);
    expect(brief.action).toBe('BUY');
    expect(brief.forces).toHaveLength(5);

    // Forces keys order check
    expect(brief.forces.map(f => f.key)).toEqual(['momentum', 'technical', 'chips', 'fundamental', 'sentiment']);

    // Technical / Chips / Sentiment factor score check
    expect(brief.forces.find(f => f.key === 'technical')?.score).toBe(80);
    expect(brief.forces.find(f => f.key === 'chips')?.score).toBe(75);
    expect(brief.forces.find(f => f.key === 'sentiment')?.score).toBe(70);

    // Check momentum & fundamental calculated scores (exact — protects hard-coded weights)
    // 動能: ma_part=100, ret_part=100 (ret20≈21.3% 飽和), vol_part≈52.4 → round(40+40+10.49)=90
    expect(brief.forces.find(f => f.key === 'momentum')?.score).toBe(90);
    // 基本面: rev_part=81.25 (YoY 25%), eps_part=81.25 (EPS 8→10 = +25%) → round(81.25)=81
    expect(brief.forces.find(f => f.key === 'fundamental')?.score).toBe(81);

    // Check plus bullets
    expect(brief.plus.length).toBeGreaterThan(0);
    expect(brief.plus.length).toBeLessThanOrEqual(4);

    // State label
    expect(brief.stateLabel).toBe('多項利多訊號並存');

    // Check headline doesn't contain NaN / undefined
    expect(brief.headline).not.toContain('NaN');
    expect(brief.headline).not.toContain('undefined');
    expect(brief.headline).not.toContain('null');
    expect(brief.headline).toContain('台積電');

    // Checkpoints
    expect(brief.checkpoints.length).toBe(4);
    expect(brief.checkpoints[0].label).toBe('守住 60 日均線');
    expect(brief.checkpoints[0].pass).toBe(true);

    // Invalidation
    expect(brief.invalidation.length).toBeGreaterThan(0);
  });

  it('handles degraded state when blended is missing or unavailable', () => {
    const input: StockBriefInput = {
      blended: null,
      dailyOhlcv: mockDailyOhlcv,
      chips: mockChips,
      fundamentals: mockFundamentals,
      news: mockNews,
    };

    const brief = buildStockBrief(input);

    expect(brief.degraded).toBe(true);
    expect(brief.overall).toBeNull();
    expect(brief.stateLabel).toBe('資料不足');
    expect(brief.headline).toBe('訊號資料不足，僅顯示可用區塊');

    // 降級時卡片仍須有可用區塊可顯示（StockBriefCard 的 hasUsable 契約）：
    // 動能/基本面來自 K線與基本面、與 blended 無關 → 仍應算得出；觀察點同理。
    expect(brief.forces.find(f => f.key === 'momentum')?.score).not.toBeNull();
    expect(brief.forces.find(f => f.key === 'fundamental')?.score).not.toBeNull();
    // 但取自 blended.factors 的三軸此時應為 null（不得用 50 假裝中性）
    expect(brief.forces.find(f => f.key === 'technical')?.score).toBeNull();
    expect(brief.forces.find(f => f.key === 'chips')?.score).toBeNull();
    expect(brief.forces.find(f => f.key === 'sentiment')?.score).toBeNull();
    expect(brief.checkpoints.length).toBeGreaterThan(0);
    const hasUsable =
      brief.forces.some(f => f.score !== null) ||
      brief.checkpoints.length > 0 ||
      brief.plus.length > 0 ||
      brief.minus.length > 0;
    expect(hasUsable).toBe(true);
  });

  it('handles missing input sources gracefully without crashing or emitting NaN', () => {
    const input: StockBriefInput = {
      blended: mockBlended,
      dailyOhlcv: null,
      chips: null,
      fundamentals: null,
      news: null,
    };

    const brief = buildStockBrief(input);

    expect(brief.degraded).toBe(false);
    expect(brief.forces.find(f => f.key === 'momentum')?.score).toBeNull();
    expect(brief.forces.find(f => f.key === 'fundamental')?.score).toBeNull();
    expect(brief.checkpoints).toHaveLength(0);

    // Ensure text output has no NaN or undefined
    const str = JSON.stringify(brief);
    expect(str).not.toContain('NaN');
    expect(str).not.toContain('undefined');
  });

  it('skips EPS QoQ calculation if previous quarter EPS <= 0', () => {
    const fundamentalsWithNegativeEps: StockFundamentals = {
      ...mockFundamentals,
      financials: [
        { quarter: '2025-Q4', eps: -1.5, gross_margin: 20, operating_margin: 5, net_margin: -5 },
        { quarter: '2026-Q1', eps: 2.0, gross_margin: 30, operating_margin: 10, net_margin: 8 },
      ],
    };

    const input: StockBriefInput = {
      blended: mockBlended,
      dailyOhlcv: mockDailyOhlcv,
      chips: mockChips,
      fundamentals: fundamentalsWithNegativeEps,
      news: mockNews,
    };

    const brief = buildStockBrief(input);
    const epsBullet = [...brief.plus, ...brief.minus].find(b => b.text.includes('EPS'));
    expect(epsBullet).toBeUndefined();
  });

  it('renders negative figures without double negatives (賣超/年減/跌幅/季減 use absolute values)', () => {
    const bearishChips: StockChips = {
      ...mockChips,
      data: Array.from({ length: 10 }, (_, i) => ({
        ...mockChips.data[i],
        date: `2026-06-${10 + i}`,
        total_net_buy_qty: -900,
        foreign_net_buy_qty: -500,
        investment_trust_net_buy_qty: -300,
      })),
    };
    const bearishFund: StockFundamentals = {
      ...mockFundamentals,
      revenue: [
        { month: '2026-04', revenue: 200000, yoy: -5.0, mom: -2.0 },
        { month: '2026-05', revenue: 180000, yoy: -18.0, mom: -10.0 },
      ],
      financials: [
        { quarter: '2025-Q4', eps: 10.0, gross_margin: 52, operating_margin: 40, net_margin: 35 },
        { quarter: '2026-Q1', eps: 5.0, gross_margin: 45, operating_margin: 30, net_margin: 25 },
      ],
    };
    // 下跌趨勢日K → 近20日跌幅為負
    const downTrend: OhlcvRow[] = Array.from({ length: 65 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, '0')}`,
      open: 300 - i,
      high: 305 - i,
      low: 295 - i,
      close: 300 - i * 2,
      volume: 1000,
    }));

    const brief = buildStockBrief({
      blended: mockBlended,
      dailyOhlcv: downTrend,
      chips: bearishChips,
      fundamentals: bearishFund,
      news: mockNews,
    });

    const allText = [...brief.plus, ...brief.minus].map(b => b.text).join(' | ');
    expect(allText).not.toMatch(/[-−]\d/); // 沒有任何「-數字」出現在因素敘述
    // 確認負向路徑確實有跑（至少一條賣超/年減/跌幅/季減敘述），且全部以絕對值呈現
    expect(brief.minus.some(b => /賣超|年減|跌幅|季減/.test(b.text))).toBe(true);
  });

  it('rounds 張 quantities to whole numbers (no decimals in bullets or checkpoints)', () => {
    // FinMind 有時回浮點張數 → 5 日累加後帶小數（例：-852.712）；顯示須取整、不得出現小數點
    const fractionalChips: StockChips = {
      ...mockChips,
      data: Array.from({ length: 10 }, (_, i) => ({
        ...mockChips.data[i],
        date: `2026-06-${10 + i}`,
        total_net_buy_qty: -170.3456, // 5 日累加 ≈ -851.728
      })),
    };

    const brief = buildStockBrief({
      blended: mockBlended,
      dailyOhlcv: mockDailyOhlcv,
      chips: fractionalChips,
      fundamentals: mockFundamentals,
      news: mockNews,
    });

    const chipsBullet = [...brief.plus, ...brief.minus].find(b => b.category === 'chips' && /張/.test(b.text));
    expect(chipsBullet?.text).toBeDefined();
    expect(chipsBullet!.text).not.toMatch(/\.\d/); // 因素敘述無小數
    const chipsCheckpoint = brief.checkpoints.find(c => /張/.test(c.current ?? ''));
    expect(chipsCheckpoint?.current).not.toMatch(/\.\d/); // 觀察點現況無小數
  });

  it('caps bullets at max 4 total and max 2 per category', () => {
    // 造出同類多條：籌碼(法人5日賣超 + 外資連賣 + 投信連賣 = 3 條同類) + 基本面 + 動能
    const manyBearChips: StockChips = {
      ...mockChips,
      data: Array.from({ length: 10 }, (_, i) => ({
        ...mockChips.data[i],
        date: `2026-06-${10 + i}`,
        total_net_buy_qty: -2000,
        foreign_net_buy_qty: -800,
        investment_trust_net_buy_qty: -400,
      })),
    };
    const downTrend: OhlcvRow[] = Array.from({ length: 65 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, '0')}`,
      open: 300 - i, high: 305 - i, low: 295 - i, close: 300 - i * 2, volume: 500,
    }));
    const bearFund: StockFundamentals = {
      ...mockFundamentals,
      revenue: [{ month: '2026-05', revenue: 180000, yoy: -25.0, mom: -10.0 }],
      financials: [
        { quarter: '2025-Q4', eps: 10.0, gross_margin: 52, operating_margin: 40, net_margin: 35 },
        { quarter: '2026-Q1', eps: 4.0, gross_margin: 45, operating_margin: 30, net_margin: 25 },
      ],
    };

    const brief = buildStockBrief({
      blended: mockBlended,
      dailyOhlcv: downTrend,
      chips: manyBearChips,
      fundamentals: bearFund,
      news: mockNews,
    });

    expect(brief.minus.length).toBeLessThanOrEqual(4);
    const chipsCount = brief.minus.filter(b => b.category === 'chips').length;
    expect(chipsCount).toBeLessThanOrEqual(2);
  });
});
