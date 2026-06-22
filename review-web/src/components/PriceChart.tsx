import React, { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type CandlestickData,
  type HistogramData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { OhlcvRow } from '../lib/api';

interface PriceChartProps {
  rows: OhlcvRow[];
  isIntraday: boolean;
  height?: number;
}

function calculateMA(rows: OhlcvRow[], period: number, isIntraday: boolean) {
  const maData: { time: string | UTCTimestamp; value: number }[] = [];
  const toTime = (d: string | number): UTCTimestamp | string => {
    if (typeof d === 'number') {
      return (d > 1e12 ? Math.floor(d / 1000) : d) as UTCTimestamp;
    }
    if (isIntraday) {
      return Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp;
    }
    return String(d).slice(0, 10);
  };

  for (let i = 0; i < rows.length; i++) {
    if (i < period - 1) {
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let j = 0; j < period; j++) {
      const val = Number(rows[i - j].close);
      if (!isNaN(val)) {
        sum += val;
        count++;
      }
    }
    if (count > 0) {
      maData.push({
        time: toTime(rows[i].date) as never,
        value: sum / count,
      });
    }
  }
  return maData;
}

export const PriceChart: React.FC<PriceChartProps> = ({ rows, isIntraday, height = 300 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const openValRef = useRef<HTMLSpanElement>(null);
  const highValRef = useRef<HTMLSpanElement>(null);
  const lowValRef = useRef<HTMLSpanElement>(null);
  const closeValRef = useRef<HTMLSpanElement>(null);
  const volValRef = useRef<HTMLSpanElement>(null);
  const ma20ValRef = useRef<HTMLSpanElement>(null);
  const ma50ValRef = useRef<HTMLSpanElement>(null);
  const dateValRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !rows || rows.length === 0) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: { 
        borderColor: '#3f3f46', 
        timeVisible: isIntraday,
        secondsVisible: false,
      },
      crosshair: { mode: 0 },
      handleScale: true,
      handleScroll: true,
    });

    chartRef.current = chart;

    const candle = chart.addCandlestickSeries({
      upColor: '#ef4444', // Red for Taiwan
      downColor: '#22c55e', // Green for Taiwan
      borderUpColor: '#ef4444',
      borderDownColor: '#22c55e',
      wickUpColor: '#ef4444',
      wickDownColor: '#22c55e',
    });

    const toTime = (d: string | number): UTCTimestamp | string => {
      if (typeof d === 'number') return (d > 1e12 ? Math.floor(d / 1000) : d) as UTCTimestamp;
      if (isIntraday) {
        return Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp;
      }
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

    // Calc MA20/MA50
    const ma20Series = chart.addLineSeries({
      color: '#eab308',
      lineWidth: 2,
      title: 'MA20',
    });
    const ma20Data = calculateMA(rows, 20, isIntraday);
    ma20Series.setData(ma20Data);

    const ma50Series = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 2,
      title: 'MA50',
    });
    const ma50Data = calculateMA(rows, 50, isIntraday);
    ma50Series.setData(ma50Data);

    // Volume Histogram
    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const volData: HistogramData[] = rows
      .filter((r) => r.volume != null)
      .map((r) => ({
        time: toTime(r.date) as never,
        value: Number(r.volume),
        color: Number(r.close) >= Number(r.open) ? '#ef444455' : '#22c55e55',
      }));
    volSeries.setData(volData);

    // Initial default values (from the last element)
    const setLegendValues = (
      dateStr: string,
      open: number | undefined,
      high: number | undefined,
      low: number | undefined,
      close: number | undefined,
      vol: number | undefined,
      m20: number | undefined,
      m50: number | undefined
    ) => {
      if (dateValRef.current) dateValRef.current.textContent = dateStr;
      if (openValRef.current) openValRef.current.textContent = open !== undefined ? open.toFixed(1) : '--';
      if (highValRef.current) highValRef.current.textContent = high !== undefined ? high.toFixed(1) : '--';
      if (lowValRef.current) lowValRef.current.textContent = low !== undefined ? low.toFixed(1) : '--';
      if (closeValRef.current) {
        closeValRef.current.textContent = close !== undefined ? close.toFixed(1) : '--';
        if (open !== undefined && close !== undefined) {
          closeValRef.current.className = close >= open ? 'text-bull font-bold' : 'text-bear font-bold';
        } else {
          closeValRef.current.className = 'text-zinc-100 font-bold';
        }
      }
      if (volValRef.current) volValRef.current.textContent = vol !== undefined ? vol.toLocaleString() : '--';
      if (ma20ValRef.current) ma20ValRef.current.textContent = m20 !== undefined ? m20.toFixed(1) : '--';
      if (ma50ValRef.current) ma50ValRef.current.textContent = m50 !== undefined ? m50.toFixed(1) : '--';
    };

    // Set default values initially
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const lastMA20 = ma20Data.length > 0 ? ma20Data[ma20Data.length - 1].value : undefined;
      const lastMA50 = ma50Data.length > 0 ? ma50Data[ma50Data.length - 1].value : undefined;
      setLegendValues(
        lastRow.date.includes('T') ? lastRow.date.replace('T', ' ').substring(0, 16) : lastRow.date,
        lastRow.open,
        lastRow.high,
        lastRow.low,
        lastRow.close,
        lastRow.volume,
        lastMA20,
        lastMA50
      );
    }

    // Subscribe to crosshair movement
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > el.clientWidth ||
        param.point.y < 0 ||
        param.point.y > height
      ) {
        // Show default values from last element
        if (rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          const lastMA20 = ma20Data.length > 0 ? ma20Data[ma20Data.length - 1].value : undefined;
          const lastMA50 = ma50Data.length > 0 ? ma50Data[ma50Data.length - 1].value : undefined;
          setLegendValues(
            lastRow.date.includes('T') ? lastRow.date.replace('T', ' ').substring(0, 16) : lastRow.date,
            lastRow.open,
            lastRow.high,
            lastRow.low,
            lastRow.close,
            lastRow.volume,
            lastMA20,
            lastMA50
          );
        }
      } else {
        const dateVal = param.time as string;
        let displayDate = typeof dateVal === 'number' 
          ? new Date(dateVal * 1000).toLocaleString('zh-TW', { hour12: false }).substring(0, 16)
          : String(dateVal);

        const candleData = param.seriesData.get(candle) as any;
        const ma20Val = param.seriesData.get(ma20Series) as any;
        const ma50Val = param.seriesData.get(ma50Series) as any;
        const volVal = param.seriesData.get(volSeries) as any;

        setLegendValues(
          displayDate,
          candleData?.open,
          candleData?.high,
          candleData?.low,
          candleData?.close,
          volVal?.value,
          ma20Val?.value,
          ma50Val?.value
        );
      }
    });

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (chartRef.current && el) {
        chartRef.current.applyOptions({ width: el.clientWidth });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [rows, isIntraday, height]);

  return (
    <div className="relative w-full flex-1 flex flex-col min-h-[300px]">
      {/* Dynamic Legend Overlay */}
      <div className="absolute top-2 left-2 z-10 text-[10px] sm:text-xs font-mono select-none flex flex-wrap gap-x-2 gap-y-1 p-2 bg-zinc-950/80 rounded-md border border-zinc-800/80 pointer-events-none text-zinc-400">
        <span className="text-zinc-500 font-bold" ref={dateValRef}>--</span>
        <span>開:<strong className="text-zinc-100 ml-0.5" ref={openValRef}>--</strong></span>
        <span>高:<strong className="text-zinc-100 ml-0.5" ref={highValRef}>--</strong></span>
        <span>低:<strong className="text-zinc-100 ml-0.5" ref={lowValRef}>--</strong></span>
        <span>收:<strong className="text-zinc-100 ml-0.5" ref={closeValRef}>--</strong></span>
        <span>量:<strong className="text-zinc-100 ml-0.5" ref={volValRef}>--</strong></span>
        <span>MA20:<strong className="text-yellow-500 ml-0.5" ref={ma20ValRef}>--</strong></span>
        <span>MA50:<strong className="text-blue-500 ml-0.5" ref={ma50ValRef}>--</strong></span>
      </div>
      <div ref={containerRef} className="w-full flex-1" />
    </div>
  );
};
