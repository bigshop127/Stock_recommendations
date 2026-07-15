import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, type StockHeatmap, type HeatmapStock } from '../lib/api';
import { squarify, type TreemapInput } from '../lib/treemap';
import { CODE_TO_GROUP } from '../lib/stockGroups';
import { isCuratedGroup } from '../lib/groupHeatmap';
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  AlertCircle,
  LayoutGrid,
  Info,
  TrendingUp,
  TrendingDown,
  Minus,
  DollarSign,
  Layers,
  Calendar
} from 'lucide-react';

export const GroupDetail: React.FC = () => {
  const { name } = useParams<{ name: string }>();
  const groupName = useMemo(() => {
    try {
      return decodeURIComponent(name || '');
    } catch {
      return name || '';
    }
  }, [name]);
  
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialPeriod = (searchParams.get('period') as 'day' | 'week' | 'month') || 'day';
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(
    ['day', 'week', 'month'].includes(initialPeriod) ? initialPeriod : 'day'
  );

  const [data, setData] = useState<StockHeatmap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hoveredStock, setHoveredStock] = useState<TreemapInput<HeatmapStock> | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handlePeriodChange = (newPeriod: 'day' | 'week' | 'month') => {
    setPeriod(newPeriod);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('period', newPeriod);
      return next;
    }, { replace: true });
  };

  const fetchData = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.marketStockHeatmap({ period }, force);
      setData(res);
    } catch (err: any) {
      setError(err.message || '無法取得族群個股資料');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [period]);

  // Check if group exists in curated STOCK_GROUPS
  const groupExists = useMemo(() => isCuratedGroup(groupName), [groupName]);

  // Filter components in this group using CODE_TO_GROUP
  const groupStocks = useMemo<HeatmapStock[]>(() => {
    if (!data || !data.stocks) return [];
    return data.stocks.filter((s) => {
      const ref = CODE_TO_GROUP.get(s.code);
      return ref?.group === groupName;
    });
  }, [data, groupName]);

  // Key Metrics
  const metrics = useMemo(() => {
    if (groupStocks.length === 0) {
      return { avgChangePct: null, totalTurnover: 0, count: 0 };
    }
    let sumPct = 0;
    let countPct = 0;
    let totalTurnover = 0;

    for (const s of groupStocks) {
      if (s.change_pct !== null && !isNaN(s.change_pct)) {
        sumPct += s.change_pct;
        countPct += 1;
      }
      if (s.turnover !== null && !isNaN(s.turnover)) {
        totalTurnover += s.turnover;
      }
    }

    return {
      avgChangePct: countPct > 0 ? sumPct / countPct : null,
      totalTurnover,
      count: groupStocks.length,
    };
  }, [groupStocks]);

  const formatTurnover = (turnover: number): string => {
    if (turnover >= 1e12) {
      return `${(turnover / 1e12).toFixed(2)} 兆`;
    }
    if (turnover >= 1e8) {
      return `${(turnover / 1e8).toFixed(2)} 億`;
    }
    return `${turnover.toLocaleString()} 元`;
  };

  const getStockColor = (changePct: number | null): string => {
    if (changePct === null || isNaN(changePct)) {
      return '#3f3f46';
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

  // Treemap calculation for individual stocks in this group
  const tiles = useMemo(() => {
    if (groupStocks.length === 0) return [];

    const FLOOR = 0.05;
    const inputs: TreemapInput[] = groupStocks
      .filter((s) => s.change_pct !== null && !isNaN(s.change_pct))
      .map((s) => ({
        key: s.code,
        value: Math.max(Math.abs(s.change_pct!), FLOOR),
        datum: s,
      }));

    return squarify(inputs, 1000, 600);
  }, [groupStocks]);

  const handleMouseMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left + 15,
      y: e.clientY - rect.top - 15,
    });
  };

  if (loading) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <span className="text-sm font-medium font-mono text-zinc-400 animate-pulse">
          載入【{groupName}】族群熱力圖中...
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto my-12">
        <AlertCircle className="w-12 h-12 text-zinc-600 mb-4" />
        <span className="text-sm text-red-400 font-semibold mb-2">載入族群資料失敗</span>
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

  if (!groupExists) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto my-12">
        <LayoutGrid className="w-12 h-12 text-zinc-600 mb-4" />
        <span className="text-sm text-zinc-300 font-semibold mb-2">查無此族群：{groupName}</span>
        <span className="text-xs text-zinc-500 font-mono mb-6">全市場熱力圖數據中無此自建族群</span>
        <Link
          to={`/heatmap?period=${period}&view=group`}
          className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-semibold transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回熱力圖
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Navigation Breadcrumb & Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Link
            to={`/heatmap?period=${period}&view=group`}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-primary transition mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            返回熱力圖
          </Link>
          <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
            {groupName}
            <span className="text-xs font-normal font-mono text-zinc-500 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800">
              自建族群
            </span>
          </h2>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => fetchData(true)}
            className="p-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all shadow-sm"
            title="重新整理"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          {/* Period Selector */}
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

      {/* Metric Cards Grid ×4 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: 族群平均漲跌% */}
        <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>族群平均漲跌幅</span>
            {metrics.avgChangePct === null ? (
              <Minus className="w-4 h-4 text-zinc-500" />
            ) : metrics.avgChangePct > 0 ? (
              <TrendingUp className="w-4 h-4 text-bull" />
            ) : (
              <TrendingDown className="w-4 h-4 text-bear" />
            )}
          </div>
          <div
            className={`text-xl font-bold font-mono ${
              metrics.avgChangePct !== null && metrics.avgChangePct > 0
                ? 'text-bull'
                : metrics.avgChangePct !== null && metrics.avgChangePct < 0
                ? 'text-bear'
                : 'text-zinc-300'
            }`}
          >
            {metrics.avgChangePct === null ? (
              '--'
            ) : (
              <>
                {metrics.avgChangePct > 0 ? '+' : ''}
                {metrics.avgChangePct.toFixed(2)} %
              </>
            )}
          </div>
        </div>

        {/* Card 2: 成交值合計 */}
        <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>成交值合計</span>
            <DollarSign className="w-4 h-4 text-zinc-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-100">
            {formatTurnover(metrics.totalTurnover)}
          </div>
        </div>

        {/* Card 3: 成分檔數 */}
        <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>成分股檔數</span>
            <Layers className="w-4 h-4 text-zinc-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-100">
            {metrics.count} <span className="text-xs font-normal text-zinc-500">檔</span>
          </div>
        </div>

        {/* Card 4: 資料日期 */}
        <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>資料日期</span>
            <Calendar className="w-4 h-4 text-zinc-500" />
          </div>
          <div className="text-sm font-bold font-mono text-zinc-200 truncate">
            {data.date}
          </div>
          {period !== 'day' && data.base_date && (
            <div className="text-[10px] font-mono text-zinc-500">
              基準日: {data.base_date}
            </div>
          )}
        </div>
      </div>

      {/* Main Stock Treemap Canvas */}
      <div className="relative border border-zinc-800 bg-zinc-900/10 rounded-xl p-4 flex items-center justify-center overflow-hidden">
        {/* 空態一律以 tiles（可繪製格子）判定：成分股全為除權息／無成交時 change_pct 皆為 null，
            groupStocks 非空但 tiles 為空，若只看 groupStocks 會畫出空白畫布 */}
        {tiles.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6">
            <LayoutGrid className="w-8 h-8 text-zinc-700 mb-3" />
            {groupStocks.length === 0 ? (
              <>
                <span className="text-sm text-zinc-400 font-semibold mb-1">本期間內無上市成分股交易資料</span>
                <span className="text-xs text-zinc-500 font-mono">
                  該族群成分股可能皆為上櫃股票（如：世界先進、雙鴻、合晶、華星光等），本站目前僅收錄上市（TWSE）個股。
                </span>
              </>
            ) : (
              <>
                <span className="text-sm text-zinc-400 font-semibold mb-1">本期間內成分股皆無漲跌幅資料</span>
                <span className="text-xs text-zinc-500 font-mono">
                  該族群 {groupStocks.length} 檔上市成分股於本期間皆無漲跌幅（可能為除權息或無成交），故無法繪製熱力圖。
                </span>
              </>
            )}
          </div>
        ) : (
          <svg viewBox="0 0 1000 600" className="w-full h-auto rounded-lg select-none">
            {tiles.map((tile) => {
              const stock: HeatmapStock = tile.item.datum;
              const isHovered = hoveredStock?.key === tile.item.key;
              const color = getStockColor(stock.change_pct);
              const changePct = stock.change_pct;

              return (
                <g key={stock.code} className="cursor-pointer">
                  <rect
                    x={tile.x}
                    y={tile.y}
                    width={tile.w}
                    height={tile.h}
                    fill={color}
                    stroke="#121214"
                    strokeWidth={1}
                    fillOpacity={isHovered ? 0.95 : 0.82}
                    onMouseEnter={() => setHoveredStock(tile.item)}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setHoveredStock(null)}
                    onClick={() => navigate(`/stock/${stock.code}`)}
                    className="transition-colors duration-150"
                  />

                  {/* Text Labels based on tile dimensions */}
                  {tile.w > 70 && tile.h > 40 ? (
                    <g className="pointer-events-none select-none">
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2 - 8}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-white font-bold text-xs"
                      >
                        {stock.name}
                      </text>
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2 + 5}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-zinc-300 font-mono text-[10px]"
                      >
                        {stock.code}
                      </text>
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2 + 17}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-zinc-100 font-mono text-[10px] font-bold"
                      >
                        {changePct !== null && changePct >= 0 ? '+' : ''}
                        {changePct !== null ? changePct.toFixed(2) : '0.00'}%
                      </text>
                    </g>
                  ) : tile.w >= 36 && tile.h >= 24 ? (
                    <g className="pointer-events-none select-none">
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2 - 4}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-white font-semibold text-[10px]"
                      >
                        {stock.name}
                      </text>
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2 + 8}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-zinc-200 font-mono text-[9px]"
                      >
                        {changePct !== null && changePct >= 0 ? '+' : ''}
                        {changePct !== null ? changePct.toFixed(1) : '0'}%
                      </text>
                    </g>
                  ) : tile.w >= 24 && tile.h >= 16 ? (
                    <g className="pointer-events-none select-none">
                      <text
                        x={tile.x + tile.w / 2}
                        y={tile.y + tile.h / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-white font-mono text-[9px]"
                      >
                        {stock.code}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
        )}

        {/* Hover Tooltip */}
        {hoveredStock && (
          <div
            className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-56 backdrop-blur-sm"
            style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          >
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
              <span className="font-bold text-zinc-100">
                {hoveredStock.datum.name} ({hoveredStock.datum.code})
              </span>
              <span className="font-mono text-zinc-500 text-[10px]">
                {period === 'day' ? '單日' : period === 'week' ? '單週' : '單月'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
              <div>收盤價:</div>
              <div className="text-zinc-200 text-right">
                {hoveredStock.datum.close !== null ? `${hoveredStock.datum.close} 元` : '無資料'}
              </div>
              <div>漲跌幅:</div>
              <div
                className={`text-right font-bold ${
                  hoveredStock.datum.change_pct !== null && hoveredStock.datum.change_pct > 0
                    ? 'text-bull'
                    : hoveredStock.datum.change_pct !== null && hoveredStock.datum.change_pct < 0
                    ? 'text-bear'
                    : 'text-zinc-400'
                }`}
              >
                {hoveredStock.datum.change_pct !== null && hoveredStock.datum.change_pct > 0 ? '+' : ''}
                {hoveredStock.datum.change_pct !== null ? hoveredStock.datum.change_pct.toFixed(2) : '0.00'} %
              </div>
              <div>成交金額:</div>
              <div className="text-zinc-200 text-right">
                {hoveredStock.datum.turnover !== null ? formatTurnover(hoveredStock.datum.turnover) : '無資料'}
              </div>
            </div>
            <div className="text-[10px] text-primary italic text-center pt-1 border-t border-zinc-900 font-medium">
              點擊進入個股深度審視 →
            </div>
          </div>
        )}
      </div>

      {/* Notice & Legend Panel */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 border border-zinc-800 bg-zinc-900/20 rounded-xl">
        <div className="text-[11px] text-zinc-500 leading-relaxed space-y-1">
          <div>* 族群分類為<strong>本站自建</strong>（公開常識），非官方分類；官方產業別另見「產業聚合」檢視。</div>
          <div>* <strong>僅上市（TWSE），不含上櫃</strong>。</div>
          <div>* 區塊面積代表個股漲跌幅絕對值。歷史漲跌幅（週/月）採未還原收盤價計算，若期間經歷除權息可能影響計算精確度。</div>
        </div>
        <div className="shrink-0 w-full sm:w-64">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Info className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-400 font-medium">個股漲跌強度色階</span>
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
