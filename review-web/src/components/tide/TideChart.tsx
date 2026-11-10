import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  axisDomain,
  fmtMd,
  fmtYi,
  quadrantCounts,
  QUADRANT_LABEL,
  sizeRatio,
  symScale,
  symTicks,
  WINDOW,
  type FlowFrame,
  type FlowUnit,
} from '../../lib/capitalFlow';

/**
 * 資金潮汐泡泡圖本體（opt54）。
 *
 * 橫軸＝近 5 日買賣超（億），縱軸＝加速流入（億/天），兩軸都是中間放大的對稱對數刻度。
 * playhead 可以是小數：兩個交易日之間用「畫面座標」線性內插，泡泡才會等速滑過去
 * （在金額上內插的話，經過對數刻度會變成忽快忽慢）。
 * 整段播放共用同一組座標範圍，所以所有播放日的畫面座標在這裡一次算好。
 */

const RED = '#ef4444';
const GREEN = '#22c55e';
const MIN_R = 3.5;
/** 小泡泡手指點不到，另外墊一顆看不見的 */
const MIN_HIT_R = 9;

export interface TideChartProps {
  units: FlowUnit[];
  frames: FlowFrame[];
  /** 0～frames.length−1，可以是小數（兩天之間） */
  playhead: number;
  playing: boolean;
  /** 一直標名字＋畫軌跡的泡泡（流入最多、流出最多） */
  highlight: number[];
  selected: number | null;
  /** 搜尋有輸入時符合的泡泡，其餘變淡；沒在搜尋給 null */
  matched: Set<number> | null;
  /** 「法人」「外資」…用在滑鼠提示 */
  instShort: string;
  onSelect: (unit: number | null) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function tickText(v: number, sign: 1 | -1): string {
  const body = v >= 1 ? v.toLocaleString('en-US') : String(v);
  return `${sign > 0 ? '+' : '-'}${body}`;
}

/** 標籤寬度估算（中文字約一個字寬、英數約半個），用來把標籤夾在圖內、判斷互相有沒有疊到 */
function estimateWidth(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? fontPx : fontPx * 0.6;
  return w;
}

export const TideChart: React.FC<TideChartProps> = ({
  units,
  frames,
  playhead,
  playing,
  highlight,
  selected,
  matched,
  instShort,
  onSelect,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ unit: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 手機是直的（比影片那張略高），桌機寬螢幕就壓扁一點免得整頁都是圖
  const geo = useMemo(() => {
    if (width < 200) return null;
    const W = width;
    const H = W < 560 ? Math.round(W * 1.12) : Math.round(clamp(W * 0.72, 480, 690));
    const narrow = W < 560;
    const l = narrow ? 40 : 48;
    const r = narrow ? 8 : 14;
    const t = 26;
    const b = 36;
    return { W, H, narrow, l, t, w: W - l - r, h: H - t - b, cx: l + (W - l - r) / 2, cy: t + (H - t - b) / 2 };
  }, [width]);

  const layout = useMemo(() => {
    if (!geo || !frames.length) return null;
    const dom = axisDomain(frames);
    const sx = symScale(dom.xMax, dom.xC);
    const sy = symScale(dom.yMax, dom.yC);
    let maxSize = 0;
    for (const f of frames) for (const s of f.size) if (s > maxSize) maxSize = s;
    const maxR = clamp(geo.W * 0.05, 15, 32);
    // 座標兩端各內縮一個最大泡泡的半徑，金額最大的那顆才不會有一半畫到框外
    const hx = geo.w / 2 - maxR - 4;
    const hy = geo.h / 2 - maxR - 4;
    const px = frames.map((f) => f.x.map((v) => geo.cx + sx(v) * hx));
    const py = frames.map((f) => f.y.map((v) => geo.cy - sy(v) * hy));
    const rr = frames.map((f) => f.size.map((s) => MIN_R + (maxR - MIN_R) * sizeRatio(s, maxSize)));
    // 大的先畫、小的疊在上面才點得到；順序固定用最後一天的大小，播放中不會前後亂跳
    const lastR = rr[rr.length - 1];
    const order = lastR.map((_, u) => u).sort((a, b) => lastR[b] - lastR[a]);
    return {
      px,
      py,
      rr,
      order,
      xTicks: symTicks(sx, 54 / hx).map((v) => ({ v, off: sx(v) * hx })),
      yTicks: symTicks(sy, 26 / hy).map((v) => ({ v, off: sy(v) * hy })),
    };
  }, [geo, frames]);

  if (!geo || !layout) {
    return <div ref={wrapRef} className="w-full min-h-[360px]" />;
  }

  const last = frames.length - 1;
  const p = clamp(playhead, 0, last);
  const i0 = Math.floor(p);
  const i1 = Math.min(last, i0 + 1);
  const t = p - i0;
  const at = (arr: number[][], u: number) => arr[i0][u] + (arr[i1][u] - arr[i0][u]) * t;
  const cur = frames[Math.round(p)];
  const counts = quadrantCounts(cur);
  const colorAt = (u: number) => (at(layout.px, u) >= geo.cx ? RED : GREEN);

  const focus = [...new Set([...highlight, ...(selected !== null ? [selected] : [])])].filter((u) => u < units.length);
  const focusSet = new Set(focus);

  // ── 標籤：預設放泡泡上方，太靠上緣或跟前一個標籤疊到就改放下方 ──
  const LABEL_FONT = geo.narrow ? 12 : 13;
  const showValue = !playing;
  const labelH = showValue ? LABEL_FONT * 2 + 14 : LABEL_FONT + 12;
  const placed: { left: number; top: number; w: number }[] = [];
  const labels = focus.map((u) => {
    const x = at(layout.px, u);
    const y = at(layout.py, u);
    const r = at(layout.rr, u);
    const valueText = `${fmtYi(cur.x[u])} 億`;
    const w = Math.max(estimateWidth(units[u].name, LABEL_FONT), showValue ? estimateWidth(valueText, LABEL_FONT) : 0) + 20;
    // 夾在繪圖區內，不要蓋到左邊的刻度數字
    const left = clamp(x - w / 2, geo.l + 2, geo.l + geo.w - w - 2);
    const above = y - r - 9 - labelH;
    const below = y + r + 9;
    const hits = (top: number) =>
      placed.some((o) => left < o.left + o.w + 4 && o.left < left + w + 4 && top < o.top + labelH + 4 && o.top < top + labelH + 4);
    let top = above;
    if (above < 2 || hits(above)) top = below + labelH > geo.H - 2 || hits(below) ? Math.max(2, above) : below;
    placed.push({ left, top, w });
    return { u, left, top, w, valueText, color: colorAt(u) };
  });

  const bubble = (u: number, strong: boolean) => {
    const x = at(layout.px, u);
    const y = at(layout.py, u);
    const r = at(layout.rr, u);
    const color = colorAt(u);
    const faded = matched !== null && !matched.has(u) && !strong;
    const found = matched !== null && matched.has(u) && !strong;
    const handlers = {
      onMouseEnter: (e: React.MouseEvent) => setHover({ unit: u, ...localPoint(e, wrapRef.current) }),
      onMouseMove: (e: React.MouseEvent) => setHover({ unit: u, ...localPoint(e, wrapRef.current) }),
      onMouseLeave: () => setHover(null),
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        setHover(null);
        onSelect(selected === u ? null : u);
      },
    };
    return (
      <g key={u} className="cursor-pointer" {...handlers}>
        {strong && (
          <>
            {!playing && (
              <circle
                cx={x}
                cy={y}
                r={r + 5}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                className="animate-ping"
                style={{ transformBox: 'fill-box', transformOrigin: 'center', animationDuration: '1.8s' }}
              />
            )}
            <circle cx={x} cy={y} r={r + 5} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.5} />
          </>
        )}
        <circle
          cx={x}
          cy={y}
          r={r}
          fill={color}
          fillOpacity={strong ? 0.92 : faded ? 0.04 : found || hover?.unit === u ? 0.65 : 0.24}
          stroke={strong ? '#fafafa' : color}
          strokeOpacity={strong ? 0.9 : faded ? 0.1 : found ? 1 : 0.6}
          strokeWidth={strong ? 1.5 : 1}
        />
        {r < MIN_HIT_R && <circle cx={x} cy={y} r={MIN_HIT_R} fill="transparent" />}
      </g>
    );
  };

  const hoverUnit = hover && hover.unit < units.length ? hover.unit : null;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        width={geo.W}
        height={geo.H}
        viewBox={`0 0 ${geo.W} ${geo.H}`}
        className="block"
        onClick={() => onSelect(null)}
        role="img"
        aria-label={`法人資金流向泡泡圖，${cur.date}`}
      >
        {/* 四象限底色：右半（買超）偏紅、左半（賣超）偏綠，很淡 */}
        <rect x={geo.cx} y={geo.t} width={geo.w / 2} height={geo.h} fill={RED} fillOpacity={0.025} />
        <rect x={geo.l} y={geo.t} width={geo.w / 2} height={geo.h} fill={GREEN} fillOpacity={0.025} />

        {/* 背景大日期（播放時看得出現在是哪一天，又不會擋到泡泡） */}
        <text
          x={geo.l + geo.w - 10}
          y={geo.t + geo.h - 34}
          textAnchor="end"
          fontSize={clamp(geo.W * 0.13, 44, 96)}
          fontWeight={900}
          fill="#fafafa"
          fillOpacity={0.07}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {fmtMd(cur.date)}
        </text>

        {/* 格線與刻度 */}
        {layout.xTicks.flatMap(({ v, off }) =>
          ([1, -1] as const).map((s) => (
            <g key={`x${s}${v}`}>
              <line x1={geo.cx + s * off} x2={geo.cx + s * off} y1={geo.t} y2={geo.t + geo.h} stroke="#27272a" strokeWidth={1} />
              <text x={geo.cx + s * off} y={geo.t + geo.h + 14} textAnchor="middle" fontSize={10} fill="#71717a" className="font-mono">
                {tickText(v, s)}
              </text>
            </g>
          )),
        )}
        {layout.yTicks.flatMap(({ v, off }) =>
          ([1, -1] as const).map((s) => (
            <g key={`y${s}${v}`}>
              <line x1={geo.l} x2={geo.l + geo.w} y1={geo.cy - s * off} y2={geo.cy - s * off} stroke="#27272a" strokeWidth={1} />
              <text x={geo.l - 6} y={geo.cy - s * off + 3.5} textAnchor="end" fontSize={10} fill="#71717a" className="font-mono">
                {tickText(v, s)}
              </text>
            </g>
          )),
        )}
        <line x1={geo.l} x2={geo.l + geo.w} y1={geo.cy} y2={geo.cy} stroke="#52525b" strokeWidth={1.25} />
        <line x1={geo.cx} x2={geo.cx} y1={geo.t} y2={geo.t + geo.h} stroke="#52525b" strokeWidth={1.25} />
        <text x={geo.l - 6} y={geo.cy + 3.5} textAnchor="end" fontSize={10} fill="#71717a" className="font-mono">0</text>

        {/* 軸說明 */}
        <text x={geo.cx} y={geo.t - 9} textAnchor="middle" fontSize={11} fill="#a1a1aa">
          加速流入（億/天）↑
        </text>
        <text x={geo.l} y={geo.H - 5} textAnchor="start" fontSize={11} fill="#a1a1aa">
          ← 資金流出
        </text>
        <text x={geo.l + geo.w} y={geo.H - 5} textAnchor="end" fontSize={11} fill="#a1a1aa">
          資金流入（億）→
        </text>

        {/* 四個角的象限名稱＋顆數 */}
        {(
          [
            ['converge', geo.l + 8, geo.t + 18, 'start', GREEN, 0.75],
            ['accumulate', geo.l + geo.w - 8, geo.t + 18, 'end', RED, 1],
            ['reduce', geo.l + 8, geo.t + geo.h - 10, 'start', GREEN, 1],
            ['cooling', geo.l + geo.w - 8, geo.t + geo.h - 10, 'end', RED, 0.75],
          ] as const
        ).map(([q, x, y, anchor, color, opacity]) => (
          <text key={q} x={x} y={y} textAnchor={anchor} fontSize={geo.narrow ? 12 : 13} fontWeight={700} fill={color} fillOpacity={opacity}>
            {QUADRANT_LABEL[q]}
            <tspan dx={5} fontSize={11} fontWeight={500} fillOpacity={0.8} className="font-mono">
              {counts[q]}
            </tspan>
          </text>
        ))}

        {/* 一般泡泡 */}
        {layout.order.filter((u) => !focusSet.has(u)).map((u) => bubble(u, false))}

        {/* 軌跡：從第一個播放日走到現在的位置 */}
        {focus.map((u) => {
          const pts: [number, number][] = [];
          for (let f = 0; f <= i0; f++) pts.push([layout.px[f][u], layout.py[f][u]]);
          if (t > 0) pts.push([at(layout.px, u), at(layout.py, u)]);
          if (pts.length < 2) return null;
          const color = colorAt(u);
          return (
            <g key={`trail${u}`} pointerEvents="none">
              <polyline
                points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeOpacity={0.85}
              />
              {pts.slice(1, t > 0 ? -1 : undefined).map(([x, y], k) => (
                <circle key={k} cx={x} cy={y} r={2.5} fill={color} />
              ))}
              <circle cx={pts[0][0]} cy={pts[0][1]} r={4} fill="#18181b" stroke={color} strokeWidth={1.5} />
              <text x={pts[0][0] + 7} y={pts[0][1] - 6} fontSize={10} fill="#a1a1aa" className="font-mono">
                {fmtMd(frames[0].date)}
              </text>
            </g>
          );
        })}

        {/* 重點泡泡（流入最多、流出最多、點選的）畫在最上面 */}
        {focus.map((u) => bubble(u, true))}
      </svg>

      {/* 重點泡泡的名字（停下來時連金額一起） */}
      {labels.map((lb) => (
        <button
          key={`label${lb.u}`}
          type="button"
          onClick={() => onSelect(selected === lb.u ? null : lb.u)}
          className="absolute rounded-md border bg-zinc-950/90 px-2 py-1 text-center font-bold leading-tight shadow-lg backdrop-blur-sm"
          style={{ left: lb.left, top: lb.top, width: lb.w, fontSize: LABEL_FONT, borderColor: lb.color }}
        >
          <span className="block whitespace-nowrap text-zinc-100">{units[lb.u].name}</span>
          {showValue && (
            <span className="block whitespace-nowrap font-mono" style={{ color: lb.color }}>
              {lb.valueText}
            </span>
          )}
        </button>
      ))}

      {/* 滑鼠提示 */}
      {hoverUnit !== null && hover && (
        <div
          className="pointer-events-none absolute z-20 w-52 space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950/95 p-3 text-xs shadow-xl backdrop-blur-sm"
          style={{ left: clamp(hover.x + 14, 4, geo.W - 212), top: clamp(hover.y - 12, 4, geo.H - 120) }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-1.5">
            <span className="truncate font-bold text-zinc-100">{units[hoverUnit].name}</span>
            <span className="shrink-0 text-[10px] text-zinc-500">{units[hoverUnit].members.length} 檔</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-400">
            <span>近 {WINDOW} 日{instShort}</span>
            <span className={`text-right ${cur.x[hoverUnit] >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtYi(cur.x[hoverUnit])} 億</span>
            <span>加速流入</span>
            <span className={`text-right ${cur.y[hoverUnit] >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtYi(cur.y[hoverUnit])} 億/天</span>
            <span>當日</span>
            <span className={`text-right ${cur.today[hoverUnit] >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtYi(cur.today[hoverUnit])} 億</span>
          </div>
          <div className="border-t border-zinc-900 pt-1 text-center text-[10px] italic text-zinc-500">點泡泡看成分股</div>
        </div>
      )}
    </div>
  );
};

function localPoint(e: React.MouseEvent, wrap: HTMLDivElement | null): { x: number; y: number } {
  const rect = wrap?.getBoundingClientRect();
  return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
}
