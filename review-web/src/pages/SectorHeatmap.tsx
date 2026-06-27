import React, { useEffect, useState, useMemo } from 'react';
import { api, type MarketSectors } from '../lib/api';
import { squarify, type TreemapInput } from '../lib/treemap';
import {
  Loader2,
  RefreshCw,
  AlertCircle,
  LayoutGrid,
  Info
} from 'lucide-react';

export const SectorHeatmap: React.FC = () => {
  const [data, setData] = useState<MarketSectors | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [hoveredSector, setHoveredSector] = useState<TreemapInput | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.marketSectors();
      setData(res);
    } catch (err: any) {
      setError(err.message || '無法取得產業類股表現數據');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

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
    if (!data || !data.sectors || data.sectors.length === 0) return [];

    const FLOOR = 0.05;
    const inputs: TreemapInput[] = data.sectors
      .filter((s) => s.change_pct !== null && !isNaN(s.change_pct))
      .map((s) => ({
        key: s.name,
        value: Math.max(Math.abs(s.change_pct!), FLOOR),
        datum: s,
      }));

    // Width = 1000, Height = 600 for the viewBox aspect ratio
    return squarify(inputs, 1000, 600);
  }, [data]);

  // Selected tile for outline highlight rendering
  const selectedTile = useMemo(() => {
    if (!selectedSector) return null;
    return tiles.find((t) => t.item.key === selectedSector) || null;
  }, [selectedSector, tiles]);

  // Handle tooltip position movement relative to SVG container
  const handleMouseMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left + 15,
      y: e.clientY - rect.top - 15,
    });
  };

  // Helper to safely truncate category names for smaller tiles
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
          載入產業類股熱力圖數據中...
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
          onClick={fetchData}
          className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-semibold transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          重新整理
        </button>
      </div>
    );
  }

  if (!data.sectors || data.sectors.length === 0) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto my-12">
        <LayoutGrid className="w-12 h-12 text-zinc-600 mb-4" />
        <span className="text-sm text-zinc-400 font-semibold mb-2">查無產業類股數據</span>
        <span className="text-xs text-zinc-500 font-mono mb-6">目前此日期無類股表現資料</span>
        <button
          onClick={fetchData}
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
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-zinc-100">產業熱力圖</h2>
            <span className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50 text-[10px] font-mono text-zinc-400 font-medium">
              資料日期: {data.date}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            展示台股官方大類股今日表現。區塊大小代表漲跌幅絕對值，紅漲綠跌，點擊可描邊高亮。
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={fetchData}
            className="p-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all shadow-sm animate-none"
            title="重新整理"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-1">
            <button className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-white shadow-sm">
              單日
            </button>
            <div className="relative group">
              <button disabled className="px-3 py-1.5 rounded-md text-xs font-semibold text-zinc-500 cursor-not-allowed hover:bg-transparent">
                單週
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 text-[10px] text-zinc-300 bg-zinc-950 border border-zinc-800 rounded opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap z-50 shadow-md">
                即將推出
              </div>
            </div>
            <div className="relative group">
              <button disabled className="px-3 py-1.5 rounded-md text-xs font-semibold text-zinc-500 cursor-not-allowed hover:bg-transparent">
                單月
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 text-[10px] text-zinc-300 bg-zinc-950 border border-zinc-800 rounded opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap z-50 shadow-md">
                即將推出
              </div>
            </div>
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
                  onClick={() => setSelectedSector(selectedSector === tile.item.key ? null : tile.item.key)}
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

          {/* Render selected tile border on top to avoid visual clipping */}
          {selectedTile && (
            <rect
              x={selectedTile.x}
              y={selectedTile.y}
              width={selectedTile.w}
              height={selectedTile.h}
              fill="none"
              stroke="#ffffff"
              strokeWidth={2.5}
              className="pointer-events-none"
            />
          )}
        </svg>

        {/* Hover Tooltip (手刻 DOM Tooltip) */}
        {hoveredSector && (
          <div
            className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-56 backdrop-blur-sm"
            style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          >
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
              <span className="font-bold text-zinc-100">{hoveredSector.key}</span>
              <span className="font-mono text-zinc-500 text-[10px]">類股表現</span>
            </div>
            <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
              <div>今日漲跌幅:</div>
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
              <div>成交值:</div>
              <div className="text-zinc-200 text-right">
                {formatTurnover(hoveredSector.datum.turnover)}
              </div>
              <div>資料來源:</div>
              <div className="text-zinc-200 text-right uppercase">
                {hoveredSector.datum.source}
              </div>
            </div>
            <div className="text-[10px] text-zinc-500 italic text-center pt-1 border-t border-zinc-900">
              點擊以高亮此區塊
            </div>
          </div>
        )}
      </div>

      {/* Legend Indicator Panel */}
      <div className="mt-8 p-4 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-xs text-zinc-400 font-medium">漲跌幅強度色階對照表</span>
        </div>
        <div className="h-3 w-full rounded bg-gradient-to-r from-[#15803d] via-[#3f3f46] to-[#b91c1c]" />
        <div className="flex justify-between text-xs text-zinc-400 font-mono mt-2 font-medium">
          <span>跌超 5%</span>
          <span>平盤 0%</span>
          <span>漲超 5%</span>
        </div>
      </div>
    </div>
  );
};
