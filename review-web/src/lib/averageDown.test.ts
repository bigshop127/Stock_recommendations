import { describe, expect, it } from 'vitest';
import {
  breakEvenPrice, defaultTarget, estimateCost, feeOf, holdingStats, kindOfCode, mergePositions, parseNum, parseSyncTime, planAverageDown,
  type CalcEnv, type Holding, type PlanInput,
} from './averageDown';

const ENV_ODD: CalcEnv = { feeRate: 0.001425, unit: 1 };
const ENV_LOT: CalcEnv = { feeRate: 0.001425, unit: 1000 };
const base: PlanInput = { mode: 'target', buyPrice: NaN, target: NaN, budget: NaN, buyShares: NaN };

// 2026-11-07 玉山實帳戶（cost_sum 含手續費、price_evn 是玉山算的損益平衡價）
const DELTA: Holding = { shares: 200, cost: 346992, price: 1055, kind: 'stock' };   // 台達電 2308
const UNIMICRON: Holding = { shares: 100, cost: 72603, price: 727, kind: 'stock' }; // 欣興 3037
const ASE: Holding = { shares: 100, cost: 58082, price: 527, kind: 'stock' };       // 日月光 3711
const L2: Holding = { shares: 25000, cost: 879650, price: 26.3, kind: 'etf' };       // 00631L

describe('kindOfCode', () => {
  it('00 開頭是 ETF，其餘是個股', () => {
    expect(kindOfCode('00631L')).toBe('etf');
    expect(kindOfCode('0050')).toBe('etf');
    expect(kindOfCode('00878')).toBe('etf');
    expect(kindOfCode('00687B')).toBe('etf');
    expect(kindOfCode('2308')).toBe('stock');
    expect(kindOfCode('6274')).toBe('stock');
    expect(kindOfCode(' 3037 ')).toBe('stock');
  });
});

describe('parseNum', () => {
  it('吃千分位與空白，空字串回 NaN', () => {
    expect(parseNum('1,234.5')).toBe(1234.5);
    expect(parseNum(' 12 ')).toBe(12);
    expect(parseNum('')).toBeNaN();
    expect(parseNum('abc')).toBeNaN();
    expect(parseNum(undefined)).toBeNaN();
  });
});

describe('feeOf', () => {
  it('無條件捨去、整股最低 20、零股最低 1', () => {
    expect(feeOf(72500, ENV_ODD)).toBe(103); // 103.3
    expect(feeOf(58000, ENV_ODD)).toBe(82);  // 82.65 → 捨去（使用者實際成本 58,082）
    expect(feeOf(1000, ENV_ODD)).toBe(1);
    expect(feeOf(1000, ENV_LOT)).toBe(20);
    expect(feeOf(0, ENV_ODD)).toBe(0);
  });
});

describe('breakEvenPrice / holdingStats：對得上玉山庫存的 price_evn', () => {
  it('台達電 1742.68、欣興 729.26、日月光 583.41', () => {
    expect(breakEvenPrice(DELTA.cost, DELTA.shares, 'stock', 0.001425)).toBe(1742.68);
    expect(breakEvenPrice(UNIMICRON.cost, UNIMICRON.shares, 'stock', 0.001425)).toBe(729.26);
    expect(breakEvenPrice(ASE.cost, ASE.shares, 'stock', 0.001425)).toBe(583.41);
  });
  it('00631L（ETF 稅 0.1%）35.28', () => {
    expect(breakEvenPrice(L2.cost, L2.shares, 'etf', 0.001425)).toBe(35.28);
  });
  it('預估損益＝現價賣出扣費稅後減成本（玉山 make_a_sum：台達電 −136,924，差在 1 元進位內）', () => {
    const st = holdingStats(DELTA, ENV_ODD)!;
    expect(st.avg).toBeCloseTo(1734.96, 2);
    expect(Math.abs(st.pnl - -136924)).toBeLessThanOrEqual(2);
    expect(st.pct).toBeLessThan(0);
  });
  it('股數或成本缺失回 null；沒現價損益是 NaN', () => {
    expect(holdingStats({ ...DELTA, shares: 0 }, ENV_ODD)).toBeNull();
    expect(holdingStats({ ...DELTA, cost: 0 }, ENV_ODD)).toBeNull();
    expect(holdingStats({ ...DELTA, price: 0 }, ENV_ODD)!.pnl).toBeNaN();
  });
});

describe('planAverageDown：目標均價', () => {
  it('台達電攤到 1,500：買進後均價真的 ≤ 1,500，且少買一單位就不達標', () => {
    const r = planAverageDown(DELTA, ENV_ODD, { ...base, mode: 'target', target: 1500 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.nA).toBeLessThanOrEqual(1500);
    // 少買 1 股就超過 1500（最小解）
    const p = r.p;
    const a = Math.round((r.n - 1) * p);
    const lessAvg = (DELTA.cost + a + feeOf(a, ENV_ODD)) / (DELTA.shares + r.n - 1);
    expect(lessAvg).toBeGreaterThan(1500);
    expect(r.total).toBe(Math.round(r.n * p) + r.fee);
    expect(r.nS).toBe(DELTA.shares + r.n);
    expect(r.gap1).toBeLessThan(r.gap0); // 離回本更近
  });
  it('整張模式股數是 1000 的倍數，最低手續費 20', () => {
    const r = planAverageDown(ASE, ENV_LOT, { ...base, mode: 'target', target: 540 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.n % 1000).toBe(0);
    expect(r.nA).toBeLessThanOrEqual(540);
  });
  it('買進價已不低於均價 → skip', () => {
    const r = planAverageDown({ ...ASE, price: 700 }, ENV_ODD, { ...base, mode: 'target', target: 600 });
    expect(r.kind).toBe('skip');
  });
  it('目標均價不合理時回 bad：空白、不低於均價、低於買進價', () => {
    expect(planAverageDown(DELTA, ENV_ODD, { ...base, target: NaN }).kind).toBe('bad');
    expect(planAverageDown(DELTA, ENV_ODD, { ...base, target: 1800 }).kind).toBe('bad');
    expect(planAverageDown(DELTA, ENV_ODD, { ...base, target: 1000 }).kind).toBe('bad');
  });
  it('買進價可自訂（掛低價）', () => {
    const r = planAverageDown(DELTA, ENV_ODD, { ...base, mode: 'target', target: 1500, buyPrice: 1000 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.p).toBe(1000);
    expect(r.nA).toBeLessThanOrEqual(1500);
  });
});

describe('planAverageDown：手上預算', () => {
  it('預算內買到最多，再多買一股就超預算', () => {
    const B = 200000;
    const r = planAverageDown(DELTA, ENV_ODD, { ...base, mode: 'budget', budget: B });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.total).toBeLessThanOrEqual(B);
    const a1 = Math.round((r.n + 1) * r.p);
    expect(a1 + feeOf(a1, ENV_ODD)).toBeGreaterThan(B);
  });
  it('預算買不起一單位 → bad 並寫出最低金額', () => {
    const r = planAverageDown(DELTA, ENV_LOT, { ...base, mode: 'budget', budget: 5000 });
    expect(r.kind).toBe('bad');
    if (r.kind === 'bad') expect(r.msg).toContain('至少要');
  });
});

describe('planAverageDown：指定股數', () => {
  it('買 100 股：金額、手續費、新均價都對', () => {
    const r = planAverageDown(UNIMICRON, ENV_ODD, { ...base, mode: 'shares', buyShares: 100, buyPrice: 700 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.fee).toBe(99);           // 70,000 × 0.1425% = 99.75 → 99
    expect(r.total).toBe(70099);
    expect(r.nS).toBe(200);
    expect(r.nA).toBeCloseTo((72603 + 70099) / 200, 6);
    expect(r.raisesAvg).toBe(false);
  });
  it('買進價高於均價 → 仍可算，但標示均價不會下降', () => {
    const r = planAverageDown(UNIMICRON, ENV_ODD, { ...base, mode: 'shares', buyShares: 100, buyPrice: 800 });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.raisesAvg).toBe(true);
      expect(r.nA).toBeGreaterThan(r.A0);
    }
  });
  it('整張模式輸入非整張 → 捨去並說明；不足一張 → bad', () => {
    const r = planAverageDown(L2, ENV_LOT, { ...base, mode: 'shares', buyShares: 2500 });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.n).toBe(2000);
      expect(r.note).toContain('捨去');
    }
    expect(planAverageDown(L2, ENV_LOT, { ...base, mode: 'shares', buyShares: 500 }).kind).toBe('bad');
  });
  it('沒填股數 → bad', () => {
    expect(planAverageDown(L2, ENV_ODD, { ...base, mode: 'shares', buyShares: NaN }).kind).toBe('bad');
  });
});

describe('defaultTarget', () => {
  it('均價與買進價（含手續費）的中點；不需攤平時回空字串', () => {
    // 欣興：均價 726.03、現價 727 > 均價 → 不需要
    expect(defaultTarget(UNIMICRON, ENV_ODD)).toBe('');
    // 台達電：均價 1734.96、買進價 1055×1.001425=1056.50 → 中點 1395.73
    expect(defaultTarget(DELTA, ENV_ODD)).toBe('1395.73');
  });
});

describe('mergePositions / estimateCost / parseSyncTime', () => {
  it('同代號兩列合併：股數相加、均價加權、成本相加', () => {
    const r = mergePositions([
      { code: '2330', shares: 1000, avg_cost: 600, market_price: 1000, cost: 600855 },
      { code: '2330', shares: 50, avg_cost: 700, market_price: 1001, cost: 35050 },
      { code: '0050', shares: 10, avg_cost: 50, market_price: 52 },
    ]);
    expect(r).toHaveLength(2);
    const t = r.find((x) => x.code === '2330')!;
    expect(t.shares).toBe(1050);
    expect(t.avg_cost).toBeCloseTo((600000 + 35000) / 1050, 6);
    expect(t.cost).toBe(635905);
    expect(t.market_price).toBe(1001);
  });
  it('只要有一列沒成本，整檔就不給成本（交給估算）；0 股列丟掉', () => {
    const r = mergePositions([
      { code: '2330', shares: 1000, avg_cost: 600, market_price: 1000, cost: 600855 },
      { code: '2330', shares: 50, avg_cost: 700, market_price: 1000 },
      { code: '9999', shares: 0, avg_cost: 1, market_price: 1 },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].cost).toBeUndefined();
  });
  it('estimateCost：欣興 100 股 @725 → 72,603（跟玉山 cost_sum 一致）', () => {
    expect(estimateCost(100, 725, 0.001425)).toBe(72603);
    expect(estimateCost(100, 580, 0.001425)).toBe(58082);
    expect(estimateCost(100, 908, 0.001425)).toBe(90929);
  });
  it('parseSyncTime：無時區視為 UTC、帶時區照用、壞字串回 null', () => {
    expect(parseSyncTime('2026-11-07T12:20:45.008478')!.toISOString()).toBe('2026-11-07T12:20:45.008Z');
    expect(parseSyncTime('2026-11-07T12:20:45+00:00')!.toISOString()).toBe('2026-11-07T12:20:45.000Z');
    expect(parseSyncTime('2026-11-07T20:20:45+08:00')!.toISOString()).toBe('2026-11-07T12:20:45.000Z');
    expect(parseSyncTime('')).toBeNull();
    expect(parseSyncTime('abc')).toBeNull();
  });
});
