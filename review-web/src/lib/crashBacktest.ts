// opt11 崩盤策略回測實驗室 — 純函式核心（不碰 DOM、不發請求）
//
// 模型＝單一標的（00631L 正2, β≈2.0）＋現金，市場代理＝0050（用來偵測回撤/崩盤）。
// 投組 β = etf_weight × etf_beta。正常模式：β 漂出容忍區間就再平衡回目標。
// 崩盤模式（單一標的簡化版，見 §9 規格）：0050 自歷史高點回撤 ≥ crash_dd → 現金全數
// 加碼 00631L 拉到滿槓桿（weight=1、β≈2）；0050 再創新高 → 退出崩盤、再平衡回目標 β。
// 註：研究文的「第二階 −50% 再加碼」在單一標的下已無可加碼空間（最高 100%/2x），故本
// 模型只實作「一階崩盤加碼 ＋ 創新高退出」，此設計假設於規格與 UI 明列。
//
// 【增修J 2026-07-07】新增「分批加碼」模式（mode='ladder'）：0050 每自高點多跌
// ladder_step（如 −5%）就用「進入回撤時的現金」等分買一筆，跌到 ladder_full_at（如 −30%）
// 買滿；創新高退出邏輯與 oneshot 相同。回撤期間（regime 內）暫停容忍區間再平衡，
// 避免再平衡把剛加碼的部位賣回去。mode 預設 'oneshot'，舊參數/舊 localStorage 行為不變。
//
// 【增修K 2026-07-07】防守端擴充為真三資產（現金＋00687B＋00953B），比照 lib/rebalance.ts
// 的 allocateDefensive：加碼/分批抽錢時依 bond_priority 走優先變現瀑布（bond1_first／
// bond2_first）或維持等比例（proportional），回補（獲利了結/期初建倉）一律等比例。僅當
// bars 帶有 bond1/bond2（alignSeries4）才啟用；用 alignSeries（雙資產）呼叫則完全走舊邏輯，
// 逐位元不變。用來實測使用者提供之研究報告核心主張（跌時優先變現美債 00687B、保留
// 00953B 月配息）在真實歷史還原價下是否成立，而非採信報告本身的估計數字。

import type { OhlcvRow } from './api';
import { allocateDefensive, DEFAULT_CASH_RESERVE, DEFAULT_BOND_SPLIT } from './rebalance';

export interface AlignedBar {
  date: string;
  etf: number; // 00631L 還原收盤
  mkt: number; // 0050 還原收盤
  bond1?: number; // 00687B 還原收盤（優先變現）【增修K】
  bond2?: number; // 00953B 還原收盤（保留供息）【增修K】
}

export interface BacktestParams {
  initial_capital: number; // 期初資金 TWD（預設 1,000,000）
  target_beta: number; // 目標投組 β（預設 1.2）
  etf_beta: number; // 標的 β（00631L 預設 2.0）
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑（沿用 opt10）
  threshold_pct: number; // pct 模式 ±%
  threshold_abs: number; // abs 模式 ±β
  crash_dd: number; // 崩盤確認門檻 (tier3)：0050 自高點回撤幅度（預設 0.28 / tiered 預設 0.20）
  cost_bps: number; // 單邊交易成本（bps，套在成交金額；預設 0）
  mode: 'oneshot' | 'ladder' | 'tiered'; // 加碼模式：一次 all-in（預設）/ 分批加碼 / 三層崩盤【優化20】
  ladder_step: number; // ladder：每多跌多少買一筆（0.05 = −5%）
  ladder_full_at: number; // ladder：跌到多深買滿（0.30 = −30%；筆數 = full_at/step）
  tier2_dd: number; // tiered：小股災回撤門檻（預設 0.15）
  beta_mid: number; // tiered：小股災中繼目標 β（預設 1.75）
  // 【增修K】防守端三資產（現金＋00687B＋00953B）；bars 未帶 bond1/bond2 時完全不啟用，行為與舊版一致
  cash_reserve: number; // 固定保留現金（預設 100,000，同 lib/rebalance.ts）
  bond_split: number; // 債券池中 bond1 佔比（預設 0.6）
  bond_priority: 'bond1_first' | 'bond2_first' | 'proportional'; // 變現優先順序：對照報告 B/C/A 方案
}

export interface Metrics {
  final_value: number;
  total_return: number; // final/initial − 1
  cagr: number; // 年化
  max_drawdown: number; // 權益曲線最大回撤（正值，0.35 = −35%）
}

export interface CurvePoint {
  date: string;
  value: number;
}

export interface EquityCurve {
  key: string;
  name: string;
  points: CurvePoint[];
  metrics: Metrics;
}

export interface Trade {
  date: string;
  type: 'rebalance' | 'crash_enter' | 'crash_exit' | 'ladder_buy' | 'tier2_enter' | 'tier2_exit';
  from_beta: number;
  to_beta: number;
  traded_value: number; // + 買 / − 賣（00631L 金額）
  cost: number;
}

export interface CrashEvent {
  enter: string;
  exit: string | null;
  max_dd: number; // 該次崩盤期間 0050 最大回撤
  tier3_date?: string | null; // tiered：從 tier2 惡化為 tier3 的日期，oneshot/ladder 恆為 undefined
}

export interface BacktestResult {
  aligned_days: number;
  start_date: string | null;
  end_date: string | null;
  strategy: EquityCurve;
  beta_curve: CurvePoint[]; // 策略每日投組 β
  mkt_drawdown: CurvePoint[]; // 0050 每日回撤（正值）
  benchmarks: EquityCurve[];
  trades: Trade[];
  crash_events: CrashEvent[];
  note?: string;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function safeNum(v: unknown, fallback: number): number {
  if (isFiniteNum(v)) return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    if (Number.isFinite(p)) return p;
  }
  return fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 收盤序列轉 date→close 對照表，只收有限正數。alignSeries / alignSeries4 共用。 */
function toCloseMap(rows: OhlcvRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    const d = String(r?.date ?? '').slice(0, 10);
    const c = safeNum(r?.close, NaN);
    if (d && Number.isFinite(c) && c > 0) m.set(d, c);
  }
  return m;
}

/** 依日期 inner-join 兩條收盤序列，只保留兩邊都有、且價格為有限正數的交易日。 */
export function alignSeries(etfRows: OhlcvRow[], mktRows: OhlcvRow[]): AlignedBar[] {
  const mkt = toCloseMap(mktRows);
  const out: AlignedBar[] = [];
  for (const r of etfRows ?? []) {
    const d = String(r?.date ?? '').slice(0, 10);
    const e = safeNum(r?.close, NaN);
    const m = mkt.get(d);
    if (d && Number.isFinite(e) && e > 0 && m !== undefined) {
      out.push({ date: d, etf: e, mkt: m });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * 依日期 4 路 inner-join（00631L／0050／00687B／00953B），只保留四邊皆有效正數收盤的交易日【增修K】。
 * 用於崩盤實驗室的三資產（現金＋兩檔債券）防守端模擬；不影響既有 alignSeries（雙資產）呼叫端。
 */
export function alignSeries4(
  etfRows: OhlcvRow[],
  mktRows: OhlcvRow[],
  bond1Rows: OhlcvRow[],
  bond2Rows: OhlcvRow[],
): AlignedBar[] {
  const mkt = toCloseMap(mktRows);
  const b1 = toCloseMap(bond1Rows);
  const b2 = toCloseMap(bond2Rows);
  const out: AlignedBar[] = [];
  for (const r of etfRows ?? []) {
    const d = String(r?.date ?? '').slice(0, 10);
    const e = safeNum(r?.close, NaN);
    const m = mkt.get(d);
    const v1 = b1.get(d);
    const v2 = b2.get(d);
    if (d && Number.isFinite(e) && e > 0 && m !== undefined && v1 !== undefined && v2 !== undefined) {
      out.push({ date: d, etf: e, mkt: m, bond1: v1, bond2: v2 });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function maxDrawdown(points: CurvePoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of points) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) {
      const dd = (peak - p.value) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}

function yearsBetween(start: string, end: string): number {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (365.25 * 24 * 3600 * 1000);
}

function metricsOf(points: CurvePoint[], initial: number): Metrics {
  if (points.length === 0 || initial <= 0) {
    return { final_value: 0, total_return: 0, cagr: 0, max_drawdown: 0 };
  }
  const final_value = points[points.length - 1].value;
  const total_return = final_value / initial - 1;
  const yrs = yearsBetween(points[0].date, points[points.length - 1].date);
  const cagr = yrs > 0 && final_value > 0 ? Math.pow(final_value / initial, 1 / yrs) - 1 : 0;
  return { final_value, total_return, cagr, max_drawdown: maxDrawdown(points) };
}

/** 買進持有（全倉單一序列）基準。 */
function buyHold(bars: AlignedBar[], pick: (b: AlignedBar) => number, initial: number): CurvePoint[] {
  const p0 = pick(bars[0]);
  const units = p0 > 0 ? initial / p0 : 0;
  return bars.map((b) => ({ date: b.date, value: units * pick(b) }));
}

/**
 * 執行回測。回傳策略曲線＋三條基準（全倉0050、全倉00631L、初始配置不再平衡）＋
 * 每日投組 β、0050 回撤、交易紀錄與崩盤事件。
 */
export function runBacktest(bars: AlignedBar[], rawParams: Partial<BacktestParams>): BacktestResult {
  const params: BacktestParams = {
    initial_capital: Math.max(1, safeNum(rawParams?.initial_capital, 1_000_000)),
    target_beta: clamp(safeNum(rawParams?.target_beta, 1.2), 0, 3),
    etf_beta: Math.max(0.1, safeNum(rawParams?.etf_beta, 2.0)),
    tolerance_mode: rawParams?.tolerance_mode === 'pct' ? 'pct' : 'abs',
    threshold_pct: Math.max(0, safeNum(rawParams?.threshold_pct, 10)),
    threshold_abs: Math.max(0, safeNum(rawParams?.threshold_abs, 0.1)),
    crash_dd: clamp(safeNum(rawParams?.crash_dd, 0.28), 0.05, 0.95),
    cost_bps: Math.max(0, safeNum(rawParams?.cost_bps, 0)),
    mode: rawParams?.mode === 'tiered' ? 'tiered' : (rawParams?.mode === 'ladder' ? 'ladder' : 'oneshot'),
    ladder_step: clamp(safeNum(rawParams?.ladder_step, 0.05), 0.01, 0.5),
    ladder_full_at: 0, // 佔位，下一行以 step 為下限修正
    tier2_dd: clamp(safeNum(rawParams?.tier2_dd, 0.15), 0.01, 0.95),
    beta_mid: clamp(safeNum(rawParams?.beta_mid, 1.75), 0, Math.max(0.1, safeNum(rawParams?.etf_beta, 2.0))),
    cash_reserve: Math.max(0, safeNum(rawParams?.cash_reserve, DEFAULT_CASH_RESERVE)),
    bond_split: clamp(safeNum(rawParams?.bond_split, DEFAULT_BOND_SPLIT), 0, 1),
    bond_priority:
      rawParams?.bond_priority === 'bond2_first' || rawParams?.bond_priority === 'proportional'
        ? rawParams.bond_priority
        : 'bond1_first',
  };
  params.ladder_full_at = clamp(safeNum(rawParams?.ladder_full_at, 0.3), params.ladder_step, 0.95);

  const empty: BacktestResult = {
    aligned_days: bars?.length ?? 0,
    start_date: bars?.length ? bars[0].date : null,
    end_date: bars?.length ? bars[bars.length - 1].date : null,
    strategy: { key: 'strategy', name: '崩盤策略', points: [], metrics: metricsOf([], params.initial_capital) },
    beta_curve: [],
    mkt_drawdown: [],
    benchmarks: [],
    trades: [],
    crash_events: [],
    note: '資料不足，至少需要 2 個交易日',
  };
  if (!bars || bars.length < 2) return empty;

  const {
    initial_capital, target_beta, etf_beta, tolerance_mode, threshold_pct, threshold_abs,
    crash_dd, cost_bps, mode, ladder_step, ladder_full_at, tier2_dd, beta_mid, cash_reserve, bond_split, bond_priority,
  } = params;

  const targetWeight = clamp(target_beta / etf_beta, 0, 1);
  const upper =
    tolerance_mode === 'abs' ? target_beta + threshold_abs : target_beta * (1 + threshold_pct / 100);
  const lower = Math.max(
    tolerance_mode === 'abs' ? target_beta - threshold_abs : target_beta * (1 - threshold_pct / 100),
    0,
  );
  const costRate = cost_bps / 10_000;

  // 【增修K】防守端三資產模型：僅當 bars 帶有 bond1/bond2 收盤才啟用；否則行為與雙資產舊版逐位元一致
  const hasBonds = typeof bars[0]?.bond1 === 'number' && typeof bars[0]?.bond2 === 'number';

  // bond_priority='proportional' 兩方向都走等比例（報告方案A）；否則縮水時依優先順序 waterfall、
  // 擴張時仍等比例（見 lib/rebalance.ts allocateDefensive）。無論優先順序為何，bond_split 永遠代表
  // 「bond1（00687B）的目標佔比」這個固定物理意義——為此把陣列順序丟給 allocateDefensive 做 waterfall
  // 判斷時，同步把 split 值也對調，換回來時才不會把 bond_split 語意搞反。
  function allocateProportional(targetDefensiveValue: number): { cash: number; bond1: number; bond2: number } {
    const c = clamp(cash_reserve, 0, Math.max(0, targetDefensiveValue));
    const bondPool = Math.max(0, targetDefensiveValue - c);
    return { cash: c, bond1: bondPool * bond_split, bond2: bondPool * (1 - bond_split) };
  }
  function allocateDefensiveTarget(
    targetDefensiveValue: number,
    bond1Value: number,
    bond2Value: number,
  ): { cash: number; bond1: number; bond2: number } {
    if (bond_priority === 'proportional') return allocateProportional(targetDefensiveValue);
    const swapped = bond_priority === 'bond2_first';
    const order = swapped ? [bond2Value, bond1Value] : [bond1Value, bond2Value];
    const splitForOrder = swapped ? 1 - bond_split : bond_split;
    const alloc = allocateDefensive(targetDefensiveValue, order, cash_reserve, splitForOrder);
    return swapped
      ? { cash: alloc.cash, bond1: alloc.bond_values[1] ?? 0, bond2: alloc.bond_values[0] ?? 0 }
      : { cash: alloc.cash, bond1: alloc.bond_values[0] ?? 0, bond2: alloc.bond_values[1] ?? 0 };
  }

  // 期初：直接以目標權重建倉（此為起始部位，不計為一筆交易）。
  let etfUnits = (targetWeight * initial_capital) / bars[0].etf;
  let cash = (1 - targetWeight) * initial_capital;
  let bond1Units = 0;
  let bond2Units = 0;
  if (hasBonds) {
    const p1 = bars[0].bond1 ?? 0;
    const p2 = bars[0].bond2 ?? 0;
    const seed = allocateDefensiveTarget(cash, 0, 0);
    cash = seed.cash;
    bond1Units = p1 > 0 ? seed.bond1 / p1 : 0;
    bond2Units = p2 > 0 ? seed.bond2 / p2 : 0;
  }

  let peakMkt = bars[0].mkt;
  let inCrash = false;
  let inTier2 = false;
  let curCrash: CrashEvent | null = null;
  // ladder 模式狀態【增修J】：進入回撤 regime 時的防守端（現金＋債券）基準與已買階數【增修K 擴充為防守端】
  const nLevels = Math.max(1, Math.round(ladder_full_at / ladder_step));
  let regimeDefensive = 0;
  let deployedLevels = 0;

  const stratPoints: CurvePoint[] = [];
  const betaCurve: CurvePoint[] = [];
  const mktDd: CurvePoint[] = [];
  const trades: Trade[] = [];
  const crashEvents: CrashEvent[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 更新 0050 高點與回撤
    if (bar.mkt > peakMkt) peakMkt = bar.mkt;
    const dd = peakMkt > 0 ? (peakMkt - bar.mkt) / peakMkt : 0;
    mktDd.push({ date: bar.date, value: dd });

    // 收盤時的部位市值（防守端＝現金＋兩檔債券市值，無債券時債券項恆為 0）【增修K】
    const bond1Price = bar.bond1 ?? 0;
    const bond2Price = bar.bond2 ?? 0;
    const etfValue = etfUnits * bar.etf;
    const bond1Value = hasBonds ? bond1Units * bond1Price : 0;
    const bond2Value = hasBonds ? bond2Units * bond2Price : 0;
    const defensiveValue = cash + bond1Value + bond2Value;
    const total = etfValue + defensiveValue;
    const curBeta = total > 0 ? (etfValue / total) * etf_beta : 0;

    // 交易結算：依目標 ETF 市值反推防守端目標，無債券時逐位元等同舊版純量現金公式【增修K】
    const settleTrade = (desiredEtfValue: number, traded: number, cost: number) => {
      if (!hasBonds) {
        cash = cash - traded - cost;
        return;
      }
      const targetDefensive = total - desiredEtfValue - cost;
      const alloc = allocateDefensiveTarget(targetDefensive, bond1Value, bond2Value);
      cash = alloc.cash;
      bond1Units = bond1Price > 0 ? alloc.bond1 / bond1Price : 0;
      bond2Units = bond2Price > 0 ? alloc.bond2 / bond2Price : 0;
    };

    // ── 狀態機（i>0 才交易，i=0 為建倉基準日）──
    if (i > 0) {
      if (mode === 'tiered') {
        if (!inCrash && dd >= crash_dd) {
          // 進入/升級為 tier 3 股災來臨
          const desiredValue = 1.0 * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'crash_enter', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          
          inCrash = true;
          inTier2 = false;
          if (curCrash) {
            curCrash.tier3_date = bar.date;
            if (dd > curCrash.max_dd) curCrash.max_dd = dd;
          } else {
            curCrash = { enter: bar.date, exit: null, max_dd: dd, tier3_date: bar.date };
          }
        } else if (!inCrash && !inTier2 && dd >= tier2_dd) {
          // 進入 tier 2 小股災
          const desiredValue = (beta_mid / etf_beta) * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'tier2_enter', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          
          inTier2 = true;
          curCrash = { enter: bar.date, exit: null, max_dd: dd, tier3_date: null };
        } else if (inCrash && dd <= 1e-9) {
          // 0050 創新高 → 退出、再平衡回目標
          const desiredValue = targetWeight * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'crash_exit', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          
          inCrash = false;
          if (curCrash) {
            curCrash.exit = bar.date;
            crashEvents.push(curCrash);
            curCrash = null;
          }
        } else if (inTier2 && dd < tier2_dd) {
          // 回落退出小股災
          const desiredValue = targetWeight * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'tier2_exit', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          
          inTier2 = false;
          if (curCrash) {
            curCrash.exit = bar.date;
            crashEvents.push(curCrash);
            curCrash = null;
          }
        } else if (inCrash) {
          // 持續滿倉中，僅記錄期間最大回撤
          if (curCrash && dd > curCrash.max_dd) curCrash.max_dd = dd;
        } else if (inTier2) {
          // 持續小股災中，僅記錄期間最大回撤
          if (curCrash && dd > curCrash.max_dd) curCrash.max_dd = dd;
        } else if (curBeta > upper || curBeta < lower) {
          // 正常模式：漂出容忍區間
          const desiredValue = targetWeight * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'rebalance', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
        }
      } else {
        // 既有 oneshot / ladder 邏輯（完全不動）
        const level = Math.floor(dd / ladder_step + 1e-12);
        if (mode === 'ladder' && !inCrash && level >= 1) {
          inCrash = true;
          regimeDefensive = defensiveValue;
          deployedLevels = 0;
          curCrash = { enter: bar.date, exit: null, max_dd: dd };
        }
        if (mode === 'oneshot' && !inCrash && dd >= crash_dd) {
          const desiredValue = 1.0 * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'crash_enter', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          inCrash = true;
          curCrash = { enter: bar.date, exit: null, max_dd: dd };
        } else if (inCrash && dd <= 1e-9) {
          const desiredValue = targetWeight * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'crash_exit', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
          inCrash = false;
          if (curCrash) {
            curCrash.exit = bar.date;
            crashEvents.push(curCrash);
            curCrash = null;
          }
        } else if (inCrash) {
          if (curCrash && dd > curCrash.max_dd) curCrash.max_dd = dd;
          if (mode === 'ladder') {
            const want = Math.min(level, nLevels);
            if (want > deployedLevels && defensiveValue > 0) {
              const tranche = regimeDefensive / nLevels;
              const traded = Math.min(defensiveValue, tranche * (want - deployedLevels));
              const cost = traded * costRate;
              etfUnits += traded / bar.etf;
              settleTrade(etfValue + traded, traded, cost);
              const toBeta = total > 0 ? ((etfValue + traded) / total) * etf_beta : 0;
              trades.push({ date: bar.date, type: 'ladder_buy', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
              deployedLevels = want;
            }
          }
        } else if (curBeta > upper || curBeta < lower) {
          const desiredValue = targetWeight * total;
          const traded = desiredValue - etfValue;
          const cost = Math.abs(traded) * costRate;
          etfUnits = desiredValue / bar.etf;
          settleTrade(desiredValue, traded, cost);
          const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
          trades.push({ date: bar.date, type: 'rebalance', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
        }
      }
    }

    // 交易後（或無交易）當日權益與 β
    const postEtfValue = etfUnits * bar.etf;
    const postBond1Value = hasBonds ? bond1Units * bond1Price : 0;
    const postBond2Value = hasBonds ? bond2Units * bond2Price : 0;
    const postTotal = postEtfValue + cash + postBond1Value + postBond2Value;
    stratPoints.push({ date: bar.date, value: postTotal });
    betaCurve.push({ date: bar.date, value: postTotal > 0 ? (postEtfValue / postTotal) * etf_beta : 0 });
  }

  // 收尾：仍在崩盤中的事件也要記錄（exit=null）
  if (curCrash) crashEvents.push(curCrash);

  const bench0050 = buyHold(bars, (b) => b.mkt, initial_capital);
  const bench631 = buyHold(bars, (b) => b.etf, initial_capital);
  // 初始配置不再平衡：期初以目標權重建倉後放著不動（有債券時比照主策略的期初配置邏輯建倉、之後永不交易）【增修K】
  const staticUnits = (targetWeight * initial_capital) / bars[0].etf;
  let staticCash = (1 - targetWeight) * initial_capital;
  let staticBond1Units = 0;
  let staticBond2Units = 0;
  if (hasBonds) {
    const p1 = bars[0].bond1 ?? 0;
    const p2 = bars[0].bond2 ?? 0;
    const seed = allocateDefensiveTarget(staticCash, 0, 0);
    staticCash = seed.cash;
    staticBond1Units = p1 > 0 ? seed.bond1 / p1 : 0;
    staticBond2Units = p2 > 0 ? seed.bond2 / p2 : 0;
  }
  const benchStatic: CurvePoint[] = bars.map((b) => ({
    date: b.date,
    value:
      staticUnits * b.etf +
      staticCash +
      (hasBonds ? staticBond1Units * (b.bond1 ?? 0) + staticBond2Units * (b.bond2 ?? 0) : 0),
  }));

  return {
    aligned_days: bars.length,
    start_date: bars[0].date,
    end_date: bars[bars.length - 1].date,
    strategy: {
      key: 'strategy',
      name:
        mode === 'tiered'
          ? `崩盤策略（三層，警戒 −${Math.round(tier2_dd * 100)}% / 股災 −${Math.round(crash_dd * 100)}%）`
          : mode === 'ladder'
            ? `崩盤策略（每 −${Math.round(ladder_step * 100)}% 分批、−${Math.round(ladder_full_at * 100)}% 買滿）`
            : `崩盤策略（−${Math.round(crash_dd * 100)}% 一次 all-in）`,
      points: stratPoints,
      metrics: metricsOf(stratPoints, initial_capital),
    },
    beta_curve: betaCurve,
    mkt_drawdown: mktDd,
    benchmarks: [
      { key: 'bench_0050', name: '全倉 0050（β=1）', points: bench0050, metrics: metricsOf(bench0050, initial_capital) },
      { key: 'bench_631', name: '全倉 00631L（β=2）', points: bench631, metrics: metricsOf(bench631, initial_capital) },
      {
        key: 'bench_static',
        name: `初始配置不再平衡（β=${target_beta}）`,
        points: benchStatic,
        metrics: metricsOf(benchStatic, initial_capital),
      },
    ],
    trades,
    crash_events: crashEvents,
  };
}
