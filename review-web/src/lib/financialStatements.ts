// 財報補完（opt45）：季度損益金額、資產負債、股利決議進度的純函式（畫面在 components/FinancialStatements.tsx）。
import type { BalanceSheetRow, DividendEvent, FinancialsRow } from './api';

/** 元 → 億（一位小數、千分位，負數帶負號）；null → '—'。表格欄位統一標「億元」，不在同一欄混用兆 */
export function fmtYi(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v / 1e8).toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** 金融業：損益沒有毛利／營業利益、資產負債沒有流動資產負債（銀行、保險、證券的報表格式不同） */
export function looksFinancial(fin: FinancialsRow[], bal: BalanceSheetRow[]): boolean {
  const noGross = fin.length > 0 && fin.every((f) => f.gross_profit === null || f.gross_profit === undefined);
  const noCurrent = bal.length > 0 && bal.every((b) => b.current_assets === null);
  return noGross && (bal.length === 0 || noCurrent);
}

/** 有沒有新版的損益金額欄位（engine 還沒更新時整張表不畫） */
export function hasIncomeAmounts(fin: FinancialsRow[]): boolean {
  return fin.some((f) => f.revenue !== null && f.revenue !== undefined);
}

export interface DebtLevel {
  label: string;
  tone: 'good' | 'mid' | 'high' | 'na';
}

/** 負債比粗分三段（一般產業）；金融業天生 90% 上下，不套門檻 */
export function debtLevel(ratio: number | null, financial: boolean): DebtLevel {
  if (ratio === null) return { label: '—', tone: 'na' };
  if (financial) return { label: '金融業不適用一般門檻', tone: 'na' };
  if (ratio < 40) return { label: '低負債', tone: 'good' };
  if (ratio < 60) return { label: '中等', tone: 'mid' };
  return { label: '偏高', tone: 'high' };
}

export function currentRatioLevel(ratio: number | null): DebtLevel {
  if (ratio === null) return { label: '—', tone: 'na' };
  if (ratio >= 150) return { label: '短期償債充裕', tone: 'good' };
  if (ratio >= 100) return { label: '尚可', tone: 'mid' };
  return { label: '流動負債大於流動資產', tone: 'high' };
}

// ── 股利決議進度 ──────────────────────────────────────────────────────────

export interface DividendStep {
  key: 'announce' | 'ex' | 'pay';
  label: string;
  date: string | null;
  done: boolean;
}

export interface DividendProgress {
  event: DividendEvent;
  /** 公告日是 null（ETF）就不列公告這一步 */
  steps: DividendStep[];
  /** 除權息那一步（排序、倒數用） */
  ex: DividendStep;
  status: '已公告' | '待除息' | '已除息・待發放' | '已除息' | '已發放' | '除權息日未定';
  /** 下一個還沒到的日子（今天當天也算還沒過） */
  next: { label: string; date: string; daysLeft: number } | null;
  total: number;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** today：台北日期 YYYY-MM-DD */
export function dividendProgress(ev: DividendEvent, today: string): DividendProgress {
  const exDate = ev.cash_ex_date || ev.stock_ex_date;
  const hasCash = (ev.cash_dividend ?? 0) > 0;
  const hasStock = (ev.stock_dividend ?? 0) > 0;
  const exLabel = hasCash && hasStock ? '除權息' : hasStock ? '除權' : '除息';
  const past = (d: string | null) => d !== null && d < today;
  const ex: DividendStep = { key: 'ex', label: exLabel, date: exDate, done: past(exDate) };
  const steps: DividendStep[] = [
    ...(ev.announce_date ? [{ key: 'announce' as const, label: '公告', date: ev.announce_date, done: ev.announce_date <= today }] : []),
    ex,
    { key: 'pay', label: '發放', date: ev.payment_date, done: past(ev.payment_date) },
  ];

  let status: DividendProgress['status'];
  if (!exDate) status = '除權息日未定';
  else if (!past(exDate)) status = ev.announce_date && ev.announce_date > today ? '已公告' : '待除息';
  else if (ev.payment_date) status = past(ev.payment_date) ? '已發放' : '已除息・待發放';
  // 沒有發放日：純配股、或資料沒給；除息一個多月後當作已經結束
  else status = daysBetween(exDate, today) > 45 ? '已除息' : '已除息・待發放';

  const upcoming = steps.find((s) => s.date !== null && s.date >= today && s.key !== 'announce');
  return {
    event: ev,
    steps,
    ex,
    status,
    next: upcoming && upcoming.date ? { label: upcoming.label, date: upcoming.date, daysLeft: daysBetween(today, upcoming.date) } : null,
    total: (ev.cash_dividend ?? 0) + (ev.stock_dividend ?? 0),
  };
}

/** 有配到東西的才算（FinMind 偶爾有「不適用」、金額 0 的列） */
export function realDividends(events: DividendEvent[] | undefined): DividendEvent[] {
  return (events ?? []).filter((e) => (e.cash_dividend ?? 0) + (e.stock_dividend ?? 0) > 0);
}

/** 最近一筆「除權息日還沒過或日期未定」的配發；沒有就 null（重點標籤用） */
export function upcomingDividend(events: DividendEvent[] | undefined, today: string): DividendProgress | null {
  const list = realDividends(events)
    .map((e) => dividendProgress(e, today))
    .filter((p) => p.status === '待除息' || p.status === '已公告')
    .sort((a, b) => (a.ex.date || '9999').localeCompare(b.ex.date || '9999'));
  return list[0] ?? null;
}
