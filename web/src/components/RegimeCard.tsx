import type { MarketRegime } from '../lib/api';
import { regimeMeta } from '../lib/format';
import { Card, Pill } from './ui';

export function RegimeCard({ regime }: { regime: MarketRegime | null }) {
  if (!regime) {
    return (
      <Card>
        <div className="text-xs text-slate-400 mb-1">大盤環境 regime</div>
        <div className="text-slate-500 text-sm">暫無（引擎降級或取不到）</div>
      </Card>
    );
  }
  const m = regimeMeta(regime.label);
  return (
    <Card>
      <div className="text-xs text-slate-400 mb-1">大盤環境 regime</div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-lg font-bold ${m.cls}`}>{m.label}</span>
        <Pill>閘門 ×{regime.gate?.toFixed(2)}</Pill>
        {regime.confidence != null && <Pill>信心 {(regime.confidence * 100).toFixed(0)}%</Pill>}
      </div>
      {regime.note && <div className="text-slate-400 text-xs mt-1">{regime.note}</div>}
    </Card>
  );
}
