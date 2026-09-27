import React from 'react';
import type { OhlcvRow } from '../lib/api';

const BULL = '#ef4444';
const BEAR = '#22c55e';
const MA = '#f59e0b';

/**
 * 迷你 K 線（卡片牆、戰情海報用）：純 SVG、不互動，viewBox 依根數算、寬度撐滿容器。
 * 台股慣例紅漲綠跌；月線用橘色細線。
 */
export const MiniCandles: React.FC<{
  bars: OhlcvRow[];
  ma20?: (number | null)[];
  /** 水平參考線（戰情卡畫關鍵價位）；價位會納入縱軸範圍 */
  levels?: { price: number; color: string; width?: number }[];
  height?: number;
  className?: string;
}> = ({ bars, ma20, levels = [], height = 96, className = '' }) => {
  if (bars.length < 2) {
    return <div className={`flex items-center justify-center text-[10px] text-zinc-600 ${className}`} style={{ height }}>K 線資料不足</div>;
  }
  const step = 6;
  const w = bars.length * step;
  const h = 100;
  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);
  const maVals = (ma20 || []).filter((v): v is number => v !== null);
  const lv = levels.map((l) => l.price);
  const min = Math.min(...lows, ...maVals, ...lv);
  const max = Math.max(...highs, ...maVals, ...lv);
  const span = max - min || 1;
  const y = (v: number) => 4 + (1 - (v - min) / span) * (h - 8);
  const maPts = (ma20 || [])
    .map((v, i) => (v === null ? null : `${i * step + step / 2},${y(v).toFixed(2)}`))
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={`w-full block ${className}`}
      style={{ height }}
      role="img"
      aria-label={`近 ${bars.length} 日 K 線`}
    >
      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const color = up ? BULL : BEAR;
        const x = i * step + step / 2;
        const top = y(Math.max(b.open, b.close));
        const bottom = y(Math.min(b.open, b.close));
        return (
          <g key={b.date}>
            <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
            <rect x={x - step * 0.32} y={top} width={step * 0.64} height={Math.max(0.6, bottom - top)} fill={color} />
          </g>
        );
      })}
      {levels.map((l, i) => (
        <line
          key={`lv-${i}`}
          x1={0}
          x2={w}
          y1={y(l.price)}
          y2={y(l.price)}
          stroke={l.color}
          strokeWidth={l.width ?? 1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      ))}
      {maPts && <polyline points={maPts} fill="none" stroke={MA} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
};
