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

  // 3a. 鎖定單一債券＋現金也鎖定 → 現金無法注入，真正卡住
  it('3a. Lock single bond + cash also locked, no injection possible, genuinely capped', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000 (locked).
    // 00687B = 25,000 * 20 = 500,000 (locked).
    // 00953B = 10,000 * 10 = 100,000 (unlocked).
    // Total value = 1,000,000. target_beta=1.6 => target_etf_weight=0.8. naive=800,000.
    // locked_defensive_sum = cash(100,000)+00687B(500,000) = 600,000. headroom = 400,000.
    // cash 也鎖定 → 不允許注入，維持舊「卡住」邏輯：target_etf_value_actual=min(800,000,400,000)=400,000.
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
        cash: true,
        bonds: { '00687B': true, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(true);
    expect(res.cash_injection_needed).toBeNull();
    expect(res.lock_note).toContain('已鎖定資產現值合計 $600,000 超過目標防守端可用空間');
    expect(res.achieved_beta).toBeCloseTo(0.8);
    // 00687B 鎖定 value_delta=0；現金也鎖定，維持 100,000 不變
    const b1 = res.bond_plans.find((p) => p.code === '00687B')!;
    expect(b1.value_delta).toBe(0);
    expect(res.target_cash_value).toBe(100000);
    expect(res.cash_adjust_delta).toBe(0);
    // 00953B（唯一未鎖定資產）吸收到 0
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b2.target_value).toBe(0);
    expect(b2.value_delta).toBe(-100000);
  });

  // 3b. 鎖定單一債券、現金未鎖定 → 既有未鎖定資金不足以達標時，改用「注入新現金」達成目標
  it('3b. Lock single bond, cash unlocked, shortfall resolved via cash injection', () => {
    // 00631L = 10,000 * 30 = 300,000.
    // cash = 100,000（未鎖定）.
    // 00687B = 25,000 * 20 = 500,000 (locked).
    // 00953B = 10,000 * 10 = 100,000（未鎖定）.
    // Total value = 1,000,000. target_beta=1.6 => target_etf_weight=0.8. naive=800,000.
    // locked_defensive_sum = 500,000（僅 00687B）. headroom = 500,000. shortfall = 300,000.
    // 現金未鎖定 → 注入 X = shortfall/(1-0.8) = 300,000/0.2 = 1,500,000。
    // target_etf_value_actual = headroom + X = 500,000 + 1,500,000 = 2,000,000。
    // effective_total = 1,000,000 + 1,500,000 = 2,500,000。achieved_beta = 2,000,000/2,500,000*2 = 1.6（精準達標）。
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
    expect(res.lock_capped).toBe(false);
    expect(res.cash_injection_needed).toBeCloseTo(1500000);
    expect(res.lock_note).toContain('需先注入新現金 $1,500,000');
    expect(res.achieved_beta).toBeCloseTo(1.6);
    expect(res.target_etf_value).toBeCloseTo(2000000);
    expect(res.etf_value_delta).toBeCloseTo(1700000); // 既有未鎖定資金 200,000 + 注入 1,500,000
    // 00687B 鎖定，value_delta=0；現金與 00953B（唯一未鎖定）吸收到 0
    const b1 = res.bond_plans.find((p) => p.code === '00687B')!;
    expect(b1.value_delta).toBe(0);
    expect(res.target_cash_value).toBeCloseTo(0);
    expect(res.cash_adjust_delta).toBeCloseTo(-100000);
    const b2 = res.bond_plans.find((p) => p.code === '00953B')!;
    expect(b2.target_value).toBeCloseTo(0);
    expect(b2.value_delta).toBeCloseTo(-100000);
  });

  // 3c. 兩檔債券都鎖定、現金未鎖定（使用者實際回報情境）→ 注入新現金全額買 00631L
  it('3c. Both bonds locked, cash unlocked (user-reported scenario) → cash injection', () => {
    // 00631L = 10,000 * 36.88 = 368,800.
    // cash = 0（未鎖定）.
    // 00687B = 10,000 * 27.89 = 278,900 (locked).
    // 00953B = 20,000 * 9.7 = 194,000 (locked).
    // Total = 841,700. target_beta=1.2, etf_beta=2.0 => target_etf_weight=0.6. naive=505,020.
    // locked_defensive_sum = 472,900（cash 未鎖定，不計入）. headroom = 368,800（= etf_value，因現金已是 0）.
    // shortfall = 505,020 - 368,800 = 136,220。注入 X = 136,220/(1-0.6) = 340,550。
    // target_etf_value_actual = 368,800+340,550 = 709,350。achieved_beta = 709,350*2/(841,700+340,550) = 1.2（精準）。
    const input: RebalanceInput = {
      shares: 10000,
      price: 36.88,
      avg_cost: 37,
      cash: 0,
      target_beta: 1.2,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 10000, price: 27.89, avg_cost: 28.18 },
        { code: '00953B', shares: 20000, price: 9.7, avg_cost: 9.7 },
      ],
      cash_reserve: 100000,
      bond_split: 0.6,
      locked: {
        cash: false,
        bonds: { '00687B': true, '00953B': true },
      },
    };

    const res = computeRebalance(input);
    expect(res.lock_capped).toBe(false);
    expect(res.cash_injection_needed).toBeCloseTo(340550);
    expect(res.achieved_beta).toBeCloseTo(1.2);
    expect(res.etf_value_delta).toBeCloseTo(340550);
    expect(res.target_cash_value).toBeCloseTo(0);
    expect(res.cash_adjust_delta).toBeCloseTo(0);
    res.bond_plans.forEach((p) => expect(p.value_delta).toBe(0));
  });

  // 3d. 目標 β = 滿槓桿（target_etf_weight=1）時，注入公式除以零 → 不應注入，退回舊「卡住」邏輯
  it('3d. target_beta === etf_beta (target_etf_weight=1) guards against divide-by-zero, falls back to capped', () => {
    // 00631L = 10,000 * 30 = 300,000. cash = 50,000（未鎖定）.
    // 00687B = 5,000 * 20 = 100,000 (locked). 00953B = 0（未鎖定，現值0）.
    // Total = 450,000. target_beta=2.0=etf_beta => target_etf_weight=1.0（滿槓桿）. naive=450,000.
    // locked_defensive_sum=100,000. headroom=350,000. shortfall=100,000，但 1-target_etf_weight=0 → 不注入。
    const input: RebalanceInput = {
      shares: 10000,
      price: 30,
      cash: 50000,
      target_beta: 2.0,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 5000, price: 20 },
        { code: '00953B', shares: 0, price: 10 },
      ],
      cash_reserve: 10000,
      bond_split: 0.6,
      locked: {
        cash: false,
        bonds: { '00687B': true, '00953B': false },
      },
    };

    const res = computeRebalance(input);
    expect(res.cash_injection_needed).toBeNull();
    expect(res.lock_capped).toBe(true);
    expect(Number.isFinite(res.target_etf_value)).toBe(true);
    expect(res.target_etf_value).toBeCloseTo(350000);
    expect(res.achieved_beta).toBeCloseTo(1.5556, 3);
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
