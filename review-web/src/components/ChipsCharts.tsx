import React, { useState } from 'react';
import type { ChipRow } from '../lib/api';

interface ChipsChartsProps {
  data: ChipRow[];
  name: string;
  asOf: string;
}

export const ChipsCharts: React.FC<ChipsChartsProps> = ({ data, name, asOf }) => {
  const [activeTab, setActiveTab] = useState<'institutional' | 'margin' | 'shareholding'>('institutional');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-12 text-xs text-zinc-500 bg-zinc-900/20 rounded-lg border border-border">
        暫無籌碼面資料
      </div>
    );
  }

  // Reverse data if it's not sorted chronologically (latest date should be at the end for chart display)
  const sortedData = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const latestRow = sortedData[sortedData.length - 1];

  // Helper calculations for Cumulative Institutional Net Buy
  const cumulativeNetBuy: number[] = [];
  let currentSum = 0;
  sortedData.forEach((row) => {
    currentSum += row.total_net_buy_qty;
    cumulativeNetBuy.push(currentSum);
  });

  // Calculate stats for tooltips and hover state
  const hoverRow = hoverIndex !== null ? sortedData[hoverIndex] : null;
  const hoverCumNet = hoverIndex !== null ? cumulativeNetBuy[hoverIndex] : null;

  // Chart dimensions
  const svgWidth = 520;
  const svgHeight = 200;
  const paddingLeft = 55;
  const paddingRight = 55;
  const paddingTop = 20;
  const paddingBottom = 30;
  const plotWidth = svgWidth - paddingLeft - paddingRight;
  const plotHeight = svgHeight - paddingTop - paddingBottom;
  const stepX = plotWidth / (sortedData.length - 1 || 1);

  // 1. Institutional Buy/Sell Y-Axis Scale
  const maxInstValue = Math.max(
    ...sortedData.map((d) =>
      Math.max(
        Math.abs(d.foreign_net_buy_qty),
        Math.abs(d.investment_trust_net_buy_qty),
        Math.abs(d.dealer_net_buy_qty),
        Math.abs(d.total_net_buy_qty)
      )
    ),
    1 // avoid division by 0
  );
  const instYScale = maxInstValue * 1.15;

  const maxCumValue = Math.max(
    ...cumulativeNetBuy.map(Math.abs),
    1 // avoid division by 0
  );
  const cumYScale = maxCumValue * 1.15;

  // 2. Margin Y-Axis Scale (Dual Axis)
  const marginBalances = sortedData.map((d) => d.margin_balance);
  const shortBalances = sortedData.map((d) => d.short_balance);
  const maxMargin = Math.max(...marginBalances, 1);
  const minMargin = Math.min(...marginBalances, 0);
  const marginYDiff = maxMargin - minMargin || 1;
  const marginMaxY = maxMargin + marginYDiff * 0.1;
  const marginMinY = Math.max(0, minMargin - marginYDiff * 0.1);

  const maxShort = Math.max(...shortBalances, 1);
  const minShort = Math.min(...shortBalances, 0);
  const shortYDiff = maxShort - minShort || 1;
  const shortMaxY = maxShort + shortYDiff * 0.1;
  const shortMinY = Math.max(0, minShort - shortYDiff * 0.1);

  // 3. Shareholding Ratio Y-Axis Scale
  const validRatios = sortedData.map((d) => d.foreign_holding_ratio).filter((v): v is number => v !== null);
  const hasShareholdingData = validRatios.length > 0;
  const maxRatio = hasShareholdingData ? Math.max(...validRatios) : 100;
  const minRatio = hasShareholdingData ? Math.min(...validRatios) : 0;
  const ratioDiff = maxRatio - minRatio || 1;
  const ratioMaxY = Math.min(100, maxRatio + ratioDiff * 0.15);
  const ratioMinY = Math.max(0, minRatio - ratioDiff * 0.15);

  // Mouse Move Event Handler for Tooltip
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left - paddingLeft;
    if (mouseX < -stepX / 2 || mouseX > plotWidth + stepX / 2) {
      setHoverIndex(null);
      return;
    }
    const idx = Math.max(0, Math.min(sortedData.length - 1, Math.round(mouseX / stepX)));
    setHoverIndex(idx);
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  // Helper formatting functions
  const fmt = (v: number) => {
    if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return v.toFixed(0);
  };

  const formatWithSign = (num: number, unit = '張') => {
    const sign = num > 0 ? '+' : '';
    const color = num > 0 ? 'text-bull' : num < 0 ? 'text-bear' : 'text-zinc-400';
    return <span className={`font-mono font-semibold ${color}`}>{sign}{num.toLocaleString(undefined, { maximumFractionDigits: 1 })}{unit}</span>;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header Cards for Latest Values */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {activeTab === 'institutional' && (
          <>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">外資買賣超</div>
              <div className="text-sm font-semibold mt-1">{formatWithSign(latestRow.foreign_net_buy_qty)}</div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">投信買賣超</div>
              <div className="text-sm font-semibold mt-1">{formatWithSign(latestRow.investment_trust_net_buy_qty)}</div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">自營商買賣超</div>
              <div className="text-sm font-semibold mt-1">{formatWithSign(latestRow.dealer_net_buy_qty)}</div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">三大法人合計</div>
              <div className="text-sm font-semibold mt-1">{formatWithSign(latestRow.total_net_buy_qty)}</div>
            </div>
          </>
        )}

        {activeTab === 'margin' && (
          <>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">融資餘額 / 增減</div>
              <div className="text-sm mt-1 flex flex-wrap items-baseline gap-1.5">
                <span className="font-mono text-zinc-200 font-semibold">{latestRow.margin_balance.toLocaleString()}張</span>
                <span className="text-xs">{formatWithSign(latestRow.margin_change)}</span>
              </div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
              <div className="text-[10px] text-zinc-500 font-medium">融券餘額 / 增減</div>
              <div className="text-sm mt-1 flex flex-wrap items-baseline gap-1.5">
                <span className="font-mono text-zinc-200 font-semibold">{latestRow.short_balance.toLocaleString()}張</span>
                <span className="text-xs">{formatWithSign(latestRow.short_change)}</span>
              </div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 col-span-2">
              <div className="text-[10px] text-zinc-500 font-medium">券資比 (融券/融資)</div>
              <div className="text-sm mt-1 font-mono font-semibold text-zinc-100">
                {latestRow.margin_balance > 0
                  ? `${((latestRow.short_balance / latestRow.margin_balance) * 100).toFixed(2)}%`
                  : '0.00%'}
              </div>
            </div>
          </>
        )}

        {activeTab === 'shareholding' && (
          <>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 col-span-2">
              <div className="text-[10px] text-zinc-500 font-medium">外資持股比率</div>
              <div className="text-sm font-semibold mt-1 font-mono text-zinc-100">
                {latestRow.foreign_holding_ratio !== null ? `${latestRow.foreign_holding_ratio.toFixed(2)}%` : '尚未提供'}
              </div>
            </div>
            <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 col-span-2">
              <div className="text-[10px] text-zinc-500 font-medium">近 {sortedData.length} 日持股增減</div>
              <div className="text-sm font-semibold mt-1">
                {hasShareholdingData
                  ? formatWithSign(
                      (validRatios[validRatios.length - 1] || 0) - (validRatios[0] || 0),
                      '%'
                    )
                  : '—'}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Tabs Selector */}
      <div className="flex border-b border-border/60 mb-4 bg-zinc-950/20 p-0.5 rounded-lg">
        <button
          onClick={() => { setActiveTab('institutional'); setHoverIndex(null); }}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
            activeTab === 'institutional'
              ? 'bg-zinc-800 text-zinc-100 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          三大法人買賣超
        </button>
        <button
          onClick={() => { setActiveTab('margin'); setHoverIndex(null); }}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
            activeTab === 'margin'
              ? 'bg-zinc-800 text-zinc-100 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          信用交易 (融資券)
        </button>
        <button
          onClick={() => { setActiveTab('shareholding'); setHoverIndex(null); }}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
            activeTab === 'shareholding'
              ? 'bg-zinc-800 text-zinc-100 shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          外資持股比
        </button>
      </div>

      {/* Chart Section */}
      <div className="relative flex-1 bg-zinc-950/30 rounded-xl border border-border/40 p-2 min-h-[220px]">
        {activeTab === 'shareholding' && !hasShareholdingData ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 font-medium">
            外資持股比率暫無資料
          </div>
        ) : (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            preserveAspectRatio="xMidYMid meet"
            className="overflow-visible select-none cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            {/* Definitions for Gradients */}
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#818cf8" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#818cf8" stopOpacity="0.00" />
              </linearGradient>
            </defs>

            {/* Grid Lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((val) => {
              const y = paddingTop + val * plotHeight;
              return (
                <line
                  key={val}
                  x1={paddingLeft}
                  y1={y}
                  x2={svgWidth - paddingRight}
                  y2={y}
                  stroke="#27272a"
                  strokeWidth="1"
                  strokeDasharray="2,2"
                />
              );
            })}

            {/* Tab-Specific Chart Rendering */}
            {activeTab === 'institutional' && (
              <>
                {/* Zero line */}
                <line
                  x1={paddingLeft}
                  y1={paddingTop + plotHeight / 2}
                  x2={svgWidth - paddingRight}
                  y2={paddingTop + plotHeight / 2}
                  stroke="#3f3f46"
                  strokeWidth="1"
                />

                {/* Y-Axis Left (張) - Daily Bars */}
                <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(instYScale)}
                </text>
                <text x={paddingLeft - 8} y={paddingTop + plotHeight / 2 + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  0
                </text>
                <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  -{fmt(instYScale)}
                </text>

                {/* Y-Axis Right (張) - Cumulative Line */}
                <text x={svgWidth - paddingRight + 8} y={paddingTop + 4} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(cumYScale)}
                </text>
                <text x={svgWidth - paddingRight + 8} y={paddingTop + plotHeight + 3} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                  -{fmt(cumYScale)}
                </text>

                {/* Stacked Bars */}
                {sortedData.map((row, idx) => {
                  const x = paddingLeft + idx * stepX;
                  const barWidth = Math.max(3, Math.min(10, stepX * 0.45));

                  // Positive & negative components
                  const posComponents: { val: number; color: string }[] = [];
                  const negComponents: { val: number; color: string }[] = [];

                  if (row.foreign_net_buy_qty >= 0) posComponents.push({ val: row.foreign_net_buy_qty, color: '#818cf8' });
                  else negComponents.push({ val: row.foreign_net_buy_qty, color: '#6366f1' });

                  if (row.investment_trust_net_buy_qty >= 0) posComponents.push({ val: row.investment_trust_net_buy_qty, color: '#ec4899' });
                  else negComponents.push({ val: row.investment_trust_net_buy_qty, color: '#db2777' });

                  if (row.dealer_net_buy_qty >= 0) posComponents.push({ val: row.dealer_net_buy_qty, color: '#14b8a6' });
                  else negComponents.push({ val: row.dealer_net_buy_qty, color: '#0d9488' });

                  const zeroY = paddingTop + plotHeight / 2;

                  // Render positive stack
                  let currentPosOffset = 0;
                  const posBars = posComponents.map((item, cidx) => {
                    const h = (item.val / instYScale) * (plotHeight / 2);
                    const rectY = zeroY - currentPosOffset - h;
                    currentPosOffset += h;
                    return (
                      <rect
                        key={`pos-${idx}-${cidx}`}
                        x={x - barWidth / 2}
                        y={rectY}
                        width={barWidth}
                        height={Math.max(1, h)}
                        fill={item.color}
                        opacity={hoverIndex === null || hoverIndex === idx ? 1 : 0.4}
                      />
                    );
                  });

                  // Render negative stack
                  let currentNegOffset = 0;
                  const negBars = negComponents.map((item, cidx) => {
                    const h = (Math.abs(item.val) / instYScale) * (plotHeight / 2);
                    const rectY = zeroY + currentNegOffset;
                    currentNegOffset += h;
                    return (
                      <rect
                        key={`neg-${idx}-${cidx}`}
                        x={x - barWidth / 2}
                        y={rectY}
                        width={barWidth}
                        height={Math.max(1, h)}
                        fill={item.color}
                        opacity={hoverIndex === null || hoverIndex === idx ? 1 : 0.4}
                      />
                    );
                  });

                  return (
                    <g key={`bar-group-${idx}`}>
                      {posBars}
                      {negBars}
                    </g>
                  );
                })}

                {/* Cumulative Line */}
                {(() => {
                  const points = cumulativeNetBuy.map((val, idx) => {
                    const x = paddingLeft + idx * stepX;
                    const y = paddingTop + plotHeight / 2 - (val / cumYScale) * (plotHeight / 2);
                    return `${x},${y}`;
                  }).join(' ');

                  return (
                    <polyline
                      points={points}
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth="1.75"
                      opacity={hoverIndex === null ? 0.85 : 0.4}
                    />
                  );
                })()}

                {/* Cumulative line points */}
                {cumulativeNetBuy.map((val, idx) => {
                  const x = paddingLeft + idx * stepX;
                  const y = paddingTop + plotHeight / 2 - (val / cumYScale) * (plotHeight / 2);
                  return (
                    <circle
                      key={`cum-dot-${idx}`}
                      cx={x}
                      cy={y}
                      r={hoverIndex === idx ? 3.5 : 2}
                      fill="#f59e0b"
                      stroke="#09090b"
                      strokeWidth="1"
                    />
                  );
                })}
              </>
            )}

            {activeTab === 'margin' && (
              <>
                {/* Y-Axis Left (Margin - 融資) */}
                <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(marginMaxY)}
                </text>
                <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(marginMinY)}
                </text>

                {/* Y-Axis Right (Short - 融券) */}
                <text x={svgWidth - paddingRight + 8} y={paddingTop + 4} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(shortMaxY)}
                </text>
                <text x={svgWidth - paddingRight + 8} y={paddingTop + plotHeight + 3} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                  {fmt(shortMinY)}
                </text>

                {/* Margin line (Blue) */}
                {(() => {
                  const points = sortedData.map((d, idx) => {
                    const x = paddingLeft + idx * stepX;
                    const y = paddingTop + plotHeight - ((d.margin_balance - marginMinY) / (marginMaxY - marginMinY || 1)) * plotHeight;
                    return `${x},${y}`;
                  }).join(' ');

                  return <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="1.75" opacity={hoverIndex === null ? 0.9 : 0.4} />;
                })()}

                {/* Short line (Yellow) */}
                {(() => {
                  const points = sortedData.map((d, idx) => {
                    const x = paddingLeft + idx * stepX;
                    const y = paddingTop + plotHeight - ((d.short_balance - shortMinY) / (shortMaxY - shortMinY || 1)) * plotHeight;
                    return `${x},${y}`;
                  }).join(' ');

                  return <polyline points={points} fill="none" stroke="#f59e0b" strokeWidth="1.75" opacity={hoverIndex === null ? 0.9 : 0.4} />;
                })()}

                {/* Active Dots */}
                {sortedData.map((d, idx) => {
                  if (hoverIndex !== idx) return null;
                  const x = paddingLeft + idx * stepX;
                  const yMargin = paddingTop + plotHeight - ((d.margin_balance - marginMinY) / (marginMaxY - marginMinY || 1)) * plotHeight;
                  const yShort = paddingTop + plotHeight - ((d.short_balance - shortMinY) / (shortMaxY - shortMinY || 1)) * plotHeight;
                  return (
                    <g key={`dots-${idx}`}>
                      <circle cx={x} cy={yMargin} r="4" fill="#3b82f6" stroke="#09090b" strokeWidth="1" />
                      <circle cx={x} cy={yShort} r="4" fill="#f59e0b" stroke="#09090b" strokeWidth="1" />
                    </g>
                  );
                })}
              </>
            )}

            {activeTab === 'shareholding' && hasShareholdingData && (
              <>
                {/* Y-Axis Left (Ratio %) */}
                <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  {ratioMaxY.toFixed(2)}%
                </text>
                <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                  {ratioMinY.toFixed(2)}%
                </text>

                {/* Area Gradient */}
                {(() => {
                  const linePoints = sortedData.map((d, idx) => {
                    const val = d.foreign_holding_ratio ?? ratioMinY;
                    const x = paddingLeft + idx * stepX;
                    const y = paddingTop + plotHeight - ((val - ratioMinY) / (ratioMaxY - ratioMinY || 1)) * plotHeight;
                    return `${x},${y}`;
                  });

                  const pathData = `M ${paddingLeft},${paddingTop + plotHeight} L ${linePoints.join(' L ')} L ${svgWidth - paddingRight},${paddingTop + plotHeight} Z`;

                  return <path d={pathData} fill="url(#areaGradient)" />;
                })()}

                {/* Line (Indigo) */}
                {(() => {
                  const points = sortedData.map((d, idx) => {
                    const val = d.foreign_holding_ratio ?? ratioMinY;
                    const x = paddingLeft + idx * stepX;
                    const y = paddingTop + plotHeight - ((val - ratioMinY) / (ratioMaxY - ratioMinY || 1)) * plotHeight;
                    return `${x},${y}`;
                  }).join(' ');

                  return <polyline points={points} fill="none" stroke="#818cf8" strokeWidth="2" opacity={hoverIndex === null ? 0.95 : 0.4} />;
                })()}

                {/* Active Dot */}
                {sortedData.map((d, idx) => {
                  if (hoverIndex !== idx || d.foreign_holding_ratio === null) return null;
                  const x = paddingLeft + idx * stepX;
                  const y = paddingTop + plotHeight - ((d.foreign_holding_ratio - ratioMinY) / (ratioMaxY - ratioMinY || 1)) * plotHeight;
                  return (
                    <circle key={`ratio-dot-${idx}`} cx={x} cy={y} r="4" fill="#818cf8" stroke="#09090b" strokeWidth="1" />
                  );
                })}
              </>
            )}

            {/* X-Axis Date Labels (Only first, middle, last) */}
            {(() => {
              const count = sortedData.length;
              if (count === 0) return null;
              const indices = [0, Math.floor(count / 2), count - 1];
              return indices.map((idx) => {
                const row = sortedData[idx];
                const x = paddingLeft + idx * stepX;
                let textAnchor: 'start' | 'middle' | 'end' = 'middle';
                if (idx === 0) textAnchor = 'start';
                if (idx === count - 1) textAnchor = 'end';

                return (
                  <text
                    key={`date-lbl-${idx}`}
                    x={x}
                    y={paddingTop + plotHeight + 14}
                    textAnchor={textAnchor}
                    className="fill-zinc-500 font-mono text-[9px]"
                  >
                    {row.date.slice(5)}
                  </text>
                );
              });
            })()}

            {/* Vertical Tracker Line on Hover */}
            {hoverIndex !== null && (
              <line
                x1={paddingLeft + hoverIndex * stepX}
                y1={paddingTop}
                x2={paddingLeft + hoverIndex * stepX}
                y2={paddingTop + plotHeight}
                stroke="#52525b"
                strokeWidth="1.2"
                strokeDasharray="3,3"
              />
            )}
          </svg>
        )}

        {/* Floating Tooltip Component */}
        {hoverIndex !== null && hoverRow && (
          <div
            className={`absolute top-2 z-10 p-2.5 rounded-lg border border-border bg-zinc-950/95 shadow-xl text-[10px] w-[160px] pointer-events-none flex flex-col gap-1 ${
              hoverIndex > sortedData.length / 2 ? 'left-16' : 'right-16'
            }`}
          >
            <div className="font-mono text-zinc-400 font-bold border-b border-border/50 pb-1 flex justify-between">
              <span>{hoverRow.date}</span>
              {activeTab === 'institutional' && (
                <span className="text-zinc-500 font-normal">單位: 張</span>
              )}
            </div>

            {activeTab === 'institutional' && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-400">外資買賣超</span>
                  <span className={hoverRow.foreign_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.foreign_net_buy_qty > 0 ? '+' : ''}
                    {hoverRow.foreign_net_buy_qty.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-400">投信買賣超</span>
                  <span className={hoverRow.investment_trust_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.investment_trust_net_buy_qty > 0 ? '+' : ''}
                    {hoverRow.investment_trust_net_buy_qty.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-400">自營買賣超</span>
                  <span className={hoverRow.dealer_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.dealer_net_buy_qty > 0 ? '+' : ''}
                    {hoverRow.dealer_net_buy_qty.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                </div>
                <div className="flex justify-between font-mono border-t border-border/30 pt-1 mt-0.5 font-bold">
                  <span className="text-zinc-300">合計買賣超</span>
                  <span className={hoverRow.total_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.total_net_buy_qty > 0 ? '+' : ''}
                    {hoverRow.total_net_buy_qty.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                </div>
                <div className="flex justify-between font-mono text-zinc-300 font-medium">
                  <span className="text-amber-500">累計買賣超</span>
                  <span className={(hoverCumNet ?? 0) >= 0 ? 'text-bull' : 'text-bear'}>
                    {(hoverCumNet ?? 0) > 0 ? '+' : ''}
                    {(hoverCumNet ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                </div>
              </div>
            )}

            {activeTab === 'margin' && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-400">融資餘額</span>
                  <span className="text-zinc-200 font-semibold">{hoverRow.margin_balance.toLocaleString()} 張</span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-500 text-[9px] pl-2">當日增減</span>
                  <span className={hoverRow.margin_change >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.margin_change > 0 ? '+' : ''}
                    {hoverRow.margin_change.toLocaleString()} 張
                  </span>
                </div>
                <div className="flex justify-between font-mono mt-0.5">
                  <span className="text-zinc-400">融券餘額</span>
                  <span className="text-zinc-200 font-semibold">{hoverRow.short_balance.toLocaleString()} 張</span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-zinc-500 text-[9px] pl-2">當日增減</span>
                  <span className={hoverRow.short_change >= 0 ? 'text-bull' : 'text-bear'}>
                    {hoverRow.short_change > 0 ? '+' : ''}
                    {hoverRow.short_change.toLocaleString()} 張
                  </span>
                </div>
                <div className="flex justify-between font-mono border-t border-border/30 pt-1 mt-0.5 font-bold">
                  <span className="text-zinc-300">券資比</span>
                  <span className="text-zinc-100">
                    {hoverRow.margin_balance > 0
                      ? `${((hoverRow.short_balance / hoverRow.margin_balance) * 100).toFixed(2)}%`
                      : '0.00%'}
                  </span>
                </div>
              </div>
            )}

            {activeTab === 'shareholding' && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                <div className="flex justify-between font-mono font-bold">
                  <span className="text-zinc-400">外資持股比</span>
                  <span className="text-indigo-400">
                    {hoverRow.foreign_holding_ratio !== null
                      ? `${hoverRow.foreign_holding_ratio.toFixed(2)}%`
                      : '—'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend Information */}
      <div className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 justify-center text-[10px] text-zinc-500">
        {activeTab === 'institutional' && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-1.5 bg-[#818cf8] rounded-sm"></span>
              <span>外資</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-1.5 bg-[#ec4899] rounded-sm"></span>
              <span>投信</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-1.5 bg-[#14b8a6] rounded-sm"></span>
              <span>自營商</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-[#fbbf24] inline-block"></span>
              <span>累計淨買超</span>
            </div>
          </>
        )}

        {activeTab === 'margin' && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-[#3b82f6] inline-block"></span>
              <span>融資餘額 (左軸)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-[#f59e0b] inline-block"></span>
              <span>融券餘額 (右軸)</span>
            </div>
          </>
        )}

        {activeTab === 'shareholding' && hasShareholdingData && (
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 bg-[#818cf8] inline-block"></span>
            <span>持股比率 (%)</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 ml-auto text-[9px] text-zinc-600 font-mono">
          <span>{name} ({asOf}) 盤後資料</span>
        </div>
      </div>
    </div>
  );
};
