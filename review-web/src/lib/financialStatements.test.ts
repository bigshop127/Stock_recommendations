import { describe, it, expect } from 'vitest';
import {
  fmtYi,
  fmtPct,
  looksFinancial,
  hasIncomeAmounts,
  debtLevel,
  currentRatioLevel,
  dividendProgress,
  upcomingDividend,
  realDividends,
} from './financialStatements';
import type { BalanceSheetRow, DividendEvent, FinancialsRow } from './api';

const ev = (over: Partial<DividendEvent>): DividendEvent => ({
  period: '115年第1季',
  base_date: '2026-09-22',
  cash_dividend: 7,
  stock_dividend: 0,
  announce_date: '2026-09-01',
  cash_ex_date: '2026-09-16',
  stock_ex_date: null,
  payment_date: '2026-10-08',
  ...over,
});

const fin = (over: Partial<FinancialsRow>): FinancialsRow => ({
  quarter: '2026-Q2', eps: 1, gross_margin: null, operating_margin: null, net_margin: 10,
  revenue: 100, gross_profit: null, operating_income: null, net_income: 10, ...over,
});

const bal = (over: Partial<BalanceSheetRow>): BalanceSheetRow => ({
  quarter: '2026-Q2', total_assets: 100, total_liabilities: 90, equity: 10, equity_parent: 10,
  current_assets: null, current_liabilities: null, cash: 5, receivables: null, inventories: null,
  debt_ratio: 90, current_ratio: null, bvps: 20, ...over,
});

describe('格式', () => {
  it('一律用億', () => {
    expect(fmtYi(1270380000000)).toBe('12,703.8');
    expect(fmtYi(-3.5e8)).toBe('-3.5');
    expect(fmtYi(9.37565e12)).toBe('93,756.5');
    expect(fmtYi(null)).toBe('—');
    expect(fmtPct(36.06, true)).toBe('+36.1%');
    expect(fmtPct(-1.32, true)).toBe('-1.3%');
    expect(fmtPct(undefined)).toBe('—');
  });
});

describe('金融業判斷與門檻', () => {
  it('沒有毛利也沒有流動資產＝金融業', () => {
    expect(looksFinancial([fin({})], [bal({})])).toBe(true);
    expect(looksFinancial([fin({ gross_profit: 50 })], [bal({})])).toBe(false);
    expect(looksFinancial([fin({})], [bal({ current_assets: 50 })])).toBe(false);
    expect(hasIncomeAmounts([fin({ revenue: undefined })])).toBe(false);
    expect(hasIncomeAmounts([fin({})])).toBe(true);
  });
  it('負債比、流動比分段', () => {
    expect(debtLevel(31, false).tone).toBe('good');
    expect(debtLevel(55, false).tone).toBe('mid');
    expect(debtLevel(63.2, false)).toEqual({ label: '偏高', tone: 'high' });
    expect(debtLevel(92, true).tone).toBe('na');
    expect(currentRatioLevel(245).tone).toBe('good');
    expect(currentRatioLevel(132).tone).toBe('mid');
    expect(currentRatioLevel(80).tone).toBe('high');
  });
});

describe('股利決議進度', () => {
  it('已除息・待發放，下一步是發放', () => {
    const p = dividendProgress(ev({}), '2026-09-27');
    expect(p.status).toBe('已除息・待發放');
    expect(p.steps.map((s) => s.done)).toEqual([true, true, false]);
    expect(p.next).toEqual({ label: '發放', date: '2026-10-08', daysLeft: 11 });
  });
  it('除息當天還算待除息', () => {
    const p = dividendProgress(ev({}), '2026-09-16');
    expect(p.status).toBe('待除息');
    expect(p.next).toEqual({ label: '除息', date: '2026-09-16', daysLeft: 0 });
  });
  it('發放日過了＝已發放、沒有下一步', () => {
    const p = dividendProgress(ev({}), '2026-10-09');
    expect(p.status).toBe('已發放');
    expect(p.next).toBeNull();
  });
  it('配股配息一起：除權息；日期未定', () => {
    const p = dividendProgress(ev({ stock_dividend: 0.5, cash_ex_date: null, stock_ex_date: null, payment_date: null }), '2026-09-02');
    expect(p.steps[1].label).toBe('除權息');
    expect(p.status).toBe('除權息日未定');
    expect(p.total).toBe(7.5);
  });
  it('ETF 沒有公告日：不列公告這一步', () => {
    const p = dividendProgress(ev({ announce_date: null, cash_ex_date: '2026-10-20', payment_date: '2026-11-12' }), '2026-09-27');
    expect(p.status).toBe('待除息');
    expect(p.steps.map((s) => s.key)).toEqual(['ex', 'pay']);
    expect(p.ex.date).toBe('2026-10-20');
  });
  it('沒有發放日：除息一個多月後算結束，不再顯示待發放', () => {
    const e = ev({ payment_date: null });
    expect(dividendProgress(e, '2026-09-27').status).toBe('已除息・待發放');
    expect(dividendProgress(e, '2026-12-01').status).toBe('已除息');
  });
  it('金額 0 的列（不適用）濾掉', () => {
    expect(realDividends([ev({ period: '不適用', cash_dividend: 0, stock_dividend: 0 }), ev({})])).toHaveLength(1);
  });
  it('upcomingDividend 挑最近一筆還沒除息的', () => {
    const events = [
      ev({ period: 'Q2', cash_ex_date: '2026-12-10', payment_date: '2027-01-08', announce_date: '2026-11-10' }),
      ev({ period: 'Q1', cash_ex_date: '2026-10-05', payment_date: '2026-10-30' }),
      ev({ period: '舊', cash_ex_date: '2026-06-11', payment_date: '2026-07-09' }),
    ];
    expect(upcomingDividend(events, '2026-09-27')!.event.period).toBe('Q1');
    expect(upcomingDividend(events, '2026-10-06')!.event.period).toBe('Q2');
    expect(upcomingDividend([], '2026-09-27')).toBeNull();
  });
});
