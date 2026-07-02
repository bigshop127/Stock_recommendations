import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type StockHeatmap } from '../lib/api';
import { squarify, type TreemapInput } from '../lib/treemap';
import {
  Loader2,
  RefreshCw,
  AlertCircle,
  Info
} from 'lucide-react';

interface AggregatedSector {
  name: string;
  change_pct: number | null;
  turnover: number;
  count: number;
}

export const SectorHeatmap: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPeriod = (searchParams.get('period') as 'day' | 'week' | 'month') || 'day';

  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(
    ['day', 'week', 'month'].includes(initialPeriod) ? initialPeriod : 'day'
  );
  const [data, setData] = useState<StockHeatmap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hoveredSector, setHoveredSector] = useState<TreemapInput<AggregatedSector> | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handlePeriodChange = (newPeriod: 'day' | 'week' | 'month') => {
    setPeriod(newPeriod);
    setSearchParams({ period: newPeriod }, { replace: true });
  };

  const fetchData = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.marketStockHeatmap({ period }, force);
      setData(res);
    } catch (err: any) {
      setError(err.message || '無法取得產業類股熱力圖數據');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [period]);

  // Aggregate stocks by sector
  const aggregatedSectors = useMemo<AggregatedSector[]>(() => {
    if (!data || !data.stocks) return [];

    const sectorMap = new Map<string, { totalPct: number; countPct: number; totalTurnover: number; totalCount: number }>();

    for (const s of data.stocks) {
      const secName = s.sector || '其他';
      if (!sectorMap.has(secName)) {
        sectorMap.set(secName, { totalPct: 0, countPct: 0, totalTurnover: 0, totalCount: 0 });
      }
      const item = sectorMap.get(secName)!;
      item.totalCount += 1;
      if (s.change_pct !== null && !isNaN(s.change_pct)) {
        item.totalPct += s.change_pct;
        item.countPct += 1;
      }
      if (s.turnover !== null && !isNaN(s.turnover)) {
        item.totalTurnover += s.turnover;
      }
    }

    const result: AggregatedSector[] = [];
    for (const [name, val] of sectorMap.entries()) {
      const avgChangePct = val.countPct > 0 ? val.totalPct / val.countPct : null;
      result.push({
        name,
        change_pct: avgChangePct,
        turnover: val.totalTurnover,
        count: val.totalCount,
      });
    }

    return result;
  }, [data]);

  // Format turnover from raw currency (NTD) to 億 (100M) or 兆 (1T)
  const formatTurnover = (turnover: number): string => {
    if (turnover >= 1e12) {
      return `${(turnover / 1e12).toFixed(2)} 兆`;
    }
    if (turnover >= 1e8) {
      return `${(turnover / 1e8).toFixed(2)} 億`;
    }
    return `${turnover.toLocaleString()} 元`;
  };

  // Interpolate RGB color for a given change percentage
  const getSectorColor = (changePct: number | null): string => {
    if (changePct === null || isNaN(changePct)) {
      return '#3f3f46'; // Neutral grey
    }
    const t = Math.max(0, Math.min(1, Math.abs(changePct) / 5)); // ±5% saturation
    const isPositive = changePct > 0;

    let r, g, b;
    if (isPositive) {
      if (t <= 0.5) {
        const ratio = t / 0.5;
        r = Math.round(63 + (239 - 63) * ratio);
        g = Math.round(63 + (68 - 63) * ratio);
        b = Math.round(70 + (68 - 70) * ratio);
      } else {
        const ratio = (t - 0.5) / 0.5;
        r = Math.round(239 + (185 - 239) * ratio);
        g = Math.round(68 + (28 - 68) * ratio);
        b = Math.round(68 + (28 - 68) * ratio);
      }
    } else if (changePct < 0) {
      if (t <= 0.5) {
        const ratio = t / 0.5;
        r = Math.round(63 + (34 - 63) * ratio);
        g = Math.round(63 + (197 - 63) * ratio);
        b = Math.round(70 + (94 - 70) * ratio);
      } else {
        const ratio = (t - 0.5) / 0.5;
        r = Math.round(34 + (21 - 34) * ratio);
        g = Math.round(197 + (128 - 197) * ratio);
        b = Math.round(94 + (61 - 94) * ratio);
      }
    } else {
      return '#3f3f46';
    }

    return `rgb(${r}, ${g}, ${b})`;
  };

  // Generate Treemap layout tiles
  const tiles = useMemo(() => {
    if (aggregatedSectors.length === 0) return [];

    const FLOOR = 0.05;
    const inputs: TreemapInput[] = aggregatedSectors
      .filter((s) => s.change_pct !== null && !isNaN(s.change_pct))
      .map((s) => ({
        key: s.name,
        value: Math.max(Math.abs(s.change_pct!), FLOOR),
        datum: s,
      }));

    return squarify(inputs, 1000, 600);
  }, [aggregatedSectors]);

  const handleMouseMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left + 15,
      y: e.clientY - rect.top - 15,
    });
  };

  const getTruncatedName = (name: string, width: number): string => {
    const maxChars = Math.floor(width / 11);
    if (name.length > maxChars) {
      return name.substring(0, Math.max(1, maxChars - 1)) + '..';
    }
    return name;
  };

  if (loading) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <span className="text-sm font-medium font-mono text-zinc-400 animate-pulse">
          載入產業熱力圖數據中...
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto my-12">
        <AlertCircle className="w-12 h-12 text-zinc-600 mb-4" />
        <span className="text-sm text-red-400 font-semibold mb-2">載入產業熱力圖失敗</span>
        <span className="text-xs text-zinc-500 font-mono mb-6">{error || '無資料'}</span>
        <button
          onClick={() => fetchData(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-semibold transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          重新整理
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-zinc-100">產業熱力圖</h2>
            <span className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50 text-[10px] font-mono text-zinc-400 font-medium">
              資料日期: {data.date} {period !== 'day' && data.base_date ? `(基準日: ${data.base_date})` : ''}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            依產業平均漲跌幅度(絕對值)顯示區塊大小，顏色深淺代表漲跌方向與強度。點擊產業可直接進入該產業總覽。
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          {/* 市場範圍 Tabs */}
          <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-1">
            <button className="px-2.5 py-1 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-200 shadow-sm">
              上市
            </button>
            <div className="relative group">
              <button disabled className="px-2.5 py-1 rounded-md text-xs font-semibold text-zinc-600 cursor-not-allowed">
                上櫃
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 text-[10px] text-zinc-300 bg-zinc-950 border border-zinc-800 rounded opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap z-50 shadow-md">
                即將推出
              </div>
            </div>
          </div>

          <button
            onClick={() => fetchData(true)}
            className="p-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all shadow-sm"
            title="重新整理"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          {/* 時間週期切換 */}
          <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-1">
            <button
              onClick={() => handlePeriodChange('day')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                period === 'day' ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              單日
            </button>
            <button
              onClick={() => handlePeriodChange('week')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                period === 'week' ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              單週
            </button>
            <button
              onClick={() => handlePeriodChange('month')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                period === 'month' ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              單月
            </button>
          </div>
        </div>
      </div>

      {/* Main Treemap Canvas */}
      <div className="relative border border-zinc-800 bg-zinc-900/10 rounded-xl p-4 flex items-center justify-center overflow-hidden">
        <svg viewBox="0 0 1000 600" className="w-full h-auto rounded-lg select-none">
          {tiles.map((tile) => {
            const isHovered = hoveredSector?.key === tile.item.key;
            const color = getSectorColor(tile.item.datum.change_pct);
            const changePct = tile.item.datum.change_pct;

            return (
              <g key={tile.item.key} className="cursor-pointer">
                <rect
                  x={tile.x}
                  y={tile.y}
                  width={tile.w}
                  height={tile.h}
                  fill={color}
                  stroke="#121214"
                  strokeWidth={1}
                  fillOpacity={isHovered ? 0.95 : 0.8}
                  onMouseEnter={() => setHoveredSector(tile.item)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={() => setHoveredSector(null)}
                  onClick={() => navigate(`/heatmap/sector/${encodeURIComponent(tile.item.key)}?period=${period}`)}
                  className="transition-colors duration-150"
                />
                
                {/* Labels based on size category */}
                {tile.w > 70 && tile.h > 40 ? (
                  <g className="pointer-events-none select-none">
                    <text
                      x={tile.x + tile.w / 2}
                      y={tile.y + tile.h / 2 - 6}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-white font-bold text-xs"
                    >
                      {getTruncatedName(tile.item.key, tile.w - 8)}
                    </text>
                    <text
                      x={tile.x + tile.w / 2}
                      y={tile.y + tile.h / 2 + 10}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-zinc-200 font-mono text-[10px]"
                    >
                      {changePct !== null && changePct >= 0 ? '+' : ''}
                      {changePct !== null ? changePct.toFixed(2) : '0.00'}%
                    </text>
                  </g>
                ) : tile.w >= 32 && tile.h >= 22 ? (
                  <g className="pointer-events-none select-none">
                    <text
                      x={tile.x + tile.w / 2}
                      y={tile.y + tile.h / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-white font-semibold text-[10px]"
                    >
                      {getTruncatedName(tile.item.key, tile.w - 4)}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>

        {/* Hover Tooltip */}
        {hoveredSector && (
          <div
            className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-60 backdrop-blur-sm"
            style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          >
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
              <span className="font-bold text-zinc-100">{hoveredSector.key}</span>
              <span className="font-mono text-zinc-500 text-[10px]">
                {period === 'day' ? '當日' : period === 'week' ? '單週' : '單月'}產業平均
              </span>
            </div>
            <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
              <div>平均漲跌幅:</div>
              <div
                className={`text-right font-bold ${
                  hoveredSector.datum.change_pct !== null && hoveredSector.datum.change_pct > 0
                    ? 'text-bull'
                    : hoveredSector.datum.change_pct !== null && hoveredSector.datum.change_pct < 0
                    ? 'text-bear'
                    : 'text-zinc-400'
                }`}
              >
                {hoveredSector.datum.change_pct !== null && hoveredSector.datum.change_pct > 0 ? '+' : ''}
                {hoveredSector.datum.change_pct !== null ? hoveredSector.datum.change_pct.toFixed(2) : '0.00'} %
              </div>
              <div>成交金額合計:</div>
              <div className="text-zinc-200 text-right">
                {formatTurnover(hoveredSector.datum.turnover)}
              </div>
              <div>成分股檔數:</div>
              <div className="text-zinc-200 text-right">
                {hoveredSector.datum.count} 檔
              </div>
            </div>
            <div className="text-[10px] text-zinc-500 italic text-center pt-1 border-t border-zinc-900">
              點擊進入【{hoveredSector.key}】產業總覽
            </div>
          </div>
        )}
      </div>

      {/* Notice & Legend Panel */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 border border-zinc-800 bg-zinc-900/20 rounded-xl">
        <div className="text-[11px] text-zinc-500 leading-relaxed">
          * 歷史漲跌幅（週/月）採未還原收盤價計算，若期間經歷除權息可能影響計算精確度。
        </div>
        <div className="shrink-0 w-full sm:w-64">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Info className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-400 font-medium">漲跌幅強度色階</span>
          </div>
          <div className="h-2.5 w-full rounded bg-gradient-to-r from-[#15803d] via-[#3f3f46] to-[#b91c1c]" />
          <div className="flex justify-between text-[10px] text-zinc-400 font-mono mt-1 font-medium">
            <span>-5% 綠跌</span>
            <span>0% 平盤</span>
            <span>+5% 紅漲</span>
          </div>
        </div>
      </div>
    </div>
  );
};
