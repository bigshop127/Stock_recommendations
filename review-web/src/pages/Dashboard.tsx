import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { MarketIndices, MarketBreadth, MarketSectors, MarketInstitutional, WatchItem } from '../lib/api';
import { Activity, BarChart3, TrendingUp, Users, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { SymbolSearch } from '../components/SymbolSearch';
import { getUserWatchlist, addToWatchlist, removeFromWatchlist, subscribeWatchlist, type UserStock } from '../lib/userStore';

interface MergedWatchItem {
  code: string;
  name: string;
  isFocus: boolean;
  isUser: boolean;
  swing_score: number | null;
  daytrade_prob: number | null;
  rank_swing: number | null;
  rank_daytrade: number | null;
  tags?: string[];
}

export const Dashboard: React.FC = () => {
  const [indicesState, setIndicesState] = useState<{ data: MarketIndices | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [breadthState, setBreadthState] = useState<{ data: MarketBreadth | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [sectorsState, setSectorsState] = useState<{ data: MarketSectors | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [institutionalState, setInstitutionalState] = useState<{ data: MarketInstitutional | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [watchlistState, setWatchlistState] = useState<{ data: WatchItem[] | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  
  const [range, setRange] = useState<'1d' | '5d' | '1m'>('1d');

  const [userWatchlist, setUserWatchlist] = useState<UserStock[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    setUserWatchlist(getUserWatchlist());
    const unsubscribe = subscribeWatchlist(() => {
      setUserWatchlist(getUserWatchlist());
    });
    return unsubscribe;
  }, []);

  // Check if mock mode is explicitly requested in Dev env
  const isDev = import.meta.env.DEV;
  const isMockParam = new URLSearchParams(window.location.search).get('mock') === '1';
  const useMock = isDev && isMockParam;

  const loadMockData = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const mockIndices: MarketIndices = {
      date: dateStr,
      as_of: new Date().toISOString(),
      indices: [
        {
          key: 'TWSE',
          name: '加權指數',
          price: 22845.81,
          change: 182.42,
          change_pct: 0.81,
          volume: 382400000000,
          intraday: [
            { t: '09:00', v: 22663.39 },
            { t: '10:00', v: 22750.50 },
            { t: '11:00', v: 22800.20 },
            { t: '12:00', v: 22820.80 },
            { t: '13:00', v: 22845.81 }
          ],
          source: 'TWSE MIS'
        },
        {
          key: 'OTC',
          name: '櫃買指數',
          price: 268.45,
          change: -1.25,
          change_pct: -0.46,
          volume: 82400000000,
          intraday: [
            { t: '09:00', v: 269.70 },
            { t: '10:00', v: 269.10 },
            { t: '11:00', v: 268.80 },
            { t: '12:00', v: 268.50 },
            { t: '13:00', v: 268.45 }
          ],
          source: 'TWSE MIS'
        },
        {
          key: 'electronic',
          name: '電子工業',
          price: 1205.30,
          change: 15.45,
          change_pct: 1.30,
          volume: null,
          intraday: [
            { t: '09:00', v: 1189.85 },
            { t: '10:00', v: 1195.40 },
            { t: '11:00', v: 1201.20 },
            { t: '12:00', v: 1203.50 },
            { t: '13:00', v: 1205.30 }
          ],
          source: 'TWSE MIS'
        },
        {
          key: 'finance',
          name: '金融保險',
          price: 1980.25,
          change: -8.15,
          change_pct: -0.41,
          volume: null,
          intraday: [
            { t: '09:00', v: 1988.40 },
            { t: '10:00', v: 1985.20 },
            { t: '11:00', v: 1982.90 },
            { t: '12:00', v: 1981.10 },
            { t: '13:00', v: 1980.25 }
          ],
          source: 'TWSE MIS'
        },
        {
          key: 'TX',
          name: '台指期',
          price: 22860.00,
          change: 195.00,
          change_pct: 0.86,
          volume: 120000,
          intraday: [
            { t: '09:00', v: 22665.00 },
            { t: '10:00', v: 22760.00 },
            { t: '11:00', v: 22815.00 },
            { t: '12:00', v: 22835.00 },
            { t: '13:00', v: 22860.00 }
          ],
          source: 'TAIFEX'
        }
      ]
    };

    const mockBreadth: MarketBreadth = {
      date: dateStr,
      advancing: 582,
      declining: 324,
      unchanged: 92,
      limit_up: 12,
      limit_down: 3,
      total: 998,
      advancing_pct: 0.583,
      above_ma20_ratio: 0.625,
      above_ma50_ratio: 0.584,
      universe: 'watchlist_union_0050',
      sample_size: 95,
      source: 'TWSE'
    };

    const mockSectors: MarketSectors = {
      date: dateStr,
      sectors: [
        { name: '半導體', change_pct: 1.45, turnover: 124500000000, source: 'TWSE' },
        { name: '電腦及週邊', change_pct: 0.82, turnover: 24500000000, source: 'TWSE' },
        { name: '光電', change_pct: 1.15, turnover: 15400000000, source: 'TWSE' },
        { name: '電子零組件', change_pct: -0.65, turnover: 18200000000, source: 'TWSE' },
        { name: '金融保險', change_pct: 0.35, turnover: 18200000000, source: 'TWSE' },
        { name: '航運', change_pct: -1.82, turnover: 32000000000, source: 'TWSE' },
        { name: '鋼鐵', change_pct: -0.95, turnover: 850000005, source: 'TWSE' },
        { name: '電機機械', change_pct: 2.10, turnover: 14500000000, source: 'TWSE' }
      ]
    };

    const mockInstitutional: MarketInstitutional = {
      date: dateStr,
      unit: '元',
      latest: {
        foreign: 8520000000,
        investment_trust: 2410000000,
        dealer: -1540000000,
        total: 9390000000
      },
      trend: [
        { date: '2026-06-15', foreign: -4200000000, investment_trust: 1200000000, dealer: -50000000, total: -3500000000 },
        { date: '2026-06-16', foreign: 1500000000, investment_trust: 800000000, dealer: 200000000, total: 2500000000 },
        { date: '2026-06-17', foreign: 3200000000, investment_trust: 1400000000, dealer: -800000000, total: 3800000000 },
        { date: '2026-06-18', foreign: -1200000000, investment_trust: 900000000, dealer: 400000000, total: 100000000 },
        { date: '2026-06-19', foreign: 8520000000, investment_trust: 2410000000, dealer: -1540000000, total: 9390000000 }
      ],
      source: 'TWSE'
    };

    setIndicesState({ data: mockIndices, loading: false, error: null });
    setBreadthState({ data: mockBreadth, loading: false, error: null });
    setSectorsState({ data: mockSectors, loading: false, error: null });
    setInstitutionalState({ data: mockInstitutional, loading: false, error: null });
  };

  const fetchIndices = async () => {
    setIndicesState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketIndices({ range });
      setIndicesState({ data, loading: false, error: null });
    } catch (err: any) {
      setIndicesState({ data: null, loading: false, error: err.message || '無法取得指數資料' });
    }
  };

  const fetchBreadth = async () => {
    setBreadthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketBreadth();
      setBreadthState({ data, loading: false, error: null });
    } catch (err: any) {
      setBreadthState({ data: null, loading: false, error: err.message || '無法取得市場多空寬度' });
    }
  };

  const fetchSectors = async () => {
    setSectorsState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketSectors();
      setSectorsState({ data, loading: false, error: null });
    } catch (err: any) {
      setSectorsState({ data: null, loading: false, error: err.message || '無法取得類股表現' });
    }
  };

  const fetchInstitutional = async () => {
    setInstitutionalState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketInstitutional();
      setInstitutionalState({ data, loading: false, error: null });
    } catch (err: any) {
      setInstitutionalState({ data: null, loading: false, error: err.message || '無法取得三大法人買賣超' });
    }
  };

  const fetchWatchlist = async () => {
    setWatchlistState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: WatchItem[];
      if (useMock) {
        data = [
          { code: '2330', name: '台積電', source: ['TWSE'], swing_score: 75, daytrade_prob: 0.82, rank_swing: 1, rank_daytrade: 2, tags: ['權值股', '半導體'] },
          { code: '2454', name: '聯發科', source: ['TWSE'], swing_score: 68, daytrade_prob: 0.75, rank_swing: 2, rank_daytrade: 4, tags: ['高價股', 'IC設計'] },
          { code: '2317', name: '鴻海', source: ['TWSE'], swing_score: 82, daytrade_prob: 0.68, rank_swing: 3, rank_daytrade: 1, tags: ['蘋果概念', '代工'] }
        ];
      } else {
        const res = await api.watchlist();
        data = res.items || [];
      }
      setWatchlistState({ data, loading: false, error: null });
    } catch (err: any) {
      setWatchlistState({ data: null, loading: false, error: err.message || '無法取得自選清單' });
    }
  };

  const fetchAllData = () => {
    if (useMock) {
      loadMockData();
      fetchWatchlist();
      return;
    }
    fetchIndices();
    fetchBreadth();
    fetchSectors();
    fetchInstitutional();
    fetchWatchlist();
  };

  useEffect(() => {
    fetchAllData();
  }, [useMock]);

  // Refetch indices if range changes
  useEffect(() => {
    if (!useMock) {
      fetchIndices();
    }
  }, [range]);

  const renderSparkline = (row: any) => {
    const points = range === '1d' ? row.intraday : row.history;
    if (!points || points.length === 0) {
      return <span className="text-[10px] text-zinc-500 italic">無走勢圖</span>;
    }
    const values = points.map((p: any) => p.v !== undefined ? p.v : p.close || 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const valRange = max - min || 1;
    const width = 80;
    const height = 24;
    const isUp = (row.change || 0) >= 0;
    const strokeColor = isUp ? '#ef4444' : '#22c55e'; // 漲紅跌綠

    const coords = points.map((p: any, idx: number) => {
      const val = p.v !== undefined ? p.v : p.close || 0;
      const x = (idx / (points.length - 1)) * width;
      const y = height - ((val - min) / valRange) * height;
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg width={width} height={height} className="overflow-visible">
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          points={coords}
        />
      </svg>
    );
  };

  const renderTrendChart = (trend: any[]) => {
    if (!trend || trend.length === 0) return null;
    const width = 500;
    const height = 150;
    const padding = { top: 10, right: 30, bottom: 20, left: 50 };

    const allValues = trend.flatMap(d => [d.foreign, d.investment_trust, d.dealer, d.total]);
    const minVal = Math.min(...allValues);
    const maxVal = Math.max(...allValues);
    const valRange = maxVal - minVal || 1;

    const getX = (idx: number) => padding.left + (idx / (trend.length - 1)) * (width - padding.left - padding.right);
    const getY = (val: number) => padding.top + (1 - (val - minVal) / valRange) * (height - padding.top - padding.bottom);

    const getLinePath = (key: string) => {
      return trend.map((d, idx) => {
        const x = getX(idx);
        const y = getY(d[key]);
        return `${idx === 0 ? 'M' : 'L'}${x},${y}`;
      }).join(' ');
    };

    return (
      <div className="w-full overflow-x-auto">
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible min-w-[400px]">
          {minVal < 0 && maxVal > 0 && (
            <line
              x1={padding.left}
              y1={getY(0)}
              x2={width - padding.right}
              y2={getY(0)}
              stroke="#3f3f46"
              strokeDasharray="4"
            />
          )}
          <text x={padding.left - 5} y={getY(maxVal)} fill="#71717a" fontSize="8" textAnchor="end">{(maxVal / 1e8).toFixed(0)}億</text>
          <text x={padding.left - 5} y={getY(0)} fill="#71717a" fontSize="8" textAnchor="end">0</text>
          <text x={padding.left - 5} y={getY(minVal)} fill="#71717a" fontSize="8" textAnchor="end">{(minVal / 1e8).toFixed(0)}億</text>

          {trend.map((d, idx) => {
            if (idx === 0 || idx === trend.length - 1 || idx === Math.floor(trend.length / 2)) {
              return (
                <text key={idx} x={getX(idx)} y={height - 5} fill="#71717a" fontSize="8" textAnchor="middle">
                  {d.date.slice(5)}
                </text>
              );
            }
            return null;
          })}

          <path d={getLinePath('foreign')} fill="none" stroke="#3b82f6" strokeWidth="1.5" />
          <path d={getLinePath('investment_trust')} fill="none" stroke="#a855f7" strokeWidth="1.5" />
          <path d={getLinePath('dealer')} fill="none" stroke="#f59e0b" strokeWidth="1.5" />
          <path d={getLinePath('total')} fill="none" stroke="#ef4444" strokeWidth="2" />

          {trend.map((d, idx) => (
            <circle key={idx} cx={getX(idx)} cy={getY(d.total)} r="3" fill={d.total >= 0 ? '#ef4444' : '#22c55e'} />
          ))}
        </svg>
        <div className="flex justify-center gap-4 text-[10px] text-zinc-400 mt-2">
          <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-[#3b82f6]"></span>外資</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-[#a855f7]"></span>投信</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-[#f59e0b]"></span>自營商</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-1 bg-[#ef4444]"></span>合計</span>
        </div>
      </div>
    );
  };

  const getHeatmapColor = (pct: number | null) => {
    if (pct === null) {
      return 'rgba(63, 63, 70, 0.4)'; // Neutral zinc-800 background
    }
    if (pct >= 0) {
      const alpha = Math.min(0.1 + (pct / 3) * 0.9, 1.0);
      return `rgba(239, 68, 68, ${alpha})`; // 漲紅
    } else {
      const alpha = Math.min(0.1 + (Math.abs(pct) / 3) * 0.9, 1.0);
      return `rgba(34, 197, 94, ${alpha})`; // 跌綠
    }
  };

  const mergedWatchlist = useMemo<MergedWatchItem[]>(() => {
    const focusItems = watchlistState.data || [];
    const orderedList: MergedWatchItem[] = [];

    focusItems.forEach(item => {
      const isUser = userWatchlist.some(u => u.code === item.code);
      orderedList.push({
        code: item.code,
        name: item.name,
        isFocus: true,
        isUser,
        swing_score: item.swing_score,
        daytrade_prob: item.daytrade_prob,
        rank_swing: item.rank_swing,
        rank_daytrade: item.rank_daytrade,
        tags: item.tags || []
      });
    });

    const userOnlyItems = userWatchlist.filter(u => !focusItems.some(f => f.code === u.code));
    const sortedUserOnly = [...userOnlyItems].sort((a, b) => new Date(b.added_at).getTime() - new Date(a.added_at).getTime());

    sortedUserOnly.forEach(u => {
      orderedList.push({
        code: u.code,
        name: u.name,
        isFocus: false,
        isUser: true,
        swing_score: null,
        daytrade_prob: null,
        rank_swing: null,
        rank_daytrade: null,
        tags: []
      });
    });

    return orderedList;
  }, [watchlistState.data, userWatchlist]);

  return (
    <div className="space-y-6">
      {/* Title block */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            大盤與市場籌碼總覽
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            整合加權及期現貨指數、市場多空寬度、類股表現、三大法人資金走向。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {useMock && (
            <span className="text-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-400 px-2.5 py-1 rounded-md font-mono animate-pulse">
              Mock Mode (DEV)
            </span>
          )}
          <button
            onClick={fetchAllData}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 transition text-zinc-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新整理
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* 1. 指數卡 */}
        <div className="bg-card border border-border rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4 border-b border-border/60 pb-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">期現貨指數與分時走勢</h3>
              </div>
              <div className="flex gap-1.5">
                {(['1d', '5d', '1m'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={`px-2 py-0.5 rounded text-[10px] transition ${range === r ? 'bg-primary text-primary-foreground font-semibold' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}
                  >
                    {r.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {indicesState.loading ? (
              <div className="h-64 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入指數資料中...</div>
            ) : indicesState.error ? (
              <div className="h-64 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
                <span className="text-xs text-red-400 font-semibold mb-2">無法取得指數資料</span>
                <span className="text-[10px] text-zinc-500 font-mono mb-4">{indicesState.error}</span>
                <button onClick={fetchIndices} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition">重試</button>
              </div>
            ) : (
              <div className="space-y-3">
                {indicesState.data?.indices.map((idx) => {
                  const isUp = (idx.change || 0) >= 0;
                  return (
                    <div key={idx.key} className="flex items-center justify-between p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                      <div>
                        <div className="text-xs font-semibold text-zinc-200">{idx.name}</div>
                        <div className="text-[9px] text-zinc-500 font-mono mt-0.5">來源: {idx.source}</div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="h-6 flex items-center">{renderSparkline(idx)}</div>
                        <div className="text-right min-w-[100px]">
                          <div className="text-xs font-bold font-mono text-zinc-100">
                            {idx.price !== null ? idx.price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '--'}
                          </div>
                          <div className={`text-[10px] font-mono font-medium mt-0.5 ${isUp ? 'text-bull' : 'text-bear'}`}>
                            {idx.change !== null ? `${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)}` : '--'}
                            {idx.change_pct !== null ? ` (${idx.change_pct >= 0 ? '+' : ''}${idx.change_pct.toFixed(2)}%)` : ''}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {indicesState.data && (
            <div className="text-[10px] text-zinc-500 font-mono text-right mt-4">
              資料時間: {new Date(indicesState.data.as_of).toLocaleString()}
            </div>
          )}
        </div>

        {/* 2. 三大法人買賣超 */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
            <Users className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-sm text-zinc-200">三大法人現貨資金流向</h3>
          </div>

          {institutionalState.loading ? (
            <div className="h-64 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入法人買賣超中...</div>
          ) : institutionalState.error ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
              <span className="text-xs text-red-400 font-semibold mb-2">無法取得法人買賣超</span>
              <span className="text-[10px] text-zinc-500 font-mono mb-4">{institutionalState.error}</span>
              <button onClick={fetchInstitutional} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition">重試</button>
            </div>
          ) : (
            <div className="space-y-4">
              {institutionalState.data && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                      <div className="text-[10px] text-zinc-500">外資與陸資</div>
                      <div className={`text-xs font-bold font-mono mt-1.5 ${institutionalState.data.latest.foreign >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {(institutionalState.data.latest.foreign / 1e8).toFixed(2)} 億
                      </div>
                    </div>
                    <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                      <div className="text-[10px] text-zinc-500">投信</div>
                      <div className={`text-xs font-bold font-mono mt-1.5 ${institutionalState.data.latest.investment_trust >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {(institutionalState.data.latest.investment_trust / 1e8).toFixed(2)} 億
                      </div>
                    </div>
                    <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                      <div className="text-[10px] text-zinc-500">自營商</div>
                      <div className={`text-xs font-bold font-mono mt-1.5 ${institutionalState.data.latest.dealer >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {(institutionalState.data.latest.dealer / 1e8).toFixed(2)} 億
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/20">
                    <span className="text-xs font-medium text-zinc-300">合計現貨買賣超</span>
                    <span className={`text-sm font-black font-mono ${institutionalState.data.latest.total >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {institutionalState.data.latest.total >= 0 ? '+' : ''}{(institutionalState.data.latest.total / 1e8).toFixed(2)} 億
                    </span>
                  </div>

                  <div className="pt-2 border-t border-border/30">
                    <div className="text-xs font-semibold text-zinc-300 mb-2">近 20 日三大法人買賣超趨勢</div>
                    {renderTrendChart(institutionalState.data.trend)}
                  </div>

                  <div className="flex items-center justify-between text-[9px] text-zinc-500 font-mono">
                    <span>來源: {institutionalState.data.source}</span>
                    <span>資料日期: {institutionalState.data.date}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* 3. 大盤寬度 */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
            <Activity className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-sm text-zinc-200">市場多空寬度指標</h3>
          </div>

          {breadthState.loading ? (
            <div className="h-64 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入市場寬度中...</div>
          ) : breadthState.error ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
              <span className="text-xs text-red-400 font-semibold mb-2">無法取得市場寬度</span>
              <span className="text-[10px] text-zinc-500 font-mono mb-4">{breadthState.error}</span>
              <button onClick={fetchBreadth} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition">重試</button>
            </div>
          ) : (
            <div className="space-y-4">
              {breadthState.data && (
                <>
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>上漲家數: <strong className="text-bull font-mono">{breadthState.data.advancing}</strong> ({breadthState.data.limit_up} 家漲停)</span>
                    <span>下跌家數: <strong className="text-bear font-mono">{breadthState.data.declining}</strong> ({breadthState.data.limit_down} 家跌停)</span>
                    <span>平盤家數: <strong className="text-zinc-500 font-mono">{breadthState.data.unchanged}</strong></span>
                  </div>
                  <div className="w-full h-3 rounded-full bg-zinc-800 flex overflow-hidden">
                    <div className="bg-bull h-full" style={{ width: `${(breadthState.data.advancing / breadthState.data.total) * 100}%` }}></div>
                    <div className="bg-zinc-600 h-full" style={{ width: `${(breadthState.data.unchanged / breadthState.data.total) * 100}%` }}></div>
                    <div className="bg-bear h-full" style={{ width: `${(breadthState.data.declining / breadthState.data.total) * 100}%` }}></div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mt-2">
                    <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                      <div className="text-[10px] text-zinc-500">站上 20MA 比例</div>
                      <div className="text-sm font-bold font-mono text-zinc-100 mt-1">{(breadthState.data.above_ma20_ratio * 100).toFixed(1)}%</div>
                    </div>
                    <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                      <div className="text-[10px] text-zinc-500">站上 50MA 比例</div>
                      <div className="text-sm font-bold font-mono text-zinc-100 mt-1">{(breadthState.data.above_ma50_ratio * 100).toFixed(1)}%</div>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-zinc-950/30 border border-border/20 text-[9px] text-zinc-500 space-y-1 font-mono">
                    <div>統計範圍 (Universe): {breadthState.data.universe}</div>
                    <div>樣本總數 (Sample Size): {breadthState.data.sample_size}</div>
                  </div>

                  <div className="flex items-center justify-between text-[9px] text-zinc-500 font-mono">
                    <span>來源: {breadthState.data.source}</span>
                    <span>資料日期: {breadthState.data.date}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* 4. 類股表現 */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
            <BarChart3 className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-sm text-zinc-200">產業類股熱力排行</h3>
          </div>

          {sectorsState.loading ? (
            <div className="h-64 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入類股表現中...</div>
          ) : sectorsState.error ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
              <span className="text-xs text-red-400 font-semibold mb-2">無法取得類股資料</span>
              <span className="text-[10px] text-zinc-500 font-mono mb-4">{sectorsState.error}</span>
              <button onClick={fetchSectors} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition">重試</button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-[280px] overflow-y-auto pr-1">
                {sectorsState.data?.sectors
                  .sort((a, b) => {
                    if (a.change_pct === null) return 1;
                    if (b.change_pct === null) return -1;
                    return b.change_pct - a.change_pct;
                  })
                  .map((sec) => {
                    const isUp = sec.change_pct !== null && sec.change_pct >= 0;
                    return (
                      <div
                        key={sec.name}
                        style={{ backgroundColor: getHeatmapColor(sec.change_pct) }}
                        className="p-3 rounded-lg border border-border/10 flex flex-col justify-between transition hover:scale-[1.02] cursor-pointer"
                      >
                        <div className="text-xs font-semibold text-white tracking-tight leading-tight">{sec.name}</div>
                        <div className="mt-3 text-right">
                          <div className="text-[11px] font-black font-mono text-white">
                            {sec.change_pct !== null ? `${isUp ? '+' : ''}${sec.change_pct.toFixed(2)}%` : '--'}
                          </div>
                          <div className="text-[8px] text-zinc-300 font-mono mt-0.5">
                            {(sec.turnover / 1e8).toFixed(1)} 億
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
              {sectorsState.data && (
                <div className="flex items-center justify-between text-[9px] text-zinc-500 font-mono pt-2 border-t border-border/20">
                  <span>來源: TWSE</span>
                  <span>資料日期: {sectorsState.data.date}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 5. 自選與焦點個股審查清單 */}
        <div className="bg-card border border-border rounded-xl p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4 border-b border-border/60 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">自選與焦點審查清單 (Watchlist)</h3>
            </div>
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-primary text-white text-xs font-semibold hover:bg-primary/95 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              加入自選
            </button>
          </div>
          {watchlistState.loading ? (
            <div className="h-32 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入自選清單中...</div>
          ) : watchlistState.error ? (
            <div className="h-32 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
              <span className="text-xs text-red-400 font-semibold mb-2">無法取得自選清單</span>
              <span className="text-[10px] text-zinc-500 font-mono mb-4">{watchlistState.error}</span>
              <button onClick={fetchWatchlist} className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition">重試</button>
            </div>
          ) : mergedWatchlist.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="text-zinc-500 border-b border-border/60 font-mono">
                    <th className="pb-2 font-semibold">代號</th>
                    <th className="pb-2 font-semibold">股名</th>
                    <th className="pb-2 font-semibold text-right">波段評分</th>
                    <th className="pb-2 font-semibold text-right">當沖機率</th>
                    <th className="pb-2 font-semibold text-right">波段排名</th>
                    <th className="pb-2 font-semibold text-right">當沖排名</th>
                    <th className="pb-2 font-semibold">標籤</th>
                    <th className="pb-2 font-semibold text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedWatchlist.map((item) => (
                    <tr key={item.code} className="border-b border-border/30 last:border-0 hover:bg-zinc-850/40 transition duration-150">
                      <td className="py-3 font-mono text-zinc-300 font-bold">{item.code}</td>
                      <td className="py-3 text-zinc-200">{item.name}</td>
                      <td className="py-3 text-right font-mono text-zinc-300">
                        {item.swing_score !== null && item.swing_score !== undefined ? `${item.swing_score}分` : '—'}
                      </td>
                      <td className="py-3 text-right font-mono text-zinc-300">
                        {item.daytrade_prob !== null && item.daytrade_prob !== undefined ? `${(item.daytrade_prob * 100).toFixed(0)}%` : '—'}
                      </td>
                      <td className="py-3 text-right font-mono text-zinc-400">
                        {item.rank_swing !== null && item.rank_swing !== undefined ? `#${item.rank_swing}` : '—'}
                      </td>
                      <td className="py-3 text-right font-mono text-zinc-400">
                        {item.rank_daytrade !== null && item.rank_daytrade !== undefined ? `#${item.rank_daytrade}` : '—'}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1">
                          {item.isFocus && (
                            <span className="text-[9px] bg-bull/10 text-bull px-1.5 py-0.5 rounded font-mono border border-bull/20 font-semibold">
                              焦點
                            </span>
                          )}
                          {item.isUser && (
                            <span className="text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono border border-primary/20 font-semibold">
                              自選
                            </span>
                          )}
                          {item.tags?.map((tag: string) => (
                            <span key={tag} className="text-[9px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center justify-center gap-2">
                          <Link
                            to={`/stock/${item.code}`}
                            className="px-2.5 py-1 bg-primary/10 text-primary hover:bg-primary/20 text-[10px] font-semibold rounded-md border border-primary/20 transition"
                          >
                            進入審查
                          </Link>
                          {item.isUser ? (
                            <button
                              onClick={() => removeFromWatchlist(item.code)}
                              className="p-1 text-zinc-500 hover:text-bull transition"
                              title="移除自選"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              disabled
                              className="p-1 text-zinc-700 cursor-not-allowed opacity-40"
                              title="系統焦點股（無法移除）"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-xs text-zinc-500">尚無自選個股</div>
          )}
        </div>

        {/* 搜尋自選股彈窗 */}
        {showSearch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md p-6 shadow-2xl relative">
              <button
                onClick={() => setShowSearch(false)}
                className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-200 text-lg"
              >
                ✕
              </button>
              <h3 className="text-zinc-200 font-semibold mb-4 text-base">搜尋並加入自選股</h3>
              <SymbolSearch
                autoFocus
                onPick={(hit) => {
                  addToWatchlist({
                    code: hit.code,
                    name: hit.name,
                    added_at: new Date().toISOString(),
                  });
                  setShowSearch(false);
                }}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
