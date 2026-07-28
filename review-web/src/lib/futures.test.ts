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
