import { describe, it, expect } from 'vitest';
import {
  computeRebalance,
  aggregatePosition,
  aggregatePortfolio,
  triggerPriceForBeta,
  allocateDefensive,
  computeMarketStatus,
  computeBondRegime,
  ETF_CODE,
  DEFAULT_CASH_RESERVE,
  type Trade,
} from './rebalance';

const mk = (side: 'buy' | 'sell', date: string, shares: number, price: number): Trade => ({
  id: `${side}_${date}_${shares}_${price}`,
  date,
  side,
  shares,
  price,
});

// 【增修I】帶標的代號的交易
const mkc = (code: string, side: 'buy' | 'sell', date: string, shares: number, price: number): Trade => ({
  ...mk(side, date, shares, price),
  id: `${code}_${side}_${date}_${shares}_${price}`,
  code,
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

  // ── 【增修H】現金流累算：買進扣現金、賣出加現金 ─────────────────
  it('【增修H】buy deducts trade amount from opening cash (使用者實例 7/06)', () => {
    // 期初 19000@35.37＋期初現金 1,000,000，買 10000@39 → 現金 1,000,000 − 390,000 = 610,000
    const r = aggregatePosition(
      { shares: 19000, avg_cost: 35.37, cash: 1_000_000 },
      [mk('buy', '2026-07-06', 10000, 39)],
    );
    expect(r.shares).toBe(29000);
    expect(r.avg_cost).toBeCloseTo((19000 * 35.37 + 10000 * 39) / 29000, 6);
    expect(r.cash).toBeCloseTo(610_000, 6);
  });

  it('【增修H】sell credits proceeds to cash', () => {
    // 期初 2000@15＋現金 100,000，賣 500@25 → 現金 100,000 + 12,500 = 112,500
    const r = aggregatePosition({ shares: 2000, avg_cost: 15, cash: 100_000 }, [mk('sell', '2026-02-01', 500, 25)]);
    expect(r.cash).toBeCloseTo(112_500, 6);
  });

  it('【增修H】oversell credits only clamped (actually sold) shares', () => {
    // 期初 1000@10＋現金 0，賣 5000@12 → 只成交 1000 股，現金 +12,000（非 +60,000）
    const r = aggregatePosition({ shares: 1000, avg_cost: 10, cash: 0 }, [mk('sell', '2026-03-01', 5000, 12)]);
    expect(r.cash).toBeCloseTo(12_000, 6);
  });

  it('【增修H】buy beyond opening cash yields negative cash (供 UI 警示，落地端 clamp)', () => {
    const r = aggregatePosition({ shares: 0, avg_cost: 0, cash: 100_000 }, [mk('buy', '2026-01-02', 10000, 20)]);
    expect(r.cash).toBeCloseTo(-100_000, 6);
  });

  it('【增修H】opening without cash defaults to 0 (向後相容)', () => {
    const r = aggregatePosition({ shares: 1000, avg_cost: 10 }, []);
    expect(r.cash).toBe(0);
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

// ===== 【增修I】多資產部位累算（共用現金池） =====

describe('aggregatePortfolio', () => {
  it('trade without code defaults to 00631L (legacy migration)', () => {
    const r = aggregatePortfolio(
      { cash: 1_000_000, positions: { [ETF_CODE]: { shares: 19000, avg_cost: 35.37 } } },
      [mk('buy', '2026-07-06', 10000, 39)],
    );
    expect(r.positions[ETF_CODE].shares).toBe(29000);
    expect(r.positions[ETF_CODE].avg_cost).toBeCloseTo((19000 * 35.37 + 10000 * 39) / 29000, 6);
    expect(r.cash).toBeCloseTo(610_000, 6);
  });

  it('bond buy deducts from the shared cash pool', () => {
    // 期初現金 500,000，買 00687B 5000@28 → 現金 500,000 − 140,000 = 360,000
    const r = aggregatePortfolio(
      { cash: 500_000, positions: { [ETF_CODE]: { shares: 1000, avg_cost: 30 } } },
      [mkc('00687B', 'buy', '2026-07-07', 5000, 28)],
    );
    expect(r.cash).toBeCloseTo(360_000, 6);
    expect(r.positions['00687B'].shares).toBe(5000);
    expect(r.positions['00687B'].avg_cost).toBeCloseTo(28, 6);
    // 00631L 不受影響
    expect(r.positions[ETF_CODE].shares).toBe(1000);
    expect(r.positions[ETF_CODE].avg_cost).toBeCloseTo(30, 6);
  });

  it('mixed-code trades: sell one asset funds buying another (date-sorted)', () => {
    // 賣 00631L 2000@40（+80,000）→ 隔日買 00953B 8000@9.6（−76,800）
    const r = aggregatePortfolio(
      { cash: 0, positions: { [ETF_CODE]: { shares: 5000, avg_cost: 35 } } },
      [
        mkc('00953B', 'buy', '2026-07-08', 8000, 9.6),
        mkc(ETF_CODE, 'sell', '2026-07-07', 2000, 40),
      ],
    );
    expect(r.positions[ETF_CODE].shares).toBe(3000);
    expect(r.positions[ETF_CODE].avg_cost).toBeCloseTo(35, 6); // 賣出不改均價
    expect(r.positions['00953B'].shares).toBe(8000);
    expect(r.cash).toBeCloseTo(80_000 - 76_800, 6);
    expect(r.realized_pnl).toBeCloseTo((40 - 35) * 2000, 6);
  });

  it('per-code oversell clamps independently and credits only sold shares', () => {
    const r = aggregatePortfolio(
      { cash: 0, positions: { '00687B': { shares: 1000, avg_cost: 28 } } },
      [mkc('00687B', 'sell', '2026-07-07', 5000, 29)],
    );
    expect(r.positions['00687B'].shares).toBe(0);
    expect(r.positions['00687B'].avg_cost).toBe(0);
    expect(r.invalid_sells).toBe(1);
    expect(r.cash).toBeCloseTo(29_000, 6); // 只計實際成交 1000 股
  });

  it('guards null opening / unknown code trade', () => {
    const r = aggregatePortfolio(null, [mkc('00687B', 'buy', '2026-07-07', 100, 28)]);
    expect(r.positions['00687B'].shares).toBe(100);
    expect(r.cash).toBeCloseTo(-2800, 6); // 期初現金 0 → 負值供 UI 警示
  });
});

// ===== 【增修I】computeRebalance 防守端（固定現金＋債券池 6:4） =====

describe('computeRebalance with bonds (增修I)', () => {
  // 基準情境：總資產 1,000,000＝00631L 650,000＋現金 150,000＋00687B 140,000＋00953B 60,000
  // β = 0.65×2 = 1.3 = 目標 → normal；目標防守端 350,000 → 現金保留 100,000、債券池 250,000（6:4）
  const base = {
    shares: 6500,
    price: 100,
    cash: 150_000,
    target_beta: 1.3,
    tolerance_mode: 'abs' as const,
    threshold_pct: 10,
    threshold_abs: 0.1,
    etf_beta: 2.0,
    bonds: [
      { code: '00687B', shares: 5000, price: 28 },
      { code: '00953B', shares: 6000, price: 10 },
    ],
    cash_reserve: 100_000,
    bond_split: 0.6,
  };

  it('β denominator includes bond market value (defensive = cash + bonds)', () => {
    const res = computeRebalance(base);
    expect(res.bond_value).toBe(200_000);
    expect(res.defensive_value).toBe(350_000);
    expect(res.total_value).toBe(1_000_000);
    expect(res.defensive_weight).toBeCloseTo(0.35, 6);
    expect(res.current_beta).toBeCloseTo(1.3, 6);
    expect(res.status).toBe('normal');
  });

  it('defensive targets: fixed cash reserve + 6:4 bond pool with trade shares', () => {
    const res = computeRebalance(base);
    expect(res.target_defensive_value).toBeCloseTo(350_000, 6);
    expect(res.target_cash_value).toBeCloseTo(100_000, 6); // min(100,000, 350,000)
    expect(res.cash_adjust_delta).toBeCloseTo(-50_000, 6); // 現金 150,000 → 100,000
    const [b687, b953] = res.bond_plans;
    expect(b687.code).toBe('00687B');
    expect(b687.target_value).toBeCloseTo(150_000, 6); // 250,000 × 0.6
    expect(b687.value_delta).toBeCloseTo(10_000, 6);
    expect(b687.trade_shares).toBe(Math.round(10_000 / 28)); // 357
    expect(b953.target_value).toBeCloseTo(100_000, 6); // 250,000 × 0.4
    expect(b953.value_delta).toBeCloseTo(40_000, 6);
    expect(b953.trade_shares).toBe(4000);
  });

  it('post-trade cash reflects bond legs; post_beta returns to target', () => {
    const res = computeRebalance(base);
    expect(res.trade_shares).toBe(0); // 00631L 已達標
    // post_cash = 150,000 − 0 − (357×28 ＋ 4000×10) = 150,000 − 49,996 = 100,004
    expect(res.post_cash).toBeCloseTo(100_004, 6);
    expect(res.post_beta).toBeCloseTo(1.3, 3);
  });

  it('cash_reserve clamps to target defensive when defensive side is small', () => {
    // 目標 β 1.9 → 目標防守端僅 5%＝50,000 < 保留額 100,000 → 全給現金、債券池 0
    const res = computeRebalance({ ...base, target_beta: 1.9 });
    expect(res.target_defensive_value).toBeCloseTo(50_000, 6);
    expect(res.target_cash_value).toBeCloseTo(50_000, 6);
    for (const p of res.bond_plans) {
      expect(p.target_value).toBeCloseTo(0, 6);
      expect(p.value_delta).toBeCloseTo(-p.value, 6); // 應全數賣出
    }
  });

  it('bond with price 0 cannot compute trade shares but keeps value at 0', () => {
    const res = computeRebalance({
      ...base,
      bonds: [
        { code: '00687B', shares: 5000, price: 0 },
        { code: '00953B', shares: 6000, price: 10 },
      ],
    });
    const [b687] = res.bond_plans;
    expect(b687.value).toBe(0);
    expect(b687.trade_shares).toBeNull();
    expect(b687.post_shares).toBeNull();
    expect(res.bond_value).toBe(60_000);
  });

  it('trigger prices solve against full defensive value (cash + bonds)', () => {
    const res = computeRebalance(base);
    // band [1.2, 1.4]，defensive=350,000 → 與舊「純現金 350,000」數字一致
    expect(res.sell_trigger_price).toBeCloseTo(125.641, 2);
    expect(res.buy_trigger_price).toBeCloseTo(80.769, 2);
  });

  it('custom bond_split changes the pool allocation', () => {
    const res = computeRebalance({ ...base, bond_split: 0.5 });
    const [b687, b953] = res.bond_plans;
    expect(b687.target_value).toBeCloseTo(125_000, 6);
    expect(b953.target_value).toBeCloseTo(125_000, 6);
  });

  it('no bonds → identical to legacy pure-cash model with defaults echoed', () => {
    const res = computeRebalance({
      shares: 6500,
      price: 100,
      cash: 350_000,
      target_beta: 1.3,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
    });
    expect(res.bond_value).toBe(0);
    expect(res.defensive_value).toBe(350_000);
    expect(res.bond_plans).toEqual([]);
    expect(res.cash_reserve).toBe(DEFAULT_CASH_RESERVE);
    expect(res.current_beta).toBeCloseTo(1.3, 6);
    expect(res.status).toBe('normal');
  });

  it('bond unrealized P&L shown when avg_cost provided', () => {
    const res = computeRebalance({
      ...base,
      bonds: [
        { code: '00687B', shares: 5000, price: 28, avg_cost: 30 },
        { code: '00953B', shares: 6000, price: 10, avg_cost: 9.5 },
      ],
    });
    const [b687, b953] = res.bond_plans;
    expect(b687.unrealized_pnl).toBeCloseTo(5000 * (28 - 30), 6);
    expect(b953.unrealized_pnl).toBeCloseTo(6000 * (10 - 9.5), 6);
  });

  // 【增修K】加碼抽錢時優先變現 00687B（美債）＝bond1_first（現為非預設選項，需明確指定）
  it('drawdown financing drains bond1 (00687B) before touching bond2 (bond1_first waterfall)', () => {
    const res = computeRebalance({
      shares: 4000,
      price: 100,
      cash: 430_000,
      target_beta: 1.6,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 2000, price: 40 }, // 80,000
        { code: '00953B', shares: 9000, price: 10 }, // 90,000
      ],
      cash_reserve: 100_000,
      bond_split: 0.6,
      bond_priority: 'bond1_first',
    });
    expect(res.total_value).toBeCloseTo(1_000_000, 6);
    expect(res.status).toBe('buy');
    // 防守端目標 200,000 → 現金保留 100,000、債券池目標 100,000（現有 170,000，需縮 70,000）
    const [b687, b953] = res.bond_plans;
    expect(b687.target_value).toBeCloseTo(10_000, 6); // 80,000 − 70,000，優先賣
    expect(b687.value_delta).toBeCloseTo(-70_000, 6);
    expect(b953.target_value).toBeCloseTo(90_000, 6); // 完全不動
    expect(b953.value_delta).toBeCloseTo(0, 6);
  });

  // 【regime-aware】新預設（regime_aware 且無宏觀資料＝normal）：反過來優先變現 00953B、留美債
  it('drawdown financing drains bond2 (00953B) first under the new regime_aware default (normal regime)', () => {
    const res = computeRebalance({
      shares: 4000,
      price: 100,
      cash: 430_000,
      target_beta: 1.6,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 2000, price: 40 }, // 80,000
        { code: '00953B', shares: 9000, price: 10 }, // 90,000
      ],
      cash_reserve: 100_000,
      bond_split: 0.6,
      // 不指定 bond_priority → 預設 regime_aware；無 macro → normal → 先賣 00953B
    });
    expect(res.status).toBe('buy');
    expect(res.bond_priority).toBe('regime_aware');
    expect(res.bond_regime.regime).toBe('normal');
    expect(res.bond_sell_first).toBe('00953B');
    const [b687, b953] = res.bond_plans;
    expect(b953.target_value).toBeCloseTo(20_000, 6); // 90,000 − 70,000，優先賣
    expect(b953.value_delta).toBeCloseTo(-70_000, 6);
    expect(b687.target_value).toBeCloseTo(80_000, 6); // 美債完全不動
    expect(b687.value_delta).toBeCloseTo(0, 6);
  });

  // 【regime-aware】升息型崩盤（宏觀指標達標）：regime_aware 自動翻回先賣美債，結果同 bond1_first
  it('regime_aware flips to selling treasury first when a macro indicator trips (rate_crash)', () => {
    const res = computeRebalance({
      shares: 4000,
      price: 100,
      cash: 430_000,
      target_beta: 1.6,
      tolerance_mode: 'abs',
      threshold_pct: 10,
      threshold_abs: 0.1,
      etf_beta: 2.0,
      bonds: [
        { code: '00687B', shares: 2000, price: 40 },
        { code: '00953B', shares: 9000, price: 10 },
      ],
      cash_reserve: 100_000,
      bond_split: 0.6,
      macro: {
        // 長天期美債殖利率半年來大漲 2 個百分點 → 超過預設門檻 0.75 → 達標
        treasury_yield: { current: 5.0, reference: 3.0 },
      },
    });
    expect(res.bond_regime.regime).toBe('rate_crash');
    expect(res.bond_regime.tripped_count).toBe(1);
    expect(res.bond_sell_first).toBe('00687B');
    const [b687, b953] = res.bond_plans;
    expect(b687.target_value).toBeCloseTo(10_000, 6); // 美債先變現
    expect(b953.target_value).toBeCloseTo(90_000, 6);
  });
});

// ===== 【regime-aware】computeBondRegime：三宏觀指標 regime 偵測 =====

describe('computeBondRegime (regime-aware)', () => {
  it('no macro data → normal (default to selling 00953B first)', () => {
    const r = computeBondRegime(undefined);
    expect(r.regime).toBe('normal');
    expect(r.available_count).toBe(0);
    expect(r.tripped_count).toBe(0);
  });

  it("'any': a single tripped indicator flips to rate_crash", () => {
    const r = computeBondRegime({ fx: { current: 34, reference: 32 } }); // +6.25% ≥ 5
    expect(r.regime).toBe('rate_crash');
    expect(r.tripped_count).toBe(1);
    expect(r.available_count).toBe(1);
  });

  it('below threshold stays normal', () => {
    const r = computeBondRegime({ fed_rate: { current: 3.8, reference: 3.6 } }); // +0.2 < 1.0
    expect(r.regime).toBe('normal');
    expect(r.signals.find((s) => s.key === 'fed_rate')?.tripped).toBe(false);
  });

  it("'all' requires every available indicator to trip", () => {
    const macro = {
      combination: 'all' as const,
      fed_rate: { current: 5, reference: 3 }, // +2 ≥ 1 trip
      treasury_yield: { current: 5, reference: 4.9 }, // +0.1 < 0.75 no
    };
    expect(computeBondRegime(macro).regime).toBe('normal'); // 只有 1/2 達標
  });

  it("'majority' trips on more than half of available indicators", () => {
    const macro = {
      combination: 'majority' as const,
      fed_rate: { current: 5, reference: 3 }, // trip
      treasury_yield: { current: 5, reference: 4 }, // +1 ≥ 0.75 trip
      fx: { current: 32, reference: 32 }, // 0 no
    };
    const r = computeBondRegime(macro);
    expect(r.tripped_count).toBe(2);
    expect(r.available_count).toBe(3);
    expect(r.regime).toBe('rate_crash'); // 2/3 過半
  });

  it('custom thresholds are respected', () => {
    const macro = {
      thresholds: { fed_rate_rise: 3.0, treasury_yield_rise: 0.75, fx_rise_pct: 5 },
      fed_rate: { current: 5, reference: 3 }, // +2 < 3.0 客製門檻 → 不達標
    };
    expect(computeBondRegime(macro).regime).toBe('normal');
  });
});

// ===== 【增修K】allocateDefensive：優先變現瀑布（縮水）／等比例（擴張）=====

describe('allocateDefensive (增修K)', () => {
  it('shrink: drains index 0 (priority bond) fully before touching index 1', () => {
    const r = allocateDefensive(100_000, [80_000, 90_000], 0, 0.6);
    expect(r.cash).toBe(0);
    expect(r.bond_values[0]).toBeCloseTo(10_000, 6); // 80,000 − 70,000
    expect(r.bond_values[1]).toBeCloseTo(90_000, 6); // 未動用
  });

  it('shrink deep enough to fully drain bond1 spills into bond2', () => {
    const r = allocateDefensive(30_000, [80_000, 90_000], 0, 0.6);
    expect(r.bond_values[0]).toBeCloseTo(0, 6); // 全數賣出
    expect(r.bond_values[1]).toBeCloseTo(30_000, 6); // 90,000 − 60,000
  });

  it('grow: snaps to bondSplit ratio regardless of current split', () => {
    const r = allocateDefensive(200_000, [10_000, 5_000], 0, 0.6);
    expect(r.bond_values[0]).toBeCloseTo(120_000, 6);
    expect(r.bond_values[1]).toBeCloseTo(80_000, 6);
  });

  it('cash reserve floors before the bond pool is computed', () => {
    // target 50,000 < cashReserve 100,000 → 現金吃光全部，債券池目標 0（雙檔清空）
    const r = allocateDefensive(50_000, [10_000, 10_000], 100_000, 0.6);
    expect(r.cash).toBeCloseTo(50_000, 6);
    expect(r.bond_values[0]).toBeCloseTo(0, 6);
    expect(r.bond_values[1]).toBeCloseTo(0, 6);
  });

  it('zero delta is treated as the grow branch (snap to ratio)', () => {
    const r = allocateDefensive(100_000, [60_000, 40_000], 0, 0.6);
    expect(r.bond_values[0]).toBeCloseTo(60_000, 6);
    expect(r.bond_values[1]).toBeCloseTo(40_000, 6);
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

describe('computeMarketStatus', () => {
  it('handles empty series, single element, or all identical prices', () => {
    // Empty series / null inputs
    expect(computeMarketStatus(null as any)).toBeNull();
    expect(computeMarketStatus({ closes: [] } as any)).toBeNull();

    // Single element
    const s1 = computeMarketStatus({ closes: [{ date: '2026-01-01', close: 100 }], tier1_dd: 0.10, tier2_dd: 0.15, tier3_dd: 0.20 });
    expect(s1).not.toBeNull();
    expect(s1!.tier).toBe(0);
    expect(s1!.drawdown).toBe(0);
    expect(s1!.peak_close).toBe(100);

    // All identical prices
    const s2 = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 100 },
        { date: '2026-01-03', close: 100 },
      ],
      tier1_dd: 0.10,
      tier2_dd: 0.15,
      tier3_dd: 0.20
    });
    expect(s2!.tier).toBe(0);
    expect(s2!.drawdown).toBe(0);
    expect(s2!.peak_close).toBe(100);
  });

  it('determines correct tiers for various drawdown percentages', () => {
    const config = {
      tier1_dd: 0.10,
      tier2_dd: 0.15,
      tier3_dd: 0.20,
    };

    // tier 0: drawdown = 5%
    const s0 = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 95 },
      ],
      ...config
    });
    expect(s0!.drawdown).toBeCloseTo(0.05, 6);
    expect(s0!.tier).toBe(0);

    // tier 1: drawdown = 11%
    const s1 = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 89 },
      ],
      ...config
    });
    expect(s1!.drawdown).toBeCloseTo(0.11, 6);
    expect(s1!.tier).toBe(1);

    // tier 2: drawdown = 16%
    const s2 = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 84 },
      ],
      ...config
    });
    expect(s2!.drawdown).toBeCloseTo(0.16, 6);
    expect(s2!.tier).toBe(2);

    // tier 3: drawdown = 22%
    const s3 = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 78 },
      ],
      ...config
    });
    expect(s3!.drawdown).toBeCloseTo(0.22, 6);
    expect(s3!.tier).toBe(3);
  });

  it('ensures peak close is calculated over the entire window, not a rolling window', () => {
    const s = computeMarketStatus({
      closes: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-01-02', close: 80 },
        { date: '2026-01-03', close: 78 },
      ],
      tier1_dd: 0.10,
      tier2_dd: 0.15,
      tier3_dd: 0.20,
    });
    expect(s!.peak_close).toBe(100);
    expect(s!.drawdown).toBeCloseTo(0.22, 6);
    expect(s!.tier).toBe(3);
  });
});
