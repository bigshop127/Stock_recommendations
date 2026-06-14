import { Card } from './ui';

// 老王操作水位（0~1）。水位越高=越積極持股。
export function WaterGauge({ level, text }: { level: number | null; text: string | null }) {
  const pctNum = level == null ? null : Math.max(0, Math.min(1, level)) * 100;
  return (
    <Card>
      <div className="text-xs text-slate-400 mb-1">操作水位</div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-sky-300">{text || '—'}</span>
        {pctNum != null && <span className="text-sm text-slate-400">{pctNum.toFixed(0)}%</span>}
      </div>
      <div className="mt-2 h-2 rounded-full bg-slate-700 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-sky-500 to-emerald-400"
          style={{ width: `${pctNum ?? 0}%` }}
        />
      </div>
    </Card>
  );
}

export function SentimentCard({ label, score }: { label?: string; score?: number }) {
  return (
    <Card>
      <div className="text-xs text-slate-400 mb-1">市場情緒</div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-amber-300">{label || '—'}</span>
        {score != null && <span className="text-sm text-slate-400">{score.toFixed(0)}/100</span>}
      </div>
      <div className="mt-2 h-2 rounded-full bg-slate-700 overflow-hidden">
        <div className="h-full bg-amber-400" style={{ width: `${score ?? 0}%` }} />
      </div>
    </Card>
  );
}
