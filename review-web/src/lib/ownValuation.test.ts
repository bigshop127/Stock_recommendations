import { describe, expect, it } from 'vitest';
import { addMonths, buildOwnValuation, forwardEps, quarterMonths, vsFairText, zoneOf } from './ownValuation';
import type { StockFundamentals } from './api';

// 日月光投控 3711：2026-11-08 正式站實際資料（只留算合理價用得到的欄位）
const ase = (): StockFundamentals =>
  ({
    code: '3711',
    name: '日月光投控',
    as_of: '2026-11-06',
    is_financial: false,
    industries: ['半導體業'],
    summary: { pe_ratio: 38.13, pb_ratio: 5.95, dividend_yield: 1.25, market_cap: null, eps_ttm: 13.92 },
    valuation_bands: {
      years: 3, start: '2023-11-08', end: '2026-11-06',
      pe: { p25: 19.4, p50: 21.7, p75: 36.8, n: 728 },
      pb: { p25: 2.1, p50: 2.6, p75: 4.2, n: 728 },
      dropped_outliers: 1, quarters_checked: 10, loss_quarters: 0,
    },
    valuation: [],
    revenue: [
      { month: '2026-04', revenue: 62247107000, yoy: null, mom: null },
      { month: '2026-05', revenue: 63033313000, yoy: null, mom: null },
      { month: '2026-06', revenue: 65783102000, yoy: null, mom: null },
      { month: '2026-07', revenue: 73783701000, yoy: null, mom: null },
      { month: '2026-08', revenue: 82247374000, yoy: null, mom: null },
      { month: '2026-09', revenue: 88130084000, yoy: null, mom: null },
    ],
    financials: [
      { quarter: '2026-Q1', eps: 3.24, gross_margin: null, operating_margin: null, net_margin: null, revenue: 173662152000 },
      { quarter: '2026-Q2', eps: 4.8, gross_margin: null, operating_margin: null, net_margin: null, revenue: 191063522000 },
    ],
    balance_sheet: [],
    dividend: [],
    unit: { revenue: '元', market_cap: '元', dividend: '元/股', ratio: '%' },
    source: 'FinMind',
  }) as unknown as StockFundamentals;

describe('小工具', () => {
  it('月份推算、季別轉月份', () => {
    expect(addMonths('2026-01', -2)).toBe('2025-11');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(quarterMonths('2026-Q2')).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(quarterMonths('2026Q2')).toBeNull();
  });
  it('現價落在哪一段', () => {
    const p = { cheap: 100, fair: 120, expensive: 150 };
    expect(zoneOf(90, p)).toBe('below');
    expect(zoneOf(110, p)).toBe('cheap');
    expect(zoneOf(130, p)).toBe('fair');
    expect(zoneOf(160, p)).toBe('above');
  });
  it('「現價比合理價高／低」用 現價 ÷ 合理價 − 1（日月光舊版寫錯成 54.5%）', () => {
    expect(vsFairText(527, 239.9)).toEqual({ text: '現價比合理價高 119.7%', cheap: false });
    expect(vsFairText(80, 100)).toEqual({ text: '現價比合理價低 20.0%', cheap: true });
  });
});

describe('推估未來四季 EPS', () => {
  it('日月光：Q2 EPS 4.8 × 4 × 7–9 月營收 ÷ 4–6 月營收 ≈ 24.54', () => {
    const fw = forwardEps(ase(), '2026-11');
    if ('reason' in fw) throw new Error(fw.reason);
    expect(fw.eps).toBeCloseTo(24.54, 2);
    expect(fw.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(fw.quarter).toBe('2026-Q2');
    expect(fw.growthPct).toBeCloseTo(27.79, 1);
  });
  it('最近 3 個月就是那一季 → EPS × 4', () => {
    const f = ase();
    f.revenue = f.revenue.slice(0, 3);
    const fw = forwardEps(f, '2026-08');
    if ('reason' in fw) throw new Error(fw.reason);
    expect(fw.eps).toBeCloseTo(19.2, 6);
  });
  it('月營收太舊、少一個月、最近一季虧損 → 說原因', () => {
    expect(forwardEps(ase(), '2027-03')).toEqual({ reason: '月營收停在 2026-09，太舊不推估' });
    const f = ase();
    f.revenue = f.revenue.filter((r) => r.month !== '2026-08');
    expect(forwardEps(f, '2026-11')).toEqual({ reason: '最近 3 個月營收不齊' });
    const g = ase();
    g.financials[1].eps = -0.5;
    expect('reason' in forwardEps(g, '2026-11')).toBe(true);
  });
  it('那一季的月營收缺 → 退用損益表營收', () => {
    const f = ase();
    f.revenue = f.revenue.filter((r) => r.month !== '2026-04');
    const fw = forwardEps(f, '2026-11');
    if ('reason' in fw) throw new Error(fw.reason);
    expect(fw.quarterRevenue).toBe(191063522000);
  });
});

describe('buildOwnValuation', () => {
  it('日月光：推估 EPS × 自身 3 年本益比 → 476／532／903，現價 527 落在便宜～合理', () => {
    const r = buildOwnValuation(ase(), 527, '2026-11');
    if (!r.ok) throw new Error(r.reason);
    const v = r.v;
    expect(v.method).toBe('pe');
    expect(v.prices.cheap).toBeCloseTo(475.9, 0);
    expect(v.prices.fair).toBeCloseTo(532.3, 0);
    expect(v.prices.expensive).toBeCloseTo(902.7, 0);
    expect(v.zone).toBe('cheap');
    expect(v.vsFairPct).toBeCloseTo((527 / v.prices.fair - 1) * 100, 6);
    // 保守參考：近四季實際 EPS 13.92 × 同一組倍數
    expect(v.conservative?.eps).toBe(13.92);
    expect(v.conservative?.prices.fair).toBeCloseTo(13.92 * 21.7, 6);
  });
  it('金融股、近 3 年有虧損季、本益比區間太寬 → 改用淨值比 × 每股淨值', () => {
    const withBs = (f: StockFundamentals) => {
      f.balance_sheet = [
        { quarter: '2026-Q1', bvps: 80 } as never,
        { quarter: '2026-Q2', bvps: 88.57 } as never,
      ];
      return f;
    };
    const fin = withBs(ase());
    fin.is_financial = true;
    const r1 = buildOwnValuation(fin, 527, '2026-11');
    if (!r1.ok) throw new Error(r1.reason);
    expect(r1.v.method).toBe('pb');
    expect(r1.v.switchReason).toBe('金融股看淨值');
    expect(r1.v.base).toBe(88.57); // 取最新一季
    expect(r1.v.prices.fair).toBeCloseTo(2.6 * 88.57, 6);
    expect(r1.v.conservative).toBeNull();

    const loss = withBs(ase());
    loss.valuation_bands!.loss_quarters = 2;
    const r2 = buildOwnValuation(loss, 527, '2026-11');
    expect(r2.ok && r2.v.switchReason).toBe('近 3 年有 2 季虧損');

    const wide = withBs(ase());
    wide.valuation_bands!.pe = { p25: 10, p50: 25, p75: 40, n: 700 };
    const r3 = buildOwnValuation(wide, 527, '2026-11');
    expect(r3.ok && r3.v.method).toBe('pb');
  });
  it('推估不了 EPS 又沒有每股淨值 → 不估並說原因；沒有區間 → 不估', () => {
    const f = ase();
    f.revenue = [];
    const r = buildOwnValuation(f, 527, '2026-11');
    expect(r).toEqual({ ok: false, reason: '推估不了 EPS（沒有月營收資料），但沒有每股淨值資料，不估' });
    const g = ase();
    g.valuation_bands = { ...g.valuation_bands!, pe: null, pb: null };
    expect(buildOwnValuation(g, 527).ok).toBe(false);
    expect(buildOwnValuation(null, 527).ok).toBe(false);
  });
  it('沒有現價 → 價格照算，位置與差距留空', () => {
    const r = buildOwnValuation(ase(), null, '2026-11');
    expect(r.ok && r.v.zone).toBeNull();
    expect(r.ok && r.v.vsFairPct).toBeNull();
  });
});
