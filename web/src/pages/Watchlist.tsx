import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { WatchRow } from '../components/WatchRow';
import { Loading, ErrorState } from '../components/ui';

type Mode = 'swing' | 'daytrade';

export function Watchlist() {
  const [mode, setMode] = useState<Mode>('swing');
  const { data, error, loading, reload } = useApi(() => api.watchlist(), []);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const items = (data?.items || []).slice().sort((a, b) =>
    mode === 'swing' ? a.rank_swing - b.rank_swing : a.rank_daytrade - b.rank_daytrade,
  );

  return (
    <div>
      <header className="mb-3">
        <h1 className="text-lg font-bold text-slate-100">觀察清單</h1>
        <div className="text-xs text-slate-500">自動由老王提及 + 引擎自選帶入（唯讀）</div>
      </header>

      <div className="flex gap-2 mb-3">
        {(['swing', 'daytrade'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium ${
              mode === m ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {m === 'swing' ? '波段潛力' : '短線當沖'}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="text-slate-500 text-sm py-8 text-center">暫無清單</div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <WatchRow key={it.code} item={it} mode={mode} />
          ))}
        </div>
      )}
    </div>
  );
}
