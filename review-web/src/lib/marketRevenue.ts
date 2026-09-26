// 月營收（盤勢總覽營收卡、熱力圖「產業營收」檢視、個股頁「本公司 vs 產業」）的純計算層。
import type { RevenueAggregate, RevenueCompany } from './api';
import type { TreemapInput } from './treemap';

/** 元 → 「5.89 兆」「9,109.4 億」「3,211 萬」 */
export function fmtRevenue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
  if (abs >= 1e8) return `${(v / 1e8).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 億`;
  if (abs >= 1e4) return `${Math.round(v / 1e4).toLocaleString('zh-TW')} 萬`;
  return `${Math.round(v).toLocaleString('zh-TW')} 元`;
}

/**
 * 圖表軸用的精簡金額格式：依整條軸的最大值挑一個單位，整條軸都用同一個單位
 * （不會同一條軸上一格寫「兆」一格寫「億」）。0 就寫 0。
 */
export function compactRevenueAxis(maxValue: number): (v: number) => string {
  if (maxValue >= 1e12) return (v) => (v === 0 ? '0' : `${(v / 1e12).toFixed(1)}兆`);
  if (maxValue >= 1e8) return (v) => (v === 0 ? '0' : `${Math.round(v / 1e8).toLocaleString('zh-TW')}億`);
  return (v) => (v === 0 ? '0' : `${Math.round(v / 1e4).toLocaleString('zh-TW')}萬`);
}

/** 46.81 → '+46.81%'；null → '—' */
export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return `${v > 0 ? '+' : ''}${s}%`;
}

/** 百分點差：+12.3 百分點 */
export function fmtPp(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} 百分點`;
}

/** 台股慣例：正＝紅（bull）、負＝綠（bear）、0 或沒有值＝灰 */
export function toneClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-zinc-400';
  return v > 0 ? 'text-bull' : 'text-bear';
}

/**
 * 發散色階（跟熱力圖漲跌幅同一組色：灰色中點→紅漲／綠跌），saturation 是「幾 % 算最深」。
 * 營收年增率動輒 ±50%，所以營收檢視用 50；股價漲跌用 5。
 */
export function divergingColor(pct: number | null | undefined, saturation: number): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct === 0) return '#3f3f46';
  const t = Math.max(0, Math.min(1, Math.abs(pct) / saturation));
  const lerp = (a: number, b: number, r: number) => Math.round(a + (b - a) * r);
  const [c0, c1, c2] = pct > 0
    ? [[63, 63, 70], [239, 68, 68], [185, 28, 28]]
    : [[63, 63, 70], [34, 197, 94], [21, 128, 61]];
  const [from, to, r] = t <= 0.5 ? [c0, c1, t / 0.5] : [c1, c2, (t - 0.5) / 0.5];
  return `rgb(${lerp(from[0], to[0], r)}, ${lerp(from[1], to[1], r)}, ${lerp(from[2], to[2], r)})`;
}

export interface RevenueMovers {
  up: RevenueAggregate[];     // 年增率最高的前 n 個（只列正成長）
  down: RevenueAggregate[];   // 年增率最低的前 n 個（只列負成長）
  upCount: number;
  downCount: number;
}

export function revenueMovers(industries: RevenueAggregate[], n = 3): RevenueMovers {
  const valid = industries.filter((i) => typeof i.yoy_pct === 'number');
  const up = valid.filter((i) => (i.yoy_pct as number) > 0).sort((a, b) => (b.yoy_pct as number) - (a.yoy_pct as number));
  const down = valid.filter((i) => (i.yoy_pct as number) < 0).sort((a, b) => (a.yoy_pct as number) - (b.yoy_pct as number));
  return { up: up.slice(0, n), down: down.slice(0, n), upCount: up.length, downCount: down.length };
}

/**
 * treemap 輸入：面積＝當月營收。最小的產業（玻璃陶瓷只占 0.1%）會小到看不見，
 * 所以給一個占總額 floorShare 的下限，tooltip 仍顯示真實金額。
 */
export function revenueTreemapInputs(
  industries: RevenueAggregate[],
  floorShare = 0.004,
): TreemapInput<RevenueAggregate>[] {
  const total = industries.reduce((a, b) => a + (b.revenue > 0 ? b.revenue : 0), 0);
  return industries
    .filter((i) => i.name && i.revenue > 0)
    .map((i) => ({ key: i.name as string, value: Math.max(i.revenue, total * floorShare), datum: i }));
}

/** 名次 → 「前 13%」（1/96 → 前 1%；96/96 → 前 100%） */
export function topPercent(rank: number, of: number): string {
  if (!(of > 0) || !(rank >= 1)) return '';
  return `前 ${Math.max(1, Math.round((rank / of) * 100))}%`;
}

export type CompanySortKey = 'revenue' | 'yoy_pct' | 'mom_pct';

/** 成分公司排序：沒有值的一律排最後，不管升降冪 */
export function sortCompanies(rows: RevenueCompany[], key: CompanySortKey, desc = true): RevenueCompany[] {
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return desc ? vb - va : va - vb;
  });
}

/** 'YYYY-MM' → '8 月'（跨年時 '2025/9'） */
export function monthLabel(ym: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return ym || '';
  return withYear ? `${m[1]}/${Number(m[2])}` : `${Number(m[2])} 月`;
}
