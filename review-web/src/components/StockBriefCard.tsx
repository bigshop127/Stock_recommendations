import React, { useState } from 'react';
import type { StockBrief } from '../lib/stockBrief';
import { ChevronDown, ChevronUp, AlertCircle, CheckCircle2, XCircle, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react';

export interface StockBriefCardProps {
  brief: StockBrief;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export const StockBriefCard: React.FC<StockBriefCardProps> = ({ brief, loading, error, onRetry }) => {
  const [collapsed, setCollapsed] = useState(false);

  if (loading) {
    return (
      <div className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 mb-6 animate-pulse">
        <div className="flex justify-between items-center mb-4">
          <div className="h-6 w-48 bg-zinc-800 rounded"></div>
          <div className="h-6 w-24 bg-zinc-800 rounded"></div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-4">
            <div className="h-16 bg-zinc-800/60 rounded-lg"></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="h-32 bg-zinc-800/60 rounded-lg"></div>
              <div className="h-32 bg-zinc-800/60 rounded-lg"></div>
            </div>
          </div>
          <div className="lg:col-span-5 h-64 bg-zinc-800/40 rounded-lg flex items-center justify-center">
            <div className="w-40 h-40 rounded-full border-2 border-zinc-700 border-dashed animate-spin"></div>
          </div>
        </div>
      </div>
    );
  }

  const { overall, action, stateLabel, headline, forces, plus, minus, checkpoints, invalidation, asOf, degraded } = brief;

  // 訊號失敗不該讓整卡全滅：動能/基本面/觀察點來自 K線與基本面，與 blended 無關。
  // 只有連這些可用區塊都算不出來時，才走整卡硬錯誤；否則降級顯示（規格 §6：blended 缺 → 灰態＋重試）。
  const hasUsable = forces.some(f => f.score !== null) || checkpoints.length > 0 || plus.length > 0 || minus.length > 0;

  if (error && !hasUsable) {
    return (
      <div className="w-full bg-red-950/20 border border-red-900/40 rounded-xl p-6 mb-6 text-zinc-300">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-400 font-medium">
            <AlertCircle className="w-5 h-5" />
            <span>無法載入研究摘要卡資料</span>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 text-xs bg-red-900/40 hover:bg-red-800/50 text-red-200 px-3 py-1.5 rounded border border-red-700/50 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 重試
            </button>
          )}
        </div>
      </div>
    );
  }

  // Radar Chart Calculations
  const cx = 140;
  const cy = 135;
  const R = 85;
  const numAxes = 5;

  const getAxisAngle = (i: number) => (i * 2 * Math.PI / numAxes) - (Math.PI / 2);

  // 4 Grid rings: 25, 50, 75, 100
  const gridRings = [0.25, 0.5, 0.75, 1.0];

  const dataPoints = forces.map((f, i) => {
    const angle = getAxisAngle(i);
    const scoreVal = f.score !== null && !isNaN(f.score) ? Math.max(0, Math.min(100, f.score)) : 0;
    const r = (scoreVal / 100) * R;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    return { x, y, score: f.score, angle };
  });

  const polygonPointsStr = dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const getActionBadge = (act: string | null) => {
    if (!act) return null;
    const uAct = act.toUpperCase();
    if (uAct === 'BUY') {
      return (
        <span className="px-2.5 py-0.5 rounded text-xs font-bold tracking-wide bg-red-500/15 text-red-400 border border-red-500/30">
          買進 BUY
        </span>
      );
    }
    if (uAct === 'SELL') {
      return (
        <span className="px-2.5 py-0.5 rounded text-xs font-bold tracking-wide bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          賣出 SELL
        </span>
      );
    }
    return (
      <span className="px-2.5 py-0.5 rounded text-xs font-bold tracking-wide bg-zinc-800 text-zinc-300 border border-zinc-700">
        {uAct}
      </span>
    );
  };

  return (
    <div className="w-full bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 md:p-6 mb-6 shadow-xl backdrop-blur-sm">
      {/* Disclaimer Top & Collapse Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/60 pb-3 mb-4 text-xs">
        <div className="flex items-center gap-2 text-zinc-400">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="font-medium text-zinc-300">個股研究摘要卡</span>
          <span className="text-zinc-500">|</span>
          <span className="text-zinc-500">本摘要為當日收盤後計算，數值不會隨盤中即時行情變動</span>
        </div>
        <div className="flex items-center gap-3">
          {asOf && <span className="text-zinc-500 text-[11px]">資料日期: {asOf}</span>}
          <button
            onClick={() => setCollapsed(prev => !prev)}
            className="text-zinc-400 hover:text-zinc-200 p-1 rounded hover:bg-zinc-800 transition-colors"
            title={collapsed ? "展開摘要卡" : "折疊摘要卡"}
          >
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Degraded / Signal-error Banner（規格 §6：blended 缺 → 灰態＋重試） */}
          {(degraded || error) && (
            <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 mb-4 text-amber-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                {error
                  ? '綜合訊號暫時無法取得（上游限流／逾時），以下為可計算之區塊（動能／基本面／觀察點）。'
                  : '訊號資料不足或無法取得，摘要卡呈現降級狀態。'}
              </span>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="ml-auto shrink-0 flex items-center gap-1 bg-amber-900/40 hover:bg-amber-800/50 text-amber-200 px-2.5 py-1 rounded border border-amber-700/50 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 重試
                </button>
              )}
            </div>
          )}

          {/* Main Layout: Desktop 2 Columns, Mobile 1 Column */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column (Desktop 7 Cols): Action/Pill + Headline + Plus/Minus Bullets */}
            <div className="lg:col-span-7 flex flex-col gap-4 order-2 lg:order-1">
              {/* Desktop Header row for score & pill if on larger screen */}
              <div className="hidden lg:flex items-center gap-3 flex-wrap">
                {getActionBadge(action)}
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700">
                  {stateLabel}
                </span>
              </div>

              {/* Headline Block */}
              <div className="bg-gradient-to-r from-zinc-800/80 to-zinc-900/80 border border-zinc-700/60 rounded-xl p-4 shadow-inner">
                <p className="text-sm md:text-base leading-relaxed text-zinc-100 font-medium">
                  {headline}
                </p>
              </div>

              {/* Plus & Minus Factors 2 Columns */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Plus Bullets (Red Tone Taiwan Stock) */}
                <div className="bg-red-950/10 border border-red-900/30 rounded-xl p-3.5">
                  <div className="flex items-center gap-1.5 mb-2.5 text-red-400 text-xs font-bold tracking-wider uppercase border-b border-red-900/30 pb-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500"></span>
                    加分因素 ({plus.length})
                  </div>
                  {plus.length > 0 ? (
                    <ul className="space-y-2.5">
                      {plus.map((item, idx) => (
                        <li key={idx} className="text-xs">
                          <div className="text-red-300 font-medium leading-tight">
                            {item.text}
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            {item.provenance}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-zinc-500 py-2">無主要利多因素。</div>
                  )}
                </div>

                {/* Minus Bullets (Green Tone Taiwan Stock) */}
                <div className="bg-emerald-950/10 border border-emerald-900/30 rounded-xl p-3.5">
                  <div className="flex items-center gap-1.5 mb-2.5 text-emerald-400 text-xs font-bold tracking-wider uppercase border-b border-emerald-900/30 pb-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    扣分因素 ({minus.length})
                  </div>
                  {minus.length > 0 ? (
                    <ul className="space-y-2.5">
                      {minus.map((item, idx) => (
                        <li key={idx} className="text-xs">
                          <div className="text-emerald-300 font-medium leading-tight">
                            {item.text}
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            {item.provenance}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-zinc-400 py-2 italic">暫無主要拖累。</div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Column (Desktop 5 Cols): Score & 5-Force Radar */}
            <div className="lg:col-span-5 flex flex-col items-center justify-center bg-zinc-950/50 border border-zinc-800/60 rounded-xl p-4 order-1 lg:order-2">
              {/* Score & Action Row (Mobile & Mobile-First layout top) */}
              <div className="w-full flex items-center justify-between mb-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-zinc-400 font-medium">綜合分數</span>
                  <span className="text-3xl md:text-4xl font-black tracking-tight text-white">
                    {overall !== null ? overall : '—'}
                  </span>
                  <span className="text-xs text-zinc-500">/ 100</span>
                </div>
                <div className="lg:hidden flex items-center gap-2">
                  {getActionBadge(action)}
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
                    {stateLabel}
                  </span>
                </div>
              </div>

              {/* Hand-coded SVG Radar Chart */}
              <div className="relative w-full flex justify-center py-2">
                <svg width="280" height="270" viewBox="0 0 280 270" className="overflow-visible">
                  {/* Grid Rings */}
                  {gridRings.map((ring, ringIdx) => {
                    const rRing = R * ring;
                    const ringPoints = Array.from({ length: numAxes }, (_, i) => {
                      const angle = getAxisAngle(i);
                      return `${(cx + rRing * Math.cos(angle)).toFixed(1)},${(cy + rRing * Math.sin(angle)).toFixed(1)}`;
                    }).join(' ');
                    return (
                      <polygon
                        key={ringIdx}
                        points={ringPoints}
                        fill="none"
                        stroke="#3f3f46"
                        strokeWidth={ringIdx === gridRings.length - 1 ? "1.5" : "1"}
                        strokeDasharray={ringIdx === gridRings.length - 1 ? "none" : "3,3"}
                        opacity={0.6}
                      />
                    );
                  })}

                  {/* Axis Spokes */}
                  {Array.from({ length: numAxes }, (_, i) => {
                    const angle = getAxisAngle(i);
                    const outerX = cx + R * Math.cos(angle);
                    const outerY = cy + R * Math.sin(angle);
                    return (
                      <line
                        key={i}
                        x1={cx}
                        y1={cy}
                        x2={outerX}
                        y2={outerY}
                        stroke="#3f3f46"
                        strokeWidth="1"
                        opacity={0.6}
                      />
                    );
                  })}

                  {/* Data Polygon */}
                  <polygon
                    points={polygonPointsStr}
                    fill="rgba(59, 130, 246, 0.25)"
                    stroke="#3b82f6"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />

                  {/* Data Dots */}
                  {dataPoints.map((pt, i) => (
                    <circle
                      key={i}
                      cx={pt.x}
                      cy={pt.y}
                      r={pt.score !== null ? 4 : 2}
                      fill={pt.score !== null ? "#3b82f6" : "#71717a"}
                      stroke="#18181b"
                      strokeWidth="1.5"
                    />
                  ))}

                  {/* Outer Axis Labels */}
                  {forces.map((f, i) => {
                    const angle = getAxisAngle(i);
                    const labelR = R + 24;
                    const lx = cx + labelR * Math.cos(angle);
                    const ly = cy + labelR * Math.sin(angle);

                    let textAnchor: 'middle' | 'start' | 'end' = 'middle';
                    if (Math.abs(Math.cos(angle)) > 0.3) {
                      textAnchor = Math.cos(angle) > 0 ? 'start' : 'end';
                    }

                    const hasScore = f.score !== null && !isNaN(f.score);

                    return (
                      <g key={i}>
                        <text
                          x={lx}
                          y={ly}
                          textAnchor={textAnchor}
                          dominantBaseline="central"
                          className="text-[11px] font-medium fill-zinc-300"
                        >
                          {f.label}
                          <tspan
                            dx="4"
                            className={`font-bold ${hasScore ? 'fill-blue-400' : 'fill-zinc-500'}`}
                          >
                            {hasScore ? f.score : '—'}
                          </tspan>
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          </div>

          {/* Bottom Section: Checkpoints & Invalidation Signals */}
          <div className="mt-6 pt-4 border-t border-zinc-800/60">
            <div className="text-xs font-bold text-zinc-300 mb-3 flex items-center gap-1.5">
              <span>關鍵觀察點 & 失效訊號</span>
            </div>

            {/* Checkpoint Cards (4 items) */}
            {checkpoints.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                {checkpoints.map((cp, idx) => (
                  <div
                    key={idx}
                    className={`p-3 rounded-lg border text-xs flex flex-col justify-between transition-colors ${
                      cp.pass
                        ? 'bg-zinc-900/80 border-zinc-800'
                        : 'bg-zinc-900/40 border-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-zinc-300 font-medium">{cp.label}</span>
                      {cp.pass ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-zinc-500 shrink-0" />
                      )}
                    </div>
                    <div className="flex items-baseline justify-between mt-1 text-[11px]">
                      <span className="text-zinc-500">現況: <strong className={cp.pass ? 'text-zinc-200' : 'text-zinc-400'}>{cp.current}</strong></span>
                      <span className="text-zinc-500">目標: <span className="text-zinc-400">{cp.target}</span></span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-zinc-500 mb-4">目前無可用之觀察點數據。</div>
            )}

            {/* Invalidation Signals Box */}
            {invalidation.length > 0 && (
              <div className="bg-red-950/20 border border-red-900/30 rounded-lg p-2.5 text-xs text-red-300 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold text-red-400">觀察失效訊號:</span>
                  {invalidation.map((inv, idx) => (
                    <span key={idx} className="bg-red-900/30 px-2 py-0.5 rounded text-[11px] border border-red-800/30">
                      {inv}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Card Footer Disclaimer */}
          <div className="mt-4 pt-3 border-t border-zinc-800/40 text-center text-[11px] text-zinc-500">
            五軸與因素為規則式合成，可在下方各卡回溯原始資料；非投資建議。
          </div>
        </>
      )}
    </div>
  );
};
