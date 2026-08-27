import { describe, it, expect } from 'vitest';
import { buildImportPlan, type ScanTradeRow, type StockScanScreen } from './stockRealizedImport';
import { DEFAULT_FEE_RATES } from './stockRealized';
import { seedStockRealizedConfig } from './stockRealizedStore';

function row(overrides: Partial<ScanTradeRow> = {}): ScanTradeRow {
  return {
    symbol: '2330',
    name: '台積電',
    kind: 'stock',
    side: 'long',
    qty: 1000,
    buy_price: 500,
    sell_price: 550,
    buy_date: '2026-08-01',
    sell_date: '2026-08-10',
    fee: null,
    tax: null,
    net_pnl: 49000,
    ref: 's|2330|2026-08-10|1000|500|550',
    ...overrides,
  };
}

function screen(rows: ScanTradeRow[], totals: { count: number | null; pnl: number | null } = { count: null, pnl: null }): StockScanScreen {
  return { title: '已實現損益查詢', rows, totals, warnings: [] };
}

describe('buildImportPlan', () => {
  it('新掃到的列會被加進 next.trades，並記進 imported_refs', () => {
    const config = seedStockRealizedConfig();
    const plan = buildImportPlan(config, [screen([row()])], DEFAULT_FEE_RATES);
    expect(plan.added_count).toBe(1);
    expect(plan.skipped_count).toBe(0);
    expect(plan.changed).toBe(true);
    expect(plan.next.trades).toHaveLength(1);
    expect(plan.next.trades[0].symbol).toBe('2330');
    expect(plan.next.imported_refs).toContain(row().ref);
  });

  it('同一個 ref 已經匯入過（在 imported_refs 裡）就略過，不重複計帳', () => {
    const config = { ...seedStockRealizedConfig(), imported_refs: [row().ref] };
    const plan = buildImportPlan(config, [screen([row()])], DEFAULT_FEE_RATES);
    expect(plan.added_count).toBe(0);
    expect(plan.skipped_count).toBe(1);
    expect(plan.changed).toBe(false);
    expect(plan.next.trades).toHaveLength(0);
  });

  it('已經存在於 trades 裡的 ref（不靠 imported_refs 帳本）也會被擋下', () => {
    const config = seedStockRealizedConfig();
    config.trades.push({
      id: 'existing', symbol: '2330', name: '台積電', kind: 'stock', side: 'long',
      qty: 1000, buy_price: 500, sell_price: 550, buy_date: '2026-08-01', sell_date: '2026-08-10',
      fee: null, tax: null, ref: row().ref,
    });
    const plan = buildImportPlan(config, [screen([row()])], DEFAULT_FEE_RATES);
    expect(plan.added_count).toBe(0);
    expect(plan.skipped_count).toBe(1);
  });

  it('同一批掃描裡兩張截圖出現同一列（重複截圖）只留一筆', () => {
    const config = seedStockRealizedConfig();
    const plan = buildImportPlan(config, [screen([row()]), screen([row()])], DEFAULT_FEE_RATES);
    expect(plan.added_count).toBe(1);
    expect(plan.skipped_count).toBe(1);
  });

  it('筆數與損益合計會跟截圖對帳，差異在容許範圍內視為 ok', () => {
    const config = seedStockRealizedConfig();
    // 券商畫面通常是「毛損益」口徑，跟本頁淨額（扣費用後）會差一點手續費+稅
    const plan = buildImportPlan(config, [screen([row()], { count: 1, pnl: 49000 })], DEFAULT_FEE_RATES);
    const countCheck = plan.checks.find((c) => c.label === '筆數');
    expect(countCheck?.ok).toBe(true);
    const pnlCheck = plan.checks.find((c) => c.label === '損益合計');
    expect(pnlCheck).toBeDefined();
  });

  it('筆數對不起來時 check.ok 為 false', () => {
    const config = seedStockRealizedConfig();
    const plan = buildImportPlan(config, [screen([row()], { count: 5, pnl: null })], DEFAULT_FEE_RATES);
    const countCheck = plan.checks.find((c) => c.label === '筆數');
    expect(countCheck?.ok).toBe(false);
  });

  it('沒有掃到任何列時 changed 為 false', () => {
    const config = seedStockRealizedConfig();
    const plan = buildImportPlan(config, [screen([])], DEFAULT_FEE_RATES);
    expect(plan.changed).toBe(false);
    expect(plan.ops).toHaveLength(0);
  });
});
