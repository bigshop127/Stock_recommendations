import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api, type CapitalTideData, type CapitalTideStock } from '../lib/api';
import {
  Waves,
  RefreshCw,
  Search,
  TrendingUp,
  Loader2,
  ChevronRight,
  Info,
  Sliders,
  DollarSign
} from 'lucide-react';

export const CapitalTide: React.FC = () => {
  const [data, setData] = useState<CapitalTideData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStock, setSelectedStock] = useState<CapitalTideStock | null>(null);
  const [hoveredStock, setHoveredStock] = useState<CapitalTideStock | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.marketCapitalTide();
      setData(res);
    } catch (err: any) {
      setError(err.message || '無法取得資金潮汐數據');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Compute quadrant stats
  const stats = useMemo(() => {
    if (!data) return null;
    const stocks = data.stocks;
    const counts = {
      inflow_up: 0,
      inflow_down: 0,
      outflow_up: 0,
      outflow_down: 0,
    };
    stocks.forEach((s) => {
      if (counts[s.quadrant] !== undefined) {
        counts[s.quadrant]++;
      }
    });

    const topBuyers = [...stocks]
      .sort((a, b) => b.flow_raw - a.flow_raw)
      .slice(0, 5);

    const topGainers = [...stocks]
      .sort((a, b) => b.momentum_raw - a.momentum_raw)
      .slice(0, 5);

    return { counts, topBuyers, topGainers };
  }, [data]);

  const handleMouseMove = (e: React.MouseEvent<SVGCircleElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left + 15,
      y: e.clientY - rect.top - 15,
    });
  };

  const getQuadrantLabel = (quad: string) => {
    switch (quad) {
      case 'inflow_up':
        return '資金流入 + 上漲 (強勢偏多)';
      case 'inflow_down':
        return '資金流入 + 下跌 (拉回伺機)';
      case 'outflow_up':
        return '資金流出 + 上漲 (無量拉抬)';
      case 'outflow_down':
        return '資金流出 + 下跌 (弱勢避開)';
      default:
        return '';
    }
  };

  const getQuadrantColorClass = (quad: string) => {
    switch (quad) {
      case 'inflow_up':
        return 'text-bull border-bull/20 bg-bull/5';
      case 'inflow_down':
        return 'text-neutral border-neutral/20 bg-neutral/5';
      case 'outflow_up':
        return 'text-accent border-accent/20 bg-accent/5';
      case 'outflow_down':
        return 'text-bear border-bear/20 bg-bear/5';
      default:
        return 'text-zinc-400 border-zinc-800 bg-zinc-900/50';
    }
  };

  // 座標展布：原始 flow_x / momentum_y 多半擠在中央 (少數極端值把尺度拉大)，
  // 用凹函數 (signed power, 指數 <1) 把靠近 0 的值往外推，明顯降低泡泡重疊、提升可讀性。
  // 指數再壓低 (0.42) 讓中央密集區展得更開。
  const spreadAxis = (v: number) => {
    const c = Math.max(-1, Math.min(1, v));
    return Math.sign(c) * Math.pow(Math.abs(c), 0.42);
  };
  const radiusOf = (s: CapitalTideStock) => 3.5 + s.size * 11;

  // 泡泡防重疊：先依展布函數放置初始座標，再做數次力導鬆弛把互相重疊的泡泡推開，
  // 大幅提升中央密集區的可讀性。位移限制在繪圖框內、僅輕微推移故不破壞象限語意 (顏色仍鎖定原象限)。
  const layout = useMemo(() => {
    if (!data) return new Map<string, { x: number; y: number; r: number }>();
    const pts = data.stocks.map((s) => ({
      code: s.code,
      x: 300 + spreadAxis(s.flow_x) * 250,
      y: 300 - spreadAxis(s.momentum_y) * 250,
      r: radiusOf(s),
    }));
    const PAD = 2; // 泡泡間最小間隙
    const MIN = 56;
    const MAX = 544;
    for (let iter = 0; iter < 80; iter++) {
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = a.r + b.r + PAD;
          if (dist < minDist) {
            if (dist < 0.01) {
              // 完全重合：給一個確定性的微小偏移避免除以零
              dx = (i % 2 === 0 ? 1 : -1) * 0.5;
              dy = (j % 2 === 0 ? 1 : -1) * 0.5;
              dist = 0.7;
            }
            const push = (minDist - dist) / 2;
            const ux = dx / dist;
            const uy = dy / dist;
            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
          }
        }
      }
      // 夾回繪圖框
      for (const p of pts) {
        p.x = Math.max(MIN, Math.min(MAX, p.x));
        p.y = Math.max(MIN, Math.min(MAX, p.y));
      }
    }
    const m = new Map<string, { x: number; y: number; r: number }>();
    for (const p of pts) m.set(p.code, { x: p.x, y: p.y, r: p.r });
    return m;
  }, [data]);

  const plotX = (s: CapitalTideStock) => layout.get(s.code)?.x ?? 300 + spreadAxis(s.flow_x) * 250;
  const plotY = (s: CapitalTideStock) => layout.get(s.code)?.y ?? 300 - spreadAxis(s.momentum_y) * 250;

  const getQuadrantDotColor = (quad: string) => {
    switch (quad) {
      case 'inflow_up':
        return '#ef4444'; // Red
      case 'inflow_down':
        return '#f59e0b'; // Amber
      case 'outflow_up':
        return '#06b6d4'; // Cyan
      case 'outflow_down':
        return '#22c55e'; // Green
      default:
        return '#71717a';
    }
  };

  if (loading) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <span className="text-sm font-medium font-mono text-zinc-400 animate-pulse">
          計算與分析全市場資金潮汐中 (包含 Watchlist 與 0050)...
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto my-12">
        <Waves className="w-12 h-12 text-zinc-600 mb-4" />
        <span className="text-sm text-red-400 font-semibold mb-2">載入資金潮汐資料失敗</span>
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

  return (
    <div className="space-y-6">
      {/* 標題與說明 */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            <Waves className="w-5 h-5 text-primary" />
            資金潮汐與動能分佈觀測
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            二維平面分佈：X 軸為近 5 日三大法人淨買賣超 (張)，Y 軸為近 5 日平均每日漲跌幅 (%)，泡泡大小代表成交值。座標已做視覺展布，將密集於中央的個股向外推開以利閱讀（相對位置不變）。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜尋代號或名稱..."
              className="bg-zinc-900 border border-zinc-850 rounded-lg pl-9 pr-4 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-primary/50 transition-colors w-48"
            />
          </div>
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-semibold hover:bg-zinc-800 transition text-zinc-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新整理
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-7 gap-6">
        {/* 左側：SVG Scatter Plot 泡泡圖 */}
        <div className="xl:col-span-5 bg-card border border-border rounded-xl p-4 relative select-none">
          <div className="absolute top-4 left-4 flex items-center gap-1.5 bg-zinc-950/60 border border-zinc-800/80 px-2.5 py-1 rounded text-[10px] text-zinc-400 font-mono z-10">
            <Info className="w-3 h-3 text-primary" />
            評估範圍: {data.universe} ({data.stocks.length} 檔)
          </div>

          <div className="aspect-square w-full max-w-[92vh] mx-auto relative mt-6">
            <svg viewBox="0 0 600 600" className="w-full h-full overflow-visible">
              {/* 四象限背景 */}
              {/* 右上 (inflow_up) */}
              <rect x="300" y="50" width="250" height="250" className="fill-bull/[0.01]" />
              {/* 左上 (outflow_up) */}
              <rect x="50" y="50" width="250" height="250" className="fill-accent/[0.01]" />
              {/* 右下 (inflow_down) */}
              <rect x="300" y="300" width="250" height="250" className="fill-neutral/[0.01]" />
              {/* 左下 (outflow_down) */}
              <rect x="50" y="300" width="250" height="250" className="fill-bear/[0.01]" />

              {/* 網格虛線 */}
              <line x1="50" y1="175" x2="550" y2="175" stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />
              <line x1="50" y1="425" x2="550" y2="425" stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />
              <line x1="175" y1="50" x2="175" y2="550" stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />
              <line x1="425" y1="50" x2="425" y2="550" stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />

              {/* 十字分隔線 */}
              <line x1="50" y1="300" x2="550" y2="300" stroke="#3f3f46" strokeWidth="1.5" />
              <line x1="300" y1="50" x2="300" y2="550" stroke="#3f3f46" strokeWidth="1.5" />

              {/* 坐標軸箭頭 / 標籤 */}
              <text x="550" y="315" className="fill-zinc-500 font-mono font-semibold text-[10px]" textAnchor="end">
                {data.axes.x.label} 流入 ➔
              </text>
              <text x="50" y="288" className="fill-zinc-500 font-mono font-semibold text-[10px]" textAnchor="start">
                ➦ 流出
              </text>
              <text x="312" y="65" className="fill-zinc-500 font-mono font-semibold text-[10px]" textAnchor="start">
                ▲ {data.axes.y.label} (上漲)
              </text>
              <text x="312" y="540" className="fill-zinc-500 font-mono font-semibold text-[10px]" textAnchor="start">
                ▼ 下跌
              </text>

              {/* 象限名稱標籤 */}
              <text x="535" y="65" className="fill-bull/40 font-bold text-[11px]" textAnchor="end">
                資金流入 + 上漲 (強勢區)
              </text>
              <text x="65" y="65" className="fill-accent/40 font-bold text-[11px]" textAnchor="start">
                資金流出 + 上漲 (無量拉抬)
              </text>
              <text x="535" y="545" className="fill-neutral/40 font-bold text-[11px]" textAnchor="end">
                資金流入 + 下跌 (拉回洗盤)
              </text>
              <text x="65" y="545" className="fill-bear/40 font-bold text-[11px]" textAnchor="start">
                資金流出 + 下跌 (弱勢區)
              </text>

              {/* 繪製泡泡 */}
              {data.stocks.map((stock) => {
                const cx = plotX(stock);
                const cy = plotY(stock);
                const r = layout.get(stock.code)?.r ?? radiusOf(stock);
                const fill = getQuadrantDotColor(stock.quadrant);
                const isMatch = searchQuery
                  ? stock.code.includes(searchQuery) || stock.name.toLowerCase().includes(searchQuery.toLowerCase())
                  : true;

                return (
                  <circle
                    key={stock.code}
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={fill}
                    fillOpacity={isMatch ? (hoveredStock?.code === stock.code ? 0.95 : 0.6) : 0.08}
                    stroke={fill}
                    strokeWidth={hoveredStock?.code === stock.code ? 2 : 1}
                    strokeOpacity={isMatch ? 0.95 : 0.08}
                    className="cursor-pointer transition-all duration-150"
                    onMouseEnter={() => setHoveredStock(stock)}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setHoveredStock(null)}
                    onClick={() => setSelectedStock(selectedStock?.code === stock.code ? null : stock)}
                  />
                );
              })}

              {/* 點擊高亮環 */}
              {selectedStock && (
                <circle
                  cx={plotX(selectedStock)}
                  cy={plotY(selectedStock)}
                  r={(layout.get(selectedStock.code)?.r ?? radiusOf(selectedStock)) + 4}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                  className="animate-pulse"
                />
              )}
            </svg>

            {/* Hover Tooltip (手刻 DOM Tooltip 漂浮在 SVG 上) */}
            {hoveredStock && (
              <div
                className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-56 backdrop-blur-sm"
                style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
              >
                <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
                  <span className="font-bold text-zinc-100">{hoveredStock.name}</span>
                  <span className="font-mono text-zinc-500">{hoveredStock.code}</span>
                </div>
                <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
                  <div>細分產業:</div>
                  <div className="text-zinc-200 text-right truncate">{hoveredStock.sector}</div>
                  <div>強弱評分:</div>
                  <div className="text-zinc-200 text-right">{hoveredStock.strength} 分</div>
                  <div>5日法人超:</div>
                  <div className={`text-right ${hoveredStock.flow_raw >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {hoveredStock.flow_raw >= 0 ? '+' : ''}
                    {hoveredStock.flow_raw.toLocaleString()} 張
                  </div>
                  <div>5日均漲幅:</div>
                  <div className={`text-right ${hoveredStock.momentum_raw >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {hoveredStock.momentum_raw >= 0 ? '+' : ''}
                    {hoveredStock.momentum_raw.toFixed(2)} %/日
                  </div>
                </div>
                <div className="text-[10px] text-zinc-500 italic text-center pt-1 border-t border-zinc-900">
                  點擊以固定在下方看板
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右側面板：強弱分析、法人焦點、動能領先與選定個股 */}
        <div className="space-y-6 xl:col-span-2 min-w-0">
          {/* 1. 選定個股看板 */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Sliders className="w-4 h-4 text-primary" />
              個股潮汐分析
            </h3>
            {selectedStock ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-base font-bold text-zinc-100">{selectedStock.name}</h4>
                    <span className="text-xs font-mono text-zinc-500">{selectedStock.code} · {selectedStock.sector}</span>
                  </div>
                  <Link
                    to={`/stock/${selectedStock.code}`}
                    className="px-3 py-1 bg-primary/10 text-primary hover:bg-primary/20 text-xs font-semibold rounded-md border border-primary/20 transition flex items-center gap-1"
                  >
                    進入審查
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>

                <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30 grid grid-cols-2 gap-4 text-center">
                  <div>
                    <span className="text-[10px] text-zinc-500 block mb-1">5日累計法人買賣</span>
                    <span className={`text-sm font-bold font-mono ${selectedStock.flow_raw >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {selectedStock.flow_raw >= 0 ? '+' : ''}
                      {selectedStock.flow_raw.toLocaleString()} 張
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 block mb-1">5日平均每日漲跌</span>
                    <span className={`text-sm font-bold font-mono ${selectedStock.momentum_raw >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {selectedStock.momentum_raw >= 0 ? '+' : ''}
                      {selectedStock.momentum_raw.toFixed(2)} %/日
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">潮汐位置:</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${getQuadrantColorClass(selectedStock.quadrant)}`}>
                      {getQuadrantLabel(selectedStock.quadrant)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">合成強弱評分:</span>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${selectedStock.strength}%` }}
                        ></div>
                      </div>
                      <span className="font-bold text-zinc-300 font-mono">{selectedStock.strength}/100</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-36 flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-lg text-center p-4">
                <span className="text-xs text-zinc-500">在左側點選任一泡泡</span>
                <span className="text-[10px] text-zinc-600 mt-1">即可在此展開完整資金數據</span>
              </div>
            )}
          </div>

          {/* 2. 象限個股計數 */}
          {stats && (
            <div className="bg-card border border-border rounded-xl p-5">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                象限分佈統計
              </h3>
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="p-3 rounded-lg border border-bull/10 bg-bull/5 flex flex-col justify-between">
                  <span className="text-[10px] text-zinc-500">強勢偏多 (右上)</span>
                  <span className="text-lg font-bold text-bull font-mono mt-1">{stats.counts.inflow_up} 檔</span>
                </div>
                <div className="p-3 rounded-lg border border-neutral/10 bg-neutral/5 flex flex-col justify-between">
                  <span className="text-[10px] text-zinc-500">拉回洗盤 (右下)</span>
                  <span className="text-lg font-bold text-neutral font-mono mt-1">{stats.counts.inflow_down} 檔</span>
                </div>
                <div className="p-3 rounded-lg border border-accent/10 bg-accent/5 flex flex-col justify-between">
                  <span className="text-[10px] text-zinc-500">無量拉抬 (左上)</span>
                  <span className="text-lg font-bold text-accent font-mono mt-1">{stats.counts.outflow_up} 檔</span>
                </div>
                <div className="p-3 rounded-lg border border-bear/10 bg-bear/5 flex flex-col justify-between">
                  <span className="text-[10px] text-zinc-500">弱勢避開 (左下)</span>
                  <span className="text-lg font-bold text-bear font-mono mt-1">{stats.counts.outflow_down} 檔</span>
                </div>
              </div>
            </div>
          )}

          {/* 3. 法人焦點選股榜 */}
          {stats && (
            <div className="bg-card border border-border rounded-xl p-5">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <DollarSign className="w-4 h-4 text-bull" />
                近5日法人買超前 5 名
              </h3>
              <div className="divide-y divide-zinc-800/60 text-xs">
                {stats.topBuyers.map((s, idx) => (
                  <div
                    key={s.code}
                    className="py-2.5 flex items-center justify-between cursor-pointer hover:bg-zinc-800/10 transition px-1 rounded"
                    onClick={() => setSelectedStock(s)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-500 w-4">#{idx + 1}</span>
                      <span className="font-bold text-zinc-200">{s.name}</span>
                      <span className="font-mono text-zinc-500 text-[10px]">{s.code}</span>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-bull font-bold">+{s.flow_raw.toLocaleString()} 張</div>
                      <div className="text-[10px] text-zinc-500">{s.sector}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4. 動能領先選股榜 */}
          {stats && (
            <div className="bg-card border border-border rounded-xl p-5">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-bull" />
                近5日平均漲幅前 5 名
              </h3>
              <div className="divide-y divide-zinc-800/60 text-xs">
                {stats.topGainers.map((s, idx) => (
                  <div
                    key={s.code}
                    className="py-2.5 flex items-center justify-between cursor-pointer hover:bg-zinc-800/10 transition px-1 rounded"
                    onClick={() => setSelectedStock(s)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-500 w-4">#{idx + 1}</span>
                      <span className="font-bold text-zinc-200">{s.name}</span>
                      <span className="font-mono text-zinc-500 text-[10px]">{s.code}</span>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-bull font-bold">+{s.momentum_raw.toFixed(2)} %/日</div>
                      <div className="text-[10px] text-zinc-500">{s.sector}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
