import type { OhlcvRow } from './api';
import type { UTCTimestamp } from 'lightweight-charts';

export const toTime = (d: string | number, isIntraday: boolean): UTCTimestamp | string => {
  if (typeof d === 'number') {
    return (d > 1e12 ? Math.floor(d / 1000) : d) as UTCTimestamp;
  }
  if (isIntraday) {
    return Math.floor(new Date(d).getTime() / 1000) as UTCTimestamp;
  }
  return String(d).slice(0, 10);
};

export function calculateSMA(rows: OhlcvRow[], period: number, isIntraday: boolean) {
  const data: { time: string | UTCTimestamp; value: number }[] = [];
  if (rows.length < period) return data;

  for (let i = period - 1; i < rows.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < period; j++) {
      const val = Number(rows[i - j].close);
      if (!isNaN(val)) {
        sum += val;
        count++;
      }
    }
    if (count === period) {
      data.push({
        time: toTime(rows[i].date, isIntraday) as never,
        value: sum / count,
      });
    }
  }
  return data;
}

export function calculateVolumeSMA(rows: OhlcvRow[], period: number, isIntraday: boolean) {
  const data: { time: string | UTCTimestamp; value: number }[] = [];
  if (rows.length < period) return data;

  for (let i = period - 1; i < rows.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < period; j++) {
      const val = Number(rows[i - j].volume || 0);
      if (!isNaN(val)) {
        sum += val;
        count++;
      }
    }
    if (count === period) {
      data.push({
        time: toTime(rows[i].date, isIntraday) as never,
        value: sum / count,
      });
    }
  }
  return data;
}

export function calculateEMAValues(values: number[], period: number): number[] {
  const ema: number[] = [];
  if (values.length === 0) return ema;

  const alpha = 2 / (period + 1);
  ema[0] = values[0];

  for (let i = 1; i < values.length; i++) {
    ema[i] = ema[i - 1] + alpha * (values[i] - ema[i - 1]);
  }
  return ema;
}

export function calculateEMA(rows: OhlcvRow[], period: number, isIntraday: boolean) {
  const data: { time: string | UTCTimestamp; value: number }[] = [];
  if (rows.length < period) return data;

  const closes = rows.map(r => Number(r.close));
  const emaValues = calculateEMAValues(closes, period);

  for (let i = period - 1; i < rows.length; i++) {
    data.push({
      time: toTime(rows[i].date, isIntraday) as never,
      value: emaValues[i],
    });
  }
  return data;
}

export interface MacdResult {
  time: string | UTCTimestamp;
  dif: number;
  dea: number;
  osc: number;
  color: string;
}

export function calculateMACD(rows: OhlcvRow[], isIntraday: boolean) {
  const closes = rows.map(r => Number(r.close));
  const ema12 = calculateEMAValues(closes, 12);
  const ema26 = calculateEMAValues(closes, 26);

  const difValues: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    difValues[i] = ema12[i] - ema26[i];
  }

  const deaValues = calculateEMAValues(difValues, 9);

  const difData: { time: string | UTCTimestamp; value: number }[] = [];
  const deaData: { time: string | UTCTimestamp; value: number }[] = [];
  const oscData: { time: string | UTCTimestamp; value: number; color: string }[] = [];

  const difStart = 25;
  const deaStart = 33;

  for (let i = difStart; i < rows.length; i++) {
    const time = toTime(rows[i].date, isIntraday);
    difData.push({ time: time as never, value: difValues[i] });

    if (i >= deaStart) {
      deaData.push({ time: time as never, value: deaValues[i] });
      const osc = difValues[i] - deaValues[i];
      oscData.push({
        time: time as never,
        value: osc,
        color: osc >= 0 ? '#ef4444' : '#22c55e',
      });
    }
  }

  return { dif: difData, dea: deaData, osc: oscData };
}

export function calculateKD(rows: OhlcvRow[], isIntraday: boolean) {
  const kData: { time: string | UTCTimestamp; value: number }[] = [];
  const dData: { time: string | UTCTimestamp; value: number }[] = [];
  if (rows.length < 9) return { k: kData, d: dData };

  const K: number[] = new Array(rows.length).fill(50);
  const D: number[] = new Array(rows.length).fill(50);

  for (let i = 8; i < rows.length; i++) {
    let h9 = -Infinity;
    let l9 = Infinity;
    for (let j = 0; j < 9; j++) {
      const h = Number(rows[i - j].high);
      const l = Number(rows[i - j].low);
      if (h > h9) h9 = h;
      if (l < l9) l9 = l;
    }

    const close = Number(rows[i].close);
    let rsv = 50;
    if (h9 !== l9) {
      rsv = ((close - l9) / (h9 - l9)) * 100;
    }

    K[i] = (2 / 3) * K[i - 1] + (1 / 3) * rsv;
    D[i] = (2 / 3) * D[i - 1] + (1 / 3) * K[i];
  }

  for (let i = 8; i < rows.length; i++) {
    const time = toTime(rows[i].date, isIntraday);
    kData.push({ time: time as never, value: K[i] });
    dData.push({ time: time as never, value: D[i] });
  }

  return { k: kData, d: dData };
}

export function calculateRSI(rows: OhlcvRow[], period: number, isIntraday: boolean) {
  const data: { time: string | UTCTimestamp; value: number }[] = [];
  if (rows.length <= period) return data;

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const diff = Number(rows[i].close) - Number(rows[i - 1].close);
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  let rs = avgLoss === 0 ? null : avgGain / avgLoss;
  let rsi = rs === null ? 100 : 100 - 100 / (1 + rs);
  data.push({
    time: toTime(rows[period].date, isIntraday) as never,
    value: rsi,
  });

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    rs = avgLoss === 0 ? null : avgGain / avgLoss;
    rsi = rs === null ? 100 : 100 - 100 / (1 + rs);

    data.push({
      time: toTime(rows[i + 1].date, isIntraday) as never,
      value: rsi,
    });
  }

  return data;
}

export interface BBandsResult {
  time: string | UTCTimestamp;
  upper: number;
  middle: number;
  lower: number;
}

export function calculateBBands(
  rows: OhlcvRow[],
  period: number,
  k: number,
  isIntraday: boolean
): BBandsResult[] {
  const data: BBandsResult[] = [];
  if (rows.length < period) return data;

  for (let i = period - 1; i < rows.length; i++) {
    let sum = 0;
    const closes: number[] = [];
    for (let j = 0; j < period; j++) {
      const val = Number(rows[i - j].close);
      sum += val;
      closes.push(val);
    }
    const middle = sum / period;

    let sumSquares = 0;
    for (const val of closes) {
      sumSquares += Math.pow(val - middle, 2);
    }
    const variance = sumSquares / period;
    const stdDev = Math.sqrt(variance);

    const upper = middle + k * stdDev;
    const lower = middle - k * stdDev;

    data.push({
      time: toTime(rows[i].date, isIntraday) as never,
      upper,
      middle,
      lower,
    });
  }

  return data;
}
