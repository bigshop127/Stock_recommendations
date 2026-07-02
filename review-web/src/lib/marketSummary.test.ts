import { describe, it, expect } from 'vitest';
import { buildMarketSummary } from './marketSummary';
import type { MarketBreadth, MarketInstitutional } from './api';

describe('marketSummary module', () => {
  const mockBreadthBull: MarketBreadth = {
    date: '2026-07-02',
    advancing: 600,
    declining: 300,
    unchanged: 100,
    limit_up: 25,
    limit_down: 2,
    total: 1000,
    advancing_pct: 0.6,
    above_ma20_ratio: 0.65,
    above_ma50_ratio: 0.6,
    universe: 'TWSE',
    sample_size: 1000,
    source: 'TWSE',
  };

  const mockInstitutionalBull: MarketInstitutional = {
    date: '2026-07-02',
    unit: '元',
    latest: {
      foreign: 20000000000, // 200 億
      investment_trust: 5000000000, // 50 億
      dealer: 5000000000, // 50 億
      total: 30000000000, // 300 億
    },
    trend: [],
    source: 'TWSE',
  };

  it('calculates mood correctly for bullish scenario', () => {
    // breadth_score = (600 / 900)*2 - 1 = 0.3333
    // inst_score = 300 / 300 = 1.0
    // level_score = 0.8 * 2 - 1 = 0.6
    // raw = 0.4*0.3333 + 0.3*1.0 + 0.3*0.6 = 0.1333 + 0.3 + 0.18 = 0.6133 => mood = 61
    const result = buildMarketSummary({
      breadth: mockBreadthBull,
      institutional: mockInstitutionalBull,
      water_level: 0.8,
    });

    expect(result.mood).toBe(61);
    expect(result.stance).toBe('bull');
    expect(result.headline).toContain('偏多');
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
    expect(result.signals.some((s) => s.text.includes('上漲 600 家'))).toBe(true);
    expect(result.signals.some((s) => s.text.includes('買超 300.0 億'))).toBe(true);
    expect(result.signals.some((s) => s.text.includes('漲停 25 家'))).toBe(true);
    expect(result.signals.some((s) => s.text.includes('水位高檔 (80%)'))).toBe(true);
  });

  it('handles stance boundary +20 and -20', () => {
    // Exactly mood +20 => bull
    // If breadth_score = 0.5 (750 vs 250), inst_score = 0, level_score = 0 => mood = 0.4*0.5*100 = 20
    const mockBreadthBoundary: MarketBreadth = {
      ...mockBreadthBull,
      advancing: 750,
      declining: 250,
      limit_up: 0,
      limit_down: 0,
    };
    const bullBoundary = buildMarketSummary({
      breadth: mockBreadthBoundary,
      institutional: { ...mockInstitutionalBull, latest: { foreign: 0, investment_trust: 0, dealer: 0, total: 0 } },
      water_level: 0.5, // level_score = 0
    });
    expect(bullBoundary.mood).toBe(20);
    expect(bullBoundary.stance).toBe('bull');

    // Bear boundary <= -20
    const mockBreadthBearBoundary: MarketBreadth = {
      ...mockBreadthBull,
      advancing: 250,
      declining: 750,
      limit_up: 0,
      limit_down: 0,
    };
    const bearBoundary = buildMarketSummary({
      breadth: mockBreadthBearBoundary,
      institutional: { ...mockInstitutionalBull, latest: { foreign: 0, investment_trust: 0, dealer: 0, total: 0 } },
      water_level: 0.5,
    });
    expect(bearBoundary.mood).toBe(-20);
    expect(bearBoundary.stance).toBe('bear');
  });

  it('returns degraded state when inputs are missing', () => {
    const degraded = buildMarketSummary({
      breadth: null,
      institutional: null,
      water_level: null,
    });

    expect(degraded.degraded).toBe(true);
    expect(degraded.mood).toBe(0);
    expect(degraded.stance).toBe('neutral');
    expect(degraded.headline).toBe('資料不足');
    expect(degraded.signals).toEqual([]);
  });

  it('handles partial missing inputs without NaN or undefined output', () => {
    const partial = buildMarketSummary({
      breadth: mockBreadthBull,
      institutional: null,
      water_level: null,
    });

    expect(partial.mood).toBeDefined();
    expect(isNaN(partial.mood)).toBe(false);
    expect(partial.headline).not.toContain('NaN');
    expect(partial.headline).not.toContain('undefined');

    partial.signals.forEach((sig) => {
      expect(sig.text).not.toContain('NaN');
      expect(sig.text).not.toContain('undefined');
    });
  });
});
