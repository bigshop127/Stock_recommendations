import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts';

export interface LineSeries {
  name: string;
  color: string;
  points: { time: string | number; value: number }[];
}

// 多條折線（策略權益曲線 vs benchmark）。
export function EquityChart({ series, height = 200 }: { series: LineSeries[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart: IChartApi = createChart(el, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 11 },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155' },
    });

    const toTime = (d: string | number) =>
      typeof d === 'number' ? ((d > 1e12 ? Math.floor(d / 1000) : d) as UTCTimestamp) : String(d).slice(0, 10);

    for (const s of series) {
      const line = chart.addLineSeries({
        color: s.color,
        lineWidth: 2,
        lineStyle: s.name.includes('0050') || /bench/i.test(s.name) ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
      });
      line.setData(s.points.map((p) => ({ time: toTime(p.time) as never, value: p.value })));
    }
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [series, height]);

  return <div ref={ref} className="w-full" />;
}
