import { describe, it, expect } from 'vitest';
import { calculateATR, buildKeyLevels, roundLevel, fmtLevel } from './keyLevels';
import type { OhlcvRow } from './api';

const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
};
const bar = (i: number, close: number, spread = 1): OhlcvRow => ({
  date: day(i),
  open: close,
  high: close + spread,
  low: close - spread,
  close,
  volume: 1000,
});

describe('calculateATR', () => {
  it('Wilder 平滑逐步手算一致（含跳空，真實區間取昨收差）', () => {
    const rows: OhlcvRow[] = [
      { date: '2026-01-01', open: 10, high: 10.5, low: 9.5, close: 10 },
      { date: '2026-01-02', open: 11, high: 11.5, low: 10.5, close: 11 }, // TR 1.5（高−昨收）
      { date: '2026-01-03', open: 12, high: 12.2, low: 11.2, close: 12 }, // TR 1.2
      { date: '2026-01-04', open: 11, high: 12, low: 10.8, close: 11 },   // TR 1.2（低−昨收）
      { date: '2026-01-05', open: 13, high: 13.5, low: 12.5, close: 13 }, // TR 2.5
    ];
    // period=2：起點 (1.5+1.2)/2=1.35 → (1.35+1.2)/2=1.275 → (1.275+2.5)/2=1.8875
    expect(calculateATR(rows, 2)).toBeCloseTo(1.8875, 10);
  });

  it('資料不足 period+1 根回 null', () => {
    expect(calculateATR([bar(0, 10), bar(1, 10), bar(2, 10)], 2)).not.toBeNull();
    expect(calculateATR([bar(0, 10), bar(1, 10)], 2)).toBeNull();
    expect(calculateATR(Array.from({ length: 14 }, (_, i) => bar(i, 10)))).toBeNull();
  });

  it('每天高低差固定 2、沒有跳空 → ATR = 2', () => {
    const rows = Array.from({ length: 40 }, (_, i) => bar(i, 100));
    expect(calculateATR(rows)).toBeCloseTo(2, 10);
  });
});

describe('roundLevel / fmtLevel', () => {
  it('依價位決定位數，警示與畫面用同一個數字', () => {
    expect(roundLevel(1234.4)).toBe(1234);
    expect(roundLevel(123.44)).toBe(123.4);
    expect(roundLevel(12.346)).toBe(12.35);
    expect(fmtLevel(1234.4)).toBe('1,234');
    expect(fmtLevel(123.44)).toBe('123.4');
    expect(fmtLevel(12.3)).toBe('12.30');
  });
});

describe('buildKeyLevels', () => {
  // 前 30 天 100、接著 20 天 110、最後 11 天 105（收盤 105）；高低點看今天以前的 20/60 根
  const stepRows = [
    ...Array.from({ length: 30 }, (_, i) => bar(i, 100)),
    ...Array.from({ length: 20 }, (_, i) => bar(30 + i, 110)),
    ...Array.from({ length: 11 }, (_, i) => bar(50 + i, 105)),
  ];

  it('上方兩區壓力、下方支撐由近到遠；相距不到 0.5 ATR 的併成一區', () => {
    const lv = buildKeyLevels(stepRows)!;
    expect(lv).not.toBeNull();
    expect(lv.close).toBe(105);
    expect(lv.date).toBe(day(60));

    const labels = lv.zones.map((z) => z.label);
    expect(labels).toEqual(['壓力二', '壓力一', '短撐', '中撐']);

    const [r2, r1, s1, s2] = lv.zones;
    // 月線 = (9×110 + 11×105)/20 = 107.25
    expect(r1.low).toBeCloseTo(107.25, 10);
    expect(r1.bases).toEqual(['月線']);
    expect(r1.distancePct).toBeCloseTo((107.25 - 105) / 105 * 100, 10);
    expect(r1.alertPrice).toBe(107.3); // ≥100 取 1 位小數
    // 近 20 日高點與近 60 日高點是同一根 → 只留期間較長的名稱
    expect(r2.low).toBe(111);
    expect(r2.bases).toEqual(['近60日高點']);

    // 季線 (29×100 + 20×110 + 11×105)/60 = 104.25 與近 20 日低點 104 相距 0.25 < 0.5 ATR → 同一區
    expect(s1.low).toBe(104);
    expect(s1.high).toBeCloseTo((2900 + 2200 + 1155) / 60, 10);
    expect(s1.bases).toEqual(['季線', '近20日低點']);
    expect(s1.alertPrice).toBe(104); // 支撐取下緣
    expect(s1.distancePct).toBeLessThan(0);

    expect(s2.low).toBe(99);
    expect(s2.bases).toEqual(['近60日低點']);
    expect(lv.danger).toBe(99);
    expect(lv.onPrice).toEqual([]);
  });

  it('ATR 與 ATR 倍數一起算出來', () => {
    const lv = buildKeyLevels(stepRows)!;
    expect(lv.atr).not.toBeNull();
    expect(lv.atrPct).toBeCloseTo((lv.atr! / 105) * 100, 10);
    const r1 = lv.zones.find((z) => z.label === '壓力一')!;
    expect(r1.atrMultiple).toBeCloseTo((107.25 - 105) / lv.atr!, 10);
  });

  it('輸入順序打亂也照日期排序後計算', () => {
    const shuffled = [...stepRows].reverse();
    expect(buildKeyLevels(shuffled)).toEqual(buildKeyLevels(stepRows));
  });

  it('創新高當天：今天自己的最高價不算壓力，突破的前高落到下方當支撐', () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => bar(i, 100)),
      { date: day(25), open: 100, high: 106, low: 100, close: 105 },
    ];
    const lv = buildKeyLevels(rows)!;
    const res = lv.zones.filter((z) => z.kind === 'resistance');
    expect(res).toHaveLength(1);
    expect(res[0].estimated).toBe(true);
    // 前 20 日高點 101 與月線 (19×100+105)/20=100.25 相距 < 0.5 ATR → 併成 100.25~101
    const s1 = lv.zones.find((z) => z.label === '短撐')!;
    expect(s1.high).toBe(101);
    expect(s1.low).toBeCloseTo(100.25, 10);
    expect(s1.bases).toEqual(['近20日高點', '月線']);
  });

  it('創新高、上方沒有任何前高 → 用收盤 + 1 ATR 推估一個壓力，並標記 estimated', () => {
    const rising = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i * 2, 0.5));
    const lv = buildKeyLevels(rising)!;
    const res = lv.zones.filter((z) => z.kind === 'resistance');
    expect(res).toHaveLength(1);
    expect(res[0].estimated).toBe(true);
    expect(res[0].low).toBeCloseTo(lv.close + lv.atr!, 10);
    expect(res[0].atrMultiple).toBeCloseTo(1, 10);
  });

  it('現價剛好壓在月線上 → 列在 onPrice，不當成壓力或支撐', () => {
    const flat = Array.from({ length: 21 }, (_, i) => bar(i, 100));
    const lv = buildKeyLevels(flat)!;
    expect(lv.onPrice).toEqual(['月線']);
    expect(lv.zones.map((z) => [z.label, z.low])).toEqual([
      ['壓力一', 101],
      ['短撐', 99],
    ]);
  });

  it('下方支撐最多三區，第三區叫守門，危險＝守門下緣', () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => bar(i, 80, 0.2)),   // 近一年低點附近 79.8
      ...Array.from({ length: 60 }, (_, i) => bar(60 + i, 90, 0.2)),
      ...Array.from({ length: 60 }, (_, i) => bar(120 + i, 100, 0.2)),
      ...Array.from({ length: 60 }, (_, i) => bar(180 + i, 120, 0.2)),
    ];
    const lv = buildKeyLevels(rows)!;
    const sup = lv.zones.filter((z) => z.kind === 'support');
    expect(sup.map((z) => z.label)).toEqual(['短撐', '中撐', '守門']);
    expect(lv.danger).toBe(sup[2].low);
  });

  it('不足 20 天或空資料回 null；壞資料列會被略過', () => {
    expect(buildKeyLevels(null)).toBeNull();
    expect(buildKeyLevels([])).toBeNull();
    expect(buildKeyLevels(Array.from({ length: 19 }, (_, i) => bar(i, 100)))).toBeNull();
    const withBad = [...Array.from({ length: 20 }, (_, i) => bar(i, 100)), { date: day(20), open: NaN, high: NaN, low: NaN, close: NaN }];
    expect(buildKeyLevels(withBad)?.date).toBe(day(19));
  });
});
