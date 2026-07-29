import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEC,
  tickValue,
  lastTradingDay,
  finalSettlementDay,
  daysBetween,
  positionPnl,
  closedPnl,
  summarizeAccount,
  rolloverAlerts,
  rolloverCost,
  stopLossRisk,
  findPreset,
  indexAtPrice,
  stressTest,
  suggestLots,
  weightedEntry,
  pnlAtPrice,
  targetPlan,
  trailingStopPlan,
  compareSpotVsFutures,
  buildRiskReport,
  SYMBOL_PRESETS,
  type FuturesPosition,
  type FuturesSpec,
} from './futures';

const spec: FuturesSpec = { ...DEFAULT_SPEC };

function pos(over: Partial<FuturesPosition> = {}): FuturesPosition {
  return {
    id: 'p1',
    month: '202608',
    side: 'long',
    lots: 1,
    entry_price: 100,
    entry_date: '2026-07-01',
    ...over,
  };
}

describe('契約規格', () => {
  it('一跳＝0.05 × 1,000 股＝50 元', () => {
    expect(tickValue(spec)).toBeCloseTo(50, 10);
  });
});

describe('lastTradingDay：到期月份的第三個星期三', () => {
  it('2026-08 的第三個星期三是 8/19', () => {
    // 2026-08-01 是星期六 → 第一個星期三 8/5 → 第三個 8/19
    expect(lastTradingDay('202608')).toBe('2026-08-19');
  });

  it('月初就是星期三時，第三個星期三是 15 號', () => {
    // 2026-07-01 是星期三
    expect(lastTradingDay('202607')).toBe('2026-07-15');
  });

  it('月初是星期四時，第一個星期三落在 7 號', () => {
    // 2026-10-01 是星期四 → 第一個星期三 10/7 → 第三個 10/21
    expect(lastTradingDay('202610')).toBe('2026-10-21');
  });

  it('格式不對回 null', () => {
    expect(lastTradingDay('2026-08')).toBeNull();
    expect(lastTradingDay('202613')).toBeNull();
    expect(lastTradingDay('')).toBeNull();
  });
});

describe('finalSettlementDay：最後交易日的次一營業日', () => {
  it('週三的次日是週四', () => {
    expect(finalSettlementDay('202608')).toBe('2026-08-20');
  });
});

describe('daysBetween', () => {
  it('算日曆天差', () => {
    expect(daysBetween('2026-08-01', '2026-08-19')).toBe(18);
    expect(daysBetween('2026-08-19', '2026-08-01')).toBe(-18);
    expect(daysBetween('2026-08-19', '2026-08-19')).toBe(0);
  });
  it('跨月跨年也對', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
  it('格式不對回 null', () => {
    expect(daysBetween('20260801', '2026-08-19')).toBeNull();
  });
});

describe('positionPnl', () => {
  it('多單獲利：一口漲 2 元＝2,000 元毛利，扣來回費用', () => {
    const r = positionPnl(pos(), 102, spec);
    expect(r.contract_value).toBe(102_000);
    expect(r.cost_value).toBe(100_000);
    expect(r.gross_pnl).toBe(2_000);
    expect(r.fees).toBe(60); // 30 元/口 × 來回
    expect(r.tax).toBeCloseTo(4.04, 6); // (100,000+102,000) × 0.00002
    expect(r.net_pnl).toBeCloseTo(1_935.96, 6);
    expect(r.margin_required).toBe(7_900);
    // 報酬率看的是保證金，不是契約總值——這正是期貨與現股的差別
    expect(r.return_on_margin).toBeCloseTo(1_935.96 / 7_900, 10);
  });

  it('空單在下跌時獲利', () => {
    const r = positionPnl(pos({ side: 'short' }), 98, spec);
    expect(r.gross_pnl).toBe(2_000);
    expect(r.net_pnl).toBeCloseTo(2_000 - 60 - (100_000 + 98_000) * 0.00002, 6);
  });

  it('多單損益平衡價：在該價位淨損益歸零', () => {
    const be = positionPnl(pos(), 100, spec).break_even;
    expect(be).toBeGreaterThan(100); // 要漲過費用才算打平
    expect(positionPnl(pos(), be, spec).net_pnl).toBeCloseTo(0, 6);
  });

  it('空單損益平衡價：在該價位淨損益歸零（且低於進場價）', () => {
    const p = pos({ side: 'short' });
    const be = positionPnl(p, 100, spec).break_even;
    expect(be).toBeLessThan(100);
    expect(positionPnl(p, be, spec).net_pnl).toBeCloseTo(0, 6);
  });

  it('多口數等比例放大', () => {
    const one = positionPnl(pos({ lots: 1 }), 102, spec);
    const three = positionPnl(pos({ lots: 3 }), 102, spec);
    expect(three.net_pnl).toBeCloseTo(one.net_pnl * 3, 6);
    expect(three.margin_required).toBe(one.margin_required * 3);
  });

  it('口數 0 / 負值一律當 0，不會生出損益', () => {
    expect(positionPnl(pos({ lots: 0 }), 120, spec).net_pnl).toBe(0);
    expect(positionPnl(pos({ lots: -5 }), 120, spec).gross_pnl).toBe(0);
  });
});

describe('closedPnl', () => {
  it('已平倉多單損益＝價差 × 乘數 − 來回費用', () => {
    const v = closedPnl(
      { id: 'c1', month: '202607', side: 'long', lots: 2, entry_price: 100, exit_price: 103, exit_date: '2026-07-10' },
      spec,
    );
    expect(v).toBeCloseTo(6_000 - 120 - (100 + 103) * 1000 * 2 * 0.00002, 6);
  });
});

describe('summarizeAccount：保證金與風險指標', () => {
  const cash = 50_000;

  it('無部位時風險指標為 null、狀態 flat', () => {
    const s = summarizeAccount([], 102, spec, cash);
    expect(s.total_lots).toBe(0);
    expect(s.risk_indicator).toBeNull();
    expect(s.status).toBe('flat');
    expect(s.equity).toBe(cash);
  });

  it('權益數＝現金＋未實現損益；保證金按總口數算', () => {
    const s = summarizeAccount([pos({ lots: 2 })], 102, spec, cash);
    const pnl = positionPnl(pos({ lots: 2 }), 102, spec).net_pnl;
    expect(s.equity).toBeCloseTo(cash + pnl, 6);
    expect(s.required_initial).toBe(7_900 * 2);
    expect(s.required_maintenance).toBe(6_100 * 2);
    expect(s.risk_indicator).toBeCloseTo((cash + pnl) / (6_100 * 2), 10);
    expect(s.leverage).toBeCloseTo(204_000 / (cash + pnl), 6);
    expect(s.status).toBe('ok');
  });

  it('多空並存：保證金看總口數，價格風險看淨口數', () => {
    const s = summarizeAccount(
      [pos({ id: 'a', lots: 2, side: 'long' }), pos({ id: 'b', lots: 1, side: 'short' })],
      102,
      spec,
      cash,
    );
    expect(s.total_lots).toBe(3);
    expect(s.net_lots).toBe(1);
    expect(s.long_lots).toBe(2);
    expect(s.short_lots).toBe(1);
    expect(s.required_initial).toBe(7_900 * 3);
  });

  it('追繳價：跌到那個價位時，權益數剛好等於維持保證金', () => {
    const positions = [pos({ lots: 2 })];
    const s = summarizeAccount(positions, 102, spec, cash);
    expect(s.margin_call_price).not.toBeNull();
    const at = summarizeAccount(positions, s.margin_call_price as number, spec, cash);
    // 期交稅那項也含價格，一併解進去了，所以這裡對得起來要到小數點下 6 位
    expect(at.equity).toBeCloseTo(at.required_maintenance, 6);
  });

  it('斷頭價：跌到那個價位時，風險指標剛好 25%', () => {
    const positions = [pos({ lots: 2 })];
    const s = summarizeAccount(positions, 102, spec, cash);
    expect(s.liquidation_price).not.toBeNull();
    const at = summarizeAccount(positions, s.liquidation_price as number, spec, cash);
    expect(at.risk_indicator as number).toBeCloseTo(0.25, 8);
  });

  it('多單的追繳價低於現價、斷頭價又更低', () => {
    const s = summarizeAccount([pos({ lots: 2 })], 102, spec, cash);
    expect(s.margin_call_price as number).toBeLessThan(102);
    expect(s.liquidation_price as number).toBeLessThan(s.margin_call_price as number);
  });

  it('空單的追繳價高於現價（漲上去才會被追繳）', () => {
    const s = summarizeAccount([pos({ lots: 2, side: 'short' })], 102, spec, cash);
    expect(s.margin_call_price as number).toBeGreaterThan(102);
    expect(s.liquidation_price as number).toBeGreaterThan(s.margin_call_price as number);
  });

  it('多空完全對沖時沒有追繳價可言（價格不再影響權益數）', () => {
    const s = summarizeAccount(
      [pos({ id: 'a', lots: 1, side: 'long' }), pos({ id: 'b', lots: 1, side: 'short' })],
      102,
      spec,
      cash,
    );
    expect(s.net_lots).toBe(0);
    expect(s.margin_call_price).toBeNull();
    expect(s.liquidation_price).toBeNull();
  });

  it('狀態分級：低於原始保證金→warn、低於維持→call、低於 25%→danger', () => {
    const positions = [pos({ lots: 2 })]; // 原始 15,800 / 維持 12,200
    expect(summarizeAccount(positions, 100, spec, 20_000).status).toBe('ok');
    expect(summarizeAccount(positions, 100, spec, 14_000).status).toBe('warn');
    expect(summarizeAccount(positions, 100, spec, 10_000).status).toBe('call');
    expect(summarizeAccount(positions, 100, spec, 2_000).status).toBe('danger');
  });

  it('已實現損益由平倉紀錄累算，不影響權益數（現金餘額已含）', () => {
    const closed = [
      { id: 'c1', month: '202607', side: 'long' as const, lots: 1, entry_price: 100, exit_price: 105, exit_date: '2026-07-10' },
    ];
    const s = summarizeAccount([pos()], 102, spec, cash, closed);
    expect(s.realized).toBeCloseTo(closedPnl(closed[0], spec), 6);
    expect(s.equity).toBeCloseTo(cash + positionPnl(pos(), 102, spec).net_pnl, 6);
  });
});

describe('rolloverAlerts：轉倉提醒', () => {
  it('離到期還久→不提醒', () => {
    const [a] = rolloverAlerts([pos({ month: '202608' })], spec, '2026-07-01');
    expect(a.last_trading_day).toBe('2026-08-19');
    expect(a.days_left).toBe(49);
    expect(a.due).toBe(false);
    expect(a.level).toBe('none');
  });

  it('預設前 7 天進入提醒區間', () => {
    const [a] = rolloverAlerts([pos({ month: '202608' })], spec, '2026-08-12');
    expect(a.days_left).toBe(7);
    expect(a.due).toBe(true);
    expect(a.level).toBe('soon');
  });

  it('剩 2 天內升級為 urgent', () => {
    const [a] = rolloverAlerts([pos({ month: '202608' })], spec, '2026-08-18');
    expect(a.days_left).toBe(1);
    expect(a.level).toBe('urgent');
  });

  it('過了最後交易日標記 expired', () => {
    const [a] = rolloverAlerts([pos({ month: '202608' })], spec, '2026-08-20');
    expect(a.days_left).toBe(-1);
    expect(a.expired).toBe(true);
    expect(a.level).toBe('expired');
  });

  it('提醒天數可調整（設 14 天＝提前兩週）', () => {
    const wide: FuturesSpec = { ...spec, rollover_days: 14 };
    const [a] = rolloverAlerts([pos({ month: '202608' })], wide, '2026-08-10');
    expect(a.days_left).toBe(9);
    expect(a.due).toBe(true);
  });

  it('同月份多筆部位合併口數，並依月份排序', () => {
    const alerts = rolloverAlerts(
      [
        pos({ id: 'a', month: '202609', lots: 1 }),
        pos({ id: 'b', month: '202608', lots: 2 }),
        pos({ id: 'c', month: '202608', lots: 3 }),
      ],
      spec,
      '2026-07-01',
    );
    expect(alerts.map((a) => a.month)).toEqual(['202608', '202609']);
    expect(alerts[0].lots).toBe(5);
  });

  it('口數 0 的部位不產生提醒', () => {
    expect(rolloverAlerts([pos({ lots: 0 })], spec, '2026-07-01')).toEqual([]);
  });
});

describe('rolloverCost：轉倉成本', () => {
  it('正價差轉倉要多付價差＋兩趟費用', () => {
    const r = rolloverCost(2, 102, 102.5, spec);
    expect(r.spread).toBeCloseTo(0.5, 10);
    expect(r.spread_cost).toBeCloseTo(1_000, 6); // 0.5 × 1,000 × 2
    expect(r.fees).toBe(120);
    expect(r.total).toBeCloseTo(1_000 + 120 + r.tax, 6);
  });

  it('逆價差（遠月較便宜）轉倉反而是收入', () => {
    const r = rolloverCost(1, 102, 101.5, spec);
    expect(r.spread_cost).toBeCloseTo(-500, 6);
  });
});

describe('stopLossRisk：停損風險', () => {
  it('算出最大損失、佔權益數比重與距離幾檔', () => {
    const r = stopLossRisk(pos({ lots: 2 }), 98, spec, 50_000);
    expect(r.loss).toBeLessThan(0);
    expect(r.loss).toBeCloseTo(-4_000 - 120 - (100 + 98) * 1000 * 2 * 0.00002, 6);
    expect(r.ticks).toBe(40); // 2 元 ÷ 0.05
    expect(r.pct_of_equity as number).toBeCloseTo(r.loss / 50_000, 10);
  });
});

// ── 由 0050.html v4.1 併入的試算功能 ────────────────────────────────────────

describe('SYMBOL_PRESETS：商品切換', () => {
  it('每個預設的維持保證金都小於原始保證金', () => {
    for (const p of SYMBOL_PRESETS) {
      expect(p.spec.maintenance_margin).toBeLessThan(p.spec.initial_margin);
      expect(p.spec.contract_size).toBeGreaterThan(0);
    }
  });

  it('findPreset 大小寫不敏感，找不到回 null', () => {
    expect(findPreset('srf')?.code).toBe('SRF');
    expect(findPreset(' mtx ')?.code).toBe('MTX');
    expect(findPreset('XXX')).toBeNull();
  });

  it('指數類商品標記 index_linked，contract_size 是「元/點」', () => {
    expect(findPreset('MTX')?.index_linked).toBe(true);
    expect(findPreset('MTX')?.spec.contract_size).toBe(50);
    expect(findPreset('SRF')?.index_linked).toBe(false);
  });
});

describe('indexAtPrice：價格 ↔ 加權指數', () => {
  it('beta＝1 時價格跌 10%，指數也跌 10%', () => {
    expect(indexAtPrice(90, 100, 40_000, 1)).toBeCloseTo(36_000, 6);
  });

  it('beta＝2 時價格跌 10% 只對應指數跌 5%', () => {
    expect(indexAtPrice(90, 100, 40_000, 2)).toBeCloseTo(38_000, 6);
  });

  it('沒有參考價、參考指數或 beta 時回 null（不硬掰）', () => {
    expect(indexAtPrice(90, 0, 40_000, 1)).toBeNull();
    expect(indexAtPrice(90, 100, 0, 1)).toBeNull();
    expect(indexAtPrice(90, 100, 40_000, 0)).toBeNull();
  });
});

describe('stressTest：壓力測試', () => {
  const positions = [pos({ lots: 5, entry_price: 100 })];

  it('情境結果與 summarizeAccount 在同一價位完全一致', () => {
    const rows = stressTest(positions, spec, 60_000, 100, { drops: [0.1] });
    const direct = summarizeAccount(positions, 90, spec, 60_000);
    expect(rows[0].price_after).toBeCloseTo(90, 10);
    expect(rows[0].equity).toBeCloseTo(direct.equity, 10);
    expect(rows[0].risk_indicator as number).toBeCloseTo(direct.risk_indicator as number, 10);
    expect(rows[0].status).toBe(direct.status);
  });

  it('beta 放大標的跌幅，指數跌幅維持情境本身', () => {
    const rows = stressTest(positions, spec, 60_000, 100, { drops: [0.1], index: 40_000, beta: 1.2 });
    expect(rows[0].price_after).toBeCloseTo(88, 10);      // 100 × (1 − 1.2×0.1)
    expect(rows[0].index_after as number).toBeCloseTo(36_000, 6); // 指數仍是 −10%
  });

  it('沒填參考指數時 index_after 為 null', () => {
    expect(stressTest(positions, spec, 60_000, 100, { drops: [0.05] })[0].index_after).toBeNull();
  });

  it('跌幅由小到大排序，淨多單的權益數必然遞減', () => {
    const rows = stressTest(positions, spec, 60_000, 100, { drops: [0.2, 0.05, 0.1] });
    expect(rows.map((r) => r.drop)).toEqual([0.05, 0.1, 0.2]);
    expect(rows[0].equity).toBeGreaterThan(rows[1].equity);
    expect(rows[1].equity).toBeGreaterThan(rows[2].equity);
  });

  it('跌夠深就會從 ok 走到 call / danger', () => {
    // 5 口需要原始 39,500／維持 30,500；8 萬現金撐得住 −3%，撐不住 −20%
    const rows = stressTest(positions, spec, 80_000, 100, { drops: [0.03, 0.1, 0.2] });
    expect(rows[0].status).toBe('ok');
    expect(['call', 'danger']).toContain(rows[2].status);
  });
});

describe('suggestLots：槓桿 → 口數', () => {
  it('3 倍槓桿、50 萬本金、價 100 → 15 口（名目 150 萬）', () => {
    const r = suggestLots(500_000, 100, 3, spec);
    expect(r.by_leverage).toBe(15);
    expect(r.lots).toBe(15);
    expect(r.notional).toBeCloseTo(1_500_000, 6);
    expect(r.leverage).toBeCloseTo(3, 6);
    expect(r.capped).toBe(false);
  });

  it('槓桿目標超過保證金押得起的量時下修並標記 capped', () => {
    // 每口名目只有 1 萬（價 10），10 倍要 100 口，但 10 萬本金只押得起 12 口
    const r = suggestLots(100_000, 10, 10, spec);
    expect(r.by_leverage).toBe(100);
    expect(r.max_by_margin).toBe(Math.floor(100_000 / spec.initial_margin));
    expect(r.lots).toBe(r.max_by_margin);
    expect(r.capped).toBe(true);
  });

  it('本金或價格為 0 時回 0 口而不是 NaN', () => {
    expect(suggestLots(0, 100, 3, spec).lots).toBe(0);
    expect(suggestLots(500_000, 0, 3, spec).lots).toBe(0);
    expect(Number.isFinite(suggestLots(0, 0, 3, spec).leverage)).toBe(true);
  });
});

describe('weightedEntry：分批加權均價', () => {
  it('10 口 @93.95 ＋ 6 口 @92 → 16 口、均價 93.22', () => {
    const r = weightedEntry([{ price: 93.95, lots: 10 }, { price: 92, lots: 6 }], spec);
    expect(r.lots).toBe(16);
    expect(r.avg_price).toBeCloseTo((93.95 * 10 + 92 * 6) / 16, 10);
    expect(r.notional).toBeCloseTo(r.avg_price * 1000 * 16, 6);
  });

  it('口數或價格為 0 的批次直接忽略，不會把均價拉低', () => {
    const r = weightedEntry([{ price: 100, lots: 2 }, { price: 0, lots: 5 }, { price: 90, lots: 0 }], spec);
    expect(r.lots).toBe(2);
    expect(r.avg_price).toBeCloseTo(100, 10);
  });

  it('全空回 0，不會除以零', () => {
    const r = weightedEntry([], spec);
    expect(r.lots).toBe(0);
    expect(r.avg_price).toBe(0);
  });
});

describe('targetPlan：上漲規劃', () => {
  const positions = [pos({ lots: 5, entry_price: 100 })];

  it('到價淨利＝兩個價位的未實現損益差，且因期交稅略低於毛利', () => {
    const p = targetPlan(positions, spec, 100_000, 100, 0.2);
    expect(p.target_price).toBeCloseTo(120, 10);
    const expected = pnlAtPrice(positions, 120, spec) - pnlAtPrice(positions, 100, spec);
    expect(p.profit).toBeCloseTo(expected, 10);
    expect(p.profit).toBeLessThan(100_000); // 毛利 20 × 1,000 × 5
  });

  it('安全出金＝到價權益數 − 保留倍數的原始保證金，且不為負', () => {
    const p = targetPlan(positions, spec, 100_000, 100, 0.2, 2.5);
    expect(p.reserve).toBeCloseTo(spec.initial_margin * 5 * 2.5, 6);
    expect(p.safe_withdraw).toBeCloseTo(Math.max(0, p.equity_after - p.reserve), 6);
    const tight = targetPlan(positions, spec, 100_000, 100, 0, 10);
    expect(tight.safe_withdraw).toBe(0);
  });

  it('無部位時 ROI 欄位為 null 而不是 NaN', () => {
    const p = targetPlan([], spec, 0, 100, 0.2);
    expect(p.roi_on_margin).toBeNull();
    expect(p.roi_on_equity).toBeNull();
    expect(p.profit).toBe(0);
  });
});

describe('trailingStopPlan：移動停損', () => {
  it('淨多單的停損價在最高價之下', () => {
    const positions = [pos({ lots: 2 })];
    const r = trailingStopPlan(positions, spec, 110, 2);
    expect(r.stop_price).toBeCloseTo(108, 10);
    expect(r.ticks).toBe(40);
    expect(r.locked_pnl).toBeGreaterThan(0); // 108 仍高於進場 100
    expect(r.give_back).toBeCloseTo(Math.abs(pnlAtPrice(positions, 110, spec) - r.locked_pnl), 10);
  });

  it('淨空單的停損價在最低價之上', () => {
    const r = trailingStopPlan([pos({ side: 'short', lots: 2 })], spec, 90, 2);
    expect(r.stop_price).toBeCloseTo(92, 10);
    expect(r.locked_pnl).toBeGreaterThan(0); // 空單 100 → 92 仍是賺
  });
});

describe('compareSpotVsFutures：期貨存股比較', () => {
  const base = {
    notional: 1_500_000,
    lots: 15,
    dividend_yield: 0.035,
    income_tax_rate: 0.12,
    idle_rate: 0.02,
    rollovers_per_year: 11,
    spread_per_rollover: 0.2,
    broker_discount: 0.6,
  };

  it('現貨成本＝來回手續費＋證交稅＋股利稅＋二代健保', () => {
    const r = compareSpotVsFutures(base, spec);
    expect(r.spot.trading_fee).toBeCloseTo(1_500_000 * 0.001425 * 0.6 * 2, 6);
    expect(r.spot.transaction_tax).toBeCloseTo(1_500, 6);
    expect(r.spot.dividend).toBeCloseTo(52_500, 6);
    expect(r.spot.dividend_tax).toBeCloseTo(52_500 * 0.12 - 52_500 * 0.085, 6);
    expect(r.spot.nhi_premium).toBeCloseTo(52_500 * 0.0211, 6);
    expect(r.spot.total_cost).toBeCloseTo(
      r.spot.trading_fee + r.spot.transaction_tax + r.spot.dividend_tax + r.spot.nhi_premium, 6,
    );
  });

  it('低稅率時股利稅被 8.5% 可抵減吃光，不會變負數', () => {
    expect(compareSpotVsFutures({ ...base, income_tax_rate: 0.05 }, spec).spot.dividend_tax).toBe(0);
  });

  it('股利未達 2 萬不課二代健保', () => {
    const r = compareSpotVsFutures({ ...base, notional: 400_000, dividend_yield: 0.03 }, spec);
    expect(r.spot.dividend).toBeCloseTo(12_000, 6);
    expect(r.spot.nhi_premium).toBe(0);
  });

  it('期貨閒置資金＝名目曝險 − 原始保證金', () => {
    const r = compareSpotVsFutures(base, spec);
    expect(r.futures.margin).toBeCloseTo(15 * spec.initial_margin, 6);
    expect(r.futures.idle_cash).toBeCloseTo(1_500_000 - 15 * spec.initial_margin, 6);
    expect(r.futures.interest).toBeCloseTo(r.futures.idle_cash * 0.02, 6);
  });

  it('轉倉次數拉高會把稅負優勢吃光，advantage 轉負', () => {
    const few = compareSpotVsFutures({ ...base, rollovers_per_year: 1 }, spec);
    const many = compareSpotVsFutures({ ...base, rollovers_per_year: 50 }, spec);
    expect(few.advantage).toBeGreaterThan(many.advantage);
    expect(many.advantage).toBeLessThan(0);
  });

  it('advantage ＝ 現貨成本 − 期貨淨成本', () => {
    const r = compareSpotVsFutures(base, spec);
    expect(r.advantage).toBeCloseTo(r.spot.total_cost - r.futures.total_cost, 6);
  });
});

describe('buildRiskReport：文字報告', () => {
  const positions = [pos({ lots: 5, entry_price: 100 })];

  it('含商品、保證金水位、危險價位、壓力測試與轉倉區塊', () => {
    const text = buildRiskReport({
      symbol_name: '小型臺灣50 ETF 期貨（SRF）',
      spec,
      summary: summarizeAccount(positions, 102, spec, 60_000),
      price: 102, cash: 60_000, index: 40_000, beta: 1,
      stress: stressTest(positions, spec, 60_000, 102, { drops: [0.05, 0.2], index: 40_000, beta: 1 }),
      plan: targetPlan(positions, spec, 60_000, 102, 0.2),
      alerts: rolloverAlerts(positions, spec, '2026-08-17'), // 距 8/19 剩 2 天
    });
    expect(text).toContain('小型臺灣50 ETF 期貨（SRF）');
    expect(text).toContain('【保證金水位】');
    expect(text).toContain('【危險價位】');
    expect(text).toContain('【壓力測試】');
    expect(text).toContain('【上漲規劃】');
    expect(text).toContain('【轉倉提醒】');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('多空完全對沖時明講沒有追繳價，不印假數字', () => {
    const hedged = [pos({ id: 'a', lots: 3 }), pos({ id: 'b', side: 'short', lots: 3 })];
    const text = buildRiskReport({
      symbol_name: 'X', spec, summary: summarizeAccount(hedged, 102, spec, 60_000),
      price: 102, cash: 60_000, index: 0, beta: 1, stress: [],
    });
    expect(text).toContain('無追繳／斷頭價');
    expect(text).not.toContain('NaN');
  });

  it('完全沒有部位也不會噴錯或印出 NaN', () => {
    const text = buildRiskReport({
      symbol_name: 'X', spec, summary: summarizeAccount([], 0, spec, 0),
      price: 0, cash: 0, index: 0, beta: 1, stress: [],
    });
    expect(text).not.toContain('NaN');
  });
});
