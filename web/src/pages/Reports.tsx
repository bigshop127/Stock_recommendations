import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { ReportView } from '../components/ReportView';
import { Loading, ErrorState, Card } from '../components/ui';

export function Reports() {
  const [date, setDate] = useState<string | undefined>(undefined);
  const list = useApi(() => api.reportsList(), []);
  const report = useApi(() => api.report(date), [date]);

  return (
    <div>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-100">老王每日報告</h1>
        {list.data && list.data.dates.length > 0 && (
          <select
            value={date || list.data.latest || ''}
            onChange={(e) => setDate(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-2 py-1 text-slate-200"
          >
            {list.data.dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
      </header>

      <Card className="mb-3 !p-2 border-slate-700/40">
        <div className="text-[11px] text-amber-300/90 text-center">
          {report.data?.emoji_semantics || '🔴=看多 / 🟢=看空 / 🟠=中性（與股市紅漲綠跌相反）'}
        </div>
      </Card>

      {report.loading && <Loading />}
      {report.error && <ErrorState error={report.error} onRetry={report.reload} />}
      {report.data && (
        <Card>
          <ReportView markdown={report.data.markdown} />
        </Card>
      )}
    </div>
  );
}
