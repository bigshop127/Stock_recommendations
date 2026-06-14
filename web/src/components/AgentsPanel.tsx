import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Badge, Card } from './ui';
import { actionMeta } from '../lib/format';

// 🚨 多 agent LLM 決策：每股 7×LLM ≈187s、燒額度 → **只在使用者按鈕觸發**，結果落地 localStorage（重整不重算）。
const cacheKey = (code: string) => `agents:decide:${code}`;

interface Cached {
  ts: number;
  decision: Record<string, unknown>;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

function loadCache(code: string): Cached | null {
  try {
    const raw = localStorage.getItem(cacheKey(code));
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

export function AgentsPanel({ code }: { code: string }) {
  const [cached, setCached] = useState<Cached | null>(() => loadCache(code));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCached(loadCache(code));
    setError(null);
  }, [code]);

  useEffect(() => {
    if (running) {
      const t0 = Date.now();
      timer.current = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [running]);

  async function run() {
    setRunning(true);
    setError(null);
    setElapsed(0);
    try {
      const resp = await api.decide([code]);
      const decision =
        (resp.decisions || []).find((d) => String((d as { code?: string }).code) === code) ||
        resp.decisions?.[0];
      if (!decision) throw new Error('引擎未回傳此股決策');
      const entry: Cached = { ts: Date.now(), decision };
      localStorage.setItem(cacheKey(code), JSON.stringify(entry));
      setCached(entry);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-slate-200">🤖 多 agent LLM 決策</div>
        {cached && !running && (
          <button onClick={run} className="text-xs text-slate-400 underline">
            重新計算
          </button>
        )}
      </div>

      {!cached && !running && !error && (
        <div>
          <p className="text-xs text-slate-400 mb-3">
            分析師 → 多空辯論 → 交易員 → 風控。<span className="text-amber-400">很貴：約 3 分鐘、會燒 LLM 額度</span>，
            只在你按下時才執行，結果會快取（重整不重算）。
          </p>
          <button
            onClick={run}
            className="w-full py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold"
          >
            ▶ 跑多 agent 決策
          </button>
        </div>
      )}

      {running && (
        <div className="text-center py-6">
          <div className="inline-block w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mb-3" />
          <div className="text-sm text-slate-300">多 agent 推理中…（已 {elapsed}s，通常約 180s）</div>
          <div className="text-xs text-slate-500 mt-1">請保持此頁開啟，跑完會自動快取</div>
        </div>
      )}

      {error && !running && (
        <div className="text-sm text-rose-300">
          決策失敗：{error.message}
          {error instanceof ApiError && error.status === 503 && <span>（引擎離線）</span>}
          <button onClick={run} className="ml-2 underline text-slate-300">
            重試
          </button>
        </div>
      )}

      {cached && !running && <DecisionView d={cached.decision} ts={cached.ts} />}
    </Card>
  );
}

function DecisionView({ d, ts }: { d: Record<string, unknown>; ts: number }) {
  const action = pick(d, ['final_action', 'action', 'decision', 'recommendation']) as string | undefined;
  const conf = pick(d, ['confidence', 'final_confidence']) as number | undefined;
  const flag = pick(d, ['flag', 'warning', 'consistency', 'consistency_flag']) as string | undefined;
  const rationale = pick(d, ['rationale', 'summary', 'reason', 'final_rationale', 'trader_rationale']) as
    | string
    | undefined;
  const m = actionMeta(action);
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Badge className={m.cls}>{m.label}</Badge>
        {conf != null && <span className="text-xs text-slate-400">信心 {(Number(conf) * (conf <= 1 ? 100 : 1)).toFixed(0)}%</span>}
        {flag && flag !== 'ok' && flag !== 'aligned' && (
          <Badge className="bg-amber-600">⚠ {String(flag)}</Badge>
        )}
      </div>
      {rationale && <p className="text-sm text-slate-300 whitespace-pre-wrap">{rationale}</p>}
      <details className="mt-2">
        <summary className="text-xs text-slate-500 cursor-pointer">完整決策 JSON</summary>
        <pre className="text-[11px] text-slate-400 overflow-x-auto mt-1 bg-slate-900/60 p-2 rounded">
          {JSON.stringify(d, null, 2)}
        </pre>
      </details>
      <div className="text-[10px] text-slate-600 mt-2">計算於 {new Date(ts).toLocaleString('zh-TW')}</div>
    </div>
  );
}
