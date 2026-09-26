// 市場槓桿溫度（證交所臺股儀表板）＋個股違約揭露的純計算層。
//
// 刻意只講「跟自己比」的事實：較前一交易日增減、在資料起算以來區間的位置與排名、
// 融資占市值在 2000 年以來年度區間的位置。不自創「低於多少就危險」的門檻——
// 維持率這組資料 2026-08-03 才開始，沒辦法回測；官方口徑（融資＋融券合併）也跟
// 媒體常講的「大盤融資維持率」不同，經驗門檻套不上。
import type {
  DefaultDisclosure,
  MarketCreditHistoryRow,
  MarketCreditResp,
  MarketCreditRow,
} from './api';

export type CreditKey = Exclude<keyof MarketCreditRow, 'date'>;

export interface LatestPoint {
  date: string;
  value: number;
  prevDate: string | null;
  prev: number | null;
  change: number | null;
}

/** 最後一個有值的交易日，以及它前一個有值的交易日 */
export function latestPoint(series: MarketCreditRow[], key: CreditKey): LatestPoint | null {
  const rows = series.filter((r) => typeof r[key] === 'number');
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const value = last[key] as number;
  const prevValue = prev ? (prev[key] as number) : null;
  return {
    date: last.date,
    value,
    prevDate: prev ? prev.date : null,
    prev: prevValue,
    change: prevValue === null ? null : value - prevValue,
  };
}

export interface RangeStat {
  since: string;
  n: number;              // 有值的交易日數
  min: number;
  max: number;
  /** 最新值在 [min, max] 的相對位置 0～1；區間只有一個值時為 null */
  position: number | null;
  /** 最新值由高到低的名次（1＝最高），同值並列取最好的名次 */
  rankHigh: number;
}

export function rangeStat(series: MarketCreditRow[], key: CreditKey): RangeStat | null {
  const rows = series.filter((r) => typeof r[key] === 'number');
  if (!rows.length) return null;
  const values = rows.map((r) => r[key] as number);
  const latest = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    since: rows[0].date,
    n: values.length,
    min,
    max,
    position: max === min ? null : (latest - min) / (max - min),
    rankHigh: values.filter((v) => v > latest).length + 1,
  };
}

/** 上市融資餘額占上市市值（%）；缺任一邊就是 null */
export function marginRatioPct(row: MarketCreditRow | undefined | null): number | null {
  if (!row || row.margin_balance === null || !row.market_value) return null;
  return (row.margin_balance / row.market_value) * 100;
}

export interface HistoryPosition {
  current: number;
  min: { label: string; value: number };
  max: { label: string; value: number };
  /** 年度值比目前還低的年數 */
  lowerYears: number;
  totalYears: number;
  /** 目前值在 [min, max] 的相對位置（可能 <0 或 >1：今天比歷史任何一年都低／高） */
  position: number;
}

export function historyPosition(
  history: MarketCreditHistoryRow[],
  current: number | null,
): HistoryPosition | null {
  if (current === null) return null;
  const rows = history.filter((h) => typeof h.margin_ratio === 'number') as (MarketCreditHistoryRow & {
    margin_ratio: number;
  })[];
  if (rows.length < 2) return null;
  const minRow = rows.reduce((a, b) => (b.margin_ratio < a.margin_ratio ? b : a));
  const maxRow = rows.reduce((a, b) => (b.margin_ratio > a.margin_ratio ? b : a));
  const span = maxRow.margin_ratio - minRow.margin_ratio;
  return {
    current,
    min: { label: minRow.label, value: minRow.margin_ratio },
    max: { label: maxRow.label, value: maxRow.margin_ratio },
    lowerYears: rows.filter((h) => h.margin_ratio < current).length,
    totalYears: rows.length,
    position: span > 0 ? (current - minRow.margin_ratio) / span : 0.5,
  };
}

export interface LeverageSnapshot {
  date: string;
  since: string | null;
  keepRate: LatestPoint | null;
  keepRange: RangeStat | null;
  below130: LatestPoint | null;
  below130Range: RangeStat | null;
  disposal: LatestPoint | null;
  disposalRange: RangeStat | null;
  disposalAmount: number | null;
  marginBalance: LatestPoint | null;
  shortShares: LatestPoint | null;
  marginRatio: number | null;
  history: HistoryPosition | null;
}

export function buildLeverageSnapshot(resp: MarketCreditResp): LeverageSnapshot {
  const s = resp.series || [];
  const disposal = latestPoint(s, 'disposal_accounts');
  const disposalRow = disposal ? s.find((r) => r.date === disposal.date) : undefined;
  const marginBalance = latestPoint(s, 'margin_balance');
  const marginRow = marginBalance ? s.find((r) => r.date === marginBalance.date) : undefined;
  const marginRatio = marginRatioPct(marginRow);
  return {
    date: resp.latest_date,
    since: resp.keep_rate_since,
    keepRate: latestPoint(s, 'keep_rate'),
    keepRange: rangeStat(s, 'keep_rate'),
    below130: latestPoint(s, 'below_130_accounts'),
    below130Range: rangeStat(s, 'below_130_accounts'),
    disposal,
    disposalRange: rangeStat(s, 'disposal_accounts'),
    disposalAmount: disposalRow ? disposalRow.disposal_amount : null,
    marginBalance,
    shortShares: latestPoint(s, 'short_shares'),
    marginRatio,
    history: historyPosition(resp.history || [], marginRatio),
  };
}

/** 'YYYY-MM-DD' → 'M/D' */
export function shortDate(iso: string | null | undefined): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso || '';
}

/** 區間位置的口語說法（只描述位置，不下好壞判斷） */
export function describePosition(r: RangeStat | null): string {
  if (!r || r.n < 5 || r.position === null) return '';
  if (r.position >= 1) return '區間最高';
  if (r.position <= 0) return '區間最低';
  if (r.position >= 0.8) return '接近區間高點';
  if (r.position <= 0.2) return '接近區間低點';
  return '位於區間中段';
}

/** 「8/3 以來第 3 高／最高」 */
export function describeRank(r: RangeStat | null): string {
  if (!r || r.n < 5) return '';
  const since = `${shortDate(r.since)} 以來`;
  return r.rankHigh === 1 ? `${since}最高` : `${since}第 ${r.rankHigh} 高`;
}

/** 近 N 個有值的交易日，給小圖用 */
export function recentPoints(
  series: MarketCreditRow[],
  key: CreditKey,
  n = 30,
): { date: string; value: number }[] {
  return series
    .filter((r) => typeof r[key] === 'number')
    .slice(-n)
    .map((r) => ({ date: r.date, value: r[key] as number }));
}

// ── 個股違約揭露 ───────────────────────────────────────────────────────────

export interface StockDisclosureSummary {
  code: string;
  latest: DefaultDisclosure;
  count: number;                // 名單期間（近一年）內上榜次數
  totalAmount: number;
  daysAgo: number;
  /** 90 天內＝近期，畫面用醒目紅色；更早的用低調樣式 */
  recent: boolean;
}

const DAY_MS = 86400 * 1000;

/** 兩個 YYYY-MM-DD 相差幾天（以日曆日計，不受時區影響） */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / DAY_MS);
}

/** 台北今天 YYYY-MM-DD */
export function tpeToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function summarizeDisclosures(
  items: DefaultDisclosure[],
  today: string = tpeToday(),
): Map<string, StockDisclosureSummary> {
  const out = new Map<string, StockDisclosureSummary>();
  for (const it of items) {
    const cur = out.get(it.code);
    if (!cur) {
      const daysAgo = daysBetween(it.date, today);
      out.set(it.code, {
        code: it.code,
        latest: it,
        count: 1,
        totalAmount: it.amount || 0,
        daysAgo,
        recent: daysAgo <= 90,
      });
    } else {
      cur.count += 1;
      cur.totalAmount += it.amount || 0;
      if (it.date > cur.latest.date) {
        cur.latest = it;
        cur.daysAgo = daysBetween(it.date, today);
        cur.recent = cur.daysAgo <= 90;
      }
    }
  }
  return out;
}

export function disclosuresForCode(items: DefaultDisclosure[], code: string): DefaultDisclosure[] {
  return items.filter((it) => it.code === code).sort((a, b) => b.date.localeCompare(a.date));
}

/** 元 → 「3.19 億」／「2,079 萬」 */
export function fmtYuan(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toLocaleString('zh-TW', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 億`;
  if (abs >= 1e4) return `${Math.round(v / 1e4).toLocaleString('zh-TW')} 萬`;
  return `${Math.round(v).toLocaleString('zh-TW')} 元`;
}
