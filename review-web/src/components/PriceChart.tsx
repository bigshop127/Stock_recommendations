import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type CandlestickData,
  type HistogramData,
} from 'lightweight-charts';
import type { OhlcvRow } from '../lib/api';
import {
  calculateSMA,
  calculateVolumeSMA,
  calculateMACD,
  calculateKD,
  calculateRSI,
  calculateBBands,
  toTime,
} from '../lib/indicators';

interface PriceChartProps {
  rows: OhlcvRow[];
  isIntraday: boolean;
  height?: number;
}

interface IndicatorSettings {
  ma5: boolean;
  ma10: boolean;
  ma20: boolean;
  ma60: boolean;
  bbands: boolean;
  vol: boolean;
  vma5: boolean;
  vma20: boolean;
  macd: boolean;
  kd: boolean;
  rsi: boolean;
}

export const PriceChart: React.FC<PriceChartProps> = ({ rows, isIntraday, height = 300 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);
  const kdContainerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);

  // Indicators switches state
  const [settings, setSettings] = useState<IndicatorSettings>(() => {
    const saved = localStorage.getItem('technical_indicator_settings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (_) {}
    }
    return {
      ma5: true,
      ma10: false,
      ma20: true,
      ma60: true,
      bbands: false,
      vol: true,
      vma5: true,
      vma20: true,
      macd: true,
      kd: false,
      rsi: false,
    };
  });

  const toggleSetting = (key: keyof typeof settings) => {
    setSettings((prev: IndicatorSettings) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('technical_indicator_settings', JSON.stringify(next));
      return next;
    });
  };

  // Main chart legend refs
  const dateValRef = useRef<HTMLSpanElement>(null);
  const openValRef = useRef<HTMLSpanElement>(null);
  const highValRef = useRef<HTMLSpanElement>(null);
  const lowValRef = useRef<HTMLSpanElement>(null);
  const closeValRef = useRef<HTMLSpanElement>(null);
  const volValRef = useRef<HTMLSpanElement>(null);
  const ma5ValRef = useRef<HTMLSpanElement>(null);
  const ma10ValRef = useRef<HTMLSpanElement>(null);
  const ma20ValRef = useRef<HTMLSpanElement>(null);
  const ma60ValRef = useRef<HTMLSpanElement>(null);
  const bbUpperValRef = useRef<HTMLSpanElement>(null);
  const bbMiddleValRef = useRef<HTMLSpanElement>(null);
  const bbLowerValRef = useRef<HTMLSpanElement>(null);
  const vma5ValRef = useRef<HTMLSpanElement>(null);
  const vma20ValRef = useRef<HTMLSpanElement>(null);

  // Sub-charts values refs (absolute overlays in their respective charts)
  const macdDifRef = useRef<HTMLSpanElement>(null);
  const macdDeaRef = useRef<HTMLSpanElement>(null);
  const macdOscRef = useRef<HTMLSpanElement>(null);
  const kdKRef = useRef<HTMLSpanElement>(null);
  const kdDRef = useRef<HTMLSpanElement>(null);
  const rsi6Ref = useRef<HTMLSpanElement>(null);
  const rsi12Ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    const mainEl = mainContainerRef.current;
    if (!el || !mainEl || !rows || rows.length === 0) return;

    // --- Pre-compute Indicator Data ---
    const ma5Data = settings.ma5 ? calculateSMA(rows, 5, isIntraday) : [];
    const ma10Data = settings.ma10 ? calculateSMA(rows, 10, isIntraday) : [];
    const ma20Data = settings.ma20 ? calculateSMA(rows, 20, isIntraday) : [];
    const ma60Data = settings.ma60 ? calculateSMA(rows, 60, isIntraday) : [];

    const bbandsData = settings.bbands ? calculateBBands(rows, 20, 2, isIntraday) : [];

    const vma5Data = settings.vma5 ? calculateVolumeSMA(rows, 5, isIntraday) : [];
    const vma20Data = settings.vma20 ? calculateVolumeSMA(rows, 20, isIntraday) : [];

    const isMacdDataSufficient = rows.length >= 34;
    const macdData = settings.macd && isMacdDataSufficient ? calculateMACD(rows, isIntraday) : null;

    const isKdDataSufficient = rows.length >= 9;
    const kdData = settings.kd && isKdDataSufficient ? calculateKD(rows, isIntraday) : null;

    const isRsiDataSufficient = rows.length >= 13;
    const rsiData = settings.rsi && isRsiDataSufficient ? {
      rsi6: calculateRSI(rows, 6, isIntraday),
      rsi12: calculateRSI(rows, 12, isIntraday)
    } : null;

    // --- Performance Optimization: Build Lookup Maps ---
    const ma5Map = new Map(ma5Data.map((d) => [d.time, d.value]));
    const ma10Map = new Map(ma10Data.map((d) => [d.time, d.value]));
    const ma20Map = new Map(ma20Data.map((d) => [d.time, d.value]));
    const ma60Map = new Map(ma60Data.map((d) => [d.time, d.value]));

    const bbUpperMap = new Map(bbandsData.map((d) => [d.time, d.upper]));
    const bbMiddleMap = new Map(bbandsData.map((d) => [d.time, d.middle]));
    const bbLowerMap = new Map(bbandsData.map((d) => [d.time, d.lower]));

    const vma5Map = new Map(vma5Data.map((d) => [d.time, d.value]));
    const vma20Map = new Map(vma20Data.map((d) => [d.time, d.value]));

    const macdDifMap = macdData ? new Map(macdData.dif.map((d) => [d.time, d.value])) : null;
    const macdDeaMap = macdData ? new Map(macdData.dea.map((d) => [d.time, d.value])) : null;
    const macdOscMap = macdData ? new Map(macdData.osc.map((d) => [d.time, d.value])) : null;

    const kdKMap = kdData ? new Map(kdData.k.map((d) => [d.time, d.value])) : null;
    const kdDMap = kdData ? new Map(kdData.d.map((d) => [d.time, d.value])) : null;

    const rsi6Map = rsiData ? new Map(rsiData.rsi6.map((d) => [d.time, d.value])) : null;
    const rsi12Map = rsiData ? new Map(rsiData.rsi12.map((d) => [d.time, d.value])) : null;

    // Helper to create chart instances with shared default options
    const createChartInstance = (container: HTMLDivElement, h: number) => {
      return createChart(container, {
        height: h,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#94a3b8',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: '#27272a' },
          horzLines: { color: '#27272a' },
        },
        rightPriceScale: {
          borderColor: '#3f3f46',
          minimumWidth: 80,
        },
        timeScale: {
          borderColor: '#3f3f46',
          timeVisible: isIntraday,
          secondsVisible: false,
        },
        crosshair: { mode: 0 },
        handleScale: true,
        handleScroll: true,
      });
    };

    // --- Create Main Chart ---
    const mainChart = createChartInstance(mainEl, height);

    const candle = mainChart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#22c55e',
      borderUpColor: '#ef4444',
      borderDownColor: '#22c55e',
      wickUpColor: '#ef4444',
      wickDownColor: '#22c55e',
    });

    const candleData: CandlestickData[] = rows
      .filter((r) => r && r.close != null)
      .map((r) => ({
        time: toTime(r.date, isIntraday) as never,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      }));
    candle.setData(candleData);

    // Add main chart indicator series
    let ma5Series: any = null;
    if (settings.ma5 && ma5Data.length > 0) {
      ma5Series = mainChart.addLineSeries({ color: '#a855f7', lineWidth: 2, title: 'MA5' });
      ma5Series.setData(ma5Data);
    }
    let ma10Series: any = null;
    if (settings.ma10 && ma10Data.length > 0) {
      ma10Series = mainChart.addLineSeries({ color: '#ec4899', lineWidth: 2, title: 'MA10' });
      ma10Series.setData(ma10Data);
    }
    let ma20Series: any = null;
    if (settings.ma20 && ma20Data.length > 0) {
      ma20Series = mainChart.addLineSeries({ color: '#eab308', lineWidth: 2, title: 'MA20' });
      ma20Series.setData(ma20Data);
    }
    let ma60Series: any = null;
    if (settings.ma60 && ma60Data.length > 0) {
      ma60Series = mainChart.addLineSeries({ color: '#3b82f6', lineWidth: 2, title: 'MA60' });
      ma60Series.setData(ma60Data);
    }

    let bbUpperSeries: any = null;
    let bbMiddleSeries: any = null;
    let bbLowerSeries: any = null;
    if (settings.bbands && bbandsData.length > 0) {
      bbUpperSeries = mainChart.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: 2, title: 'BB Upper' });
      bbUpperSeries.setData(bbandsData.map(d => ({ time: d.time, value: d.upper })));
      // Use dotted style for BB Middle to resolve visual overlap with MA20
      bbMiddleSeries = mainChart.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: 3, title: 'BB Middle' });
      bbMiddleSeries.setData(bbandsData.map(d => ({ time: d.time, value: d.middle })));
      bbLowerSeries = mainChart.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: 2, title: 'BB Lower' });
      bbLowerSeries.setData(bbandsData.map(d => ({ time: d.time, value: d.lower })));
    }

    // Volume Histogram
    let volSeries: any = null;
    if (settings.vol) {
      volSeries = mainChart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      const volData: HistogramData[] = rows
        .filter((r) => r.volume != null)
        .map((r) => ({
          time: toTime(r.date, isIntraday) as never,
          value: Number(r.volume),
          color: Number(r.close) >= Number(r.open) ? '#ef444455' : '#22c55e55',
        }));
      volSeries.setData(volData);
    }

    // Volume MAs (Only draw if volume is enabled)
    let vma5Series: any = null;
    if (settings.vol && settings.vma5 && vma5Data.length > 0) {
      vma5Series = mainChart.addLineSeries({
        color: '#f97316',
        lineWidth: 1,
        priceScaleId: 'vol',
        title: 'VMA5',
      });
      vma5Series.setData(vma5Data);
    }
    let vma20Series: any = null;
    if (settings.vol && settings.vma20 && vma20Data.length > 0) {
      vma20Series = mainChart.addLineSeries({
        color: '#06b6d4',
        lineWidth: 1,
        priceScaleId: 'vol',
        title: 'VMA20',
      });
      vma20Series.setData(vma20Data);
    }

    // --- Create MACD Sub-Chart ---
    let macdChart: IChartApi | null = null;
    let macdDifSeries: any = null;
    let macdDeaSeries: any = null;
    let macdOscSeries: any = null;
    if (settings.macd && macdData && macdContainerRef.current) {
      macdChart = createChartInstance(macdContainerRef.current, 120);

      // Whitespace spine to align index-based time scale logically with main chart
      const spine = macdChart.addLineSeries({ lastValueVisible: false, priceLineVisible: false });
      spine.setData(rows.map(r => ({ time: toTime(r.date, isIntraday) })));

      macdDifSeries = macdChart.addLineSeries({ color: '#cbd5e1', lineWidth: 2, title: 'DIF' });
      macdDifSeries.setData(macdData.dif);
      macdDeaSeries = macdChart.addLineSeries({ color: '#3b82f6', lineWidth: 2, title: 'DEA' });
      macdDeaSeries.setData(macdData.dea);
      macdOscSeries = macdChart.addHistogramSeries({ title: 'OSC' });
      macdOscSeries.setData(macdData.osc);
    }

    // --- Create KD Sub-Chart ---
    let kdChart: IChartApi | null = null;
    let kdKSeries: any = null;
    let kdDSeries: any = null;
    if (settings.kd && kdData && kdContainerRef.current) {
      kdChart = createChartInstance(kdContainerRef.current, 120);

      // Whitespace spine to align index-based time scale logically with main chart
      const spine = kdChart.addLineSeries({ lastValueVisible: false, priceLineVisible: false });
      spine.setData(rows.map(r => ({ time: toTime(r.date, isIntraday) })));

      kdKSeries = kdChart.addLineSeries({ color: '#f97316', lineWidth: 2, title: 'K' });
      kdKSeries.setData(kdData.k);
      kdDSeries = kdChart.addLineSeries({ color: '#06b6d4', lineWidth: 2, title: 'D' });
      kdDSeries.setData(kdData.d);

      kdKSeries.createPriceLine({ price: 80, color: '#3f3f46', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '超買' });
      kdKSeries.createPriceLine({ price: 20, color: '#3f3f46', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '超賣' });
    }

    // --- Create RSI Sub-Chart ---
    let rsiChart: IChartApi | null = null;
    let rsi6Series: any = null;
    let rsi12Series: any = null;
    if (settings.rsi && rsiData && rsiContainerRef.current) {
      rsiChart = createChartInstance(rsiContainerRef.current, 120);

      // Whitespace spine to align index-based time scale logically with main chart
      const spine = rsiChart.addLineSeries({ lastValueVisible: false, priceLineVisible: false });
      spine.setData(rows.map(r => ({ time: toTime(r.date, isIntraday) })));

      rsi6Series = rsiChart.addLineSeries({ color: '#d946ef', lineWidth: 2, title: 'RSI6' });
      rsi6Series.setData(rsiData.rsi6);
      rsi12Series = rsiChart.addLineSeries({ color: '#06b6d4', lineWidth: 2, title: 'RSI12' });
      rsi12Series.setData(rsiData.rsi12);

      rsi6Series.createPriceLine({ price: 70, color: '#3f3f46', lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
      rsi6Series.createPriceLine({ price: 50, color: '#27272a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
      rsi6Series.createPriceLine({ price: 30, color: '#3f3f46', lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    }

    // Gather active charts
    const activeCharts = [mainChart, macdChart, kdChart, rsiChart].filter(Boolean) as IChartApi[];

    // --- Sync Visible Ranges Initially ---
    if (activeCharts.length > 1) {
      const range = mainChart.timeScale().getVisibleLogicalRange();
      if (range) {
        activeCharts.forEach((c) => {
          if (c !== mainChart) {
            c.timeScale().setVisibleLogicalRange(range);
          }
        });
      }
    }

    // --- Sync Scroll/Zoom Horizontal Range ---
    let isSyncingRange = false;
    activeCharts.forEach((chart) => {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (isSyncingRange || !range) return;
        isSyncingRange = true;
        activeCharts.forEach((otherChart) => {
          if (otherChart !== chart) {
            otherChart.timeScale().setVisibleLogicalRange(range);
          }
        });
        isSyncingRange = false;
      });
    });

    // --- Dynamic Legend Updates ---
    const updateLegends = (time: any) => {
      if (!time) {
        // Revert to last data point
        if (rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          updateLegends(toTime(lastRow.date, isIntraday));
        }
        return;
      }

      const row = rows.find((r) => toTime(r.date, isIntraday) === time);
      if (!row) return;

      const displayDate = typeof time === 'number'
        ? new Date(time * 1000).toLocaleString('zh-TW', { hour12: false }).substring(0, 16)
        : String(time);

      if (dateValRef.current) dateValRef.current.textContent = displayDate;
      if (openValRef.current) openValRef.current.textContent = Number(row.open).toFixed(1);
      if (highValRef.current) highValRef.current.textContent = Number(row.high).toFixed(1);
      if (lowValRef.current) lowValRef.current.textContent = Number(row.low).toFixed(1);
      if (closeValRef.current) {
        closeValRef.current.textContent = Number(row.close).toFixed(1);
        const close = Number(row.close);
        const open = Number(row.open);
        closeValRef.current.className = close >= open ? 'text-bull font-bold' : 'text-bear font-bold';
      }
      if (volValRef.current) volValRef.current.textContent = Number(row.volume || 0).toLocaleString();

      if (ma5ValRef.current) {
        const val = ma5Map.get(time);
        ma5ValRef.current.textContent = val !== undefined ? val.toFixed(1) : '--';
      }
      if (ma10ValRef.current) {
        const val = ma10Map.get(time);
        ma10ValRef.current.textContent = val !== undefined ? val.toFixed(1) : '--';
      }
      if (ma20ValRef.current) {
        const val = ma20Map.get(time);
        ma20ValRef.current.textContent = val !== undefined ? val.toFixed(1) : '--';
      }
      if (ma60ValRef.current) {
        const val = ma60Map.get(time);
        ma60ValRef.current.textContent = val !== undefined ? val.toFixed(1) : '--';
      }

      if (settings.bbands && bbandsData.length > 0) {
        const upperVal = bbUpperMap.get(time);
        const middleVal = bbMiddleMap.get(time);
        const lowerVal = bbLowerMap.get(time);
        if (bbUpperValRef.current) bbUpperValRef.current.textContent = upperVal !== undefined ? upperVal.toFixed(1) : '--';
        if (bbMiddleValRef.current) bbMiddleValRef.current.textContent = middleVal !== undefined ? middleVal.toFixed(1) : '--';
        if (bbLowerValRef.current) bbLowerValRef.current.textContent = lowerVal !== undefined ? lowerVal.toFixed(1) : '--';
      }

      if (vma5ValRef.current) {
        const val = vma5Map.get(time);
        vma5ValRef.current.textContent = val !== undefined ? Math.floor(val).toLocaleString() : '--';
      }
      if (vma20ValRef.current) {
        const val = vma20Map.get(time);
        vma20ValRef.current.textContent = val !== undefined ? Math.floor(val).toLocaleString() : '--';
      }

      // MACD Sub-chart Legend
      if (settings.macd && macdData) {
        const difVal = macdDifMap?.get(time);
        const deaVal = macdDeaMap?.get(time);
        const oscVal = macdOscMap?.get(time);
        if (macdDifRef.current) macdDifRef.current.textContent = difVal !== undefined ? difVal.toFixed(2) : '--';
        if (macdDeaRef.current) macdDeaRef.current.textContent = deaVal !== undefined ? deaVal.toFixed(2) : '--';
        if (macdOscRef.current) {
          macdOscRef.current.textContent = oscVal !== undefined ? oscVal.toFixed(2) : '--';
          if (oscVal !== undefined) {
            macdOscRef.current.className = oscVal >= 0 ? 'text-bull font-bold' : 'text-bear font-bold';
          }
        }
      }

      // KD Sub-chart Legend
      if (settings.kd && kdData) {
        const kVal = kdKMap?.get(time);
        const dVal = kdDMap?.get(time);
        if (kdKRef.current) kdKRef.current.textContent = kVal !== undefined ? kVal.toFixed(1) : '--';
        if (kdDRef.current) kdDRef.current.textContent = dVal !== undefined ? dVal.toFixed(1) : '--';
      }

      // RSI Sub-chart Legend
      if (settings.rsi && rsiData) {
        const rsi6Val = rsi6Map?.get(time);
        const rsi12Val = rsi12Map?.get(time);
        if (rsi6Ref.current) rsi6Ref.current.textContent = rsi6Val !== undefined ? rsi6Val.toFixed(1) : '--';
        if (rsi12Ref.current) rsi12Ref.current.textContent = rsi12Val !== undefined ? rsi12Val.toFixed(1) : '--';
      }
    };

    // Set initial legend content to the last bar
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      updateLegends(toTime(lastRow.date, isIntraday));
    }

    // --- Sync Crosshair Move & Hover Details ---
    let isSyncingCrosshair = false;
    activeCharts.forEach((chart) => {
      chart.subscribeCrosshairMove((param) => {
        if (isSyncingCrosshair) return;
        const time = param.time;

        if (!time || !param.point || param.point.x < 0 || param.point.y < 0) {
          // Clear crosshairs on other charts
          isSyncingCrosshair = true;
          activeCharts.forEach((otherChart) => {
            if (otherChart !== chart) {
              otherChart.clearCrosshairPosition();
            }
          });
          isSyncingCrosshair = false;
          updateLegends(undefined);
        } else {
          // Sync other charts
          isSyncingCrosshair = true;
          activeCharts.forEach((otherChart) => {
            if (otherChart !== chart) {
              let targetSeries: any = null;
              let price = 0;

              if (otherChart === mainChart) {
                targetSeries = candle;
                const row = rows.find((r) => toTime(r.date, isIntraday) === (time as any));
                price = Number(row?.close || 0);
              } else if (otherChart === macdChart && macdData) {
                targetSeries = macdDifSeries;
                price = macdDifMap?.get(time as any) || 0;
              } else if (otherChart === kdChart && kdData) {
                targetSeries = kdKSeries;
                price = kdKMap?.get(time as any) || 0;
              } else if (otherChart === rsiChart && rsiData) {
                targetSeries = rsi6Series;
                price = rsi6Map?.get(time as any) || 0;
              }

              if (targetSeries) {
                otherChart.setCrosshairPosition(price, time, targetSeries);
              }
            }
          });
          isSyncingCrosshair = false;
          updateLegends(time);
        }
      });
    });

    mainChart.timeScale().fitContent();

    // --- Handle Resize Alignment ---
    const ro = new ResizeObserver(() => {
      if (el) {
        const width = el.clientWidth;
        activeCharts.forEach((c) => c.applyOptions({ width }));
      }
    });
    ro.observe(el);

    // --- Cleanup Charts on Change ---
    return () => {
      ro.disconnect();
      activeCharts.forEach((c) => c.remove());
    };
  }, [rows, isIntraday, height, settings]);

  return (
    <div ref={containerRef} className="w-full flex flex-col gap-2">
      {/* Dynamic Indicators Controls Bar */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3 items-center text-xs text-zinc-400 bg-zinc-900/40 p-2.5 rounded-lg border border-zinc-800/80">
        <span className="font-semibold text-zinc-300">技術指標：</span>
        
        {/* Main Chart MAs */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.ma5}
            onChange={() => toggleSetting('ma5')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          MA5
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.ma10}
            onChange={() => toggleSetting('ma10')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          MA10
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.ma20}
            onChange={() => toggleSetting('ma20')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          MA20
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.ma60}
            onChange={() => toggleSetting('ma60')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          MA60
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.bbands}
            onChange={() => toggleSetting('bbands')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          布林通道 (20,2)
        </label>

        <span className="text-zinc-700">|</span>

        {/* Volume */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.vol}
            onChange={() => toggleSetting('vol')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          成交量
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.vma5}
            onChange={() => toggleSetting('vma5')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          VMA5
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.vma20}
            onChange={() => toggleSetting('vma20')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          VMA20
        </label>

        <span className="text-zinc-700">|</span>

        {/* Sub-charts */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.macd}
            onChange={() => toggleSetting('macd')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          MACD
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.kd}
            onChange={() => toggleSetting('kd')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          KD
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-zinc-200">
          <input
            type="checkbox"
            checked={settings.rsi}
            onChange={() => toggleSetting('rsi')}
            className="rounded border-zinc-700 text-primary focus:ring-0 focus:ring-offset-0 bg-zinc-950"
          />
          RSI
        </label>
      </div>

      {/* Candlestick Main Chart Container */}
      <div className="relative w-full flex-1 flex flex-col min-h-[300px]">
        {/* Dynamic Legend Overlay */}
        <div className="absolute top-2 left-2 z-10 text-[10px] sm:text-xs font-mono select-none flex flex-wrap gap-x-2 gap-y-1 p-2 bg-zinc-950/80 rounded-md border border-zinc-800/80 pointer-events-none text-zinc-400 max-w-[95%]">
          <span className="text-zinc-500 font-bold" ref={dateValRef}>--</span>
          <span>開:<strong className="text-zinc-100 ml-0.5" ref={openValRef}>--</strong></span>
          <span>高:<strong className="text-zinc-100 ml-0.5" ref={highValRef}>--</strong></span>
          <span>低:<strong className="text-zinc-100 ml-0.5" ref={lowValRef}>--</strong></span>
          <span>收:<strong className="text-zinc-100 ml-0.5" ref={closeValRef}>--</strong></span>
          {settings.vol && <span>量:<strong className="text-zinc-100 ml-0.5" ref={volValRef}>--</strong></span>}
          
          {settings.ma5 && <span>MA5:<strong className="text-purple-400 ml-0.5" ref={ma5ValRef}>--</strong></span>}
          {settings.ma10 && <span>MA10:<strong className="text-pink-400 ml-0.5" ref={ma10ValRef}>--</strong></span>}
          {settings.ma20 && <span>MA20:<strong className="text-yellow-500 ml-0.5" ref={ma20ValRef}>--</strong></span>}
          {settings.ma60 && <span>MA60:<strong className="text-blue-500 ml-0.5" ref={ma60ValRef}>--</strong></span>}
          
          {settings.bbands && (
            <>
              <span>BB上:<strong className="text-slate-400 ml-0.5" ref={bbUpperValRef}>--</strong></span>
              <span>BB中:<strong className="text-slate-400 ml-0.5" ref={bbMiddleValRef}>--</strong></span>
              <span>BB下:<strong className="text-slate-400 ml-0.5" ref={bbLowerValRef}>--</strong></span>
            </>
          )}

          {settings.vol && settings.vma5 && <span>VMA5:<strong className="text-orange-400 ml-0.5" ref={vma5ValRef}>--</strong></span>}
          {settings.vol && settings.vma20 && <span>VMA20:<strong className="text-cyan-400 ml-0.5" ref={vma20ValRef}>--</strong></span>}
        </div>
        <div ref={mainContainerRef} className="w-full h-full flex-1 min-h-[300px]" />
      </div>

      {/* MACD Sub-chart Panel */}
      {settings.macd && (
        <div className="w-full h-[120px] mt-2 border-t border-zinc-800 pt-2 relative bg-zinc-950/20 rounded-lg">
          {rows.length >= 34 ? (
            <>
              <div className="absolute top-1 left-2 z-10 text-[10px] font-mono text-zinc-400 select-none pointer-events-none">
                MACD(12,26,9) DIF: <span className="text-slate-300 font-bold" ref={macdDifRef}>--</span> DEA: <span className="text-blue-400 font-bold" ref={macdDeaRef}>--</span> OSC: <span className="font-bold" ref={macdOscRef}>--</span>
              </div>
              <div ref={macdContainerRef} className="w-full h-full" />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
              MACD 資料不足 (需要至少 34 筆)
            </div>
          )}
        </div>
      )}

      {/* KD Sub-chart Panel */}
      {settings.kd && (
        <div className="w-full h-[120px] mt-2 border-t border-zinc-800 pt-2 relative bg-zinc-950/20 rounded-lg">
          {rows.length >= 9 ? (
            <>
              <div className="absolute top-1 left-2 z-10 text-[10px] font-mono text-zinc-400 select-none pointer-events-none">
                KD(9,3,3) K: <span className="text-orange-400 font-bold" ref={kdKRef}>--</span> D: <span className="text-cyan-400 font-bold" ref={kdDRef}>--</span>
              </div>
              <div ref={kdContainerRef} className="w-full h-full" />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
              KD 資料不足 (需要至少 9 筆)
            </div>
          )}
        </div>
      )}

      {/* RSI Sub-chart Panel */}
      {settings.rsi && (
        <div className="w-full h-[120px] mt-2 border-t border-zinc-800 pt-2 relative bg-zinc-950/20 rounded-lg">
          {rows.length >= 13 ? (
            <>
              <div className="absolute top-1 left-2 z-10 text-[10px] font-mono text-zinc-400 select-none pointer-events-none">
                RSI RSI6: <span className="text-pink-400 font-bold" ref={rsi6Ref}>--</span> RSI12: <span className="text-cyan-400 font-bold" ref={rsi12Ref}>--</span>
              </div>
              <div ref={rsiContainerRef} className="w-full h-full" />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
              RSI 資料不足 (需要至少 13 筆)
            </div>
          )}
        </div>
      )}
    </div>
  );
};
