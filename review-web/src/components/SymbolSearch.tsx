import React, { useState, useEffect } from 'react';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { SymbolHit } from '../lib/api';

export interface SymbolSearchProps {
  onPick: (hit: SymbolHit) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export const SymbolSearch: React.FC<SymbolSearchProps> = ({
  onPick,
  placeholder = '搜尋代號或股名，如 2330 / 台積電',
  autoFocus = false,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const handler = setTimeout(async () => {
      try {
        const res = await api.symbolSearch(query);
        if (res.degraded) {
          setError('搜尋暫時無法使用（後端降級）');
          setResults([]);
        } else {
          setResults(res.results || []);
        }
      } catch (err: any) {
        console.error('Failed to search symbols:', err);
        setError('搜尋暫時無法使用');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [query]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-primary/50 transition-colors"
        />
      </div>

      <div className="max-h-60 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 divide-y divide-zinc-800/60">
        {loading && (
          <div className="flex items-center justify-center py-6 text-zinc-500 gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-xs font-mono">搜尋中...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-2 p-4 text-xs text-bull bg-bull/5 border-l-2 border-bull">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && query.trim() !== '' && results.length === 0 && (
          <div className="p-4 text-center text-xs text-zinc-500">
            查無符合個股
          </div>
        )}

        {!loading && !error && results.map((hit) => (
          <div
            key={hit.code}
            className="flex items-center justify-between p-3 hover:bg-zinc-800/30 transition-colors"
          >
            <div>
              <span className="font-semibold text-zinc-200 text-sm mr-2">{hit.name}</span>
              <span className="text-xs text-zinc-500 font-mono">{hit.code}</span>
            </div>
            <button
              onClick={() => onPick(hit)}
              className="px-2.5 py-1 text-xs bg-primary hover:bg-primary/95 text-white font-semibold rounded transition"
            >
              加入
            </button>
          </div>
        ))}

        {!query.trim() && (
          <div className="p-4 text-center text-xs text-zinc-600">
            請輸入關鍵字開始搜尋
          </div>
        )}
      </div>
    </div>
  );
};
