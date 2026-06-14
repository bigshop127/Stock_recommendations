import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type CandlestickData,
  type HistogramData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { OhlcvRow } from '../lib/api';

// 蠟燭圖 + 量能（lightweight-charts v4）。資料來自 gateway /api/stocks/:code/ohlcv。
export function PriceChart({ rows, height = 280 }: { rows: OhlcvRow[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const chart: IChartApi = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: false },
      crosshair: { mode: 0 },
      handleScale: true,
      handleScroll: true,
    });

    // 台股紅漲綠跌：漲 = 紅 #ef4444、跌 = 綠 #22c55e
    const candle = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#22c55e',
      borderUpColor: '#ef4444',
      borderDownColor: '#22c55e',
      wickUpColor: '#ef4444',
      wickDownColor: '#22c55e',
    });

    const toTime = (d: string | number): UTCTimestamp | string => {
      // lightweight-charts 接受 'YYYY-MM-DD' 字串；容錯處理 epoch 數字
      if (typeof d === 'number') return (d > 1e12 ? Math.floor(d / 1000) : d) as UTCTimestamp;
      return String(d).slice(0, 10);
    };

    const candleData: CandlestickData[] = rows
      .filter((r) => r && r.close != null)
      .map((r) => ({
        time: toTime(r.date) as never,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      }));
    candle.setData(candleData);

    const hasVol = rows.some((r) => r.volume != null);
    if (hasVol) {
      const vol = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: '#475569',
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      const volData: HistogramData[] = rows
        .filter((r) => r.volume != null)
        .map((r) => ({
          time: toTime(r.date) as never,
          value: Number(r.volume),
          color: Number(r.close) >= Number(r.open) ? '#ef444455' : '#22c55e55',
        }));
      vol.setData(volData);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [rows, height]);

  return <div ref={ref} className="w-full" />;
}
