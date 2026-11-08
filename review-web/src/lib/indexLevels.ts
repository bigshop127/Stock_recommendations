// 大盤頁「期現貨與國際指數」九個方塊的線圖＋距高低點（opt53，2026-11-08）。
//
// 使用者定案：三種點位都列——
//   ① 一年高／一年低：近一年日收盤的最高、最低，算「現在離它多少 %」
//   ② 波段：收盤反向超過 5% 才算換波段（zigzag）；現在在下跌段就說「自某日高點回檔 −x%」，
//      在上漲段就說「自某日低點上漲 +x%」
//   ③ 歷史高：gateway 給的歷史最高收盤（Yahoo 全部日線；櫃買／台指期用存下來的兩年多資料，見 routes/index_charts.js）
// 「現在」一律用方塊上顯示的即時價，所以 % 跟方塊上的價格對得起來。

export type ChartRange = '1d' | '3m' | '1y';
export const CHART_RANGES: { id: ChartRange; label: string }[] = [
  { id: '1d', label: '1日' },
  { id: '3m', label: '3月' },
  { id: '1y', label: '1年' },
];

/** 收盤反向超過這個比例才算換波段 */
export const SWING_THRESHOLD = 0.05;

/** d＝交易日；null＝接在最後面的即時價（還沒有日收盤的那一筆） */
export interface Pt {
  d: string | null;
  c: number;
}

export interface LevelRef {
  value: number;
  date: string | null;
  /** (現在 ÷ 這個點 − 1) × 100 */
  pct: number;
}

export interface Swing {
  dir: 'up' | 'down';
  /** 這一段的起點：上漲段是低點、下跌段是高點 */
  pivot: LevelRef;
}

export interface IndexLevels {
  last: number;
  /** 最後一個有日期的交易日（算「近一年」與日期格式用） */
  lastDate: string;
  high1y: LevelRef;
  low1y: LevelRef;
  ath: LevelRef | null;
  /** 歷史最高就是一年內那個高點（畫面上就不用再寫一次日期） */
  athIsHigh1y: boolean;
  swing: Swing | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD 往前／後推 n 個月；月底會夾到該月最後一天（5/31 − 3 月 → 2/28） */
export function shiftMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(Math.min(d, dim))}`;
}

/**
 * 日收盤接上即時價。
 * - 最後一根是今天盤中的半根（partialLast）→ 換成即時價
 * - 否則即時價跟最後收盤不一樣（例：櫃買中心今天的收盤還沒公布）→ 接在後面當「最新」
 */
export function withLive(d: string[], c: number[], live: number | null, partialLast: boolean): Pt[] {
  const pts: Pt[] = [];
  d.forEach((x, i) => {
    const v = c[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) pts.push({ d: x, c: v });
  });
  if (live === null || !Number.isFinite(live) || live <= 0 || !pts.length) return pts;
  const lastPt = pts[pts.length - 1];
  if (partialLast) {
    pts[pts.length - 1] = { d: lastPt.d, c: live };
  } else if (Math.abs(live / lastPt.c - 1) > 1e-6) {
    pts.push({ d: null, c: live });
  }
  return pts;
}

const lastDated = (pts: Pt[]): string | null => {
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i].d) return pts[i].d;
  return null;
};

/** 畫 3 月／1 年線圖用：只留那段期間（即時價那筆一定留） */
export function sliceRange(pts: Pt[], range: '3m' | '1y'): Pt[] {
  const ld = lastDated(pts);
  if (!ld) return pts;
  const cut = shiftMonths(ld, range === '3m' ? -3 : -12);
  return pts.filter((p) => p.d === null || p.d >= cut);
}

/**
 * zigzag 找「現在這一段」：從頭走一遍，收盤從目前這段的極值反向超過 threshold 就換段。
 * 回傳這一段的方向與起點；整段資料都沒有超過 threshold 的波動就回 null。
 */
export function lastSwing(pts: Pt[], threshold = SWING_THRESHOLD): { dir: 'up' | 'down'; pivot: Pt } | null {
  if (pts.length < 2) return null;
  let trend: 0 | 1 | -1 = 0;
  let hi = pts[0];
  let lo = pts[0];
  let pivot = pts[0];
  let ext = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (trend === 0) {
      if (p.c > hi.c) hi = p;
      if (p.c < lo.c) lo = p;
      if (p === hi && hi.c >= lo.c * (1 + threshold)) {
        trend = 1;
        pivot = lo;
        ext = p;
      } else if (p === lo && lo.c <= hi.c * (1 - threshold)) {
        trend = -1;
        pivot = hi;
        ext = p;
      }
      continue;
    }
    if (trend === 1) {
      if (p.c >= ext.c) ext = p;
      else if (p.c <= ext.c * (1 - threshold)) {
        trend = -1;
        pivot = ext;
        ext = p;
      }
    } else {
      if (p.c <= ext.c) ext = p;
      else if (p.c >= ext.c * (1 + threshold)) {
        trend = 1;
        pivot = ext;
        ext = p;
      }
    }
  }
  if (trend === 0) return null;
  return { dir: trend === 1 ? 'up' : 'down', pivot };
}

const ref = (p: { c: number; d: string | null }, last: number): LevelRef => ({
  value: p.c,
  date: p.d,
  pct: (last / p.c - 1) * 100,
});

/** pts 要已經接好即時價（withLive）；ath 是 gateway 給的歷史最高收盤 */
export function computeIndexLevels(pts: Pt[], ath: { value: number; date: string } | null): IndexLevels | null {
  const lastDate = lastDated(pts);
  if (pts.length < 2 || !lastDate) return null;
  const last = pts[pts.length - 1].c;
  const cut = shiftMonths(lastDate, -12);
  const year = pts.filter((p) => p.d === null || p.d >= cut);
  let hi = year[0];
  let lo = year[0];
  for (const p of year) {
    if (p.c > hi.c) hi = p;
    if (p.c < lo.c) lo = p;
  }
  let athRef: LevelRef | null = null;
  let athIsHigh1y = false;
  if (ath && ath.value > 0) {
    if (hi.c >= ath.value) {
      athRef = ref(hi, last);
      athIsHigh1y = true;
    } else {
      athRef = ref({ c: ath.value, d: ath.date }, last);
    }
  }
  const sw = lastSwing(pts);
  return {
    last,
    lastDate,
    high1y: ref(hi, last),
    low1y: ref(lo, last),
    ath: athRef,
    athIsHigh1y,
    swing: sw ? { dir: sw.dir, pivot: ref(sw.pivot, last) } : null,
  };
}

/**
 * 跟最後交易日同一年寫 M/D，其他年份寫 YYYY/M/D（去年 11/21 只寫 11/21 會被看成今年還沒到的日子）；
 * null（即時價）寫「最新」
 */
export function fmtLevelDate(date: string | null, lastDate: string): string {
  if (!date) return '最新';
  const [y, m, d] = date.split('-').map(Number);
  if (date.slice(0, 4) === lastDate.slice(0, 4)) return `${m}/${d}`;
  return `${y}/${m}/${d}`;
}

export const fmtPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
