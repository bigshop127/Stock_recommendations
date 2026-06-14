import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { WaterGauge, SentimentCard } from '../components/WaterGauge';
import { RegimeCard } from '../components/RegimeCard';
import { WatchRow } from '../components/WatchRow';
import { Loading, ErrorState, Section, Card } from '../components/ui';

export function Dashboard() {
  const { data, error, loading, reload } = useApi(() => api.dashboard(), []);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const top = (data.watchlist || []).slice().sort((a, b) => a.rank_swing - b.rank_swing).slice(0, 6);

  return (
    <div>
      <header className="mb-4">
        <h1 className="text-lg font-bold text-slate-100">每日儀表板</h1>
        <div className="text-xs text-slate-500">
          報告日 {data.as_of_date || data.date || '—'}
          {data.as_of_date && data.date && data.as_of_date !== data.date && `（沿用，查詢 ${data.date}）`}
        </div>
      </header>

      {data.degraded && (
        <Card className="mb-4 border-amber-700/50 bg-amber-950/30">
          <div className="text-amber-300 text-sm font-semibold mb-1">降級模式</div>
          <ul className="text-xs text-slate-400 list-disc pl-4 space-y-0.5">
            {(data.notes || ['引擎不可用，僅顯示老王水位/情緒快取']).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 mb-4">
        <WaterGauge level={data.water_level} text={data.water_level_text} />
        <SentimentCard label={data.puhui_sentiment?.label} score={data.puhui_sentiment?.score} />
      </div>

      <div className="mb-4">
        <RegimeCard regime={data.market_regime} />
      </div>

      <Section
        title="觀察清單（波段排序）"
        right={
          <Link to="/watchlist" className="text-xs text-emerald-400">
            全部 →
          </Link>
        }
      >
        {top.length === 0 ? (
          <Card>
            <div className="text-slate-500 text-sm">
              {data.degraded ? '降級模式無觀察清單（需引擎）' : '暫無觀察清單'}
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {top.map((it) => (
              <WatchRow key={it.code} item={it} mode="swing" />
            ))}
          </div>
        )}
      </Section>

      <p className="text-[11px] text-slate-600 mt-6 leading-relaxed">
        🔴=看多 / 🟢=看空 / 🟠=中性（老王報告色碼與股市相反）。本頁數字一律來自後端引擎與老王報告，前端不重算。
      </p>
    </div>
  );
}
