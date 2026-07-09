import { describe, it, expect } from 'vitest';
import { computeFundFlows, type RebalanceResult } from './rebalance';

describe('computeFundFlows', () => {
  // 1. 單來源雙用途（本案例原型）
  // 賣 00687B $278,305、買 00631L $178,305、補現金 $100,000
  it('handles single source with dual uses correctly', () => {
    const mockResult = {
      status: 'buy', // 00631L delta > 0, so it's a buy situation
      etf_value_delta: 178305,     // 用途 (buy)
      cash_adjust_delta: 100000,   // 用途 (replenish)
      bond_plans: [
        { code: '00687B', value_delta: -278305 }, // 來源 (sell)
        { code: '00953B', value_delta: 0 }         // 噪音過濾
      ]
    } as unknown as RebalanceResult;

    const flow = computeFundFlows(mockResult);

    expect(flow.sources).toHaveLength(1);
    expect(flow.sources[0].key).toBe('00687B');
    expect(flow.sources[0].amount).toBe(278305);

    expect(flow.uses).toHaveLength(2);
    expect(flow.uses[0].key).toBe('etf'); // 178305 is larger than 100000, sorted first
    expect(flow.uses[0].amount).toBe(178305);
    expect(flow.uses[1].key).toBe('cash');
    expect(flow.uses[1].amount).toBe(100000);

    // check breakdown for source
    const breakdown = flow.sources[0].breakdown;
    expect(breakdown).toHaveLength(2);
    // first use: etf
    expect(breakdown[0].key).toBe('etf');
    expect(breakdown[0].pct).toBeCloseTo(178305 / 278305, 4); // ≈ 0.6407
    // second use: cash
    expect(breakdown[1].key).toBe('cash');
    expect(breakdown[1].pct).toBeCloseTo(100000 / 278305, 4); // ≈ 0.3593

    // sum of pct ≈ 1
    const totalPct = breakdown.reduce((sum, item) => sum + item.pct, 0);
    expect(totalPct).toBeCloseTo(1.0, 4);

    // uses should have empty breakdown because sources.length is 1 (< 2)
    expect(flow.uses[0].breakdown).toHaveLength(0);
    expect(flow.uses[1].breakdown).toHaveLength(0);
  });

  // 2. 雙來源單用途
  // 例如賣 00631L 部分＋現金同時減少，全部拿去買某檔債券
  it('handles dual sources with single use correctly', () => {
    const mockResult = {
      status: 'sell',
      etf_value_delta: -150000,    // 來源
      cash_adjust_delta: -50000,   // 來源
      bond_plans: [
        { code: '00687B', value_delta: 200000 },  // 用途
      ]
    } as unknown as RebalanceResult;

    const flow = computeFundFlows(mockResult);

    // 2 sources
    expect(flow.sources).toHaveLength(2);
    expect(flow.sources[0].key).toBe('etf');
    expect(flow.sources[0].amount).toBe(150000);
    expect(flow.sources[1].key).toBe('cash');
    expect(flow.sources[1].amount).toBe(50000);

    // 1 use
    expect(flow.uses).toHaveLength(1);
    expect(flow.uses[0].key).toBe('00687B');
    expect(flow.uses[0].amount).toBe(200000);

    // source side: each source's breakdown is empty because uses.length < 2
    expect(flow.sources[0].breakdown).toHaveLength(0);
    expect(flow.sources[1].breakdown).toHaveLength(0);

    // use side: breakdown has 2 sources
    const breakdown = flow.uses[0].breakdown;
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].key).toBe('etf');
    expect(breakdown[0].pct).toBeCloseTo(150000 / 200000, 4); // 0.75
    expect(breakdown[1].key).toBe('cash');
    expect(breakdown[1].pct).toBeCloseTo(50000 / 200000, 4);  // 0.25
  });

  // 3. 1 對 1 直接搬錢
  it('handles 1-to-1 movement by returning empty breakdowns', () => {
    const mockResult = {
      status: 'buy',
      etf_value_delta: 100000,
      cash_adjust_delta: -100000,
      bond_plans: []
    } as unknown as RebalanceResult;

    const flow = computeFundFlows(mockResult);
    expect(flow.sources).toHaveLength(1);
    expect(flow.uses).toHaveLength(1);
    expect(flow.sources[0].breakdown).toHaveLength(0);
    expect(flow.uses[0].breakdown).toHaveLength(0);
  });

  // 4. status === 'normal'
  it('returns empty lists when status is normal', () => {
    const mockResult = {
      status: 'normal',
      etf_value_delta: 0,
      cash_adjust_delta: 0,
      bond_plans: []
    } as unknown as RebalanceResult;

    const flow = computeFundFlows(mockResult);
    expect(flow.sources).toHaveLength(0);
    expect(flow.uses).toHaveLength(0);
  });

  // 5. 邊界與異常值處理
  it('handles edge cases (zero values, noise filter, missing deltas)', () => {
    const mockResult = {
      status: 'buy',
      etf_value_delta: null, // missing
      cash_adjust_delta: 0.5, // noise < 1
      bond_plans: [
        { code: '00687B', value_delta: -0.2 } // noise < 1
      ]
    } as unknown as RebalanceResult;

    const flow = computeFundFlows(mockResult);
    expect(flow.sources).toHaveLength(0);
    expect(flow.uses).toHaveLength(0);
  });
});
