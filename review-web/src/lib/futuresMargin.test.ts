/**
 * futuresMargin.test.ts — 遠月加收保證金（2026-11-11 起）。
 *
 * 規則（見 futures.ts「遠月加收保證金」段）：加收是**期貨商**自訂、不是期交所規定；
 * 指數類「最近 3 檔以外」加收 20%（可調）。這些案例釘住的是會讓帳戶「少算保證金」的邊界：
 * 月份順位、最後交易日前後換月、舊資料沒欄位時的預設、前後端白名單。
 */
import { describe, it, expect } from 'vitest';
import {
  findPreset, monthRank, marginPerLot, listedMonths, summarizeAccount, summarizeAccountAll,
  defaultFarMonthRule, positionPnl, farUntil, monthBreakdown, stressTest,
  type FuturesPosition, type FuturesSpec, type ProductPriceSpec,
} from './futures';
import { normalizeFutures } from './futuresStore';
// @ts-expect-error 後端是 CJS、沒有型別宣告
import futuresRouter from '../../../routes/futures.js';

// 2026-11 第三個星期三 ＝ 11/18。11/11 時最近三檔＝202611／202612／202701
const TX: FuturesSpec = {
  ...findPreset('TX')!.spec, initial_margin: 700_000, maintenance_margin: 500_000,
  far_month_surcharge: 0.2, near_months: 3,
};

describe('monthRank：掛牌順位', () => {
  it('最後交易日前：當月是第 1 檔', () => {
    expect(monthRank('202611', '2026-11-11')).toBe(1);
    expect(monthRank('202612', '2026-11-11')).toBe(2);
    expect(monthRank('202701', '2026-11-11')).toBe(3);
    expect(monthRank('202703', '2026-11-11')).toBe(5);
  });
  it('最後交易日當天當月仍是第 1 檔；隔天起算到下個月', () => {
    expect(monthRank('202611', '2026-11-18')).toBe(1);
    expect(monthRank('202611', '2026-11-19')).toBe(0);
    expect(monthRank('202612', '2026-11-19')).toBe(1);
    expect(monthRank('202702', '2026-11-19')).toBe(3);
  });
  it('跨年、壞格式', () => {
    expect(monthRank('202701', '2026-12-30')).toBe(1); // 12/16 已結算 → 1 月是最近月
    expect(monthRank('abc', '2026-11-11')).toBeNull();
    expect(monthRank('202611', 'not-a-date')).toBeNull();
  });
});

describe('marginPerLot：只有第 4 檔以後才加收，原始與維持一起加', () => {
  it('近三檔不加收', () => {
    for (const m of ['202611', '202612', '202701']) {
      const r = marginPerLot(TX, m, '2026-11-11');
      expect(r.far).toBe(false);
      expect(r.initial).toBe(700_000);
      expect(r.maintenance).toBe(500_000);
    }
  });
  it('202703 是遠月：×1.2', () => {
    const r = marginPerLot(TX, '202703', '2026-11-11');
    expect(r.far).toBe(true);
    expect(r.surcharge).toBe(0.2);
    expect(r.initial).toBe(840_000);
    expect(r.maintenance).toBe(600_000);
  });
  it('比例可調：30%', () => {
    expect(marginPerLot({ ...TX, far_month_surcharge: 0.3 }, '202703', '2026-11-11').initial).toBe(910_000);
  });
  it('免加收檔數可調：2 檔時第 3 檔也加收', () => {
    expect(marginPerLot({ ...TX, near_months: 2 }, '202701', '2026-11-11').far).toBe(true);
  });
  it('比例 0、欄位沒填（舊資料）、月份空白（模擬近月）都不加收', () => {
    expect(marginPerLot({ ...TX, far_month_surcharge: 0 }, '202703', '2026-11-11').far).toBe(false);
    const legacy: FuturesSpec = { ...TX }; delete legacy.far_month_surcharge;
    expect(marginPerLot(legacy, '202703', '2026-11-11').initial).toBe(700_000);
    expect(marginPerLot(TX, '', '2026-11-11').far).toBe(false);
  });
  it('已過期月份（順位 ≤ 0）不加收', () => {
    expect(marginPerLot(TX, '202610', '2026-11-11').far).toBe(false);
  });
  it('換月後同一個月份的狀態會變：11/19 起 202702 變近月、202703 仍遠月', () => {
    expect(marginPerLot(TX, '202702', '2026-11-19').far).toBe(false);
    expect(marginPerLot(TX, '202703', '2026-11-19').far).toBe(true);
  });
  it('比例夾在 0～1', () => {
    expect(marginPerLot({ ...TX, far_month_surcharge: 9 }, '202703', '2026-11-11').initial).toBe(1_400_000);
  });
});

describe('listedMonths', () => {
  it('11/11：近三個連續月＋三個季月', () => {
    expect(listedMonths('2026-11-11')).toEqual(['202611', '202612', '202701', '202703', '202706', '202709']);
  });
  it('11/19（當月已結算）', () => {
    expect(listedMonths('2026-11-19')).toEqual(['202612', '202701', '202702', '202703', '202706', '202709']);
  });
});

describe('帳戶彙總：遠月部位佔用較多保證金', () => {
  const pos = (id: string, month: string, lots: number): FuturesPosition => ({
    id, product: 'TX', month, side: 'long', lots, entry_price: 30_000, entry_date: '2026-11-01',
  });
  const price = { byMonth: { '202612': 30_000, '202703': 30_000 }, fallback: 30_000 };

  it('summarizeAccount：近月 1 口＋遠月 1 口＝70 萬＋84 萬', () => {
    const s = summarizeAccount([pos('a', '202612', 1), pos('b', '202703', 1)], price, TX, 5_000_000, [], '2026-11-11');
    expect(s.required_initial).toBe(700_000 + 840_000);
    expect(s.required_maintenance).toBe(500_000 + 600_000);
    expect(s.far_lots).toBe(1);
    expect(s.far_extra_initial).toBe(140_000);
  });

  it('沒有遠月部位：跟舊算式（口數 × 每口）逐位元相同、far_* 為 0', () => {
    const s = summarizeAccount([pos('a', '202612', 3)], price, TX, 5_000_000, [], '2026-11-11');
    expect(s.required_initial).toBe(3 * 700_000);
    expect(s.far_lots).toBe(0);
    expect(s.far_extra_initial).toBe(0);
  });

  it('遠月加收會讓風險指標下降、追繳價上移（不會低估風險）', () => {
    const near = summarizeAccount([pos('a', '202612', 2)], price, TX, 2_000_000, [], '2026-11-11');
    const far = summarizeAccount([pos('a', '202703', 2)], price, TX, 2_000_000, [], '2026-11-11');
    expect(far.risk_indicator!).toBeLessThan(near.risk_indicator!);
    expect(far.margin_call_price!).toBeGreaterThan(near.margin_call_price!);
  });

  it('summarizeAccountAll（多商品）與單商品版一致，by_product 帶 far_lots', () => {
    const products: Record<string, ProductPriceSpec> = { TX: { spec: TX, price, beta: 1 } };
    const list = [pos('a', '202612', 1), pos('b', '202703', 2)];
    const one = summarizeAccount(list, price, TX, 5_000_000, [], '2026-11-11');
    const all = summarizeAccountAll(list, products, 5_000_000, [], '2026-11-11');
    expect(all.required_initial).toBe(one.required_initial);
    expect(all.required_maintenance).toBe(one.required_maintenance);
    expect(all.far_lots).toBe(2);
    expect(all.by_product?.[0].far_lots).toBe(2);
  });

  it('positionPnl.margin_required 逐月份', () => {
    expect(positionPnl(pos('a', '202703', 2), 30_000, TX, '2026-11-11').margin_required).toBe(2 * 840_000);
    expect(positionPnl(pos('a', '202612', 2), 30_000, TX, '2026-11-11').margin_required).toBe(2 * 700_000);
  });
});

describe('預設規則與白名單', () => {
  it('defaultFarMonthRule：大台／小台／微台 20%＋3 檔，其餘不加收', () => {
    expect(defaultFarMonthRule('TX')).toEqual({ far_month_surcharge: 0.2, near_months: 3 });
    expect(defaultFarMonthRule('mtx')).toEqual({ far_month_surcharge: 0.2, near_months: 3 });
    expect(defaultFarMonthRule('TMF')).toEqual({ far_month_surcharge: 0.2, near_months: 3 });
    expect(defaultFarMonthRule('SRF')).toEqual({ far_month_surcharge: 0, near_months: 2 });
    expect(defaultFarMonthRule('UMC')).toEqual({ far_month_surcharge: 0, near_months: 2 });
  });

  it('內建預設商品：指數類帶 20%', () => {
    for (const c of ['TX', 'MTX', 'TMF']) {
      expect(findPreset(c)!.spec.far_month_surcharge).toBe(0.2);
      expect(findPreset(c)!.spec.near_months).toBe(3);
    }
    expect(findPreset('SRF')!.spec.far_month_surcharge).toBe(0);
  });

  const bareSpec = { contract_size: 10, tick_size: 1, initial_margin: 35_050, maintenance_margin: 26_900, fee_per_lot: 30, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25 };

  it('前端 normalizeFutures：舊資料沒欄位 → 微台補 20%／3；使用者調過的值保留；超範圍被夾', () => {
    const cfg = normalizeFutures({ products: { TMF: { spec: bareSpec } }, active_product: 'TMF' });
    expect(cfg.products.TMF.spec.far_month_surcharge).toBe(0.2);
    expect(cfg.products.TMF.spec.near_months).toBe(3);
    const mine = normalizeFutures({ products: { TMF: { spec: { ...bareSpec, far_month_surcharge: 0.3, near_months: 2 } } }, active_product: 'TMF' });
    expect(mine.products.TMF.spec.far_month_surcharge).toBe(0.3);
    expect(mine.products.TMF.spec.near_months).toBe(2);
    const wild = normalizeFutures({ products: { TMF: { spec: { ...bareSpec, far_month_surcharge: 5, near_months: 99 } } }, active_product: 'TMF' });
    expect(wild.products.TMF.spec.far_month_surcharge).toBe(1);
    expect(wild.products.TMF.spec.near_months).toBe(12);
  });

  it('gateway sanitizeFutures 白名單：欄位不會被吃掉，舊資料補預設', () => {
    const { sanitizeFutures } = futuresRouter;
    const kept = sanitizeFutures({ products: { TX: { spec: { ...bareSpec, far_month_surcharge: 0.3, near_months: 3 } } }, active_product: 'TX' });
    expect(kept.products.TX.spec.far_month_surcharge).toBe(0.3);
    const legacy = sanitizeFutures({ products: { TX: { spec: bareSpec }, SRF: { spec: bareSpec } }, active_product: 'TX' });
    expect(legacy.products.TX.spec.far_month_surcharge).toBe(0.2);
    expect(legacy.products.SRF.spec.far_month_surcharge).toBe(0);
    expect(legacy.products.SRF.spec.near_months).toBe(2);
  });
});

describe('壓力測試：各月份明細', () => {
  const pos = (id: string, month: string, lots: number, side: 'long' | 'short' = 'long'): FuturesPosition => ({
    id, product: 'TX', month, side, lots, entry_price: 30_000, entry_date: '2026-11-01',
  });
  const price = { byMonth: { '202612': 30_000, '202703': 30_000 }, fallback: 30_000 };
  const products: Record<string, ProductPriceSpec> = { TX: { spec: TX, price, beta: 1 } };

  it('farUntil：202703 在 12/16 結算後（12/17 起）轉近月；近月回 null', () => {
    expect(farUntil('202703', 3, '2026-11-11')).toBe('2026-12-17');
    expect(farUntil('202612', 3, '2026-11-11')).toBeNull();
  });

  it('monthBreakdown：每月份保證金、遠月多佔、情境損益', () => {
    const rows = monthBreakdown([pos('a', '202612', 1), pos('b', '202703', 2), pos('c', '202703', 1, 'short')], products, 0.1, '2026-11-11');
    expect(rows.map((r) => r.month)).toEqual(['202612', '202703']);
    const [near, far] = rows;
    expect(near.far).toBe(false);
    expect(near.required_initial).toBe(700_000);
    expect(far.far).toBe(true);
    expect(far.lots).toBe(3);
    expect(far.long_lots).toBe(2);
    expect(far.short_lots).toBe(1);
    expect(far.required_initial).toBe(3 * 840_000);
    expect(far.extra_initial).toBe(3 * 140_000);
    expect(far.near_since).toBe('2026-12-17');
    // 大盤跌 10%：多單虧、空單賺，近月多單 1 口虧 30000×0.1×200 = 600,000 ＋費用
    expect(near.unrealized_at_drop).toBeLessThan(-600_000);
    expect(near.unrealized_at_drop).toBeGreaterThan(-601_000);
  });

  it('合計與 summarizeAccountAll 的保證金一致；stressTest 帶 required_initial', () => {
    const list = [pos('a', '202612', 1), pos('b', '202703', 2)];
    const rows = monthBreakdown(list, products, 0, '2026-11-11');
    const all = summarizeAccountAll(list, products, 5_000_000, [], '2026-11-11');
    expect(rows.reduce((a, r) => a + r.required_initial, 0)).toBe(all.required_initial);
    const st = stressTest(list, products, 5_000_000, { drops: [0.1], today: '2026-11-11' });
    expect(st[0].required_initial).toBe(all.required_initial);
  });
});
