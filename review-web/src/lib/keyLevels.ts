import type { OhlcvRow } from './api';

/**
 * 關鍵價位＋ATR（2026-09-27，仿 5888 戰情卡「關鍵價位」但規則全部公開）。
 *
 * 做法：把大家常看的價位（月線/季線/半年線/年線、近 20/60 日與一年高低點）當候選，
 * 依現價切成上方（壓力）與下方（支撐），由近到遠排；彼此相距不到 0.5 個 ATR 的
 * 併成一個區間（避免月線跟 20 日低點只差一點點卻列成兩條）。
 * 上方取最近兩區（壓力一/二），下方取最近三區（短撐/中撐/守門），守門再往下＝危險區。
 * 全部用還原日 K，與個股頁 K 線圖、價格警示腳本（ohlcv?adjust=true）同一口徑。
 */

export interface LevelZone {
  kind: 'resistance' | 'support';
  /** 壓力一/壓力二/短撐/中撐/守門 */
  label: string;
  /** 圖上價格軸的短標 */
  short: string;
  low: number;
  high: number;
  /** 依據，例：['月線', '近20日低點'] */
  bases: string[];
  /** 離現價最近那一邊的距離 %（壓力為正、支撐為負） */
  distancePct: number;
  /** 相當於幾個 ATR（沒有 ATR 時為 null） */
  atrMultiple: number | null;
  /** 設警示用的價位：壓力取上緣（整區突破）、支撐取下緣（整區跌破） */
  alertPrice: number;
  /** 上方已無任何前高，改用 1 個 ATR 推估 */
  estimated?: boolean;
}

export interface KeyLevels {
  date: string;
  close: number;
  atr: number | null;
  atrPct: number | null;
  /** 由上到下：壓力二、壓力一、短撐、中撐、守門 */
  zones: LevelZone[];
  /** 收盤跌破這個價位＝危險區（最後一道支撐的下緣） */
  danger: number | null;
  /** 現價正壓在上面的價位（±0.2% 內），例：['月線'] */
  onPrice: string[];
}

/** 圖上畫線與關鍵價位卡共用同一組顏色：壓力＝橘、支撐＝青（守門另外加粗） */
export const LEVEL_COLORS = { resistance: '#fb923c', support: '#2dd4bf' } as const;

const ATR_PERIOD = 14;
/** 現價正在測試的判定範圍：±0.2% */
const ON_PRICE_TOL = 0.002;
/** 相距不到 0.5 個 ATR 的價位併成一區 */
const MERGE_ATR = 0.5;

function isValidRow(r: OhlcvRow): boolean {
  return [r.open, r.high, r.low, r.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/** 依價位大小決定顯示位數，警示也用同一個數字，信裡看到的才會跟畫面一致 */
export function roundLevel(p: number): number {
  if (p >= 1000) return Math.round(p);
  if (p >= 100) return Math.round(p * 10) / 10;
  return Math.round(p * 100) / 100;
}

export function fmtLevel(p: number): string {
  const digits = p >= 1000 ? 0 : p >= 100 ? 1 : 2;
  return roundLevel(p).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * ATR（平均真實區間，Wilder 平滑）：每天的真實區間＝max(高−低, |高−昨收|, |低−昨收|)，
 * 前 period 天取平均當起點，之後每天 ATR = (前值×(n−1) + 今日真實區間) / n。
 * rows 需為日期遞增；資料不足 period+1 根時回 null。
 */
export function calculateATR(rows: OhlcvRow[], period = ATR_PERIOD): number | null {
  if (rows.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const { high, low } = rows[i];
    const prevClose = rows[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

interface Candidate {
  price: number;
  basis: string;
}

interface RawZone {
  low: number;
  high: number;
  bases: string[];
}

function collectCandidates(rows: OhlcvRow[]): Candidate[] {
  const out: Candidate[] = [];
  const closes = rows.map((r) => r.close);
  const n = rows.length;

  const maList: [number, string][] = [[20, '月線'], [60, '季線'], [120, '半年線'], [240, '年線']];
  for (const [period, name] of maList) {
    if (n < period) continue;
    const slice = closes.slice(n - period);
    out.push({ price: slice.reduce((a, b) => a + b, 0) / period, basis: name });
  }

  // 高低點只看「今天以前」的 K 棒：否則創新高當天，今天自己的最高價會變成貼著現價的假壓力；
  // 排除今天之後，突破的前高會自然落到下方變支撐。
  // 由短到長掃；跟上一個期間同一根 K 棒（價位相同）時，只留期間較長的名稱
  const hiLoList: [number, string][] = [[20, '近20日'], [60, '近60日'], [240, '近一年']];
  let prevHigh: Candidate | null = null;
  let prevLow: Candidate | null = null;
  for (const [period, name] of hiLoList) {
    if (n < period + 1) continue;
    const slice = rows.slice(n - 1 - period, n - 1);
    const hi = Math.max(...slice.map((r) => r.high));
    const lo = Math.min(...slice.map((r) => r.low));
    if (prevHigh && prevHigh.price === hi) {
      prevHigh.basis = `${name}高點`;
    } else {
      prevHigh = { price: hi, basis: `${name}高點` };
      out.push(prevHigh);
    }
    if (prevLow && prevLow.price === lo) {
      prevLow.basis = `${name}低點`;
    } else {
      prevLow = { price: lo, basis: `${name}低點` };
      out.push(prevLow);
    }
  }
  return out;
}

/** list 需已由近到遠排序；區間寬度以「最靠近現價那一邊」起算不超過 gap，避免一路串成超寬區 */
function mergeZones(list: Candidate[], direction: 'up' | 'down', gap: number): RawZone[] {
  const zones: RawZone[] = [];
  for (const c of list) {
    const z = zones[zones.length - 1];
    const nearEdge = z ? (direction === 'up' ? z.low : z.high) : 0;
    if (z && Math.abs(c.price - nearEdge) <= gap) {
      z.low = Math.min(z.low, c.price);
      z.high = Math.max(z.high, c.price);
      if (!z.bases.includes(c.basis)) z.bases.push(c.basis);
    } else {
      zones.push({ low: c.price, high: c.price, bases: [c.basis] });
    }
  }
  return zones;
}

export function buildKeyLevels(input: OhlcvRow[] | null | undefined): KeyLevels | null {
  if (!input || input.length === 0) return null;
  const rows = input.filter(isValidRow).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 20) return null;

  const last = rows[rows.length - 1];
  const close = last.close;
  const atr = calculateATR(rows);
  const tol = close * ON_PRICE_TOL;
  const gap = atr !== null ? atr * MERGE_ATR : close * 0.01;

  const candidates = collectCandidates(rows);
  const onPrice = candidates.filter((c) => Math.abs(c.price - close) <= tol).map((c) => c.basis);
  const above = candidates.filter((c) => c.price > close + tol).sort((a, b) => a.price - b.price);
  const below = candidates.filter((c) => c.price < close - tol).sort((a, b) => b.price - a.price);

  const toZone = (z: RawZone, kind: LevelZone['kind'], label: string, short: string, estimated = false): LevelZone => {
    const nearEdge = kind === 'resistance' ? z.low : z.high;
    return {
      kind,
      label,
      short,
      low: z.low,
      high: z.high,
      bases: z.bases,
      distancePct: ((nearEdge - close) / close) * 100,
      atrMultiple: atr !== null && atr > 0 ? Math.abs(nearEdge - close) / atr : null,
      alertPrice: roundLevel(kind === 'resistance' ? z.high : z.low),
      ...(estimated ? { estimated: true } : {}),
    };
  };

  const resistances: LevelZone[] = [];
  const upZones = mergeZones(above, 'up', gap).slice(0, 2);
  const resLabels: [string, string][] = [['壓力一', '壓一'], ['壓力二', '壓二']];
  upZones.forEach((z, i) => resistances.push(toZone(z, 'resistance', resLabels[i][0], resLabels[i][1])));
  if (resistances.length === 0 && atr !== null) {
    const p = close + atr;
    resistances.push(toZone({ low: p, high: p, bases: ['上方已無前高，以 1 個 ATR 推估'] }, 'resistance', '壓力一', '壓一', true));
  }

  const supports: LevelZone[] = [];
  const downZones = mergeZones(below, 'down', gap).slice(0, 3);
  const supLabels: [string, string][] = [['短撐', '短撐'], ['中撐', '中撐'], ['守門', '守門']];
  downZones.forEach((z, i) => supports.push(toZone(z, 'support', supLabels[i][0], supLabels[i][1])));

  return {
    date: last.date.slice(0, 10),
    close,
    atr,
    atrPct: atr !== null ? (atr / close) * 100 : null,
    zones: [...resistances.reverse(), ...supports],
    danger: supports.length > 0 ? supports[supports.length - 1].low : null,
    onPrice,
  };
}
