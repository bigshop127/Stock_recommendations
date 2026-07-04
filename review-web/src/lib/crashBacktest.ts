// opt11 崩盤策略回測實驗室 — 純函式核心（不碰 DOM、不發請求）
//
// 模型＝單一標的（00631L 正2, β≈2.0）＋現金，市場代理＝0050（用來偵測回撤/崩盤）。
// 投組 β = etf_weight × etf_beta。正常模式：β 漂出容忍區間就再平衡回目標。
// 崩盤模式（單一標的簡化版，見 §9 規格）：0050 自歷史高點回撤 ≥ crash_dd → 現金全數
// 加碼 00631L 拉到滿槓桿（weight=1、β≈2）；0050 再創新高 → 退出崩盤、再平衡回目標 β。
// 註：研究文的「第二階 −50% 再加碼」在單一標的下已無可加碼空間（最高 100%/2x），故本
// 模型只實作「一階崩盤加碼 ＋ 創新高退出」，此設計假設於規格與 UI 明列。

import type { OhlcvRow } from './api';

export interface AlignedBar {
  date: string;
  etf: number; // 00631L 還原收盤
  mkt: number; // 0050 還原收盤
}

export interface BacktestParams {
  initial_capital: number; // 期初資金 TWD（預設 1,000,000）
  target_beta: number; // 目標投組 β（預設 1.2）
  etf_beta: number; // 標的 β（00631L 預設 2.0）
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑（沿用 opt10）
  threshold_pct: number; // pct 模式 ±%
  threshold_abs: number; // abs 模式 ±β
  crash_dd: number; // 崩盤觸發：0050 自高點回撤幅度（0.28 = −28%）
  cost_bps: number; // 單邊交易成本（bps，套在成交金額；預設 0）
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
  type: 'rebalance' | 'crash_enter' | 'crash_exit';
  from_beta: number;
  to_beta: number;
  traded_value: number; // + 買 / − 賣（00631L 金額）
  cost: number;
}

export interface CrashEvent {
  enter: string;
  exit: string | null;
  max_dd: number; // 該次崩盤期間 0050 最大回撤
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

/** 依日期 inner-join 兩條收盤序列，只保留兩邊都有、且價格為有限正數的交易日。 */
export function alignSeries(etfRows: OhlcvRow[], mktRows: OhlcvRow[]): AlignedBar[] {
  const mkt = new Map<string, number>();
  for (const r of mktRows ?? []) {
    const d = String(r?.date ?? '').slice(0, 10);
    const c = safeNum(r?.close, NaN);
    if (d && Number.isFinite(c) && c > 0) mkt.set(d, c);
  }
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
  };

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

  const { initial_capital, target_beta, etf_beta, tolerance_mode, threshold_pct, threshold_abs, crash_dd, cost_bps } =
    params;

  const targetWeight = clamp(target_beta / etf_beta, 0, 1);
  const upper =
    tolerance_mode === 'abs' ? target_beta + threshold_abs : target_beta * (1 + threshold_pct / 100);
  const lower = Math.max(
    tolerance_mode === 'abs' ? target_beta - threshold_abs : target_beta * (1 - threshold_pct / 100),
    0,
  );
  const costRate = cost_bps / 10_000;

  // 期初：直接以目標權重建倉（此為起始部位，不計為一筆交易）。
  let etfUnits = (targetWeight * initial_capital) / bars[0].etf;
  let cash = (1 - targetWeight) * initial_capital;

  let peakMkt = bars[0].mkt;
  let inCrash = false;
  let curCrash: CrashEvent | null = null;

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

    // 收盤時的部位市值
    const etfValue = etfUnits * bar.etf;
    const total = etfValue + cash;
    const curBeta = total > 0 ? (etfValue / total) * etf_beta : 0;

    // ── 狀態機（i>0 才交易，i=0 為建倉基準日）──
    if (i > 0) {
      if (!inCrash && dd >= crash_dd) {
        // 進入崩盤：全數加碼到滿槓桿
        const desiredValue = 1.0 * total;
        const traded = desiredValue - etfValue;
        const cost = Math.abs(traded) * costRate;
        etfUnits = desiredValue / bar.etf;
        cash = cash - traded - cost;
        const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
        trades.push({ date: bar.date, type: 'crash_enter', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
        inCrash = true;
        curCrash = { enter: bar.date, exit: null, max_dd: dd };
      } else if (inCrash && dd <= 1e-9) {
        // 0050 創新高 → 退出崩盤、再平衡回目標
        const desiredValue = targetWeight * total;
        const traded = desiredValue - etfValue;
        const cost = Math.abs(traded) * costRate;
        etfUnits = desiredValue / bar.etf;
        cash = cash - traded - cost;
        const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
        trades.push({ date: bar.date, type: 'crash_exit', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
        inCrash = false;
        if (curCrash) {
          curCrash.exit = bar.date;
          crashEvents.push(curCrash);
          curCrash = null;
        }
      } else if (inCrash) {
        // 崩盤持續：維持滿槓桿，記錄期間最大回撤
        if (curCrash && dd > curCrash.max_dd) curCrash.max_dd = dd;
      } else if (curBeta > upper || curBeta < lower) {
        // 正常模式：漂出容忍區間 → 再平衡回目標 β
        const desiredValue = targetWeight * total;
        const traded = desiredValue - etfValue;
        const cost = Math.abs(traded) * costRate;
        etfUnits = desiredValue / bar.etf;
        cash = cash - traded - cost;
        const toBeta = total > 0 ? (desiredValue / total) * etf_beta : 0;
        trades.push({ date: bar.date, type: 'rebalance', from_beta: curBeta, to_beta: toBeta, traded_value: traded, cost });
      }
    }

    // 交易後（或無交易）當日權益與 β
    const postEtfValue = etfUnits * bar.etf;
    const postTotal = postEtfValue + cash;
    stratPoints.push({ date: bar.date, value: postTotal });
    betaCurve.push({ date: bar.date, value: postTotal > 0 ? (postEtfValue / postTotal) * etf_beta : 0 });
  }

  // 收尾：仍在崩盤中的事件也要記錄（exit=null）
  if (curCrash) crashEvents.push(curCrash);

  const bench0050 = buyHold(bars, (b) => b.mkt, initial_capital);
  const bench631 = buyHold(bars, (b) => b.etf, initial_capital);
  // 初始配置不再平衡：期初以目標權重建倉後放著不動
  const staticUnits = (targetWeight * initial_capital) / bars[0].etf;
  const staticCash = (1 - targetWeight) * initial_capital;
  const benchStatic: CurvePoint[] = bars.map((b) => ({ date: b.date, value: staticUnits * b.etf + staticCash }));

  return {
    aligned_days: bars.length,
    start_date: bars[0].date,
    end_date: bars[bars.length - 1].date,
    strategy: {
      key: 'strategy',
      name: '崩盤策略',
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
