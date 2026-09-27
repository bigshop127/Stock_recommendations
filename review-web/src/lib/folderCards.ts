// 資料夾卡片牆（opt45，仿 Danny Quant「今日資料池」策略卡片牆，但只放自己資料夾裡的股票）。
// 每檔一張卡：近 60 日還原 K 線＋月線、量比、三大法人 5 日合計、最新月營收年增。
import type { ChipRow, OhlcvRow, StockMetric } from './api';

export const SPARK_BARS = 60;

export interface CardMetrics {
  /** 畫迷你 K 線用：最後 60 根 */
  bars: OhlcvRow[];
  /** 跟 bars 對齊的月線（前面不足 20 根的是 null） */
  ma20: (number | null)[];
  close: number | null;
  changePct: number | null;
  date: string | null;
  /** 5 日均量 ÷ 20 日均量 */
  volRatio: number | null;
  /** 三大法人最近 5 個交易日買賣超合計（張）；instDays＝實際有幾天資料 */
  inst5: number | null;
  instDays: number;
  /** 收盤距 60 日高點 % */
  fromHigh60: number | null;
}

const validBar = (r: OhlcvRow) => [r.open, r.high, r.low, r.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);

export function cardMetrics(rows: OhlcvRow[] | null, chips: ChipRow[] | null): CardMetrics {
  const all = (rows || []).filter(validBar).sort((a, b) => a.date.localeCompare(b.date));
  const n = all.length;
  const ma20All = all.map((_, i) => (i >= 19 ? all.slice(i - 19, i + 1).reduce((a, r) => a + r.close, 0) / 20 : null));
  const start = Math.max(0, n - SPARK_BARS);
  const last = n ? all[n - 1] : null;
  const prev = n > 1 ? all[n - 2] : null;

  let volRatio: number | null = null;
  if (n >= 20) {
    const vols = all.map((r) => r.volume ?? 0);
    const v5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const v20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    volRatio = v20 > 0 ? v5 / v20 : null;
  }

  const chipRows = (chips || []).slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-5);
  const inst5 = chipRows.length ? chipRows.reduce((a, r) => a + (Number.isFinite(r.total_net_buy_qty) ? r.total_net_buy_qty : 0), 0) : null;

  const window60 = all.slice(start);
  const hi60 = window60.length ? Math.max(...window60.map((r) => r.high)) : null;

  return {
    bars: window60,
    ma20: ma20All.slice(start),
    close: last ? last.close : null,
    changePct: last && prev ? (last.close / prev.close - 1) * 100 : null,
    date: last ? last.date : null,
    volRatio,
    inst5,
    instDays: chipRows.length,
    fromHigh60: last && hi60 ? (last.close / hi60 - 1) * 100 : null,
  };
}

export type CardSortKey = 'order' | 'change' | 'volRatio' | 'inst5' | 'revYoy' | 'fromHigh60';

export const CARD_SORTS: { key: CardSortKey; label: string }[] = [
  { key: 'order', label: '加入順序' },
  { key: 'change', label: '漲跌幅' },
  { key: 'volRatio', label: '量比' },
  { key: 'inst5', label: '法人 5 日' },
  { key: 'revYoy', label: '營收年增' },
  { key: 'fromHigh60', label: '離 60 日高點' },
];

export interface CardItem {
  code: string;
  name: string;
  order: number;
  metrics: CardMetrics | null;
  stock: StockMetric | null;
}

function sortValue(c: CardItem, key: CardSortKey): number | null {
  switch (key) {
    case 'order': return c.order;
    case 'change': return c.metrics?.changePct ?? null;
    case 'volRatio': return c.metrics?.volRatio ?? null;
    case 'inst5': return c.metrics?.inst5 ?? null;
    case 'revYoy': return c.stock?.rev_yoy ?? null;
    case 'fromHigh60': return c.metrics?.fromHigh60 ?? null;
  }
}

/** 加入順序由舊到新；其他一律大到小，沒有數值的排最後 */
export function sortCards(items: CardItem[], key: CardSortKey): CardItem[] {
  return [...items].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return a.order - b.order;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (key === 'order') return va - vb;
    return vb - va || a.order - b.order;
  });
}

/** 同時最多 limit 個請求（一個資料夾幾十檔時不要一次打爆 engine／FinMind） */
export async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
