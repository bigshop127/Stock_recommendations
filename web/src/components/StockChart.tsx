import { useState } from 'react';
import { api, ApiError, type OhlcvRow } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { PriceChart } from './PriceChart';
import { Loading } from './ui';

type Tab = 'adj' | 'raw' | 'intraday';
const TABS: { key: Tab; label: string }[] = [
  { key: 'adj', label: '日K · 還原' },
  { key: 'raw', label: '日K · 原始' },
  { key: 'intraday', label: '盤中分K' },
];

export function StockChart({ code }: { code: string }) {
  const [tab, setTab] = useState<Tab>('adj');
  const [tf, setTf] = useState('5');

  const { data, error, loading } = useApi<{ rows: OhlcvRow[] }>(async () => {
    if (tab === 'intraday') return { rows: (await api.intraday(code, { timeframe: tf })).data };
    return { rows: (await api.ohlcv(code, { adjust: tab === 'adj' })).data };
  }, [code, tab, tf]);

  // 富果未設金鑰 → engine 502 → gateway ENGINE_ERROR：優雅降級為提示，不顯示破圖
  const fugleMissing =
    tab === 'intraday' &&
    error instanceof ApiError &&
    (error.status === 502 ||
      /fugle|富果|api[_-]?key|金鑰/i.test(`${error.message} ${JSON.stringify(error.detail ?? '')}`));

  return (
    <div>
      <div className="flex gap-1.5 mb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
              tab === t.key ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab === 'intraday' && !fugleMissing && (
          <select
            value={tf}
            onChange={(e) => setTf(e.target.value)}
            className="ml-auto bg-slate-800 border border-slate-700 rounded-lg text-xs px-1.5 text-slate-300"
          >
            {['1', '5', '15', '30', '60'].map((v) => (
              <option key={v} value={v}>
                {v} 分
              </option>
            ))}
          </select>
        )}
      </div>

      {tab === 'raw' && (
        <div className="text-[11px] text-amber-400/90 mb-1">
          ⚠️ 原始價（FinMind 未還原）：有分割/除權的個股（如 0050）會出現價格斷點失真，建議看「還原」。
        </div>
      )}

      {loading && <Loading label="載入 K 線…" />}

      {fugleMissing && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4 text-center">
          <div className="text-2xl mb-1">🔌</div>
          <div className="text-sm text-slate-300 font-medium mb-1">盤中分K 需要富果金鑰</div>
          <div className="text-xs text-slate-500 leading-relaxed">
            未設定 <code className="text-slate-400">FUGLE_API_KEY</code>（engine/.env）。
            日K 與五檔盤口不受影響；填入富果 Marketdata 金鑰後此圖即可啟用。
          </div>
        </div>
      )}

      {error && !fugleMissing && !loading && (
        <div className="text-sm text-rose-300 py-4">K 線載入失敗：{error.message}</div>
      )}

      {!loading && !error && data && (
        data.rows && data.rows.length > 0 ? (
          <PriceChart rows={data.rows} />
        ) : (
          <div className="text-sm text-slate-500 py-4 text-center">此區間無 K 線資料</div>
        )
      )}
    </div>
  );
}
