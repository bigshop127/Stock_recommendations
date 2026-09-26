import { describe, it, expect } from 'vitest';
import type { MarketRevenueResp, RevenueCompanyResp, RevenueIndustryResp } from './api';
import {
  fmtRevenue,
  fmtPct,
  fmtPp,
  toneClass,
  divergingColor,
  revenueMovers,
  revenueTreemapInputs,
  topPercent,
  sortCompanies,
  monthLabel,
  compactRevenueAxis,
} from './marketRevenue';
// 2026-09-26 由 gateway /api/market/revenue* 實際抓下來的回應
import revenueFixture from './__fixtures__/market_revenue.json';
import companyFixture from './__fixtures__/revenue_company_2330.json';
import industryFixture from './__fixtures__/revenue_industry_distribution.json';

const revenue = revenueFixture as unknown as MarketRevenueResp;
const company = companyFixture as unknown as RevenueCompanyResp;
const industry = industryFixture as unknown as RevenueIndustryResp;

describe('真實資料（2026-08 營收）跟證交所臺股儀表板對得上', () => {
  it('全體上市概況', () => {
    expect(revenue.month).toBe('2026-08');
    expect(revenue.overview.count).toBe(1084);
    expect(fmtRevenue(revenue.overview.revenue)).toBe('5.89 兆');
    expect(Math.round(revenue.overview.revenue / 1e6) / 100).toBe(58916.61);
    expect(fmtPct(revenue.overview.yoy_pct)).toBe('+46.81%');
    expect(fmtPct(revenue.overview.mom_pct)).toBe('+5.66%');
    expect(fmtPct(revenue.overview.cum_yoy_pct)).toBe('+37.92%');
    expect(revenue.industries).toHaveLength(32);
    expect(revenue.trend).toHaveLength(12);
  });

  it('成長前三與衰退產業', () => {
    const m = revenueMovers(revenue.industries);
    expect(m.up.map((i) => i.name)).toEqual(['電腦及週邊設備業', '電子通路業', '半導體業']);
    expect(m.down.map((i) => i.name)).toEqual(['金融保險業']);
    expect(m.upCount).toBe(31);
    expect(m.downCount).toBe(1);
  });

  it('treemap：最小產業有下限、其餘照實際營收', () => {
    const inputs = revenueTreemapInputs(revenue.industries);
    expect(inputs).toHaveLength(32);
    const total = revenue.industries.reduce((a, b) => a + b.revenue, 0);
    const glass = inputs.find((i) => i.key === '玻璃陶瓷')!;
    expect(glass.value).toBeCloseTo(total * 0.004, 0);
    expect(glass.datum.revenue).toBeLessThan(glass.value);
    const pc = inputs.find((i) => i.key === '電腦及週邊設備業')!;
    expect(pc.value).toBe(pc.datum.revenue);
  });

  it('台積電 vs 半導體業', () => {
    expect(company.company.industry).toBe('半導體業');
    expect(company.industry?.count).toBe(96);
    expect(company.rank).toEqual({ rank: 29, of: 96 });
    expect(topPercent(29, 96)).toBe('前 30%');
    const diff = (company.company.yoy_pct as number) - (company.industry?.yoy_pct as number);
    expect(fmtPp(diff)).toBe('-8.0 百分點');
  });

  it('產業成分股排序：沒有值排最後', () => {
    const byYoy = sortCompanies(industry.companies, 'yoy_pct');
    for (let i = 1; i < byYoy.length; i++) {
      const a = byYoy[i - 1].yoy_pct;
      const b = byYoy[i].yoy_pct;
      if (a !== null && b !== null) expect(a).toBeGreaterThanOrEqual(b);
    }
    const rows = [
      { ...industry.companies[0], yoy_pct: null },
      { ...industry.companies[1], yoy_pct: 5 },
      { ...industry.companies[2], yoy_pct: -5 },
    ];
    expect(sortCompanies(rows, 'yoy_pct', true).map((r) => r.yoy_pct)).toEqual([5, -5, null]);
    expect(sortCompanies(rows, 'yoy_pct', false).map((r) => r.yoy_pct)).toEqual([-5, 5, null]);
  });
});

describe('格式與色階', () => {
  it('金額與百分比', () => {
    expect(fmtRevenue(910937000000)).toBe('9,109.4 億');
    expect(fmtRevenue(32110000)).toBe('3,211 萬');
    expect(fmtRevenue(null)).toBe('—');
    expect(fmtPct(-34.8798)).toBe('-34.88%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPp(12.34)).toBe('+12.3 百分點');
  });

  it('紅漲綠跌', () => {
    expect(toneClass(3)).toBe('text-bull');
    expect(toneClass(-3)).toBe('text-bear');
    expect(toneClass(0)).toBe('text-zinc-400');
    expect(toneClass(null)).toBe('text-zinc-400');
  });

  it('發散色階：中點灰、到飽和點最深、超過不再變深', () => {
    expect(divergingColor(0, 50)).toBe('#3f3f46');
    expect(divergingColor(null, 50)).toBe('#3f3f46');
    expect(divergingColor(25, 50)).toBe('rgb(239, 68, 68)');
    expect(divergingColor(50, 50)).toBe('rgb(185, 28, 28)');
    expect(divergingColor(90, 50)).toBe('rgb(185, 28, 28)');
    expect(divergingColor(-50, 50)).toBe('rgb(21, 128, 61)');
    // 跟熱力圖漲跌幅色階同一組色（±5% 飽和）
    expect(divergingColor(2.5, 5)).toBe('rgb(239, 68, 68)');
  });

  it('軸用精簡格式：整條軸同一個單位', () => {
    const big = compactRevenueAxis(6.5e12);
    expect(big(6.5e12)).toBe('6.5兆');
    expect(big(3.25e12)).toBe('3.3兆');
    expect(big(0)).toBe('0');
    const mid = compactRevenueAxis(9.5e11);
    expect(mid(5.01e11)).toBe('5,010億');
    expect(compactRevenueAxis(5e7)(2.5e7)).toBe('2,500萬');
  });

  it('月份標籤與名次百分比邊界', () => {
    expect(monthLabel('2026-08')).toBe('8 月');
    expect(monthLabel('2025-09', true)).toBe('2025/9');
    expect(topPercent(1, 96)).toBe('前 1%');
    expect(topPercent(96, 96)).toBe('前 100%');
    expect(topPercent(1, 0)).toBe('');
  });
});
