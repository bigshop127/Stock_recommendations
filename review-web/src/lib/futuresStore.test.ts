/**
 * futuresStore.test.ts — 舊格式（8/24 以前）帳戶設定遷移到多商品格式（opt33）。
 *
 * VM 正式站現在存的就是舊格式：整帳戶只有一組 contract/spec/beta/index_ref/prices，
 * 沒有 products 這個 key。遷移邏輯錯了會讓使用者現有的 SRF 部位算出跟遷移前不一樣的
 * 保證金/風險指標——這個檔案就是在部署到 VM 之前先擋住這件事。
 */
import { describe, it, expect } from 'vitest';
import { normalizeFutures } from './futuresStore';
import { summarizeAccount, summarizeAccountAll, type ProductPriceSpec } from './futures';

// 貼近真實 8/21 那筆帳戶設定的形狀（見 memory：14 口 @105.5679、保證金 8700/6700）
const legacy = {
  contract: 'SRF',
  price: 104.7,
  prices: { '202609': 104.7 },
  price_month: '202609',
  price_as_of: '2026-08-21',
  price_source: 'daily',
  cash: 400000,
  index_ref: 24000,
  beta: 1.05,
  spec: {
    contract_size: 1000,
    tick_size: 0.05,
    initial_margin: 8700,
    maintenance_margin: 6700,
    fee_per_lot: 40,
    tax_rate: 0.00002,
    rollover_days: 7,
    liquidation_ratio: 0.25,
  },
  positions: [
    { id: 'p1', month: '202609', side: 'long', lots: 14, entry_price: 105.5679, entry_date: '2026-08-11' },
  ],
  closed: [
    { id: 'c1', month: '202608', side: 'long', lots: 6, entry_price: 103.8, exit_price: 104.15, exit_date: '2026-08-11', fee: 240, tax: 12 },
  ],
  cash_flows: [{ id: 'f1', date: '2026-08-01', type: 'deposit', amount: 100000 }],
  stop_loss: { p1: 100 },
  planner: {
    capital: 0, target_leverage: 1.2, gain_pct: 0.2, reserve_multiple: 2.5,
    trailing_peak: 0, trailing_dist: 2, plan_base_leverage: 1.2, plan_peak: 0,
    batches: [{ price: 0, lots: 0 }, { price: 0, lots: 0 }, { price: 0, lots: 0 }],
    stress_drops: [-0.05, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3],
  },
  imported_refs: ['f|2026-08-19 09:12:03|61166'],
};

describe('normalizeFutures：舊格式遷移成單一商品', () => {
  it('positions/closed/cash/imported_refs 逐項不失真，全部歸到 SRF 這個商品代碼下', () => {
    const cfg = normalizeFutures(legacy as unknown as Record<string, unknown>);
    expect(Object.keys(cfg.products)).toEqual(['SRF']);
    expect(cfg.active_product).toBe('SRF');

    const p = cfg.products.SRF;
    expect(p.spec).toEqual(legacy.spec);
    expect(p.beta).toBeCloseTo(1.05, 10);
    expect(p.index_ref).toBe(24000);
    expect(p.price).toBeCloseTo(104.7, 10);
    expect(p.prices).toEqual({ '202609': 104.7 });
    expect(p.price_month).toBe('202609');
    expect(p.price_as_of).toBe('2026-08-21');

    expect(cfg.cash).toBe(400000);
    expect(cfg.positions).toHaveLength(1);
    expect(cfg.positions[0]).toMatchObject({ product: 'SRF', month: '202609', lots: 14, entry_price: 105.5679 });
    expect(cfg.closed).toHaveLength(1);
    expect(cfg.closed[0]).toMatchObject({ product: 'SRF', fee: 240, tax: 12 });
    expect(cfg.stop_loss).toEqual({ p1: 100 });
    expect(cfg.imported_refs).toEqual(['f|2026-08-19 09:12:03|61166']);
    expect(cfg.planner.SRF.target_leverage).toBeCloseTo(1.2, 10);
  });

  it('遷移後用 summarizeAccountAll 算出的權益數/保證金/風險指標/斷頭價，跟遷移前用 summarizeAccount 算的完全一致', () => {
    const cfg = normalizeFutures(legacy as unknown as Record<string, unknown>);
    const products: Record<string, ProductPriceSpec> = {
      SRF: {
        spec: cfg.products.SRF.spec,
        price: { byMonth: cfg.products.SRF.prices, fallback: cfg.products.SRF.price },
        beta: cfg.products.SRF.beta,
        index_ref: cfg.products.SRF.index_ref,
      },
    };
    const after = summarizeAccountAll(cfg.positions, products, cfg.cash, cfg.closed);
    const before = summarizeAccount(
      cfg.positions,
      { byMonth: legacy.prices, fallback: legacy.price },
      legacy.spec,
      legacy.cash,
      cfg.closed,
    );
    expect(after.equity).toBeCloseTo(before.equity, 6);
    expect(after.risk_indicator as number).toBeCloseTo(before.risk_indicator as number, 6);
    expect(after.required_initial).toBeCloseTo(before.required_initial, 6);
    expect(after.required_maintenance).toBeCloseTo(before.required_maintenance, 6);
    expect(after.margin_call_price as number).toBeCloseTo(before.margin_call_price as number, 4);
    expect(after.liquidation_price as number).toBeCloseTo(before.liquidation_price as number, 4);
    expect(after.status).toBe(before.status);
  });

  it('已經是新格式（有 products）時不會被誤判成舊格式重新包裝一層', () => {
    const cfg1 = normalizeFutures(legacy as unknown as Record<string, unknown>);
    const cfg2 = normalizeFutures(cfg1 as unknown as Record<string, unknown>);
    expect(Object.keys(cfg2.products)).toEqual(['SRF']);
    expect(cfg2.products.SRF.spec).toEqual(cfg1.products.SRF.spec);
    expect(cfg2.positions).toEqual(cfg1.positions);
  });

  it('全新帳戶（沒有任何舊欄位）遷移不會炸掉，回退成一個空的 SRF 商品', () => {
    const cfg = normalizeFutures({});
    expect(Object.keys(cfg.products)).toEqual(['SRF']);
    expect(cfg.active_product).toBe('SRF');
    expect(cfg.positions).toEqual([]);
    expect(cfg.cash).toBe(0);
  });
});
