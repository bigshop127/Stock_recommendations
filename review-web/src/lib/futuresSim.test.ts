import { describe, expect, it } from 'vitest';
import { findPreset, type FuturesPosition, type ProductPriceSpec } from './futures';
import { lotsToShow, maxAffordableLots, simGrid, simulateLots, type SimInput } from './futuresSim';

const TX = findPreset('TX')!.spec;   // 大台：每點 200、原始 636,000、維持 488,000、手續費 60、期交稅十萬分之二
const NYF = findPreset('NYF')!.spec;

const long = (cash: number, entry = 40000): SimInput => ({ spec: TX, side: 'long', entry, cash });

describe('simulateLots：大台', () => {
  it('1 口 @40,000、現金 200 萬：保證金、費用、權益、風險指標', () => {
    const r = simulateLots(long(2_000_000), 1)!;
    expect(r.notional).toBe(8_000_000);
    expect(r.sim_initial).toBe(636_000);
    expect(r.initial).toBe(636_000);
    expect(r.maintenance).toBe(488_000);
    // 來回手續費 120 ＋ 期交稅 (8,000,000 + 8,000,000) × 0.00002 ＝ 320
    expect(r.costs).toBeCloseTo(440, 6);
    expect(r.equity).toBeCloseTo(2_000_000 - 440, 6);
    expect(r.excess).toBeCloseTo(2_000_000 - 440 - 636_000, 6);
    expect(r.risk).toBeCloseTo((2_000_000 - 440) / 636_000, 6);
    expect(r.status).toBe('ok');
    expect(r.affordable).toBe(true);
  });

  it('追繳價：把價格放到那裡，權益數剛好等於維持保證金（跟壓力測試同一套算式）', () => {
    const inp = long(2_000_000);
    const r = simulateLots(inp, 2)!;
    expect(r.call_move).not.toBeNull();
    expect(r.call_move!).toBeLessThan(0);
    const cell = simGrid(inp, [2], [r.call_move!])[0][0];
    expect(Math.abs(cell.equity - r.maintenance)).toBeLessThan(1);
    expect(cell.price).toBeCloseTo(r.call_price!, 6);
    // 斷頭價：權益剛好等於原始保證金 × 25%
    const cell2 = simGrid(inp, [2], [r.liq_move!])[0][0];
    expect(Math.abs(cell2.equity - r.initial * 0.25)).toBeLessThan(1);
    expect(r.liq_price!).toBeLessThan(r.call_price!);
  });

  it('做空：追繳價在進場價上方', () => {
    const r = simulateLots({ ...long(2_000_000), side: 'short' }, 1)!;
    expect(r.call_move!).toBeGreaterThan(0);
    expect(r.call_price!).toBeGreaterThan(40000);
    expect(r.liq_price!).toBeGreaterThan(r.call_price!);
  });

  it('口數越多，追繳價離進場價越近、保證金越高', () => {
    const inp = long(2_000_000);
    const rows = [1, 2, 3].map((n) => simulateLots(inp, n)!);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].initial).toBeGreaterThan(rows[i - 1].initial);
      expect(Math.abs(rows[i].call_move!)).toBeLessThan(Math.abs(rows[i - 1].call_move!));
    }
  });

  it('資金不夠開的口數：affordable=false；maxAffordableLots 找到上限', () => {
    const inp = long(2_000_000);
    expect(simulateLots(inp, 3)!.affordable).toBe(true);   // 3 × 636,000 = 1,908,000
    expect(simulateLots(inp, 4)!.affordable).toBe(false);  // 2,544,000
    expect(maxAffordableLots(inp)).toBe(3);
    expect(maxAffordableLots(long(100_000))).toBe(0);
  });

  it('進場當下就已低於門檻：該方向的追繳／斷頭距離不顯示', () => {
    // 現金 60 萬：低於原始（63.6 萬）但高於維持（48.8 萬）→ warn，追繳距離還有
    const warn = simulateLots(long(600_000), 1)!;
    expect(warn.status).toBe('warn');
    expect(warn.call_move).not.toBeNull();
    // 現金 40 萬：低於維持 → 已追繳，追繳距離不顯示，斷頭距離還在
    const call = simulateLots(long(400_000), 1)!;
    expect(call.status).toBe('call');
    expect(call.call_move).toBeNull();
    expect(call.liq_move).not.toBeNull();
    // 現金 10 萬：風險指標 < 25% → 斷頭，兩個都不顯示
    const danger = simulateLots(long(100_000), 1)!;
    expect(danger.status).toBe('danger');
    expect(danger.call_price).toBeNull();
    expect(danger.liq_price).toBeNull();
  });

  it('疊加真實部位：保證金相加，追繳價改用大盤連動換算到大台價格', () => {
    const positions: FuturesPosition[] = [
      { id: 'a', product: 'NYF', month: '202611', side: 'long', lots: 1, entry_price: 100, entry_date: '2026-11-01' },
    ];
    const products: Record<string, ProductPriceSpec> = { NYF: { spec: NYF, price: 100, beta: 1.05, index_ref: 40000 } };
    const only = simulateLots(long(2_000_000), 1)!;
    const stacked = simulateLots({ ...long(2_000_000), base: { positions, products } }, 1)!;
    expect(stacked.initial).toBe(NYF.initial_margin + 636_000);
    expect(stacked.sim_initial).toBe(636_000);
    expect(stacked.status).toBe('ok');
    // 真實部位也是多單，帳戶總風險比單看大台更近
    expect(stacked.call_move!).toBeGreaterThan(only.call_move!); // 負得比較少＝離進場價比較近
  });

  it('壞輸入回 null', () => {
    expect(simulateLots(long(1e6), 0)).toBeNull();
    expect(simulateLots(long(1e6), -1)).toBeNull();
    expect(simulateLots({ ...long(1e6), entry: NaN }, 1)).toBeNull();
    expect(simulateLots({ ...long(1e6), entry: 0 }, 1)).toBeNull();
  });
});

describe('simGrid：口數 × 漲跌幅', () => {
  it('+5%：1 口賺 (42,000−40,000)×200 扣來回費用；2 口是兩倍毛利', () => {
    const g = simGrid(long(2_000_000), [1, 2], [-0.1, 0.05]);
    expect(g).toHaveLength(2);
    expect(g[0]).toHaveLength(2);
    const up1 = g[0][1];
    expect(up1.price).toBeCloseTo(42000, 6);
    // 毛利 400,000；費用 120 ＋ (8,000,000 + 8,400,000) × 0.00002 ＝ 448
    expect(up1.pnl).toBeCloseTo(400_000 - 448, 4);
    expect(up1.equity).toBeCloseTo(2_000_000 + up1.pnl, 4);
    const up2 = g[1][1];
    expect(up2.pnl).toBeCloseTo(800_000 - (240 + (16_000_000 + 16_800_000) * 0.00002), 4);
  });

  it('空單 −10% 賺錢；多單 −10% 賠錢；賠到追繳線以下時狀態跟著變', () => {
    const l = simGrid(long(900_000), [1], [-0.1])[0][0];
    expect(l.pnl).toBeLessThan(0);
    expect(l.pnl).toBeCloseTo(-800_000 - (120 + (8_000_000 + 7_200_000) * 0.00002), 4);
    expect(l.status === 'call' || l.status === 'danger').toBe(true);
    const s = simGrid({ ...long(900_000), side: 'short' }, [1], [-0.1])[0][0];
    expect(s.pnl).toBeGreaterThan(0);
    expect(s.status).toBe('ok');
  });

  it('beta ≠ 1 時價格仍照傳入的漲跌幅走', () => {
    const g = simGrid({ spec: NYF, side: 'long', entry: 100, cash: 1_000_000, beta: 1.05 }, [1], [0.1])[0][0];
    expect(g.price).toBeCloseTo(110, 6);
    expect(g.pnl).toBeCloseTo(10 * NYF.contract_size - (2 * NYF.fee_per_lot + (100 + 110) * NYF.contract_size * NYF.tax_rate), 4);
  });
});

describe('simGrid：新口數 vs 新＋舊 兩種口徑', () => {
  const positions: FuturesPosition[] = [
    { id: 'a', product: 'NYF', month: '202611', side: 'long', lots: 1, entry_price: 100, entry_date: '2026-11-01' },
  ];
  const products: Record<string, ProductPriceSpec> = { NYF: { spec: NYF, price: 100, beta: 1, index_ref: 40000 } };

  it('沒疊加真實部位：account_pnl ＝ pnl，權益 ＝ 現金 ＋ pnl', () => {
    const c = simGrid(long(2_000_000), [2], [0.05])[0][0];
    expect(c.account_pnl).toBeCloseTo(c.pnl, 4);
    expect(c.equity).toBeCloseTo(2_000_000 + c.pnl, 4);
  });

  it('疊加真實部位：account_pnl ＝ 新口數損益 ＋ 現有部位損益；pnl 仍只看新口數', () => {
    const only = simGrid(long(2_000_000), [2], [0.05])[0][0];
    const both = simGrid({ ...long(2_000_000), base: { positions, products } }, [2], [0.05])[0][0];
    expect(both.pnl).toBeCloseTo(only.pnl, 4);
    // 現有部位：NYF 多 1 口 @100 → 105（beta 1、大盤 +5%），扣來回費用
    const existing = 5 * NYF.contract_size - (2 * NYF.fee_per_lot + (100 + 105) * NYF.contract_size * NYF.tax_rate);
    expect(both.account_pnl).toBeCloseTo(only.pnl + existing, 3);
    expect(both.equity).toBeCloseTo(2_000_000 + both.account_pnl, 3);
  });
});

describe('lotsToShow', () => {
  it('1～10，加上選的口數與資金上限，去重排序', () => {
    expect(lotsToShow(3, 5)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(lotsToShow(12, 31)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 31]);
    expect(lotsToShow(0, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
