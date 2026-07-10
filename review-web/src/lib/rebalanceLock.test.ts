import { describe, it, expect } from 'vitest';
import {
  computeRebalance,
  type RebalanceInput,
} from './rebalance';

describe('Rebalance Asset Lock Tests', () => {
  // 1. 回歸測試（最重要）
  it('1. Regression tests: no lock vs explicit all false lock vs undefined lock', () => {
    const baseInput: RebalanceInput = {
      shares: 10000,
      price: 36.88,
      cash: 0,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 10000, price: 27.89, avg_cost: 28 },
        { code: '00953B', shares: 20000, price: 9.7, avg_cost: 10 },
      ],
      cash_reserve: 100_000,
      bond_split: 0.6,
    };

    const resNone = computeRebalance(baseInput);
    const resUndefined = computeRebalance({ ...baseInput, locked: undefined });
    const resAllFalse = computeRebalance({
      ...baseInput,
      locked: {
        cash: false,
        bonds: { '00687B': false, '00953B': false },
      },
    });

    expect(resUndefined).toEqual(resNone);
    expect(resAllFalse).toEqual(resNone);
  });

  // 2. 鎖定單一債券、鎖定值不足以卡住目標
  // 加碼 00631L 需要防守端縮小，鎖定 00687B 現值只有一小部分，不影響 00631L 加碼幅度
  it('2. Lock single bond, lock sum does not cap target', () => {
    // 00631L beta = 2.0, target_beta = 1.6 => target_etf_weight = 0.8
    // Total value = 00631L(10000*30=300000) + cash(200000) + 00687B(1000*20=20000) + 00953B(1000*10=10000) = 530,000
    // naive_target_etf_value = 0.8 * 530,000 = 424,000.
    // target_defensive_value = 530,000 - 424,000 = 106,000.
    // cash_reserve = 50,000.
    // 00687B is locked, current value = 20,000.
    // locked_defensive_sum = 20,000.
    // total_value - locked_defensive_sum = 510,000 >= 424,000. So target_etf_value_actual = 424,000.
    // lock_capped = false. achieved_beta = 1.6.
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 200000,
      target_beta: 1.6,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 1000, price: 20 },
        { code: '00953B', shares: 1000, price: 10 },
      ],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: false,
        bonds: { '00687B': true, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(false);
    expect(res.lock_note).toBeNull();
    expect(res.achieved_beta).toBeCloseTo(1.6);
    // 00687B is locked, value_delta should be 0, post_shares = initial shares = 1000
    const b1 = res.bond_plans.find((p) => p.code === '00687B')!;
    expect(b1.value_delta).toBe(0);
    expect(b1.trade_shares).toBe(0);
    expect(b1.post_shares).toBe(1000);

    // 00953B and cash absorb the shrinking.
    // naive: target_defensive_value = 106,000.
    // locked 00687B = 20,000. Remaining unlocked_pool = 106,000 - 20,000 = 86,000.
    // cash is not locked, cash_reserve = 50,000 <= 86,000.
    // So cash target = 50,000.
    // bondPool = 86,000 - 50,000 = 36,000.
    // Since only 00953B is unlocked, 00953B gets full bondPool = 36,000.
    expect(res.target_cash_value).toBe(50000);
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b2.target_value).toBe(36000);
  });

  // 3. 鎖定單一債券、鎖定值卡住目標
  // 縮小需求 $30 萬，但鎖定 00687B 現值 $50 萬
  it('3. Lock single bond, lock sum caps target', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000.
    // 00687B = 25,000 * 20 = 500,000 (locked).
    // 00953B = 10,000 * 10 = 100,000.
    // Total value = 1,000,000.
    // target_beta = 1.6 => target_etf_weight = 0.8.
    // naive_target_etf_value = 0.8 * 1,000,000 = 800,000. (wants to buy 500,000 00631L, so defensive should shrink to 200,000)
    // But 00687B is locked at 500,000.
    // locked_defensive_sum = 500,000.
    // target_etf_value_actual = Math.min(800,000, 1,000,000 - 500,000) = 500,000.
    // lock_capped = true.
    // achieved_beta = (500,000 / 1,000,000) * 2.0 = 1.0 < 1.6.
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 100000,
      target_beta: 1.6,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 25000, price: 20 },
        { code: '00953B', shares: 10000, price: 10 },
      ],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: false,
        bonds: { '00687B': true, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(true);
    expect(res.lock_note).toContain('已鎖定資產現值合計 $500,000 超過目標防守端可用空間');
    expect(res.achieved_beta).toBeCloseTo(1.0);
    // 00687B is locked, value_delta = 0
    const b1 = res.bond_plans.find((p) => p.code === '00687B')!;
    expect(b1.value_delta).toBe(0);

    // 00953B/現金吸收到 0 為止 (不會被要求變負值)
    // target_defensive_value = 1,000,000 - 500,000 = 500,000.
    // locked 00687B = 500,000. Remaining unlocked_pool = 500,000 - 500,000 = 0.
    // So cash target = 0. 00953B target = 0.
    expect(res.target_cash_value).toBe(0);
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b2.target_value).toBe(0);
    expect(res.cash_adjust_delta).toBe(-100000);
    expect(b2.value_delta).toBe(-100000);
  });

  // 4. 鎖定現金＋防守端擴大
  it('4. Lock cash and expand defensive side', () => {
    // 00631L = 20,000 * 30 = 600,000.
    // cash = 100,000 (locked).
    // 00687B = 10,000 * 20 = 200,000.
    // 00953B = 10,000 * 10 = 100,000.
    // Total value = 1,000,000.
    // target_beta = 1.0 => target_etf_weight = 0.5. (Wants to reduce 00631L to 500,000, so defensive expands to 500,000)
    // naive_target_etf_value = 500,000.
    // locked_defensive_sum = cash(100,000) = 100,000.
    // target_etf_value_actual = Math.min(500,000, 1,000,000 - 100,000) = 500,000.
    // lock_capped = false.
    const input: RebalanceInput = {
      shares: 20000,
      price: 30,
      cash: 100000,
      target_beta: 1.0,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 10000, price: 20 },
        { code: '00953B', shares: 10000, price: 10 },
      ],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: true,
        bonds: { '00687B': false, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(false);
    expect(res.target_cash_value).toBe(100000); // locked cash remains 100,000
    expect(res.cash_adjust_delta).toBe(0);

    // Remaining unlocked_pool = 500,000 - 100,000 = 400,000.
    // The two unlocked bonds share it according to bond_split: 0.6 / 0.4
    // 00687B target = 400,000 * 0.6 = 240,000.
    // 00953B target = 400,000 * 0.4 = 160,000.
    const b1 = res.bond_plans.find((p) => p.code === '00687B')!;
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b1.target_value).toBe(240000);
    expect(b2.target_value).toBe(160000);
  });

  // 5. 鎖定唯一一檔未鎖債券的情境
  it('5. Only one bond unlocked, it gets the entire bondPool', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000.
    // 00687B = 10,000 * 20 = 200,000 (locked).
    // 00953B = 10,000 * 10 = 100,000.
    // Total value = 700,000.
    // target_beta = 1.0 => target_etf_weight = 0.5. (target_defensive = 350,000)
    // cash_reserve = 50,000.
    // locked 00687B = 200,000.
    // unlocked_pool = 350,000 - 200,000 = 150,000.
    // cash target = 50,000. Remaining bondPool = 100,000.
    // Only 00953B is unlocked.
    // 00953B target should be 100,000.
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 100000,
      target_beta: 1.0,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 10000, price: 20 },
        { code: '00953B', shares: 10000, price: 10 },
      ],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: false,
        bonds: { '00687B': true, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b2.target_value).toBe(100000);
  });

  // 6. 三項防守端全鎖定
  it('6. All three defensive assets locked', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000 (locked).
    // 00687B = 10,000 * 20 = 200,000 (locked).
    // 00953B = 10,000 * 10 = 100,000 (locked).
    // Total = 700,000.
    // target_beta = 1.0 => target_etf_weight = 0.5. (Wants to reduce 00631L to 350,000)
    // Since all locked, etf_value_actual = etf_value = 300,000.
    // lock_capped = true.
    // achieved_beta = (300,000 / 700,000) * 2.0 = 0.857.
    // All trade deltas should be 0.
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 100000,
      target_beta: 1.0,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 10000, price: 20 },
        { code: '00953B', shares: 10000, price: 10 },
      ],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: true,
        bonds: { '00687B': true, '00953B': true },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(true);
    expect(res.lock_note).toBe('現金／債券皆已鎖定，投組曝險無法調整（等同鎖死整體配置）');
    expect(res.etf_value_delta).toBe(0);
    expect(res.cash_adjust_delta).toBe(0);
    res.bond_plans.forEach((p) => {
      expect(p.value_delta).toBe(0);
    });
  });

  // 7. 邊界：bonds 為空陣列
  it('7. Empty bonds array (pure cash model) works with cash lock', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000 (locked).
    // Total = 400,000.
    // target_beta = 1.0 => target_etf_weight = 0.5. (Wants to reduce 00631L to 200,000)
    // Since cash locked, allDefensiveLocked = lockedCash = true.
    // target_etf_value_actual = 300,000.
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 100000,
      target_beta: 1.0,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [],
      cash_reserve: 50000,
      bond_split: 0.6,
      locked: {
        cash: true,
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(true);
    expect(res.lock_note).toBe('現金／債券皆已鎖定，投組曝險無法調整（等同鎖死整體配置）');
    expect(res.etf_value_delta).toBe(0);
    expect(res.cash_adjust_delta).toBe(0);
  });
});
