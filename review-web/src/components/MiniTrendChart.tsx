import React, { useCallback, useState } from 'react';
import { shortDate } from '../lib/marketCredit';

export interface MiniTrendPoint {
  date: string;  // YYYY-MM-DD
  value: number;
}

interface MiniTrendChartProps {
  points: MiniTrendPoint[];
  kind: 'line' | 'bar';
  /** 提示框用的數字格式（軸標籤沒另外給 axisFormat 時也用它） */
  format: (v: number) => string;
  /** 軸標籤專用的精簡格式——左邊只留 44px，「5,010.2 億」這種會被截掉 */
  axisFormat?: (v: number) => string;
  /** 給螢幕閱讀器的圖名（畫面上的標題由外層負責） */
  label: string;
  height?: number;
}

const PAD = { top: 10, right: 10, bottom: 20, left: 44 };
const PRIMARY = '#3b82f6';
const SURFACE = '#18181b';

/**
 * 單一數列的小趨勢圖（折線或長條），手刻 SVG、附滑鼠／觸控提示。
 * 用實際量到的容器寬度當 viewBox（跟 StockDetail 的基本面圖同一招），
 * 滑鼠座標才不會因為縮放置中而跟圖上的點對不齊。
 */
export const MiniTrendChart: React.FC<MiniTrendChartProps> = ({
  points,
  kind,
  format,
  axisFormat,
  label,
  height = 132,
}) => {
  const [width, setWidth] = useState(360);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () => setWidth(Math.max(200, node.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-[11px] text-zinc-500" style={{ height }}>
        暫無資料
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  let lo: number;
  let hi: number;
  if (kind === 'bar') {
    lo = 0;
    hi = vMax > 0 ? vMax * 1.1 : 1;
  } else {
    const pad = (vMax - vMin) * 0.15 || Math.max(Math.abs(vMax) * 0.01, 1);
    lo = vMin - pad;
    hi = vMax + pad;
  }

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const n = points.length;
  // 長條圖每根佔一格、置中；折線圖頭尾貼齊繪圖區
  const step = kind === 'bar' ? plotW / n : n > 1 ? plotW / (n - 1) : plotW;
  const xAt = (i: number) => (kind === 'bar' ? PAD.left + step * (i + 0.5) : PAD.left + (n > 1 ? step * i : plotW / 2));
  const yAt = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;

  const ticks = [lo, (lo + hi) / 2, hi];
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const raw = kind === 'bar' ? Math.floor((x - PAD.left) / step) : Math.round((x - PAD.left) / (step || 1));
    setHover(Math.min(n - 1, Math.max(0, raw)));
  };

  const hoverPt = hover !== null ? points[hover] : null;
  const hx = hover !== null ? xAt(hover) : 0;
  const barW = Math.max(2, Math.min(14, step * 0.62));
  const baseY = yAt(0);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="block touch-pan-y"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yAt(t)} y2={yAt(t)} stroke="#27272a" strokeWidth={1} />
            <text x={PAD.left - 6} y={yAt(t) + 3} fill="#71717a" fontSize="10" textAnchor="end" fontFamily="ui-monospace, monospace">
              {(axisFormat || format)(t)}
            </text>
          </g>
        ))}
        <text x={xAt(0)} y={height - 5} fill="#71717a" fontSize="10" textAnchor={kind === 'bar' ? 'middle' : 'start'}>
          {shortDate(points[0].date)}
        </text>
        {n > 1 && (
          <text x={xAt(n - 1)} y={height - 5} fill="#71717a" fontSize="10" textAnchor={kind === 'bar' ? 'middle' : 'end'}>
            {shortDate(points[n - 1].date)}
          </text>
        )}

        {kind === 'bar'
          ? points.map((p, i) => {
              const top = yAt(p.value);
              const h = Math.max(0, baseY - top);
              const r = Math.min(2, barW / 2, h);
              const x0 = xAt(i) - barW / 2;
              // 只有頂端圓角、底部貼齊基準線
              const d = h <= 0
                ? ''
                : `M${x0},${baseY} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${baseY} Z`;
              return d ? (
                <path key={p.date} d={d} fill={PRIMARY} opacity={hover === null || hover === i ? 1 : 0.45} />
              ) : null;
            })
          : (
            <>
              <path
                d={points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(p.value)}`).join(' ')}
                fill="none"
                stroke={PRIMARY}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx={xAt(n - 1)} cy={yAt(points[n - 1].value)} r={4} fill={PRIMARY} stroke={SURFACE} strokeWidth={2} />
            </>
          )}

        {hoverPt && (
          <>
            <line x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + plotH} stroke="#52525b" strokeWidth={1} strokeDasharray="3 3" />
            {kind === 'line' && (
              <circle cx={hx} cy={yAt(hoverPt.value)} r={4.5} fill={PRIMARY} stroke={SURFACE} strokeWidth={2} />
            )}
          </>
        )}
      </svg>

      {hoverPt && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-zinc-900/95 px-2 py-1 text-[11px] shadow-lg whitespace-nowrap"
          style={hx > width / 2 ? { right: width - hx + 8 } : { left: hx + 8 }}
        >
          <div className="text-zinc-500">{hoverPt.date}</div>
          <div className="font-mono font-semibold text-zinc-100">{format(hoverPt.value)}</div>
        </div>
      )}

      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{format(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
