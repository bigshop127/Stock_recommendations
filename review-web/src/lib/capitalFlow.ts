/**
 * capitalFlow.ts — 資金潮汐（法人資金流向泡泡圖）的純計算（opt54，2026-11-10）。
 *
 * 後端 /api/market/inst-flow 給的是「每檔上市普通股、每天、外資／投信／自營商買賣超金額」，
 * 這裡依自建族群表（stockGroups.ts）加總成一顆顆泡泡，再算出每個播放日的座標：
 *
 *   橫軸 x＝近 5 日法人買賣超（億）
 *   縱軸 y＝加速流入（億/天）＝（近 5 日合計 − 前 5 日合計）÷ 5，也就是近 5 天比前 5 天平均每天多買多少
 *
 *   右上 持續加碼｜左上 賣壓收斂｜左下 持續減碼｜右下 買氣降溫
 *
 * 金額是後端用「買賣超股數 × 當日成交均價」估的，單位在這裡一律換成「億」。
 */
import type { InstFlowPayload, InstitutionalTrades } from './api';
import { CODE_TO_GROUP, STOCK_GROUPS } from './stockGroups';

export type Inst = 'all' | 'foreign' | 'trust' | 'dealer';
export type Level = 'group' | 'category';

export const INSTS: readonly Inst[] = ['all', 'foreign', 'trust', 'dealer'];
export const INST_LABEL: Record<Inst, string> = { all: '全體法人', foreign: '外資', trust: '投信', dealer: '自營商' };
/** 句子裡用的短稱（「法人近 5 日買超」「外資近 5 日買超」） */
export const INST_SHORT: Record<Inst, string> = { all: '法人', foreign: '外資', trust: '投信', dealer: '自營商' };
export const LEVEL_LABEL: Record<Level, string> = { group: '細分族群', category: '大類' };

/** 近幾日累計（橫軸）、長天期累計（明細面板）、最多播放幾個交易日 */
export const WINDOW = 5;
export const LONG_WINDOW = 20;
export const MAX_FRAMES = 10;
/** 後端要抓幾天：最早那個播放日也要能往前算滿 20 日累計 */
export const FETCH_DAYS = MAX_FRAMES + LONG_WINDOW;

const MILLION_PER_YI = 100;

// ── 泡泡單位（族群／大類）───────────────────────────────────────────────

export interface FlowUnit {
  /** 族群名或大類名（各自不重複） */
  name: string;
  /** 所屬大類；大類層級時等於 name */
  category: string;
  /** 成分股在 payload.codes 的位置 */
  members: number[];
}

/** 依族群表把代號分進泡泡；表裡沒有的代號（三檔刻意不分類的、新上市還沒收錄的）不計入 */
export function buildUnits(codes: readonly string[], level: Level): FlowUnit[] {
  const order: string[] = [];
  const categoryOf = new Map<string, string>();
  for (const [category, groups] of Object.entries(STOCK_GROUPS)) {
    if (level === 'category') {
      order.push(category);
      categoryOf.set(category, category);
    } else {
      for (const group of Object.keys(groups)) {
        order.push(group);
        categoryOf.set(group, category);
      }
    }
  }
  const members = new Map<string, number[]>(order.map((n) => [n, []]));
  codes.forEach((code, i) => {
    const ref = CODE_TO_GROUP.get(code);
    if (!ref) return;
    members.get(level === 'category' ? ref.category : ref.group)?.push(i);
  });
  return order
    .map((name) => ({ name, category: categoryOf.get(name) ?? name, members: members.get(name) ?? [] }))
    .filter((u) => u.members.length > 0);
}

// ── 每天每顆泡泡的買賣超與成交金額 ─────────────────────────────────────────

export interface FlowCube {
  dates: string[];
  units: FlowUnit[];
  /** net[day][unit]＝當日買賣超（億） */
  net: number[][];
  /** turnover[day][unit]＝當日成交金額（億） */
  turnover: number[][];
}

/** 單檔單日某一類法人的買賣超（百萬元） */
function stockNetMillion(day: InstFlowPayload['days'][number], inst: Inst, i: number): number {
  switch (inst) {
    case 'foreign': return day.f[i] ?? 0;
    case 'trust': return day.t[i] ?? 0;
    case 'dealer': return day.d[i] ?? 0;
    default: return (day.f[i] ?? 0) + (day.t[i] ?? 0) + (day.d[i] ?? 0);
  }
}

export function buildCube(payload: InstFlowPayload, units: FlowUnit[], inst: Inst): FlowCube {
  const net: number[][] = [];
  const turnover: number[][] = [];
  for (const day of payload.days) {
    const n: number[] = [];
    const tv: number[] = [];
    for (const u of units) {
      let sn = 0;
      let st = 0;
      for (const i of u.members) {
        sn += stockNetMillion(day, inst, i);
        st += day.val[i] ?? 0;
      }
      n.push(sn / MILLION_PER_YI);
      tv.push(st / MILLION_PER_YI);
    }
    net.push(n);
    turnover.push(tv);
  }
  return { dates: payload.dates, units, net, turnover };
}

// ── 播放日（frame）──────────────────────────────────────────────────────

export interface FlowFrame {
  date: string;
  /** 這一天在 cube.dates 的位置 */
  dayIndex: number;
  /** 近 5 日買賣超（億） */
  x: number[];
  /** 加速流入（億/天） */
  y: number[];
  /** 當日買賣超（億） */
  today: number[];
  /** 近 20 日買賣超（億）；資料還沒補滿 20 天時是 null */
  long: (number | null)[];
  /** 近 5 日成交金額（億），決定泡泡大小 */
  size: number[];
}

/** 一段日期（含頭尾）的合計；用前綴和，prefix[d]＝第 0 到 d−1 天的合計 */
function rangeSum(prefix: number[][], from: number, to: number, u: number): number {
  return prefix[to + 1][u] - prefix[from][u];
}
function prefixSums(rows: number[][], width: number): number[][] {
  const out: number[][] = [new Array<number>(width).fill(0)];
  for (const row of rows) {
    const prev = out[out.length - 1];
    out.push(row.map((v, u) => prev[u] + v));
  }
  return out;
}

/**
 * 最後 maxFrames 個「算得出座標」的交易日。一個播放日要有前面 9 天（近 5 ＋ 前 5），
 * 所以資料少於 10 天時回空陣列。
 */
export function buildFrames(cube: FlowCube, maxFrames: number = MAX_FRAMES): FlowFrame[] {
  const D = cube.dates.length;
  const U = cube.units.length;
  const need = WINDOW * 2;
  if (D < need || U === 0) return [];
  const netPrefix = prefixSums(cube.net, U);
  const tvPrefix = prefixSums(cube.turnover, U);
  const first = Math.max(need - 1, D - maxFrames);
  const frames: FlowFrame[] = [];
  for (let i = first; i < D; i++) {
    const x: number[] = [];
    const y: number[] = [];
    const long: (number | null)[] = [];
    const size: number[] = [];
    for (let u = 0; u < U; u++) {
      const recent = rangeSum(netPrefix, i - WINDOW + 1, i, u);
      const before = rangeSum(netPrefix, i - need + 1, i - WINDOW, u);
      x.push(recent);
      y.push((recent - before) / WINDOW);
      long.push(i >= LONG_WINDOW - 1 ? rangeSum(netPrefix, i - LONG_WINDOW + 1, i, u) : null);
      size.push(rangeSum(tvPrefix, i - WINDOW + 1, i, u));
    }
    frames.push({ date: cube.dates[i], dayIndex: i, x, y, today: cube.net[i].slice(), long, size });
  }
  return frames;
}

// ── 象限 ───────────────────────────────────────────────────────────────

export type Quadrant = 'accumulate' | 'converge' | 'reduce' | 'cooling';
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  accumulate: '持續加碼',
  converge: '賣壓收斂',
  reduce: '持續減碼',
  cooling: '買氣降溫',
};

export function quadrantOf(x: number, y: number): Quadrant {
  if (x >= 0) return y >= 0 ? 'accumulate' : 'cooling';
  return y >= 0 ? 'converge' : 'reduce';
}

/** 明細面板那條標籤：「持續加碼・近 5 日買超・還在加快」 */
export function quadrantTag(x: number, y: number): string {
  switch (quadrantOf(x, y)) {
    case 'accumulate': return `持續加碼・近 ${WINDOW} 日買超・還在加快`;
    case 'cooling': return `買氣降溫・近 ${WINDOW} 日買超・力道轉弱`;
    case 'converge': return `賣壓收斂・近 ${WINDOW} 日賣超・賣壓減輕`;
    default: return `持續減碼・近 ${WINDOW} 日賣超・還在加重`;
  }
}

export function quadrantCounts(frame: FlowFrame): Record<Quadrant, number> {
  const out: Record<Quadrant, number> = { accumulate: 0, converge: 0, reduce: 0, cooling: 0 };
  for (let u = 0; u < frame.x.length; u++) out[quadrantOf(frame.x[u], frame.y[u])] += 1;
  return out;
}

// ── 座標刻度（中間放大的對稱對數）──────────────────────────────────────────
//
// 少數幾個族群的金額是其他的幾十倍（台積電所在的晶圓代工動輒幾百億），線性刻度會把其餘的全擠在原點。
// 所以用 symlog：|v| 小於 c 的地方接近線性、大於 c 的地方是對數，正負對稱。

export interface SymScale {
  /** 值 → −1～1（超出範圍夾住） */
  (v: number): number;
  max: number;
  c: number;
}

export function symScale(max: number, c: number): SymScale {
  const m = Math.max(max, 1e-9);
  const k = Math.max(c, 1e-9);
  const denom = Math.log1p(m / k);
  const fn = ((v: number) => {
    const a = Math.min(Math.abs(v), m);
    return (Math.sign(v) * Math.log1p(a / k)) / denom;
  }) as SymScale;
  fn.max = m;
  fn.c = k;
  return fn;
}

/**
 * 線性區的寬度 c：取所有值絕對值的第 25 百分位，也就是「金額最小的那四分之一當成幾乎沒動」。
 * 2026-11 的真實資料：141 個族群的近 5 日買賣超從 0.2 億到 1,150 億、大致是對數均勻分布，
 * 用中位數當 c 還是有六成泡泡擠在中央一成的範圍裡；改用 P25 後中央一成剩三成、一半的泡泡在內圈四分之一以外。
 * 再夾在 max/20000～max/8 之間（太小會把雜訊放大到滿版，太大就等於沒放大）。
 */
export function pickLinThreshold(values: readonly number[], max: number): number {
  const abs = values.map((v) => Math.abs(v)).filter((v) => v > 0).sort((a, b) => a - b);
  const p25 = abs.length ? abs[Math.floor(abs.length / 4)] : max / 8;
  return Math.min(max / 8, Math.max(max / 20000, p25));
}

/**
 * 泡泡半徑的比例（0～1）：成交金額開立方根。台積電所在的族群成交金額是中位數族群的兩百倍，
 * 用面積正比（開平方）的話其他泡泡全變成最小的點。
 */
export function sizeRatio(size: number, maxSize: number): number {
  if (!(size > 0) || !(maxSize > 0)) return 0;
  return Math.min(1, Math.cbrt(size / maxSize));
}

/**
 * 正值這一側的刻度（不含 0），從 1-2-5 序列裡挑；minGap 是相鄰刻度在 −1～1 座標上的最小間距，
 * 太密的跳過。負值那側畫面上直接鏡射。
 */
export function symTicks(scale: SymScale, minGap: number): number[] {
  const out: number[] = [];
  let last = 0;
  for (let exp = -2; exp <= 6; exp++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** exp;
      if (v > scale.max) return out;
      const pos = scale(v);
      if (pos - last >= minGap) {
        out.push(Number(v.toPrecision(1)));
        last = pos;
      }
    }
  }
  return out;
}

export interface AxisDomain {
  xMax: number;
  yMax: number;
  xC: number;
  yC: number;
}

/** 整段播放共用同一組座標範圍，泡泡移動才看得出是它在動、不是座標在縮放 */
export function axisDomain(frames: readonly FlowFrame[]): AxisDomain {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of frames) {
    xs.push(...f.x);
    ys.push(...f.y);
  }
  const maxAbs = (a: number[]) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  // 留 12% 邊，最大的泡泡不會貼在框上；全 0（剛開始回補）時給 1 億免得除以 0
  const xMax = Math.max(1, maxAbs(xs) * 1.12);
  const yMax = Math.max(1, maxAbs(ys) * 1.12);
  return { xMax, yMax, xC: pickLinThreshold(xs, xMax), yC: pickLinThreshold(ys, yMax) };
}

// ── 摘要與排行 ───────────────────────────────────────────────────────────

export interface UnitValue {
  unit: number;
  name: string;
  value: number;
}

/** 依 values 排序取前 n（desc=true 由大到小）；只留符合 keep 條件的 */
export function topUnits(
  units: readonly FlowUnit[],
  values: readonly number[],
  n: number,
  desc: boolean,
  keep: (v: number, u: number) => boolean = () => true,
): UnitValue[] {
  return values
    .map((value, unit) => ({ unit, name: units[unit].name, value }))
    .filter((r) => keep(r.value, r.unit))
    .sort((a, b) => (desc ? b.value - a.value : a.value - b.value))
    .slice(0, n);
}

/** 「資金重心從 A 流向 B」：近 5 日賣最多的與買最多的。沒有賣超或沒有買超的那一側是 null */
export function flowHeadline(units: readonly FlowUnit[], frame: FlowFrame): { from: UnitValue | null; to: UnitValue | null } {
  const to = topUnits(units, frame.x, 1, true, (v) => v > 0)[0] ?? null;
  const from = topUnits(units, frame.x, 1, false, (v) => v < 0)[0] ?? null;
  return { from, to };
}

export interface KeyFlows {
  inflow: UnitValue[];
  outflow: UnitValue[];
  /** 加速最快（y 最大）／降溫最快（y 最小） */
  speedUp: UnitValue[];
  slowDown: UnitValue[];
  /** 前 5 日賣超、近 5 日轉買超（依近 5 日金額排）／反過來 */
  turnedBuy: UnitValue[];
  turnedSell: UnitValue[];
}

export function keyFlows(units: readonly FlowUnit[], frame: FlowFrame, n = 3): KeyFlows {
  // 前 5 日合計＝近 5 日合計 − 5 × 加速度
  const before = (u: number) => frame.x[u] - WINDOW * frame.y[u];
  return {
    inflow: topUnits(units, frame.x, n, true, (v) => v > 0),
    outflow: topUnits(units, frame.x, n, false, (v) => v < 0),
    speedUp: topUnits(units, frame.y, n, true, (v) => v > 0),
    slowDown: topUnits(units, frame.y, n, false, (v) => v < 0),
    turnedBuy: topUnits(units, frame.x, n, true, (v, u) => v > 0 && before(u) < 0),
    turnedSell: topUnits(units, frame.x, n, false, (v, u) => v < 0 && before(u) > 0),
  };
}

export interface DuoRow {
  unit: number;
  name: string;
  foreign: number;
  trust: number;
}
export interface ForeignVsTrust {
  bothBuy: DuoRow[];
  bothSell: DuoRow[];
  foreignBuyTrustSell: DuoRow[];
  trustBuyForeignSell: DuoRow[];
}

/**
 * 土洋操作：外資與投信近 5 日在同一個族群是同買、同賣還是對作。
 * 任一方不到 minYi 億的不列（幾千萬的進出談不上表態）。
 */
export function foreignVsTrust(
  units: readonly FlowUnit[],
  foreignX: readonly number[],
  trustX: readonly number[],
  n = 3,
  minYi = 0.5,
): ForeignVsTrust {
  const rows: DuoRow[] = units
    .map((u, unit) => ({ unit, name: u.name, foreign: foreignX[unit], trust: trustX[unit] }))
    .filter((r) => Math.abs(r.foreign) >= minYi && Math.abs(r.trust) >= minYi);
  const pick = (keep: (r: DuoRow) => boolean, score: (r: DuoRow) => number) =>
    rows.filter(keep).sort((a, b) => score(b) - score(a)).slice(0, n);
  return {
    bothBuy: pick((r) => r.foreign > 0 && r.trust > 0, (r) => r.foreign + r.trust),
    bothSell: pick((r) => r.foreign < 0 && r.trust < 0, (r) => -(r.foreign + r.trust)),
    foreignBuyTrustSell: pick((r) => r.foreign > 0 && r.trust < 0, (r) => r.foreign - r.trust),
    trustBuyForeignSell: pick((r) => r.foreign < 0 && r.trust > 0, (r) => r.trust - r.foreign),
  };
}

// ── 成分股 ───────────────────────────────────────────────────────────────

/** 到 idx 這天為止連續幾天同方向：+3＝連買 3 天、−2＝連賣 2 天、0＝這天沒進出 */
export function streakAt(series: readonly number[], idx: number): number {
  const sign = Math.sign(series[idx] ?? 0);
  if (sign === 0) return 0;
  let n = 0;
  for (let i = idx; i >= 0 && Math.sign(series[i]) === sign; i--) n += 1;
  return sign * n;
}

export interface MemberRow {
  code: string;
  name: string;
  close: number | null;
  /** 漲跌幅 % */
  chg: number | null;
  /** 當日買賣超（億） */
  today: number;
  /** 近 5 日買賣超（億） */
  sum5: number;
  /** 連買（正）／連賣（負）天數 */
  streak: number;
}

/** 某顆泡泡在某一天的成分股清單，依近 5 日買賣超由多到少 */
export function memberRows(payload: InstFlowPayload, unit: FlowUnit, inst: Inst, dayIndex: number): MemberRow[] {
  const day = payload.days[dayIndex];
  if (!day) return [];
  const from = Math.max(0, dayIndex - WINDOW + 1);
  return unit.members
    .map((i) => {
      const series: number[] = [];
      for (let d = 0; d <= dayIndex; d++) series.push(stockNetMillion(payload.days[d], inst, i));
      let sum5 = 0;
      for (let d = from; d <= dayIndex; d++) sum5 += series[d];
      return {
        code: payload.codes[i],
        name: payload.names[i] || payload.codes[i],
        close: day.close ? day.close[i] ?? null : null,
        chg: day.chg ? day.chg[i] ?? null : null,
        today: series[dayIndex] / MILLION_PER_YI,
        sum5: sum5 / MILLION_PER_YI,
        streak: streakAt(series, dayIndex),
      };
    })
    .sort((a, b) => b.sum5 - a.sum5);
}

/** 每顆泡泡當天的平均漲跌幅（成分股簡單平均，跟族群熱力圖同口徑）；那天沒帶行情或全部沒比價回 null */
export function unitAvgChange(payload: InstFlowPayload, units: readonly FlowUnit[], dayIndex: number): (number | null)[] {
  const chg = payload.days[dayIndex]?.chg;
  return units.map((u) => {
    if (!chg) return null;
    let sum = 0;
    let n = 0;
    for (const i of u.members) {
      const v = chg[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    return n ? sum / n : null;
  });
}

export function upDownCounts(avgChange: readonly (number | null)[]): { up: number; down: number; total: number } {
  let up = 0;
  let down = 0;
  for (const v of avgChange) {
    if (v === null) continue;
    if (v > 0) up += 1;
    else if (v < 0) down += 1;
  }
  return { up, down, total: avgChange.length };
}

// ── 盤後結論（三大法人官方金額）──────────────────────────────────────────

export type InstKey = 'foreign' | 'investment_trust' | 'dealer';
export interface InstStreak {
  dir: 'buy' | 'sell' | 'flat';
  days: number;
  /** 連續天數已經頂到手上資料的長度（實際可能更長） */
  capped: boolean;
}

/** trend 舊到新；回最後一天往前連續同方向的天數 */
export function instStreak(trend: readonly InstitutionalTrades[], key: InstKey): InstStreak {
  if (!trend.length) return { dir: 'flat', days: 0, capped: false };
  const series = trend.map((r) => r[key]);
  const s = streakAt(series, series.length - 1);
  if (s === 0) return { dir: 'flat', days: 0, capped: false };
  return { dir: s > 0 ? 'buy' : 'sell', days: Math.abs(s), capped: Math.abs(s) === series.length };
}

function streakPhrase(label: string, s: InstStreak): string | null {
  if (s.dir === 'flat') return null;
  const word = s.dir === 'buy' ? '買超' : '賣超';
  if (s.days === 1) return `${label}轉為${word}`;
  return `${label}連 ${s.days}${s.capped ? ' 日以上' : ' 日'}${word}`;
}

/** 「外資連 5 日買超、投信連 2 日賣超，類股跌多漲少。」 */
export function conclusionText(
  streaks: { foreign: InstStreak; trust: InstStreak } | null,
  counts: { up: number; down: number } | null,
): string {
  const parts: string[] = [];
  if (streaks) {
    const a = streakPhrase('外資', streaks.foreign);
    const b = streakPhrase('投信', streaks.trust);
    const joined = [a, b].filter(Boolean).join('、');
    if (joined) parts.push(joined);
  }
  if (counts && counts.up + counts.down > 0) {
    // 差距不到兩成算互見，免得 71 比 70 也寫成「漲多跌少」
    const hi = Math.max(counts.up, counts.down);
    const lo = Math.min(counts.up, counts.down);
    parts.push(hi < lo * 1.2 ? '類股漲跌互見' : counts.up > counts.down ? '類股漲多跌少' : '類股跌多漲少');
  }
  return parts.length ? `${parts.join('，')}。` : '';
}

// ── 顯示用 ───────────────────────────────────────────────────────────────

/** 帶正負號的「億」：10 億以上一位小數，以下兩位（小族群、單一個股常只有零點幾億） */
export function fmtYi(v: number | null | undefined, opts?: { sign?: boolean }): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 10 ? 1 : 2;
  const rounded = Number(v.toFixed(digits));
  const body = Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (rounded === 0) return body;
  if (rounded < 0) return `-${body}`;
  return opts?.sign === false ? body : `+${body}`;
}

/** '2026-11-10' → '11/10' */
export function fmtMd(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** '2026-11-10' → '二' */
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? '';
}
