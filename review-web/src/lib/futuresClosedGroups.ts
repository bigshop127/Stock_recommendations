// 期貨平倉紀錄分組（2026-09-28，「部位 & 平倉紀錄」分頁收納整理用）。
//
// 券商一筆委託常常拆成好幾筆成交：同一天、同一個價位的 1 口／2 口／1 口各自是一筆平倉紀錄，
// 攤平列出來 36 筆看不出每天到底賺賠多少。比照「已實現損益總覽」頁依標的摺疊的做法，
// 這裡提供兩種分組：
//   - 依平倉日（預設）：一天一組，回答「那天出場賺了多少」
//   - 依合約：商品＋契約月份＋方向一組，回答「這個月份的合約總共做了多少」
// 組內只有一筆時畫面直接顯示那一筆，不多一層。
import type { ClosedTrade, ClosedBreakdown, Side } from './futures';

export type ClosedGroupMode = 'exit_date' | 'contract';
export type ClosedSortMode = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

export interface ClosedRowView {
  t: ClosedTrade;
  b: ClosedBreakdown;
}

export interface ClosedGroup {
  key: string;
  rows: ClosedRowView[];
  lots: number;
  gross: number;
  /** 手續費＋交易稅 */
  cost: number;
  net: number;
  wins: number;
  /** 組內最新／最早的平倉日（沒有日期的列不算） */
  latestDate: string;
  earliestDate: string;
  /** 組內全部同一個值才有，混在一起是 null（畫面就不顯示該欄） */
  product: string | null;
  month: string | null;
  side: Side | null;
  exitDate: string | null;
  /** 口數加權平均進出場價；商品或方向混在一起時不算（不同商品的價格加權沒有意義） */
  avgEntry: number | null;
  avgExit: number | null;
  /** 組內有任何一筆費用是用設定費率推估的 */
  anyEstimated: boolean;
}

const same = <T,>(values: T[]): T | null => (values.length && values.every((v) => v === values[0]) ? values[0] : null);

function groupKey(t: ClosedTrade, mode: ClosedGroupMode): string {
  if (mode === 'contract') return `${t.product}|${t.month}|${t.side}`;
  return t.exit_date || '（無平倉日）';
}

/** 組內排序：新的平倉日在前；同一天依進場價由低到高，相同成交價的拆單會排在一起 */
function rowOrder(a: ClosedRowView, b: ClosedRowView): number {
  return (b.t.exit_date || '').localeCompare(a.t.exit_date || '')
    || a.t.entry_price - b.t.entry_price
    || a.t.exit_price - b.t.exit_price;
}

export function groupClosedTrades(rows: ClosedRowView[], mode: ClosedGroupMode): ClosedGroup[] {
  const buckets = new Map<string, ClosedRowView[]>();
  for (const r of rows) {
    const k = groupKey(r.t, mode);
    const list = buckets.get(k);
    if (list) list.push(r);
    else buckets.set(k, [r]);
  }

  const groups: ClosedGroup[] = [];
  for (const [key, list] of buckets) {
    const sorted = [...list].sort(rowOrder);
    const lotsOf = (r: ClosedRowView) => Math.max(0, r.t.lots);
    const lots = sorted.reduce((s, r) => s + lotsOf(r), 0);
    const dates = sorted.map((r) => r.t.exit_date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const product = same(sorted.map((r) => r.t.product));
    const side = same(sorted.map((r) => r.t.side));
    const priceable = product !== null && side !== null && lots > 0;
    groups.push({
      key,
      rows: sorted,
      lots,
      gross: sorted.reduce((s, r) => s + r.b.gross, 0),
      cost: sorted.reduce((s, r) => s + r.b.fees + r.b.tax, 0),
      net: sorted.reduce((s, r) => s + r.b.net, 0),
      wins: sorted.filter((r) => r.b.net > 0).length,
      latestDate: dates.length ? dates[dates.length - 1] : '',
      earliestDate: dates.length ? dates[0] : '',
      product,
      month: same(sorted.map((r) => r.t.month)),
      side,
      exitDate: same(sorted.map((r) => r.t.exit_date)),
      avgEntry: priceable ? sorted.reduce((s, r) => s + r.t.entry_price * lotsOf(r), 0) / lots : null,
      avgExit: priceable ? sorted.reduce((s, r) => s + r.t.exit_price * lotsOf(r), 0) / lots : null,
      anyEstimated: sorted.some((r) => !r.b.actual_cost),
    });
  }
  return groups;
}

/** 日期排序看組內最新的平倉日；金額排序看組的淨損益。同分時新的在前 */
export function sortClosedGroups(groups: ClosedGroup[], mode: ClosedSortMode): ClosedGroup[] {
  const byDateDesc = (a: ClosedGroup, b: ClosedGroup) => b.latestDate.localeCompare(a.latestDate) || a.key.localeCompare(b.key);
  const arr = [...groups];
  switch (mode) {
    case 'date_asc':
      return arr.sort((a, b) => a.latestDate.localeCompare(b.latestDate) || a.key.localeCompare(b.key));
    case 'amount_desc':
      return arr.sort((a, b) => b.net - a.net || byDateDesc(a, b));
    case 'amount_asc':
      return arr.sort((a, b) => a.net - b.net || byDateDesc(a, b));
    case 'date_desc':
    default:
      return arr.sort(byDateDesc);
  }
}
