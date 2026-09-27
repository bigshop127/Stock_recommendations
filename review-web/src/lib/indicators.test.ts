import { describe, it, expect } from 'vitest';
import { calculateKD, calculateRSI, calculateBBands, calculateMACD, calculateSMA, recentWindowStart } from './indicators';
import type { OhlcvRow } from './api';

// Helper to create test rows
const createMockRows = (closes: number[], highs?: number[], lows?: number[]): OhlcvRow[] => {
  return closes.map((close, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    open: closes[i],
    high: highs ? highs[i] : closes[i],
    low: lows ? lows[i] : closes[i],
    close,
    volume: 1000,
  }));
};

describe('Technical Indicators Calculations', () => {
  describe('SMA', () => {
    it('should compute simple moving average', () => {
      const closes = [10, 20, 30, 40, 50];
      const rows = createMockRows(closes);
      const sma = calculateSMA(rows, 3, false);
      
      // Expected length: 5 - 3 + 1 = 3
      expect(sma.length).toBe(3);
      expect(sma[0].value).toBe((10 + 20 + 30) / 3); // index 2
      expect(sma[1].value).toBe((20 + 30 + 40) / 3); // index 3
      expect(sma[2].value).toBe((30 + 40 + 50) / 3); // index 4
    });
  });

  describe('KD', () => {
    it('should compute KD values with seed 50', () => {
      // 9 days of flat prices
      const flatRows = createMockRows(new Array(9).fill(100));
      const kdFlat = calculateKD(flatRows, false);
      expect(kdFlat.k.length).toBe(1);
      expect(kdFlat.d.length).toBe(1);
      expect(kdFlat.k[0].value).toBeCloseTo(50, 4);
      expect(kdFlat.d[0].value).toBeCloseTo(50, 4);

      // 9 days with variable prices
      // First 8 days flat 100
      const closes = [...new Array(8).fill(100), 120];
      const highs = [...new Array(8).fill(100), 120];
      const lows = [...new Array(8).fill(100), 100];
      const rows = createMockRows(closes, highs, lows);

      const kd = calculateKD(rows, false);
      // RSV at index 8 = (120 - 100) / (120 - 100) * 100 = 100
      // K_8 = (2/3) * 50 + (1/3) * 100 = 66.66666...
      // D_8 = (2/3) * 50 + (1/3) * 66.66666... = 55.5555...
      expect(kd.k[0].value).toBeCloseTo(66.67, 1);
      expect(kd.d[0].value).toBeCloseTo(55.56, 1);
    });
  });

  describe('RSI', () => {
    it('should compute RSI values correctly', () => {
      // Closes steadily increasing (RSI should be 100)
      const incRows = createMockRows([10, 20, 30, 40, 50, 60, 70, 80]);
      const rsiInc = calculateRSI(incRows, 6, false);
      expect(rsiInc.length).toBe(2);
      expect(rsiInc[0].value).toBe(100);
      expect(rsiInc[1].value).toBe(100);

      // Closes steadily decreasing (RSI should be 0)
      const decRows = createMockRows([80, 70, 60, 50, 40, 30, 20, 10]);
      const rsiDec = calculateRSI(decRows, 6, false);
      expect(rsiDec.length).toBe(2);
      expect(rsiDec[0].value).toBe(0);
      expect(rsiDec[1].value).toBe(0);
    });
  });

  describe('BBands', () => {
    it('should compute upper, middle, and lower bands', () => {
      const flatRows = createMockRows(new Array(20).fill(100));
      const bbands = calculateBBands(flatRows, 20, 2, false);
      expect(bbands.length).toBe(1);
      expect(bbands[0].middle).toBe(100);
      expect(bbands[0].upper).toBe(100);
      expect(bbands[0].lower).toBe(100);
    });
  });

  describe('MACD', () => {
    it('should calculate MACD DIF, DEA, and OSC values', () => {
      const flatRows = createMockRows(new Array(35).fill(100));
      const macd = calculateMACD(flatRows, false);
      // Flat inputs: DIF and DEA should be 0, OSC should be 0
      expect(macd.dif.length).toBe(10); // starts at index 25 (35 - 25 = 10)
      expect(macd.dea.length).toBe(2);  // starts at index 33 (35 - 33 = 2)
      expect(macd.dif[0].value).toBeCloseTo(0, 4);
      expect(macd.dea[0].value).toBeCloseTo(0, 4);
      expect(macd.osc[0].value).toBeCloseTo(0, 4);
    });
  });
});

describe('recentWindowStart（日 K 預設只框近兩個月）', () => {
  // 2026-06-01 起每個平日一根
  const weekdays = (start: string, count: number) => {
    const out: string[] = [];
    const d = new Date(`${start}T00:00:00Z`);
    while (out.length < count) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };

  it('最後一根 9/25 → 從 7/25 以後的第一根開始', () => {
    const dates = weekdays('2026-06-01', 85); // 最後一天 2026-09-25
    const last = dates[dates.length - 1];
    expect(last).toBe('2026-09-25');
    const i = recentWindowStart(dates, 2);
    expect(dates[i]).toBe('2026-07-27'); // 7/25、7/26 是週末
    expect(dates[i - 1] < '2026-07-25').toBe(true);
  });

  it('月底往前推到短月份會夾在月底（4/30 → 2/28）', () => {
    const dates = ['2026-02-27', '2026-02-28', '2026-03-02', ...weekdays('2026-03-03', 40), '2026-04-30'];
    const i = recentWindowStart(dates, 2, 1);
    expect(dates[i]).toBe('2026-02-28');
  });

  it('資料不到 minBars 根就從頭；剛好在邊界也至少留 minBars 根', () => {
    expect(recentWindowStart(weekdays('2026-09-01', 10), 2)).toBe(0);
    const dates = weekdays('2026-01-01', 200);
    const i = recentWindowStart(dates, 2, 60);
    expect(dates.length - i).toBeGreaterThanOrEqual(60);
  });

  it('空陣列、日期格式不對都回 0', () => {
    expect(recentWindowStart([], 2)).toBe(0);
    expect(recentWindowStart(['abc'], 2)).toBe(0);
  });
});
