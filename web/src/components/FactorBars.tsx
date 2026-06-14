import type { FactorScore } from '../lib/api';

// 多因子分數明細（取代雷達圖的輕量水平長條，手機更好讀）。
export function FactorBars({ factors }: { factors?: FactorScore[] }) {
  if (!factors || factors.length === 0) {
    return <div className="text-slate-500 text-sm">無因子明細</div>;
  }
  return (
    <div className="space-y-2">
      {factors.map((f) => {
        const s = Math.max(0, Math.min(100, f.score ?? 0));
        const color = s >= 70 ? 'bg-emerald-500' : s >= 50 ? 'bg-amber-500' : 'bg-rose-500';
        return (
          <div key={f.key}>
            <div className="flex justify-between text-xs mb-0.5">
              <span className="text-slate-300">
                {f.name}
                <span className="text-slate-500 ml-1">×{f.weight?.toFixed(2)}</span>
                {f.live_only && <span className="text-amber-400 ml-1">live</span>}
              </span>
              <span className="text-slate-400">{f.score?.toFixed(0)}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
              <div className={`h-full ${color}`} style={{ width: `${s}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
