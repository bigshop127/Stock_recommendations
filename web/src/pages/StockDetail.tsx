import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, type StockSignal, type BacktestResult } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { StockChart } from '../components/StockChart';
import { FactorBars } from '../components/FactorBars';
import { EquityChart, type LineSeries } from '../components/EquityChart';
import { AgentsPanel } from '../components/AgentsPanel';
import { Card, Section, Badge, Pill, Loading, ErrorState } from '../components/ui';
import { actionMeta, regimeMeta, num, pct, scoreColor } from '../lib/format';

function SignalHeadline({ s, label }: { s: StockSignal; label: string }) {
  if (s.unavailable) {
    return (
      <div className="text-sm text-slate-500">
        {label}：盤後無盤口資料（live-only）{s.reason ? ` — ${s.reason}` : ''}
      </div>
    );
  }
  const m = actionMeta(s.action);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge className={m.cls}>{m.label}</Badge>
      <span className={`text-lg font-bold ${scoreColor(s.score)}`}>{num(s.score, 0)}</span>
      <span className="text-xs text-slate-500">{label}</span>
      {s.confidence != null && <Pill>信心 {(s.confidence * 100).toFixed(0)}%</Pill>}
      {s.regime_gate != null && <Pill>閘門 ×{s.regime_gate.toFixed(2)}</Pill>}
    </div>
  );
}

function curve(arr?: Record<string, unknown>[]): { time: string | number; value: number }[] {
  if (!arr) return [];
  return arr
    .map((p) => ({
      time: (p.date ?? p.time ?? p.t ?? p.day) as string | number,
      value: Number(p.equity ?? p.value ?? p.nav ?? p.cum_return ?? p.v ?? NaN),
    }))
    .filter((p) => p.time != null && !Number.isNaN(p.value));
}

function BacktestPanel({ code }: { code: string }) {
  const [show, setShow] = useState(false);
  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function run() {
    setShow(true);
    setLoading(true);
    setError(null);
    try {
      setData(await api.backtest({ codes: [code] }));
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }

  if (!show) {
    return (
      <button
        onClick={run}
        className="w-full py-2 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-sm text-slate-200"
      >
        📈 跑迷你回測（波段策略）
      </button>
    );
  }
  if (loading) return <Loading label="回測中…" />;
  if (error) return <ErrorState error={error} onRetry={run} />;
  if (!data) return null;

  const m = data.metrics || {};
  const series: LineSeries[] = [];
  const strat = curve(data.equity_curve);
  if (strat.length) series.push({ name: '策略', color: '#34d399', points: strat });
  const bench = curve(data.benchmark?.equity_curve);
  if (bench.length) series.push({ name: data.benchmark?.name || 'benchmark 0050', color: '#94a3b8', points: bench });

  return (
    <div>
      {series.length > 0 && <EquityChart series={series} />}
      <div className="grid grid-cols-3 gap-2 mt-2 text-center">
        <Metric label="累積報酬" value={pct(m.cum_return, 1)} />
        <Metric label="年化" value={pct(m.annual_return, 1)} />
        <Metric label="Sharpe" value={num(m.sharpe, 2)} />
        <Metric label="最大回撤" value={pct(m.max_drawdown, 1)} />
        <Metric label="勝率" value={pct(m.win_rate, 0)} />
        <Metric label="交易數" value={num(m.trades, 0)} />
      </div>
      {data.benchmark?.cum_return != null && (
        <div className="text-[11px] text-slate-500 mt-2">
          對照 {data.benchmark.name || '0050'} buy&hold：{pct(data.benchmark.cum_return, 1)}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-900/50 py-2">
      <div className="text-sm font-bold text-slate-100">{value}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

export function StockDetail() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi(() => api.stock(code), [code]);

  return (
    <div>
      <button onClick={() => navigate(-1)} className="text-sm text-slate-400 mb-2">
        ← 返回
      </button>

      {loading && <Loading />}
      {error && <ErrorState error={error} onRetry={reload} />}

      {data && (
        <>
          <header className="mb-3">
            <h1 className="text-xl font-bold text-slate-100">
              {data.name || code} <span className="text-sm text-slate-500">{code}</span>
            </h1>
            <div className="text-xs text-slate-500">訊號日 {data.date || '—'}</div>
          </header>

          <Section title="K 線">
            <Card>
              <StockChart code={code} />
            </Card>
          </Section>

          <Section title="融合訊號（量化 × 老王）">
            <Card>
              <SignalHeadline s={data.blended} label="融合" />
              {data.blended?.conflict && (
                <div className="mt-2 text-xs text-amber-300">⚠️ 量化與老王方向背離（conflict）→ 信心已下修</div>
              )}
              {data.blended?.agreement && (
                <div className="mt-1 text-xs text-slate-400">一致性：{String(data.blended.agreement)}</div>
              )}
              {data.blended?.reasons && data.blended.reasons.length > 0 && (
                <ul className="mt-2 text-sm text-slate-300 list-disc pl-4 space-y-0.5">
                  {data.blended.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section title="多因子 · 波段">
            <Card>
              <SignalHeadline s={data.swing} label="波段" />
              {data.swing?.regime && (
                <div className="text-xs text-slate-400 mt-1">
                  大盤環境：<span className={regimeMeta(data.swing.regime.label).cls}>{regimeMeta(data.swing.regime.label).label}</span>
                  （閘門 ×{data.swing.regime.gate?.toFixed(2)}）
                </div>
              )}
              <div className="mt-3">
                <FactorBars factors={data.swing?.factors} />
              </div>
              {data.swing?.reasons && data.swing.reasons.length > 0 && (
                <ul className="mt-2 text-xs text-slate-400 list-disc pl-4 space-y-0.5">
                  {data.swing.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section title="多因子 · 當沖">
            <Card>
              <SignalHeadline s={data.daytrade} label="當沖" />
              {!data.daytrade?.unavailable && (
                <div className="mt-3">
                  <FactorBars factors={data.daytrade?.factors} />
                </div>
              )}
            </Card>
          </Section>

          <Section title="老王觀點">
            <Card>
              {data.puhui ? (
                <PuhuiView p={data.puhui} />
              ) : (
                <div className="text-sm text-slate-500">老王近期報告未提及此股</div>
              )}
            </Card>
          </Section>

          <Section title="迷你回測">
            <Card>
              <BacktestPanel code={code} />
            </Card>
          </Section>

          <Section title="多 agent 決策">
            <AgentsPanel code={code} />
          </Section>
        </>
      )}
    </div>
  );
}

function PuhuiView({ p }: { p: Record<string, unknown> }) {
  const signal = (p.signal ?? p.stance ?? p.action) as string | undefined;
  const reason = (p.reason ?? p.note ?? p.summary) as string | undefined;
  const emoji = p.emoji as string | undefined;
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {emoji && <span className="text-lg">{emoji}</span>}
        {signal && <Pill className="!bg-indigo-900/70 !text-indigo-200">{signal}</Pill>}
      </div>
      {reason && <p className="text-sm text-slate-300 mt-2">{reason}</p>}
      <div className="text-[11px] text-slate-600 mt-2">🔴=看多 / 🟢=看空 / 🟠=中性（老王色碼與股市相反）</div>
      <details className="mt-2">
        <summary className="text-xs text-slate-500 cursor-pointer">原始解析</summary>
        <pre className="text-[11px] text-slate-400 overflow-x-auto mt-1 bg-slate-900/60 p-2 rounded">
          {JSON.stringify(p, null, 2)}
        </pre>
      </details>
    </div>
  );
}
