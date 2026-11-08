// 大盤頁指數方塊下半部（opt53）：簡單線圖＋距一年高低／歷史高／波段。
import React, { useEffect, useRef, useState } from 'react';
import type { IndexLevels } from '../lib/indexLevels';
import { fmtLevelDate, fmtPct } from '../lib/indexLevels';

export interface SparkPoint {
  y: number;
  /** 滑鼠移上去顯示的時間／日期 */
  label: string;
}

const H = 44;
const PAD_Y = 4;

/**
 * 線圖：用量到的容器寬度當 SVG 寬，線寬與字不會被拉變形（同 MiniTrendChart 的做法）。
 * baseline（1 日線圖的昨收）畫成虛線；滑鼠／手指移上去有直線＋數值。
 */
export const IndexSparkline: React.FC<{
  points: SparkPoint[];
  baseline?: number | null;
  /** 有 baseline 時以它判斷漲跌顏色，否則比頭尾 */
  className?: string;
}> = ({ points, baseline = null, className = '' }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setW(Math.round(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) {
    return <div className={`h-11 flex items-center text-[10px] text-zinc-600 ${className}`}>線圖資料不足</div>;
  }
  const ys = points.map((p) => p.y);
  const ref = baseline ?? ys[0];
  const last = ys[ys.length - 1];
  const tone = last > ref ? 'text-bull' : last < ref ? 'text-bear' : 'text-zinc-400';
  let lo = Math.min(...ys, ...(baseline !== null ? [baseline] : []));
  let hi = Math.max(...ys, ...(baseline !== null ? [baseline] : []));
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const x = (i: number) => (w <= 1 ? 0 : (i / (points.length - 1)) * (w - 2) + 1);
  const y = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (H - PAD_Y * 2);
  const line = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(ys.length - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    setHover(Math.round((rel / Math.max(rect.width, 1)) * (points.length - 1)));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div ref={boxRef} className={`relative h-11 ${tone} ${className}`}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block touch-pan-y"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`線圖：${points[0].label} ${ys[0].toLocaleString()} → ${points[points.length - 1].label} ${last.toLocaleString()}`}
        >
          <path d={area} fill="currentColor" opacity={0.08} />
          {baseline !== null && (
            <line x1={0} x2={w} y1={y(baseline)} y2={y(baseline)} stroke="#52525b" strokeWidth={1} strokeDasharray="3 3" />
          )}
          <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {hp && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="#71717a" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(hp.y)} r={3} fill="currentColor" stroke="#09090b" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute -top-5 px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] font-mono text-zinc-200 whitespace-nowrap z-10"
          style={x(hover) > w / 2 ? { right: Math.max(w - x(hover) - 4, 0) } : { left: Math.max(x(hover) - 4, 0) }}
        >
          {hp.label} {hp.y.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
};

const toneOf = (v: number) => (v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-zinc-400');

// 手機上方塊很窄：數字與日期放不下時日期自己換行，不截掉
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline gap-1.5 min-w-0 text-[10px] leading-4">
    <span className="text-zinc-500 shrink-0 w-[2.6rem]">{label}</span>
    <span className="font-mono min-w-0 flex flex-wrap gap-x-1">{children}</span>
  </div>
);

/** 一年高／一年低／歷史高／波段 四行；wide＝台股寬方塊，螢幕夠寬時排成兩欄 */
export const IndexLevelStats: React.FC<{ lv: IndexLevels; wide?: boolean }> = ({ lv, wide = false }) => {
  const d = (date: string | null) => fmtLevelDate(date, lv.lastDate);
  return (
    <div className={`grid gap-x-3 grid-cols-1 ${wide ? '2xl:grid-cols-2' : ''}`}>
      <Row label="一年高">
        <span className={toneOf(lv.high1y.pct)}>{fmtPct(lv.high1y.pct)}</span>
        <span className="text-zinc-500">{d(lv.high1y.date)}</span>
      </Row>
      <Row label="一年低">
        <span className={toneOf(lv.low1y.pct)}>{fmtPct(lv.low1y.pct)}</span>
        <span className="text-zinc-500">{d(lv.low1y.date)}</span>
      </Row>
      <Row label="歷史高">
        {lv.ath ? (
          <>
            <span className={toneOf(lv.ath.pct)}>{fmtPct(lv.ath.pct)}</span>
            <span className="text-zinc-500">{lv.athIsHigh1y ? '＝一年高' : d(lv.ath.date)}</span>
          </>
        ) : (
          <span className="text-zinc-600">暫無</span>
        )}
      </Row>
      <Row label="波段">
        {lv.swing ? (
          <>
            <span className={toneOf(lv.swing.pivot.pct)}>
              {lv.swing.dir === 'down' ? '回檔' : '上漲'} {fmtPct(lv.swing.pivot.pct)}
            </span>
            <span className="text-zinc-500">
              自 {d(lv.swing.pivot.date)} {lv.swing.dir === 'down' ? '高點' : '低點'}
            </span>
          </>
        ) : (
          <span className="text-zinc-600">波動未達 5%</span>
        )}
      </Row>
    </div>
  );
};
