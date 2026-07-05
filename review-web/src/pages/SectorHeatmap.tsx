import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type StockHeatmap, type HeatmapStock } from '../lib/api';
import { squarify, type TreemapInput, type TreemapTile } from '../lib/treemap';
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

// 個股層級巢狀 treemap 的分組結果
interface StockGroup {
  sector: TreemapTile<{ stocks: HeatmapStock[]; total: number; count: number }>;
  stocks: TreemapTile<HeatmapStock>[];
}

// treemap 畫布尺寸（viewBox 座標）
const CANVAS_W = 1000;
const CANVAS_H = 640;
// 每個產業區塊頂部標題列高度
const HEADER_H = 17;
const GROUP_GAP = 2;
const TINY_FLOOR = 1; // 成交值下限，避免 0 值

export const SectorHeatmap: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPeriod = (searchParams.get('period') as 'day' | 'week' | 'month') || 'day';

  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(
    ['day', 'week', 'month'].includes(initialPeriod) ? initialPeriod : 'day'
  );
  // 檢視模式：個股 (finviz 式) / 產業聚合
  const [viewMode, setViewMode] = useState<'stock' | 'sector'>('stock');
  const [data, setData] = useState<StockHeatmap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hoveredSector, setHoveredSector] = useState<TreemapInput<AggregatedSector> | null>(null);
  const [hoveredStock, setHoveredStock] = useState<HeatmapStock | null>(null);
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

  // Interpolate RGB color for a given change percentage (共用：產業聚合 & 個股)
  const getChangeColor = (changePct: number | null): string => {
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

  // === 產業聚合 treemap（一產業一格） ===
  const sectorTiles = useMemo(() => {
    if (aggregatedSectors.length === 0) return [];

    const FLOOR = 0.05;
    const inputs: TreemapInput<AggregatedSector>[] = aggregatedSectors
      .filter((s) => s.change_pct !== null && !isNaN(s.change_pct))
      .map((s) => ({
        key: s.name,
        value: Math.max(Math.abs(s.change_pct!), FLOOR),
        datum: s,
      }));

    return squarify(inputs, CANVAS_W, CANVAS_H);
  }, [aggregatedSectors]);

  // === 個股 finviz 式巢狀 treemap（外層產業、內層個股，皆依成交值） ===
  const stockGroups = useMemo<StockGroup[]>(() => {
    if (!data || !data.stocks) return [];

    // 依產業分組（僅計成交值 > 0 者）
    const groups = new Map<string, HeatmapStock[]>();
    for (const s of data.stocks) {
      if (s.turnover === null || !(s.turnover > 0)) continue;
      const sec = s.sector || '其他';
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec)!.push(s);
    }

    // 外層：一產業一區塊，面積 = 產業成交值合計
    const outerInputs: TreemapInput<{ stocks: HeatmapStock[]; total: number; count: number }>[] = [];
    for (const [sec, list] of groups.entries()) {
      const total = list.reduce((a, b) => a + (b.turnover || 0), 0);
      if (total > 0) {
        outerInputs.push({ key: sec, value: total, datum: { stocks: list, total, count: list.length } });
      }
    }
    if (outerInputs.length === 0) return [];

    const outerTiles = squarify(outerInputs, CANVAS_W, CANVAS_H);

    // 內層：每個產業區塊內，依個股成交值切格
    const result: StockGroup[] = [];
    for (const st of outerTiles) {
      const ix = st.x + GROUP_GAP;
      const iy = st.y + HEADER_H;
      const iw = Math.max(0, st.w - GROUP_GAP * 2);
      const ih = Math.max(0, st.h - HEADER_H - GROUP_GAP);

      let stocks: TreemapTile<HeatmapStock>[] = [];
      if (iw > 2 && ih > 2) {
        const innerInputs: TreemapInput<HeatmapStock>[] = st.item.datum.stocks
          .map((s) => ({ key: s.code, value: Math.max(s.turnover || 0, TINY_FLOOR), datum: s }));
        stocks = squarify(innerInputs, iw, ih).map((t) => ({
          ...t,
          x: t.x + ix,
          y: t.y + iy,
        }));
      }
      result.push({ sector: st, stocks });
    }
    return result;
  }, [data]);

  const handleMouseMove = (e: React.MouseEvent<SVGElement>) => {
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

  const isStockView = viewMode === 'stock';

  return (
    <div className="space-y-6">
      {/* Top Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-zinc-100">產業熱力圖</h2>
            <span className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50 text-[10px] font-mono text-zinc-400 font-medium">
              資料日期: {data.date} {period !== 'day' && data.base_date ? `(基準日: ${data.base_date})` : ''}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            {isStockView
              ? '每格為一檔個股、依產業分區；格子大小＝成交值，顏色深淺＝漲跌方向與強度。點擊個股進入審查頁。'
              : '依產業平均漲跌幅度(絕對值)顯示區塊大小，顏色深淺代表漲跌方向與強度。點擊產業可直接進入該產業總覽。'}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          {/* 檢視模式切換：個股 / 產業 */}
          <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-1">
            <button
              onClick={() => setViewMode('stock')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                isStockView ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              個股
            </button>
            <button
              onClick={() => setViewMode('sector')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                !isStockView ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              產業聚合
            </button>
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
      <div className="relative border border-zinc-800 bg-zinc-900/10 rounded-xl p-3 flex items-center justify-center overflow-hidden">
        <svg
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          className="w-full h-auto rounded-lg select-none"
          onMouseLeave={() => {
            setHoveredSector(null);
            setHoveredStock(null);
          }}
        >
          {isStockView
            ? /* === 個股 finviz 式巢狀 treemap === */
              stockGroups.map((group) => {
                const sec = group.sector;
                const secName = sec.item.key;
                const secCount = sec.item.datum.count;
                return (
                  <g key={secName}>
                    {/* 產業區塊外框 */}
                    <rect
                      x={sec.x}
                      y={sec.y}
                      width={sec.w}
                      height={sec.h}
                      fill="#09090b"
                      stroke="#27272a"
                      strokeWidth={1}
                    />
                    {/* 產業標題列 */}
                    {sec.w > 46 && sec.h > HEADER_H + 6 && (
                      <text
                        x={sec.x + 5}
                        y={sec.y + HEADER_H / 2 + 3}
                        className="fill-zinc-300 font-bold text-[11px] pointer-events-none select-none uppercase tracking-wide"
                      >
                        {getTruncatedName(`${secName} · ${secCount}`, sec.w - 10)}
                      </text>
                    )}
                    {/* 個股格子 */}
                    {group.stocks.map((tile) => {
                      const st = tile.item.datum;
                      const isHovered = hoveredStock?.code === st.code;
                      const color = getChangeColor(st.change_pct);
                      const showLabel = tile.w >= 30 && tile.h >= 18;
                      const showPct = tile.w >= 52 && tile.h >= 34;
                      // 顯示名稱（2330→台積電）；窄格截斷，極窄仍放不下時退回代號
                      const label = getTruncatedName(st.name || st.code, tile.w - 6) || st.code;
                      return (
                        <g key={st.code} className="cursor-pointer">
                          <rect
                            x={tile.x}
                            y={tile.y}
                            width={tile.w}
                            height={tile.h}
                            fill={color}
                            stroke="#121214"
                            strokeWidth={0.75}
                            fillOpacity={isHovered ? 1 : 0.85}
                            onMouseEnter={() => setHoveredStock(st)}
                            onMouseMove={handleMouseMove}
                            onClick={() => navigate(`/stock/${st.code}`)}
                            className="transition-opacity duration-150"
                          />
                          {showLabel && (
                            <g className="pointer-events-none select-none">
                              <text
                                x={tile.x + tile.w / 2}
                                y={tile.y + tile.h / 2 + (showPct ? -5 : 3)}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                className="fill-white font-bold text-[10px]"
                              >
                                {label}
                              </text>
                              {showPct && (
                                <text
                                  x={tile.x + tile.w / 2}
                                  y={tile.y + tile.h / 2 + 9}
                                  textAnchor="middle"
                                  dominantBaseline="middle"
                                  className="fill-zinc-100 font-mono text-[9px]"
                                >
                                  {st.change_pct !== null && st.change_pct >= 0 ? '+' : ''}
                                  {st.change_pct !== null ? st.change_pct.toFixed(2) : '0.00'}%
                                </text>
                              )}
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })
            : /* === 產業聚合 treemap === */
              sectorTiles.map((tile) => {
                const isHovered = hoveredSector?.key === tile.item.key;
                const color = getChangeColor(tile.item.datum.change_pct);
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

        {/* Hover Tooltip — 個股 */}
        {isStockView && hoveredStock && (
          <div
            className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-60 backdrop-blur-sm"
            style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          >
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
              <span className="font-bold text-zinc-100">{hoveredStock.name}</span>
              <span className="font-mono text-zinc-500 text-[10px]">{hoveredStock.code}</span>
            </div>
            <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
              <div>產業:</div>
              <div className="text-zinc-200 text-right truncate">{hoveredStock.sector || '其他'}</div>
              <div>收盤價:</div>
              <div className="text-zinc-200 text-right">
                {hoveredStock.close !== null ? hoveredStock.close.toFixed(2) : '--'}
              </div>
              <div>漲跌幅:</div>
              <div
                className={`text-right font-bold ${
                  hoveredStock.change_pct !== null && hoveredStock.change_pct > 0
                    ? 'text-bull'
                    : hoveredStock.change_pct !== null && hoveredStock.change_pct < 0
                    ? 'text-bear'
                    : 'text-zinc-400'
                }`}
              >
                {hoveredStock.change_pct !== null && hoveredStock.change_pct > 0 ? '+' : ''}
                {hoveredStock.change_pct !== null ? hoveredStock.change_pct.toFixed(2) : '0.00'} %
              </div>
              <div>成交值:</div>
              <div className="text-zinc-200 text-right">
                {hoveredStock.turnover !== null ? formatTurnover(hoveredStock.turnover) : '--'}
              </div>
            </div>
            <div className="text-[10px] text-zinc-500 italic text-center pt-1 border-t border-zinc-900">
              點擊進入【{hoveredStock.name}】審查頁
            </div>
          </div>
        )}

        {/* Hover Tooltip — 產業聚合 */}
        {!isStockView && hoveredSector && (
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
          {isStockView
            ? '* 格子大小依成交值；個股依 TWSE 產業別分區。歷史漲跌幅（週/月）採未還原收盤價計算，若期間經歷除權息可能影響精確度。'
            : '* 歷史漲跌幅（週/月）採未還原收盤價計算，若期間經歷除權息可能影響計算精確度。'}
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
