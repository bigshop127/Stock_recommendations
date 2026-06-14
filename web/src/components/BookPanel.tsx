import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { Loading, ErrorState } from './ui';

// 即時最佳五檔（TWSE MIS 預設；盤後常為空殼）。MIS 無內外盤 → 以委買/委賣量總和推估盤口強弱。
export function BookPanel({ code }: { code: string }) {
  const { data, error, loading, reload } = useApi(() => api.book(code), [code]);

  if (loading) return <Loading label="抓盤口…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const b = data.book || {};
  const bids = (b.bids || []).filter((x) => x.price != null);
  const asks = (b.asks || []).filter((x) => x.price != null);
  if (bids.length === 0 && asks.length === 0) {
    return (
      <div className="text-xs text-slate-500 py-2">
        盤口暫無資料（非交易時段或查無）。來源：{data.source}
      </div>
    );
  }

  const sum = (arr: { size: number | null }[]) => arr.reduce((s, x) => s + (x.size || 0), 0);
  const bidSize = sum(bids);
  const askSize = sum(asks);
  const total = bidSize + askSize;
  const bidPct = total > 0 ? (bidSize / total) * 100 : 50;

  const Row = ({ price, size, side }: { price: number | null; size: number | null; side: 'bid' | 'ask' }) => (
    <div className="flex justify-between text-xs py-0.5">
      <span className={side === 'bid' ? 'text-rose-300' : 'text-emerald-300'}>{price ?? '—'}</span>
      <span className="text-slate-400">{size ?? '—'}</span>
    </div>
  );

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs mb-2">
        <span className="text-slate-400">
          成交 <span className="text-slate-100 font-semibold">{b.last_price ?? '—'}</span>
        </span>
        <span className="text-slate-500">{data.source?.includes('MIS') ? 'TWSE MIS' : data.source}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] text-rose-400 mb-0.5">委買 (價/量)</div>
          {bids.map((x, i) => (
            <Row key={i} price={x.price} size={x.size} side="bid" />
          ))}
        </div>
        <div>
          <div className="text-[10px] text-emerald-400 mb-0.5">委賣 (價/量)</div>
          {asks.map((x, i) => (
            <Row key={i} price={x.price} size={x.size} side="ask" />
          ))}
        </div>
      </div>
      <div className="mt-2">
        <div className="flex justify-between text-[10px] text-slate-500 mb-0.5">
          <span>買盤 {bidSize}</span>
          <span>盤口強弱（委買量占比）</span>
          <span>{askSize} 賣盤</span>
        </div>
        <div className="h-2 rounded-full bg-emerald-700/50 overflow-hidden">
          <div className="h-full bg-rose-500" style={{ width: `${bidPct}%` }} />
        </div>
      </div>
    </div>
  );
}
