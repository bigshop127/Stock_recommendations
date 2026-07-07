import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi } from 'lightweight-charts';
import { FlaskConical, RefreshCw, AlertTriangle, TrendingDown } from 'lucide-react';
import { api } from '../lib/api';
import type { OhlcvRow } from '../lib/api';
import { toTime } from '../lib/indicators';
import {
  alignSeries,
  runBacktest,
  type BacktestParams,
  type CurvePoint,
  type EquityCurve,
} from '../lib/crashBacktest';

const ETF_CODE = '00631L';
const MKT_CODE = '0050';
const START = '2020-01-01';
const PARAMS_KEY = 'review:backtest:v1';

const DEFAULT_PARAMS: BacktestParams = {
  initial_capital: 1_000_000,
  target_beta: 1.2,
  etf_beta: 2.0,
  tolerance_mode: 'abs',
  threshold_pct: 10,
  threshold_abs: 0.1,
  crash_dd: 0.28,
  cost_bps: 0,
  mode: 'oneshot',
  ladder_step: 0.05,
  ladder_full_at: 0.3,
};

function loadParams(): BacktestParams {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (raw) return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_PARAMS };
}

const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
// 台股慣例：報酬為正＝紅、為負＝綠
const retClass = (v: number) => (v >= 0 ? 'text-bull' : 'text-bear');

const SERIES_COLORS: Record<string, string> = {
  strategy: '#a855f7', // 崩盤策略（主色強調）
  bench_0050: '#94a3b8', // 全倉 0050
  bench_631: '#eab308', // 全倉 00631L
  bench_static: '#3b82f6', // 初始配置不再平衡
};

/** 通用多線折線圖（lightweight-charts），沿用個股 K 線的暗色調。 */
const MultiLineChart: React.FC<{
  series: { key: string; name: string; color: string; points: CurvePoint[]; lineWidth?: number }[];
  height?: number;
  priceLines?: { price: number; color: string; title: string }[];
}> = ({ series, height = 320, priceLines }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = chartHostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap || series.length === 0) return;

    const chart: IChartApi = createChart(host, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } },
      rightPriceScale: { borderColor: '#3f3f46', minimumWidth: 72 },
      timeScale: { borderColor: '#3f3f46', timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    let firstSeries: ReturnType<IChartApi['addLineSeries']> | null = null;
    for (const s of series) {
      const ls = chart.addLineSeries({
        color: s.color,
        lineWidth: (s.lineWidth ?? 2) as never,
        title: s.name,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      ls.setData(
        s.points
          .filter((p) => Number.isFinite(p.value))
          .map((p) => ({ time: toTime(p.date, false) as never, value: p.value })),
      );
      if (!firstSeries) firstSeries = ls;
    }
    if (firstSeries && priceLines) {
      for (const pl of priceLines) {
        firstSeries.createPriceLine({
          price: pl.price,
          color: pl.color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: pl.title,
        });
      }
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (wrap) chart.applyOptions({ width: wrap.clientWidth });
    });
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [series, height, priceLines]);

  return (
    <div ref={wrapRef} className="w-full">
      <div ref={chartHostRef} className="w-full" />
    </div>
  );
};

export const CrashBacktest: React.FC = () => {
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    etf: OhlcvRow[] | null;
    mkt: OhlcvRow[] | null;
  }>({ loading: true, error: null, etf: null, mkt: null });
  const [params, setParams] = useState<BacktestParams>(() => loadParams());

  const fetchData = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [etfRes, mktRes] = await Promise.all([
        api.ohlcv(ETF_CODE, { start: START, adjust: true }),
        api.ohlcv(MKT_CODE, { start: START, adjust: true }),
      ]);
      setState({ loading: false, error: null, etf: etfRes.data ?? [], mkt: mktRes.data ?? [] });
    } catch (err: any) {
      setState({ loading: false, error: err?.message || '無法載入歷史行情', etf: null, mkt: null });
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
  }, [params]);

  const update = (patch: Partial<BacktestParams>) => setParams((p) => ({ ...p, ...patch }));

  const result = useMemo(() => {
    if (!state.etf || !state.mkt) return null;
    const bars = alignSeries(state.etf, state.mkt);
    return runBacktest(bars, params);
  }, [state.etf, state.mkt, params]);

  const equitySeries = useMemo(() => {
    if (!result) return [];
    const all: EquityCurve[] = [result.strategy, ...result.benchmarks];
    return all.map((c) => ({
      key: c.key,
      name: c.name,
      color: SERIES_COLORS[c.key] ?? '#71717a',
      points: c.points,
      lineWidth: c.key === 'strategy' ? 3 : 1,
    }));
  }, [result]);

  const targetWeightPct = Math.round((Math.min(Math.max(params.target_beta / params.etf_beta, 0), 1)) * 100);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 標題 */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100 flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-primary" />
            崩盤策略回測實驗室
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            00631L（正2）＋現金，以 0050 偵測崩盤：一次 all-in 或每跌一階分批加碼，創新高回目標 β。
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${state.loading ? 'animate-spin' : ''}`} />
          重新抓取
        </button>
      </div>

      {/* 參數控制 */}
      <div className="bg-card border border-border rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        {/* 目標 β */}
        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-zinc-300 font-medium">目標投組 β</span>
            <span className="font-mono text-primary font-bold">
              {params.target_beta.toFixed(2)}X · 00631L {targetWeightPct}% / 現金 {100 - targetWeightPct}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={params.target_beta}
            onChange={(e) => update({ target_beta: Number(e.target.value) })}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-[10px] text-zinc-600 font-mono mt-1">
            <span>0X 全現金</span>
            <span>1.0X 平衡</span>
            <span>2.0X 全槓桿</span>
          </div>
        </div>

        {/* 加碼模式：一次 all-in / 分批加碼【增修J】 */}
        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-zinc-300 font-medium">加碼模式（0050 回撤觸發）</span>
            <div className="flex rounded-lg overflow-hidden border border-border">
              <button
                onClick={() => update({ mode: 'oneshot' })}
                className={`px-3 py-1.5 text-xs font-medium ${
                  params.mode !== 'ladder' ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                一次 all-in
              </button>
              <button
                onClick={() => update({ mode: 'ladder' })}
                className={`px-3 py-1.5 text-xs font-medium ${
                  params.mode === 'ladder' ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                分批加碼
              </button>
            </div>
          </div>
          {params.mode !== 'ladder' ? (
            <>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-zinc-400">觸發回撤（一次全數加碼滿槓桿）</span>
                <span className="font-mono text-bear font-bold">−{Math.round(params.crash_dd * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.5}
                step={0.01}
                value={params.crash_dd}
                onChange={(e) => update({ crash_dd: Number(e.target.value) })}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 font-mono mt-1">
                <span>−10%</span>
                <span>−28%（研究文預設）</span>
                <span>−50%</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-zinc-400">每跌一階買一筆</span>
                <span className="font-mono text-bear font-bold">−{Math.round(params.ladder_step * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.01}
                max={0.1}
                step={0.01}
                value={params.ladder_step}
                onChange={(e) =>
                  update({
                    ladder_step: Number(e.target.value),
                    ladder_full_at: Math.max(params.ladder_full_at, Number(e.target.value)),
                  })
                }
                className="w-full accent-primary"
              />
              <div className="flex items-center justify-between text-xs mb-1 mt-2">
                <span className="text-zinc-400">買滿深度（現金分 {Math.max(1, Math.round(params.ladder_full_at / params.ladder_step))} 筆等分）</span>
                <span className="font-mono text-bear font-bold">−{Math.round(params.ladder_full_at * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.5}
                step={0.05}
                value={params.ladder_full_at}
                onChange={(e) => update({ ladder_full_at: Math.max(Number(e.target.value), params.ladder_step) })}
                className="w-full accent-primary"
              />
            </>
          )}
        </div>

        {/* 容忍模式 */}
        <div>
          <div className="text-sm text-zinc-300 font-medium mb-2">再平衡容忍區間</div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-border">
              <button
                onClick={() => update({ tolerance_mode: 'abs' })}
                className={`px-3 py-1.5 text-xs font-medium ${
                  params.tolerance_mode === 'abs' ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                ±β
              </button>
              <button
                onClick={() => update({ tolerance_mode: 'pct' })}
                className={`px-3 py-1.5 text-xs font-medium ${
                  params.tolerance_mode === 'pct' ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                ±%
              </button>
            </div>
            {params.tolerance_mode === 'abs' ? (
              <div className="flex-1">
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={params.threshold_abs}
                  onChange={(e) => update({ threshold_abs: Number(e.target.value) })}
                  className="w-full accent-primary"
                />
                <span className="text-[11px] font-mono text-zinc-400">±{params.threshold_abs.toFixed(2)} β</span>
              </div>
            ) : (
              <div className="flex-1">
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={params.threshold_pct}
                  onChange={(e) => update({ threshold_pct: Number(e.target.value) })}
                  className="w-full accent-primary"
                />
                <span className="text-[11px] font-mono text-zinc-400">±{params.threshold_pct}%</span>
              </div>
            )}
          </div>
        </div>

        {/* 期初資金 + 成本 */}
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-zinc-300 font-medium">期初資金</span>
            <input
              type="number"
              min={1}
              value={params.initial_capital}
              onChange={(e) => update({ initial_capital: Number(e.target.value) })}
              className="mt-1.5 w-full bg-zinc-950 border border-border rounded-lg px-3 py-1.5 text-sm font-mono text-zinc-100 focus:outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-300 font-medium">單邊成本 (bps)</span>
            <input
              type="number"
              min={0}
              value={params.cost_bps}
              onChange={(e) => update({ cost_bps: Number(e.target.value) })}
              className="mt-1.5 w-full bg-zinc-950 border border-border rounded-lg px-3 py-1.5 text-sm font-mono text-zinc-100 focus:outline-none focus:border-primary"
            />
          </label>
        </div>
      </div>

      {/* 載入 / 錯誤 */}
      {state.loading && (
        <div className="flex h-40 items-center justify-center text-zinc-400">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-xs font-mono animate-pulse">抓取 00631L / 0050 歷史還原價...</span>
          </div>
        </div>
      )}
      {!state.loading && state.error && (
        <div className="flex items-center gap-3 bg-bull/10 border border-bull/20 text-bull rounded-lg px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {state.error}
        </div>
      )}

      {/* 結果 */}
      {!state.loading && !state.error && result && (
        <>
          {result.note ? (
            <div className="text-sm text-zinc-500 bg-card border border-border rounded-lg px-4 py-3">{result.note}</div>
          ) : (
            <>
              <div className="text-xs text-zinc-500 font-mono">
                回測區間 {result.start_date} ~ {result.end_date}（{result.aligned_days} 個交易日） · 崩盤事件{' '}
                {result.crash_events.length} 次 · 交易 {result.trades.length} 筆
              </div>

              {/* 績效比較表 */}
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-border text-sm font-semibold text-zinc-200">績效比較</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-zinc-500 text-xs border-b border-border">
                        <th className="text-left font-medium px-5 py-2.5">策略 / 基準</th>
                        <th className="text-right font-medium px-4 py-2.5">期末資產</th>
                        <th className="text-right font-medium px-4 py-2.5">總報酬</th>
                        <th className="text-right font-medium px-4 py-2.5">年化</th>
                        <th className="text-right font-medium px-5 py-2.5">最大回撤</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[result.strategy, ...result.benchmarks].map((c) => (
                        <tr
                          key={c.key}
                          className={`border-b border-border/50 last:border-0 ${
                            c.key === 'strategy' ? 'bg-primary/5' : ''
                          }`}
                        >
                          <td className="px-5 py-2.5">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: SERIES_COLORS[c.key] ?? '#71717a' }}
                              />
                              <span className={c.key === 'strategy' ? 'font-semibold text-zinc-100' : 'text-zinc-300'}>
                                {c.name}
                              </span>
                            </span>
                          </td>
                          <td className="text-right px-4 py-2.5 font-mono text-zinc-200">{fmtMoney(c.metrics.final_value)}</td>
                          <td className={`text-right px-4 py-2.5 font-mono ${retClass(c.metrics.total_return)}`}>
                            {c.metrics.total_return >= 0 ? '+' : ''}
                            {fmtPct(c.metrics.total_return)}
                          </td>
                          <td className={`text-right px-4 py-2.5 font-mono ${retClass(c.metrics.cagr)}`}>
                            {c.metrics.cagr >= 0 ? '+' : ''}
                            {fmtPct(c.metrics.cagr)}
                          </td>
                          <td className="text-right px-5 py-2.5 font-mono text-bear">−{fmtPct(c.metrics.max_drawdown)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 權益曲線 */}
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="text-sm font-semibold text-zinc-200 mb-3">權益曲線</div>
                <MultiLineChart series={equitySeries} height={340} />
              </div>

              {/* 投組 β 曲線 */}
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="text-sm font-semibold text-zinc-200 mb-3">
                  策略投組 β（{params.mode === 'ladder' ? '回撤期分批墊高' : '崩盤期拉滿槓桿 ≈ 2.0'}，創新高回目標 {params.target_beta.toFixed(2)}）
                </div>
                <MultiLineChart
                  series={[{ key: 'beta', name: '投組 β', color: '#a855f7', points: result.beta_curve }]}
                  height={200}
                  priceLines={[{ price: params.target_beta, color: '#3f3f46', title: `目標 ${params.target_beta}` }]}
                />
              </div>

              {/* 0050 回撤 */}
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-bear" />
                  0050 自高點回撤（
                  {params.mode === 'ladder'
                    ? `首筆 −${Math.round(params.ladder_step * 100)}%／買滿 −${Math.round(params.ladder_full_at * 100)}%`
                    : `觸發線 −${Math.round(params.crash_dd * 100)}%`}
                  ）
                </div>
                <MultiLineChart
                  series={[
                    {
                      key: 'dd',
                      name: '回撤',
                      color: '#22c55e',
                      points: result.mkt_drawdown.map((p) => ({ date: p.date, value: -p.value * 100 })),
                    },
                  ]}
                  height={180}
                  priceLines={
                    params.mode === 'ladder'
                      ? [
                          { price: -params.ladder_step * 100, color: '#f59e0b', title: `首筆 −${Math.round(params.ladder_step * 100)}%` },
                          { price: -params.ladder_full_at * 100, color: '#ef4444', title: `買滿 −${Math.round(params.ladder_full_at * 100)}%` },
                        ]
                      : [
                          { price: -params.crash_dd * 100, color: '#ef4444', title: `觸發 −${Math.round(params.crash_dd * 100)}%` },
                        ]
                  }
                />
              </div>

              {/* 崩盤事件 */}
              {result.crash_events.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-5">
                  <div className="text-sm font-semibold text-zinc-200 mb-3">崩盤事件</div>
                  <div className="space-y-2">
                    {result.crash_events.map((e, i) => (
                      <div key={i} className="flex items-center justify-between text-xs font-mono text-zinc-400 bg-zinc-950/40 rounded px-3 py-2">
                        <span>
                          <span className="text-bear">▼</span> {e.enter} → {e.exit ?? '（尚未創新高，回測結束仍持有滿槓桿）'}
                        </span>
                        <span className="text-bear">期間最大回撤 −{fmtPct(e.max_dd)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 交易紀錄 */}
              {result.trades.length > 0 && (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border text-sm font-semibold text-zinc-200">
                    交易紀錄（{result.trades.length} 筆）
                  </div>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="text-zinc-500 border-b border-border">
                          <th className="text-left font-medium px-5 py-2">日期</th>
                          <th className="text-left font-medium px-4 py-2">動作</th>
                          <th className="text-right font-medium px-4 py-2">β 變化</th>
                          <th className="text-right font-medium px-5 py-2">00631L 金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.map((t, i) => {
                          const label =
                            t.type === 'crash_enter'
                              ? '崩盤加碼'
                              : t.type === 'ladder_buy'
                              ? '分批加碼'
                              : t.type === 'crash_exit'
                              ? '創新高退出'
                              : '再平衡';
                          const labelClass =
                            t.type === 'crash_enter' || t.type === 'ladder_buy'
                              ? 'text-bull'
                              : t.type === 'crash_exit'
                              ? 'text-bear'
                              : 'text-zinc-300';
                          return (
                            <tr key={i} className="border-b border-border/40 last:border-0 font-mono">
                              <td className="px-5 py-1.5 text-zinc-400">{t.date}</td>
                              <td className={`px-4 py-1.5 font-sans ${labelClass}`}>{label}</td>
                              <td className="px-4 py-1.5 text-right text-zinc-400">
                                {t.from_beta.toFixed(2)} → {t.to_beta.toFixed(2)}
                              </td>
                              <td className={`px-5 py-1.5 text-right ${t.traded_value >= 0 ? 'text-bull' : 'text-bear'}`}>
                                {t.traded_value >= 0 ? '買 +' : '賣 '}
                                {fmtMoney(t.traded_value)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* 聲明 */}
      <p className="text-[11px] text-zinc-600 leading-relaxed">
        本回測為單一標的（00631L＋現金）簡化模型：投組 β＝00631L 佔比×2、現金 β＝0；崩盤偵測以 0050
        自歷史高點回撤為準。「一次 all-in」＝觸發後現金全數加碼至滿槓桿（100%/2x，故不再實作研究文的第二階 −50%
        加碼）；「分批加碼」＝每多跌一階，用進入回撤時的現金等分買一筆，跌到買滿深度為止，回撤期間暫停容忍區間再平衡。兩種模式皆於
        0050 創新高後再平衡回目標 β。歷史還原價來自 <span className="font-mono">/api/stocks/:code/ohlcv?adjust=1</span>；
        回測結果為過去資料的機械式模擬，不含滑價與稅費（除非自行填入成本），非投資建議。門檻類參數對結果高度敏感（歷史上大跌谷底
        −27.5% 與 −28% 觸發只差 0.5%），單一門檻的回測優勢未必能外推。
      </p>
    </div>
  );
};
