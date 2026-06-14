import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type WatchItem } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { BookPanel } from '../components/BookPanel';
import { Loading, ErrorState, Card, Pill } from '../components/ui';
import { pct, scoreColor } from '../lib/format';

function Candidate({ item }: { item: WatchItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Link to={`/stock/${item.code}`} className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-100 truncate">{item.name}</span>
            <span className="text-xs text-slate-500">{item.code}</span>
          </div>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            <Pill>#{item.rank_daytrade} 當沖</Pill>
            {item.source?.includes('puhui') && <Pill className="!bg-indigo-900/70 !text-indigo-200">老王</Pill>}
            {item.tags?.slice(0, 2).map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
          </div>
        </Link>
        <div className="text-right shrink-0">
          <div
            className={`text-xl font-bold ${
              item.daytrade_prob == null ? 'text-slate-500' : scoreColor(item.daytrade_prob * 100)
            }`}
          >
            {pct(item.daytrade_prob, 0)}
          </div>
          <div className="text-[10px] text-slate-500">當沖機率</div>
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-2 w-full text-xs py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-300"
      >
        {open ? '收起盤口' : '看即時盤口（五檔）'}
      </button>
      {open && <BookPanel code={item.code} />}
    </Card>
  );
}

export function Daytrade() {
  const { data, error, loading, reload } = useApi(() => api.watchlist(), []);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const items = (data?.items || []).slice().sort((a, b) => a.rank_daytrade - b.rank_daytrade);

  return (
    <div>
      <header className="mb-3">
        <h1 className="text-lg font-bold text-slate-100">當沖候選</h1>
        <div className="text-xs text-slate-500">依當沖機率排序 · 即時盤口走 TWSE MIS（免金鑰，盤中有效）</div>
      </header>
      {items.length === 0 ? (
        <div className="text-slate-500 text-sm py-8 text-center">暫無候選</div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <Candidate key={it.code} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}
