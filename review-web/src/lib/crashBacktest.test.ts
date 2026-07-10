import { describe, it, expect } from 'vitest';
import { alignSeries, alignSeries4, runBacktest, type AlignedBar } from './crashBacktest';
import type { OhlcvRow } from './api';

// 產生連續日期（YYYY-MM-DD），i 天後
function d(i: number): string {
  const base = new Date('2020-01-01T00:00:00Z').getTime();
  return new Date(base + i * 86400_000).toISOString().slice(0, 10);
}

// 由 etf/mkt 收盤陣列組出對齊列
function bars(etf: number[], mkt: number[]): AlignedBar[] {
  return etf.map((e, i) => ({ date: d(i), etf: e, mkt: mkt[i] }));
}

// 【增修K】由 etf/mkt/bond1/bond2 收盤陣列組出三資產對齊列
function bars4(etf: number[], mkt: number[], bond1: number[], bond2: number[]): AlignedBar[] {
  return etf.map((e, i) => ({ date: d(i), etf: e, mkt: mkt[i], bond1: bond1[i], bond2: bond2[i] }));
}

function row(date: string, close: number): OhlcvRow {
  return { date, open: close, high: close, low: close, close };
}

describe('alignSeries', () => {
  it('inner-joins on common dates and drops missing/non-positive', () => {
    const etf = [row('2020-01-01', 100), row('2020-01-02', 101), row('2020-01-03', 102)];
    const mkt = [row('2020-01-02', 50), row('2020-01-03', 0), row('2020-01-04', 52)];
    const out = alignSeries(etf, mkt);
    // 只有 01-02 兩邊都有且價格為正（01-03 mkt=0 被丟、01-01/01-04 單邊被丟）
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ date: '2020-01-02', etf: 101, mkt: 50 });
  });

  it('sorts output ascending by date', () => {
    const etf = [row('2020-01-03', 3), row('2020-01-01', 1), row('2020-01-02', 2)];
    const mkt = [row('2020-01-01', 10), row('2020-01-02', 20), row('2020-01-03', 30)];
    const out = alignSeries(etf, mkt);
    expect(out.map((b) => b.date)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
  });
});

describe('alignSeries4（增修K）', () => {
  it('inner-joins on common dates across all four series, dropping any single-side gap', () => {
    const etf = [row('2020-01-01', 100), row('2020-01-02', 101), row('2020-01-03', 102)];
    const mkt = [row('2020-01-01', 50), row('2020-01-02', 50), row('2020-01-03', 50)];
    const bond1 = [row('2020-01-02', 28), row('2020-01-03', 28)]; // 缺 01-01
    const bond2 = [row('2020-01-02', 10), row('2020-01-03', 0)]; // 01-03 收盤 0（無效）
    const out = alignSeries4(etf, mkt, bond1, bond2);
    // 只有 01-02 四邊皆有效正數（01-01 缺債券資料；01-03 bond2=0 被丟）
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ date: '2020-01-02', etf: 101, mkt: 50, bond1: 28, bond2: 10 });
  });
});

describe('runBacktest — guards', () => {
  it('returns note when fewer than 2 bars', () => {
    const res = runBacktest(bars([100], [50]), {});
    expect(res.note).toBeTruthy();
    expect(res.strategy.points).toHaveLength(0);
    expect(res.trades).toHaveLength(0);
  });

  it('never yields NaN/Infinity in curves', () => {
    const res = runBacktest(bars([100, 110, 90, 130], [50, 55, 45, 65]), { target_beta: 1.2 });
    for (const p of [...res.strategy.points, ...res.beta_curve, ...res.mkt_drawdown]) {
      expect(Number.isFinite(p.value)).toBe(true);
    }
    expect(Number.isFinite(res.strategy.metrics.final_value)).toBe(true);
  });
});

describe('runBacktest — normal mode', () => {
  it('flat market: no trades, beta stays at target, equity ≈ initial', () => {
    const flat = Array(10).fill(100);
    const mkt = Array(10).fill(50);
    const res = runBacktest(bars(flat, mkt), {
      target_beta: 1.2,
      etf_beta: 2.0,
      tolerance_mode: 'abs',
      threshold_abs: 0.1,
      initial_capital: 1_000_000,
    });
    expect(res.trades).toHaveLength(0);
    expect(res.crash_events).toHaveLength(0);
    // 目標權重 0.6 → β 1.2 全程不動
    for (const p of res.beta_curve) expect(p.value).toBeCloseTo(1.2, 6);
    expect(res.strategy.metrics.final_value).toBeCloseTo(1_000_000, 4);
  });

  it('rising ETF drifts beta above upper band → rebalance sell back to target', () => {
    // mkt 平盤（無崩盤），etf 跳漲 → 權重升、β 破上限 1.3
    const res = runBacktest(bars([100, 140, 140], [50, 50, 50]), {
      target_beta: 1.2,
      etf_beta: 2.0,
      tolerance_mode: 'abs',
      threshold_abs: 0.1,
    });
    expect(res.crash_events).toHaveLength(0);
    const rebs = res.trades.filter((t) => t.type === 'rebalance');
    expect(rebs.length).toBeGreaterThanOrEqual(1);
    // 賣出（traded_value < 0）拉回目標 β
    expect(rebs[0].traded_value).toBeLessThan(0);
    expect(rebs[0].to_beta).toBeCloseTo(1.2, 6);
  });
});

describe('runBacktest — crash state machine', () => {
  it('enters crash on ≥28% drawdown then exits on new high', () => {
    // 0050：100 高點 → 70（−30%，進崩盤）→ 110（創新高，退崩盤）
    const res = runBacktest(bars([100, 70, 130], [100, 70, 110]), {
      target_beta: 1.2,
      etf_beta: 2.0,
      crash_dd: 0.28,
    });
    const types = res.trades.map((t) => t.type);
    expect(types).toEqual(['crash_enter', 'crash_exit']);
    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].enter).toBe(d(1));
    expect(res.crash_events[0].exit).toBe(d(2));
    // 崩盤期間拉到滿槓桿 → β 曲線出現 ≈ 2.0
    expect(Math.max(...res.beta_curve.map((p) => p.value))).toBeCloseTo(2.0, 6);
    // 退出後回目標
    expect(res.beta_curve[res.beta_curve.length - 1].value).toBeCloseTo(1.2, 6);
  });

  it('does not enter crash when drawdown stays below threshold', () => {
    // 最大回撤 20% < 28%
    const res = runBacktest(bars([100, 90, 100], [100, 80, 100]), { crash_dd: 0.28 });
    expect(res.trades.filter((t) => t.type === 'crash_enter')).toHaveLength(0);
    expect(res.crash_events).toHaveLength(0);
  });

  it('records an unclosed crash event (exit=null) if still down at end', () => {
    const res = runBacktest(bars([100, 60], [100, 60]), { crash_dd: 0.28 });
    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].exit).toBeNull();
  });
});

describe('runBacktest — ladder mode（增修J 分批加碼）', () => {
  const P = {
    initial_capital: 1_000_000,
    target_beta: 1.2,
    etf_beta: 2.0,
    tolerance_mode: 'abs' as const,
    threshold_abs: 0.1,
    mode: 'ladder' as const,
    ladder_step: 0.05,
    ladder_full_at: 0.15, // 3 筆等分
  };

  it('deploys one tranche per −5% level, caps at full_at, exits on new high', () => {
    // etf 平盤（排除 β 漂移干擾），0050：100 → −6% → −11% → −16% → −20% → 創新高
    const res = runBacktest(bars([100, 100, 100, 100, 100, 100], [100, 94, 89, 84, 80, 101]), P);
    expect(res.trades.map((t) => t.type)).toEqual(['ladder_buy', 'ladder_buy', 'ladder_buy', 'crash_exit']);
    // 期初現金 40 萬、3 筆等分 → 每筆 133,333.33；−20% 已買滿不再加碼
    const tranche = 400_000 / 3;
    for (const t of res.trades.slice(0, 3)) expect(t.traded_value).toBeCloseTo(tranche, 4);
    // 買滿後全數在 00631L → β ≈ 2.0；創新高退出後回目標 1.2
    expect(Math.max(...res.beta_curve.map((p) => p.value))).toBeCloseTo(2.0, 6);
    expect(res.beta_curve[res.beta_curve.length - 1].value).toBeCloseTo(1.2, 6);
    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].enter).toBe(d(1));
    expect(res.crash_events[0].exit).toBe(d(5));
    expect(res.strategy.name).toContain('分批');
  });

  it('gap through multiple levels buys the summed tranches in one trade', () => {
    // 一天直落 −12%（跳過 −5% 階）→ 一筆補買 2 個 tranche
    const res = runBacktest(bars([100, 100], [100, 88]), P);
    expect(res.trades.map((t) => t.type)).toEqual(['ladder_buy']);
    expect(res.trades[0].traded_value).toBeCloseTo((400_000 / 3) * 2, 4);
  });

  it('suspends band rebalancing during a drawdown regime', () => {
    // etf 大跌使 β 破下限，但已在回撤 regime 內 → 只有 ladder_buy、無 rebalance
    const res = runBacktest(bars([100, 60], [100, 94]), P);
    expect(res.trades.map((t) => t.type)).toEqual(['ladder_buy']);
  });

  it('omitting mode keeps legacy oneshot behavior (backward compat)', () => {
    const res = runBacktest(bars([100, 70, 130], [100, 70, 110]), { crash_dd: 0.28 });
    expect(res.trades.map((t) => t.type)).toEqual(['crash_enter', 'crash_exit']);
    expect(res.strategy.name).toContain('all-in');
  });
});

describe('runBacktest — benchmarks & metrics', () => {
  it('buy-and-hold 0050 metrics: total_return and max_drawdown correct', () => {
    // 100 → 150 → 75 → 150：期末 +50%，最大回撤 (150−75)/150 = 50%
    const res = runBacktest(bars([100, 150, 75, 150], [100, 150, 75, 150]), { initial_capital: 1_000_000 });
    const b0050 = res.benchmarks.find((b) => b.key === 'bench_0050')!;
    expect(b0050.metrics.total_return).toBeCloseTo(0.5, 6);
    expect(b0050.metrics.max_drawdown).toBeCloseTo(0.5, 6);
    expect(b0050.metrics.final_value).toBeCloseTo(1_500_000, 2);
  });

  it('exposes three benchmarks and a strategy curve of equal length', () => {
    const res = runBacktest(bars([100, 110, 120, 130], [50, 52, 54, 56]), {});
    expect(res.benchmarks.map((b) => b.key)).toEqual(['bench_0050', 'bench_631', 'bench_static']);
    for (const b of res.benchmarks) expect(b.points).toHaveLength(4);
    expect(res.strategy.points).toHaveLength(4);
    expect(res.beta_curve).toHaveLength(4);
  });

  it('static benchmark holds initial allocation and never trades', () => {
    const res = runBacktest(bars([100, 200], [50, 50]), { target_beta: 1.2, etf_beta: 2.0, initial_capital: 1_000_000 });
    const stat = res.benchmarks.find((b) => b.key === 'bench_static')!;
    // 期初 0.6×1M 買 etf@100 → 6000 單位；etf 翻倍到 200 → 1,200,000 + 現金 400,000 = 1,600,000
    expect(stat.metrics.final_value).toBeCloseTo(1_600_000, 2);
  });
});

// 【增修K】崩盤實驗室三資產防守端（現金＋00687B＋00953B）：驗證用網站自己的引擎、真實資料
// 才能檢驗報告「美債優先變現」主張是否成立——而非直接採信報告數字。
describe('runBacktest — 三資產防守端（增修K）', () => {
  const P3 = {
    initial_capital: 1_000_000,
    target_beta: 1.2,
    etf_beta: 2.0,
    tolerance_mode: 'abs' as const,
    threshold_abs: 0.1,
    mode: 'ladder' as const,
    ladder_step: 0.05,
    ladder_full_at: 0.15, // 3 筆等分
    cash_reserve: 100_000,
    bond_split: 0.6,
  };

  it('bars without bond1/bond2 stay on the legacy 2-asset path (hasBonds=false)', () => {
    // 沿用 alignSeries（雙資產）產生的 bars 完全沒有 bond1/bond2 欄位 → 三資產路徑不啟用
    const res = runBacktest(bars([100, 70, 130], [100, 70, 110]), { ...P3, mode: 'oneshot', crash_dd: 0.28 });
    expect(res.trades.map((t) => t.type)).toEqual(['crash_enter', 'crash_exit']);
    expect(Math.max(...res.beta_curve.map((p) => p.value))).toBeCloseTo(2.0, 6);
  });

  it('bond_priority does not leak into the initial seed split (regression guard)', () => {
    // etf/mkt 全平盤（避免正常模式再平衡干擾），bond1 期初翻倍、bond2 不動：
    // 若 bond_priority 錯誤污染期初等比例分配（曾經的 bug：swap 陣列時 split 忘了跟著換），
    // 兩種優先順序的期初 00687B/00953B 股數會不同，翻倍後金額就會兜不起來。
    const b = bars4([100, 100], [100, 100], [1, 2], [1, 1]);
    const r1 = runBacktest(b, { ...P3, bond_priority: 'bond1_first' });
    const r2 = runBacktest(b, { ...P3, bond_priority: 'bond2_first' });
    const s1 = r1.benchmarks.find((x) => x.key === 'bench_static')!;
    const s2 = r2.benchmarks.find((x) => x.key === 'bench_static')!;
    // 600,000(etf 不動) + 100,000(現金) + 180,000×2(00687B 翻倍) + 120,000×1(00953B 不動) = 1,180,000
    expect(s1.metrics.final_value).toBeCloseTo(1_180_000, 1);
    expect(s2.metrics.final_value).toBeCloseTo(1_180_000, 1);
  });

  it('bond1_first vs bond2_first drain different bonds first, producing different outcomes when their paths diverge', () => {
    // 00687B(bond1) 從 1 一路漲到 1.8（模擬股災避險溢價），00953B(bond2) 全程持平於 1。
    // bar1 回撤 6% 觸發第一階分批加碼：bond1_first 優先賣掉正在增值的 00687B（事後看少賺）、
    // bond2_first 優先賣持平的 00953B、保留持續增值的 00687B（事後看多賺）——兩者應產生不同總值。
    const b = bars4([100, 100, 100], [100, 94, 100], [1, 1.4, 1.8], [1, 1, 1]);
    const r1 = runBacktest(b, { ...P3, bond_priority: 'bond1_first' });
    const r2 = runBacktest(b, { ...P3, bond_priority: 'bond2_first' });
    expect(r1.trades.map((t) => t.type)).toEqual(['ladder_buy', 'crash_exit']);
    expect(r2.trades.map((t) => t.type)).toEqual(['ladder_buy', 'crash_exit']);
    // 手算：bar1 買進同額 00631L（不受優先順序影響）；bar2 創新高再平衡、總值等於崩盤前市值總和
    expect(r1.strategy.points[2].value).toBeCloseTo(1_099_047.62, 1);
    expect(r2.strategy.points[2].value).toBeCloseTo(1_133_333.33, 1);
    expect(r1.strategy.points[2].value).not.toBeCloseTo(r2.strategy.points[2].value, 0);
  });

  it('proportional mode shrinks both bonds together instead of draining one first', () => {
    const b = bars4([100, 100, 100], [100, 94, 100], [1, 1.4, 1.8], [1, 1, 1]);
    const prop = runBacktest(b, { ...P3, bond_priority: 'proportional' });
    const bond1First = runBacktest(b, { ...P3, bond_priority: 'bond1_first' });
    // proportional 在 bar1 縮水時兩檔一起按比例減少，結果應與「優先變現單一檔」不同
    expect(prop.strategy.points[2].value).not.toBeCloseTo(bond1First.strategy.points[2].value, 0);
  });

  it('never yields NaN/Infinity with bonds enabled across modes', () => {
    const b = bars4([100, 110, 90, 130], [50, 55, 45, 65], [28, 28.5, 29, 28.8], [10, 10.05, 10.1, 10.08]);
    for (const bond_priority of ['bond1_first', 'bond2_first', 'proportional'] as const) {
      const res = runBacktest(b, { ...P3, mode: 'oneshot', crash_dd: 0.1, bond_priority });
      for (const p of [...res.strategy.points, ...res.beta_curve, ...res.mkt_drawdown]) {
        expect(Number.isFinite(p.value)).toBe(true);
      }
      for (const bd of res.benchmarks) expect(Number.isFinite(bd.metrics.final_value)).toBe(true);
    }
  });
});

describe('runBacktest — tiered mode (三層股災)', () => {
  const P_TIERED = {
    initial_capital: 1_000_000,
    target_beta: 1.2,
    etf_beta: 2.0,
    tolerance_mode: 'abs' as const,
    threshold_abs: 0.1,
    mode: 'tiered' as const,
    tier2_dd: 0.15,
    beta_mid: 1.75,
    crash_dd: 0.20,
  };

  it('progresses tier2_enter -> crash_enter (tier3) -> crash_exit correctly', () => {
    // 0050: 100 -> 90 (-10% / tier1, 無動作) -> 84 (-16% / tier2, 加碼至 1.75) -> 78 (-22% / tier3, 滿倉 2.0) -> 101 (創新高, 退出回 1.2)
    const res = runBacktest(bars(
      [100, 100, 100, 100, 100],
      [100, 90, 84, 78, 101]
    ), P_TIERED);

    const tradeTypes = res.trades.map((t) => t.type);
    expect(tradeTypes).toEqual(['tier2_enter', 'crash_enter', 'crash_exit']);

    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].enter).toBe(d(2)); // tier2_enter on 84
    expect(res.crash_events[0].tier3_date).toBe(d(3)); // crash_enter on 78
    expect(res.crash_events[0].exit).toBe(d(4)); // crash_exit on 101
    // 升級當天（78，-22%）才是全程最深回撤，須被記錄，不可停留在 tier2 進場當天（84，-16%）
    expect(res.crash_events[0].max_dd).toBeCloseTo(0.22, 6);

    // Check portfolio beta transitions
    // initial: 1.2
    // day 1 (90): 1.2 (no action)
    // day 2 (84): 1.75 (tier2_enter)
    // day 3 (78): 2.0 (crash_enter)
    // day 4 (101): 1.2 (crash_exit)
    expect(res.beta_curve[0].value).toBeCloseTo(1.2, 6);
    expect(res.beta_curve[1].value).toBeCloseTo(1.2, 6);
    expect(res.beta_curve[2].value).toBeCloseTo(1.75, 6);
    expect(res.beta_curve[3].value).toBeCloseTo(2.0, 6);
    expect(res.beta_curve[4].value).toBeCloseTo(1.2, 6);
  });

  it('recovers to target when dropping below tier2 limit (tier2 -> tier2_exit)', () => {
    // 0050: 100 -> 84 (-16% / tier2, 加碼至 1.75) -> 95 (-5% / tier2_exit, 回退至 1.2)
    const res = runBacktest(bars(
      [100, 100, 100],
      [100, 84, 95]
    ), P_TIERED);

    const tradeTypes = res.trades.map((t) => t.type);
    expect(tradeTypes).toEqual(['tier2_enter', 'tier2_exit']);

    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].enter).toBe(d(1)); // tier2_enter on 84
    expect(res.crash_events[0].exit).toBe(d(2)); // tier2_exit on 95
    expect(res.crash_events[0].tier3_date).toBeNull(); // never hit tier3

    expect(res.beta_curve[1].value).toBeCloseTo(1.75, 6);
    expect(res.beta_curve[2].value).toBeCloseTo(1.2, 6);
  });

  it('jumps straight to crash_enter (tier3) on extreme sudden drops', () => {
    // 0050: 100 -> 78 (-22% / tier3 directly)
    const res = runBacktest(bars(
      [100, 100],
      [100, 78]
    ), P_TIERED);

    const tradeTypes = res.trades.map((t) => t.type);
    expect(tradeTypes).toEqual(['crash_enter']);

    expect(res.crash_events).toHaveLength(1);
    expect(res.crash_events[0].enter).toBe(d(1));
    expect(res.crash_events[0].tier3_date).toBe(d(1));
    expect(res.crash_events[0].exit).toBeNull();

    expect(res.beta_curve[1].value).toBeCloseTo(2.0, 6);
  });
});
