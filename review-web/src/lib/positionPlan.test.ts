import { describe, it, expect } from 'vitest';
import { defaultBatches, stopPrice, computePlan, fmtShares, DEFAULT_SETTINGS } from './positionPlan';
import type { KeyLevels, LevelZone } from './keyLevels';

const zone = (kind: LevelZone['kind'], label: string, low: number, high: number, bases: string[], estimated = false): LevelZone => ({
  kind, label, short: label, low, high, bases, distancePct: 0, atrMultiple: null, alertPrice: kind === 'resistance' ? high : low, estimated,
});

const levels = (over: Partial<KeyLevels> = {}): KeyLevels => ({
  date: '2026-09-24',
  close: 100,
  atr: 4,
  atrPct: 4,
  zones: [
    zone('resistance', '壓力二', 120, 121, ['近60日高點']),
    zone('resistance', '壓力一', 110, 111, ['月線']),
    zone('support', '短撐', 95, 96, ['季線']),
    zone('support', '中撐', 90, 92, ['近20日低點']),
    zone('support', '守門', 80, 82, ['年線']),
  ],
  danger: 80,
  onPrice: [],
  ...over,
});

describe('預設分批與停損', () => {
  it('三道支撐：現價＋短撐＋中撐三批 40/30/30，停損＝守門下緣', () => {
    const d = defaultBatches(levels());
    expect(d.map((b) => [b.label, b.price, b.weight])).toEqual([
      ['第一批', 100, 40],
      ['第二批', 96, 30],
      ['第三批', 92, 30],
    ]);
    expect(d[1].basis).toBe('短撐（季線）');
    expect(stopPrice(levels(), DEFAULT_SETTINGS)).toEqual({ price: 80, basis: '收盤跌破守門下緣' });
  });

  it('只有兩道支撐：兩批 50/50，停損在第二道下緣', () => {
    const lv = levels({ zones: levels().zones.slice(0, 4), danger: 90 });
    const d = defaultBatches(lv);
    expect(d.map((b) => b.weight)).toEqual([50, 50]);
    expect(stopPrice(lv, DEFAULT_SETTINGS)!.price).toBe(90);
  });

  it('沒有支撐 → 一批、停損用 2 個 ATR；自訂停損', () => {
    const lv = levels({ zones: levels().zones.slice(0, 2), danger: null });
    expect(defaultBatches(lv)).toHaveLength(1);
    expect(stopPrice(lv, DEFAULT_SETTINGS)).toEqual({ price: 92, basis: '現價往下 2 個 ATR' });
    expect(stopPrice(lv, { ...DEFAULT_SETTINGS, stopMode: 'custom', customStop: 93.5 })).toEqual({ price: 93.5, basis: '自訂' });
    expect(stopPrice(lv, { ...DEFAULT_SETTINGS, stopMode: 'custom', customStop: null })).toBeNull();
  });
});

describe('computePlan', () => {
  it('用可承受虧損反推股數，全部進場後停損虧損不超過設定', () => {
    const lv = levels();
    // 每股加權風險＝0.4×20＋0.3×16＋0.3×12＝16.4 → 可承受 100 萬 ÷ 16.4 ≈ 60,975 股
    const r = computePlan(lv, defaultBatches(lv), { ...DEFAULT_SETTINGS, maxLoss: 1_000_000, lotMode: 'lot' })!;
    expect(r.batches.map((b) => b.shares)).toEqual([24000, 18000, 18000]);
    expect(r.totalShares).toBe(60000);
    expect(r.totalAmount).toBe(24000 * 100 + 18000 * 96 + 18000 * 92);
    expect(r.lossAtStop).toBe(24000 * 20 + 18000 * 16 + 18000 * 12);
    expect(r.lossAtStop).toBeLessThanOrEqual(1_000_000);
    expect(r.avgCost).toBeCloseTo(r.totalAmount / 60000, 6);
    expect(r.targets.map((t) => t.label)).toEqual(['壓力一', '壓力二']);
    expect(r.targets[0].price).toBe(110);
    expect(r.targets[0].rMultiple).toBeCloseTo((110 - r.avgCost!) / (r.avgCost! - 80), 6);
    expect(r.warnings).toEqual([]);
  });

  it('整張買不到 → 提醒改零股；零股照算', () => {
    const lv = levels();
    const lot = computePlan(lv, defaultBatches(lv), { ...DEFAULT_SETTINGS, maxLoss: 10000, lotMode: 'lot' })!;
    expect(lot.batches.map((b) => b.shares)).toEqual([0, 0, 0]);
    expect(lot.warnings[0]).toContain('零股');
    const odd = computePlan(lv, defaultBatches(lv), { ...DEFAULT_SETTINGS, maxLoss: 10000 })!; // 預設就是可零股
    expect(odd.batches.map((b) => b.shares)).toEqual([243, 182, 182]);
    expect(odd.lossAtStop).toBeLessThanOrEqual(10000);
  });

  it('資金上限會把股數壓下來並標明', () => {
    const lv = levels();
    const r = computePlan(lv, defaultBatches(lv), { ...DEFAULT_SETTINGS, maxLoss: 1_000_000, capital: 1_000_000 })!;
    expect(r.cappedByCapital).toBe(true);
    expect(r.totalAmount).toBeLessThanOrEqual(1_000_000);
    expect(r.warnings.some((w) => w.includes('資金上限'))).toBe(true);
  });

  it('進場價不高於停損的批次略過、比重重新分配', () => {
    const lv = levels();
    const drafts = defaultBatches(lv);
    drafts[2] = { ...drafts[2], price: 79 };
    const r = computePlan(lv, drafts, { ...DEFAULT_SETTINGS, maxLoss: 1_000_000 })!;
    expect(r.batches[2].skipped).toBe(true);
    expect(r.batches[2].shares).toBe(0);
    expect(r.warnings.some((w) => w.includes('略過'))).toBe(true);
    // 剩 40:30 → 每股風險 (40×20+30×16)/70
    expect(r.lossAtStop).toBeLessThanOrEqual(1_000_000);
    expect(r.batches[0].shares).toBeGreaterThan(r.batches[1].shares);
  });

  it('可承受虧損為 0 或停損算不出來 → null', () => {
    const lv = levels();
    expect(computePlan(lv, defaultBatches(lv), { ...DEFAULT_SETTINGS, maxLoss: 0 })).toBeNull();
    expect(computePlan(levels({ danger: null, atr: null }), defaultBatches(lv), DEFAULT_SETTINGS)).toBeNull();
  });
});

describe('fmtShares', () => {
  it('張與零股', () => {
    expect(fmtShares(24000)).toBe('24 張');
    expect(fmtShares(243)).toBe('243 股');
    expect(fmtShares(2500)).toBe('2 張 500 股');
    expect(fmtShares(0)).toBe('0');
  });
});
