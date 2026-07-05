import { describe, it, expect } from 'vitest';
import { computeRebalance, aggregatePosition, triggerPriceForBeta, type Trade } from './rebalance';

const mk = (side: 'buy' | 'sell', date: string, shares: number, price: number): Trade => ({
  id: `${side}_${date}_${shares}_${price}`,
  date,
  side,
  shares,
  price,
});

describe('aggregatePosition', () => {
  it('opening only, no trades → returns opening', () => {
    const r = aggregatePosition({ shares: 19000, avg_cost: 35.37 }, []);
    expect(r.shares).toBe(19000);
    expect(r.avg_cost).toBeCloseTo(35.37, 6);
    expect(r.realized_pnl).toBe(0);
    expect(r.invalid_sells).toBe(0);
  });

  it('buy adds shares and recomputes weighted average cost', () => {
    // 期初 1000@10（成本 10,000）＋ 買進 1000@20（成本 20,000）＝ 2000 股、均價 15
    const r = aggregatePosition({ shares: 1000, avg_cost: 10 }, [mk('buy', '2026-01-02', 1000, 20)]);
    expect(r.shares).toBe(2000);
    expect(r.avg_cost).toBeCloseTo(15, 6);
  });

  it('sell reduces shares but leaves average cost unchanged; realized pnl computed', () => {
    // 期初 2000@15，賣 500@25 → 剩 1500 股、均價仍 15、已實現 (25-15)*500=5000
    const r = aggregatePosition({ shares: 2000, avg_cost: 15 }, [mk('sell', '2026-02-01', 500, 25)]);
    expect(r.shares).toBe(1500);
    expect(r.avg_cost).toBeCloseTo(15, 6);
    expect(r.realized_pnl).toBeCloseTo(5000, 6);
  });

  it('oversell clamps to held shares and flags invalid_sells; shares/avg go to 0', () => {
    const r = aggregatePosition({ shares: 1000, avg_cost: 10 }, [mk('sell', '2026-03-01', 5000, 12)]);
    expect(r.shares).toBe(0);
    expect(r.avg_cost).toBe(0);
    expect(r.invalid_sells).toBe(1);
    // 賣出 clamp 到 1000 股：已實現 (12-10)*1000 = 2000
    expect(r.realized_pnl).toBeCloseTo(2000, 6);
  });

  it('sorts by date regardless of input order (buy before sell chronologically)', () => {
    // 亂序輸入：先給 2026-02 賣、再給 2026-01 買；期初 0
    const trades = [mk('sell', '2026-02-01', 500, 30), mk('buy', '2026-01-01', 1000, 20)];
    const r = aggregatePosition({ shares: 0, avg_cost: 0 }, trades);
    // 排序後：買 1000@20 → 賣 500@30 → 剩 500 股、均價 20、已實現 (30-20)*500=5000
    expect(r.shares).toBe(500);
    expect(r.avg_cost).toBeCloseTo(20, 6);
    expect(r.realized_pnl).toBeCloseTo(5000, 6);
  });

  it('guards NaN / missing fields', () => {
    const r = aggregatePosition(null, [
      { id: 'x', date: '2026-01-01', side: 'buy', shares: NaN as unknown as number, price: 10 },
      { id: 'y', date: '2026-01-02', side: 'buy', shares: 100, price: 10 },
    ]);
    expect(Number.isFinite(r.shares)).toBe(true);
    expect(r.shares).toBe(100);
    expect(r.avg_cost).toBeCloseTo(10, 6);
  });
});

describe('computeRebalance', () => {
  it('clean regression case: 60/40 ratio matching target beta 1.2', () => {
    const res = computeRebalance({
      shares: 6000,
      price: 100,
      cash: 400000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.etf_value).toBe(600000);
    expect(res.total_value).toBe(1000000);
    expect(res.etf_weight).toBe(0.6);
    expect(res.cash_weight).toBe(0.4);
    expect(res.current_beta).toBe(1.2);
    expect(res.status).toBe('normal');
    expect(res.etf_value_delta).toBe(0);
    expect(res.trade_shares).toBe(0);
    expect(res.post_shares).toBe(6000);
    expect(res.action_label).toContain('✅ 正常範圍');
  });

  it('triggers sell when beta exceeds upper band (beta > 1.32)', () => {
    // etf_value = 750,000, cash = 250,000 => total = 1,000,000
    // etf_weight = 0.75 => beta = 1.5 > upper_band 1.32
    const res = computeRebalance({
      shares: 7500,
      price: 100,
      cash: 250000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.current_beta).toBe(1.5);
    expect(res.upper_band).toBe(1.32);
    expect(res.status).toBe('sell');
    expect(res.etf_value_delta).toBe(-150000); // needs to go back to 600,000
    expect(res.trade_shares).toBe(-1500);
    expect(res.cash_delta).toBe(150000);
    expect(res.post_shares).toBe(6000);
    expect(res.post_cash).toBe(400000);
    expect(res.post_beta).toBe(1.2);
    expect(res.action_label).toContain('⚠ 已破上限 1.32');
    expect(res.action_label).toContain('建議賣出 00631L 約 $150,000（約 1,500 股）');
  });

  it('triggers buy when beta drops below lower band (beta < 1.08)', () => {
    // etf_value = 400,000, cash = 600,000 => total = 1,000,000
    // etf_weight = 0.4 => beta = 0.8 < lower_band 1.08
    const res = computeRebalance({
      shares: 4000,
      price: 100,
      cash: 600000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.current_beta).toBe(0.8);
    expect(res.lower_band).toBe(1.08);
    expect(res.status).toBe('buy');
    expect(res.etf_value_delta).toBe(200000);
    expect(res.trade_shares).toBe(2000);
    expect(res.cash_delta).toBe(-200000);
    expect(res.post_shares).toBe(6000);
    expect(res.post_cash).toBe(400000);
    expect(res.post_beta).toBe(1.2);
    expect(res.action_label).toContain('⚠ 已破下限 1.08');
    expect(res.action_label).toContain('建議買進 00631L 約 $200,000（約 2,000 股）');
  });

  it('handles discrete share rounding correctly', () => {
    // price = 185.5, shares = 1000 => etf = 185,500, cash = 100,000 => total = 285,500
    // target_beta = 1.2 => target etf weight = 0.6 => target_etf_value = 171,300
    // etf_value_delta = 171,300 - 185,500 = -14,200
    // trade_shares = round(-14200 / 185.5) = round(-76.5498) = -77
    const res = computeRebalance({
      shares: 1000,
      price: 185.5,
      cash: 100000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.etf_value_delta).toBeCloseTo(-14200);
    expect(res.trade_shares).toBe(-77);
    expect(res.post_shares).toBe(923); // 1000 - 77
    expect(res.post_cash).toBe(100000 - (-77 * 185.5)); // 100000 + 14283.5 = 114283.5
    expect(res.post_beta).toBeDefined();
    expect(res.post_beta).not.toBeNull();
  });

  it('handles total_value <= 0 guard', () => {
    const res = computeRebalance({
      shares: 0,
      price: 100,
      cash: 0,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.status).toBe('empty');
    expect(res.current_beta).toBeNull();
    expect(res.etf_weight).toBeNull();
    expect(res.trade_shares).toBeNull();
    expect(res.note).toBe('尚未輸入持倉');
  });

  it('handles price <= 0 guard when cash is positive', () => {
    const res = computeRebalance({
      shares: 100,
      price: 0,
      cash: 500000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.total_value).toBe(500000);
    expect(res.etf_value).toBe(0);
    expect(res.current_beta).toBe(0);
    expect(res.trade_shares).toBeNull();
    expect(res.note).toBe('填入現價才能換算交易股數');
  });

  it('handles target_beta boundaries (0.0 and 2.0)', () => {
    const resZero = computeRebalance({
      shares: 1000,
      price: 100,
      cash: 100000,
      target_beta: 0,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(resZero.target_etf_weight).toBe(0);
    expect(resZero.target_cash_weight).toBe(1);
    expect(resZero.deviation_pct).toBeNull(); // target=0 -> null

    const resMax = computeRebalance({
      shares: 1000,
      price: 100,
      cash: 100000,
      target_beta: 2.0,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(resMax.target_etf_weight).toBe(1);
    expect(resMax.target_cash_weight).toBe(0);
  });

  it('handles invalid/NaN inputs without crashing', () => {
    const res = computeRebalance({
      shares: NaN,
      price: Infinity,
      cash: -500,
      target_beta: NaN,
      tolerance_mode: undefined as any,
      threshold_pct: undefined as any,
      threshold_abs: undefined as any,
      etf_beta: 0,
    });

    expect(Number.isFinite(res.etf_value)).toBe(true);
    expect(Number.isFinite(res.total_value)).toBe(true);
    expect(res.status).toBeDefined();
  });

  // ===== 增修A：容忍模式切換 =====

  it('abs mode: target 1.3 ± 0.1 gives band [1.2, 1.4] (not percentage)', () => {
    // etf_value = 650,000, cash = 350,000 => total 1,000,000
    // etf_weight = 0.65 => beta = 1.3 = target
    const res = computeRebalance({
      shares: 6500,
      price: 100,
      cash: 350000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });

    expect(res.current_beta).toBeCloseTo(1.3);
    expect(res.upper_band).toBeCloseTo(1.4); // 1.3 + 0.1（非 1.3×1.1=1.43）
    expect(res.lower_band).toBeCloseTo(1.2); // 1.3 − 0.1（非 1.3×0.9=1.17）
    expect(res.status).toBe('normal');
    expect(res.action_label).toContain('β');
    expect(res.action_label).toContain('±0.1 β');
    expect(res.action_label).not.toContain('%');
  });

  it('abs mode: beta just above upper band 1.4 triggers sell', () => {
    // etf_weight 0.71 => beta 1.42 > 1.4
    const res = computeRebalance({
      shares: 7100,
      price: 100,
      cash: 290000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.current_beta).toBeCloseTo(1.42);
    expect(res.upper_band).toBeCloseTo(1.4);
    expect(res.status).toBe('sell');
  });

  it('pct and abs modes differ for the same target/holdings', () => {
    const base = {
      shares: 6800,
      price: 100,
      cash: 320000,
      target_beta: 1.3,
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    };
    const abs = computeRebalance({ ...base, tolerance_mode: 'abs' });
    const pct = computeRebalance({ ...base, tolerance_mode: 'pct' });
    expect(abs.upper_band).toBeCloseTo(1.4);
    expect(abs.lower_band).toBeCloseTo(1.2);
    expect(pct.upper_band).toBeCloseTo(1.43); // 1.3 × 1.1
    expect(pct.lower_band).toBeCloseTo(1.17); // 1.3 × 0.9
  });

  it('abs mode clamps lower band to >= 0 when target < threshold_abs', () => {
    const res = computeRebalance({
      shares: 1000,
      price: 100,
      cash: 100000,
      target_beta: 0.05,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.lower_band).toBe(0); // 0.05 − 0.1 = −0.05 → clamp 0
  });

  it('missing tolerance fields default to abs mode (backward-compat guard)', () => {
    const res = computeRebalance({
      shares: 6500,
      price: 100,
      cash: 350000,
      target_beta: 1.3,
      etf_beta: 2.0,
    } as any);
    expect(res.upper_band).toBeCloseTo(1.4); // 預設 abs ±0.1
    expect(res.lower_band).toBeCloseTo(1.2);
  });

  // ===== 增修B：平均成本 → 未實現損益 =====

  it('computes unrealized profit when price > avg_cost', () => {
    const res = computeRebalance({
      shares: 1000,
      price: 200,
      avg_cost: 150,
      cash: 100000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.cost_basis).toBe(150000); // 1000 × 150
    expect(res.unrealized_pnl).toBe(50000); // 200000 − 150000
    expect(res.unrealized_pnl_pct).toBeCloseTo(0.3333, 3);
  });

  it('computes unrealized loss when price < avg_cost', () => {
    const res = computeRebalance({
      shares: 1000,
      price: 120,
      avg_cost: 150,
      cash: 100000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.cost_basis).toBe(150000);
    expect(res.unrealized_pnl).toBe(-30000); // 120000 − 150000
    expect(res.unrealized_pnl_pct).toBeCloseTo(-0.2, 3);
  });

  it('P&L fields are null when avg_cost not provided (does not affect rebalance)', () => {
    const res = computeRebalance({
      shares: 6000,
      price: 100,
      cash: 400000,
      target_beta: 1.2,
      tolerance_mode: 'pct',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    } as any);
    expect(res.cost_basis).toBeNull();
    expect(res.unrealized_pnl).toBeNull();
    expect(res.unrealized_pnl_pct).toBeNull();
    // 再平衡計算不受影響
    expect(res.current_beta).toBe(1.2);
    expect(res.status).toBe('normal');
  });

  it('avg_cost with zero shares still yields null P&L (empty guard)', () => {
    const res = computeRebalance({
      shares: 0,
      price: 0,
      avg_cost: 150,
      cash: 0,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.status).toBe('empty');
    expect(res.cost_basis).toBeNull();
    expect(res.unrealized_pnl).toBeNull();
  });

  // ===== 觸發價位（反解 β → 價格） =====

  it('surfaces sell/buy trigger prices that reproduce the band betas', () => {
    // shares 6500、cash 350,000、etf_beta 2.0、target 1.3、abs ±0.1 → band [1.2, 1.4]
    const res = computeRebalance({
      shares: 6500,
      price: 100,
      cash: 350000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    // 賣點 β=1.4：P = 1.4×350000/(6500×0.6) = 125.6410…
    expect(res.sell_trigger_price).toBeCloseTo(125.641, 2);
    // 買點 β=1.2：P = 1.2×350000/(6500×0.8) = 80.7692…
    expect(res.buy_trigger_price).toBeCloseTo(80.769, 2);
    // 反代回去 β 應等於上/下限
    for (const [price, band] of [
      [res.sell_trigger_price!, 1.4],
      [res.buy_trigger_price!, 1.2],
    ] as const) {
      const etf = 6500 * price;
      const beta = (etf / (etf + 350000)) * 2.0;
      expect(beta).toBeCloseTo(band, 6);
    }
  });
});

describe('triggerPriceForBeta', () => {
  it('solves price so that beta hits the target', () => {
    // β=1.4, shares 6500, cash 350000, etf_beta 2 → 125.641
    expect(triggerPriceForBeta(1.4, 6500, 350000, 2.0)).toBeCloseTo(125.641, 2);
  });

  it('returns null when cash is 0 (beta independent of price)', () => {
    expect(triggerPriceForBeta(1.4, 6500, 0, 2.0)).toBeNull();
  });

  it('returns null when no shares held', () => {
    expect(triggerPriceForBeta(1.4, 0, 350000, 2.0)).toBeNull();
  });

  it('returns null when target beta >= etf_beta (unreachable at any price)', () => {
    expect(triggerPriceForBeta(2.0, 6500, 350000, 2.0)).toBeNull();
    expect(triggerPriceForBeta(2.5, 6500, 350000, 2.0)).toBeNull();
  });

  it('returns null when target beta <= 0 (never triggers falling)', () => {
    expect(triggerPriceForBeta(0, 6500, 350000, 2.0)).toBeNull();
    expect(triggerPriceForBeta(-0.5, 6500, 350000, 2.0)).toBeNull();
  });

  it('guards NaN inputs', () => {
    expect(triggerPriceForBeta(NaN, 6500, 350000, 2.0)).toBeNull();
    expect(triggerPriceForBeta(1.4, NaN, 350000, 2.0)).toBeNull();
  });
});
