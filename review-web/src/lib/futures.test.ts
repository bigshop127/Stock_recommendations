import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEC,
  tickValue,
  lastTradingDay,
  finalSettlementDay,
  daysBetween,
  isBusinessDay,
  nextBusinessDay,
  tradingDaysBetween,
  positionPnl,
  closedPnl,
  closeLots,
  summarizeAccount,
  rolloverAlerts,
  rolloverCost,
  stopLossRisk,
  findPreset,
  priceOf,
  shiftPrices,
  scalePrices,
  referenceMonthOf,
  indexAtPrice,
  stressTest,
  suggestLots,
  weightedEntry,
  pnlAtPrice,
  targetPlan,
  trailingStopPlan,
  buildRiskReport,
  SYMBOL_PRESETS,
  equityStats,
  summarizeCashFlows,
  holdingAsBatch,
  flowDelta,
  type FuturesPosition,
  type FuturesSpec,
  type CashFlow,
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

describe('finalSettlementDay：與最後交易日同一天', () => {
  // 這裡原本斷言「次一營業日」（2026-08-20），是錯的。國內股價指數類與股票／ETF
  // 期貨的最後結算價都取**到期日當天**收盤前的平均價，所以最後結算日＝最後交易日；
  // 「次一營業日結算」是國外指數期貨（日經 225、S&P 500）的規則。
  it('週三到期就是週三結算，不會跑到週四', () => {
    expect(finalSettlementDay('202608')).toBe('2026-08-19');
    expect(finalSettlementDay('202608')).toBe(lastTradingDay('202608'));
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

  it('紀錄上有券商實收費用時以它為準，不用 spec 推估', () => {
    const t = {
      id: 'c1', month: '202607', side: 'long' as const, lots: 3,
      entry_price: 103.8, exit_price: 104.15, exit_date: '2026-08-11',
      fee: 240, tax: 12,
    };
    // 券商對帳單上的淨損益就是 798；用 spec 的 30 元/口會算成 857.5
    expect(closedPnl(t, spec)).toBeCloseTo(798, 6);
    expect(closedPnl({ ...t, fee: undefined, tax: undefined }, spec)).toBeCloseTo(857.5, 1);
  });

  it('只認得出手續費、認不出交易稅時，兩個欄位各自獨立退回推估', () => {
    const t = {
      id: 'c1', month: '202607', side: 'long' as const, lots: 3,
      entry_price: 103.8, exit_price: 104.15, exit_date: '2026-08-11',
      fee: 240,
    };
    const estTax = (103.8 + 104.15) * 1000 * 3 * 0.00002;
    expect(closedPnl(t, spec)).toBeCloseTo(1050 - 240 - estTax, 6);
  });
});

describe('closeLots：部分平倉', () => {
  const p = pos({ id: 'p1', month: '202609', side: 'long', lots: 14, entry_price: 104, entry_date: '2026-08-11' });

  it('平一部分：產生平倉紀錄，剩餘部位沿用同一個 id（停損價才不會掉）', () => {
    const res = closeLots(p, 6, 105.55, '2026-08-18');
    expect(res).not.toBeNull();
    expect(res!.closed).toMatchObject({ month: '202609', side: 'long', lots: 6, entry_price: 104, exit_price: 105.55 });
    expect(res!.closed.entry_date).toBe('2026-08-11');
    expect(res!.remaining).toMatchObject({ id: 'p1', lots: 8 });
  });

  it('全平：remaining 為 null', () => {
    expect(closeLots(p, 14, 105, '2026-08-18')!.remaining).toBeNull();
  });

  it('口數超過、口數為 0、價格為 0 一律拒絕（回 null，不會做半套）', () => {
    expect(closeLots(p, 15, 105, '2026-08-18')).toBeNull();
    expect(closeLots(p, 0, 105, '2026-08-18')).toBeNull();
    expect(closeLots(p, 3, 0, '2026-08-18')).toBeNull();
  });

  it('分兩次平掉的損益總和，等於一次平掉', () => {
    const once = closedPnl(closeLots(p, 14, 105.55, '2026-08-18')!.closed, spec);
    const a = closeLots(p, 6, 105.55, '2026-08-18')!;
    const b = closeLots(a.remaining!, 8, 105.55, '2026-08-18')!;
    expect(closedPnl(a.closed, spec) + closedPnl(b.closed, spec)).toBeCloseTo(once, 6);
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

// ── 假日曆 ──────────────────────────────────────────────────────────────────

// 2026 年台股休市日（證交所 OpenAPI 實際回傳值，已濾掉「開始交易日」那種標記列）
const TW_HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-02-12', '2026-02-13', '2026-02-15', '2026-02-16', '2026-02-17',
  '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-27', '2026-02-28',
  '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-06-19', '2026-09-25', '2026-09-28',
  '2026-10-09', '2026-10-10', '2026-10-25', '2026-10-26', '2026-12-25',
]);

describe('isBusinessDay / nextBusinessDay', () => {
  it('週末與休市日都不是營業日', () => {
    expect(isBusinessDay('2026-07-29', TW_HOLIDAYS_2026)).toBe(true);  // 週三
    expect(isBusinessDay('2026-08-01', TW_HOLIDAYS_2026)).toBe(false); // 週六
    expect(isBusinessDay('2026-01-01', TW_HOLIDAYS_2026)).toBe(false); // 元旦
  });

  it('沒有假日曆時只認週末', () => {
    expect(isBusinessDay('2026-01-01')).toBe(true); // 週四，沒日曆就當有開盤
    expect(isBusinessDay('2026-08-01')).toBe(false);
  });

  it('nextBusinessDay 跨過連假', () => {
    // 2/18(三) 起連休到 2/20(五)，21/22 週末 → 下一個營業日是 2/23(一)
    expect(nextBusinessDay('2026-02-18', TW_HOLIDAYS_2026)).toBe('2026-02-23');
    expect(nextBusinessDay('2026-07-29', TW_HOLIDAYS_2026)).toBe('2026-07-29'); // 本身就是營業日
  });
});

describe('lastTradingDay：第三個星期三，遇休市順延', () => {
  it('2026-08 的第三個星期三 8/19 沒撞假日', () => {
    expect(lastTradingDay('202608', TW_HOLIDAYS_2026)).toBe('2026-08-19');
  });

  it('2026-02 的第三個星期三 2/18 在春節休市中 → 順延到 2/23', () => {
    expect(lastTradingDay('202602')).toBe('2026-02-18');                  // 純規則
    expect(lastTradingDay('202602', TW_HOLIDAYS_2026)).toBe('2026-02-23'); // 校正後
  });

  it('是順延不是提前（期交所明文：以其最近之次一營業日為最後交易日）', () => {
    const adjusted = lastTradingDay('202602', TW_HOLIDAYS_2026) as string;
    expect(adjusted > '2026-02-18').toBe(true);
  });

  it('最後結算日就是最後交易日（國內股票/ETF/指數期貨皆同日結算）', () => {
    for (const m of ['202602', '202608', '202612']) {
      expect(finalSettlementDay(m, TW_HOLIDAYS_2026)).toBe(lastTradingDay(m, TW_HOLIDAYS_2026));
    }
  });
});

describe('tradingDaysBetween：剩幾個交易日', () => {
  it('只算營業日，連假不計', () => {
    // 2/13(五)→2/23(一)：中間 2/16~2/20 全休、週末不算 → 只剩 2/23 這一天
    expect(tradingDaysBetween('2026-02-13', '2026-02-23', TW_HOLIDAYS_2026)).toBe(1);
    // 沒有假日曆時只扣週末 → 2/16~2/20 五天 + 2/23 = 6
    expect(tradingDaysBetween('2026-02-13', '2026-02-23')).toBe(6);
  });

  it('同一天為 0，過期為負', () => {
    expect(tradingDaysBetween('2026-07-29', '2026-07-29', TW_HOLIDAYS_2026)).toBe(0);
    expect(tradingDaysBetween('2026-07-29', '2026-07-27', TW_HOLIDAYS_2026)).toBeLessThan(0);
  });
});

describe('rolloverAlerts：用交易日判斷提醒區間', () => {
  const positions = [pos({ month: '202602', lots: 3 })];

  it('連假讓「日曆天還有 10 天」其實只剩 1 個交易日 → 提前亮紅燈', () => {
    const [a] = rolloverAlerts(positions, spec, '2026-02-13', TW_HOLIDAYS_2026);
    expect(a.last_trading_day).toBe('2026-02-23');
    expect(a.days_left).toBe(10);            // 日曆天
    expect(a.trading_days_left).toBe(1);     // 實際只剩一個交易日
    expect(a.level).toBe('urgent');          // 用日曆天會誤判成「還早」
    expect(a.holiday_adjusted).toBe(true);
  });

  it('沒有假日曆時標記 calendar_known=false', () => {
    const [a] = rolloverAlerts(positions, spec, '2026-02-13');
    expect(a.calendar_known).toBe(false);
    expect(a.holiday_adjusted).toBe(false);
  });

  it('過了最後交易日就是 expired', () => {
    const [a] = rolloverAlerts(positions, spec, '2026-03-02', TW_HOLIDAYS_2026);
    expect(a.expired).toBe(true);
    expect(a.level).toBe('expired');
  });
});

// ── 逐月份報價 ──────────────────────────────────────────────────────────────

describe('priceOf / shiftPrices / scalePrices', () => {
  const book = { byMonth: { 202608: 100, 202609: 100.5 }, fallback: 99 };

  it('number 代表所有月份同一個價', () => {
    expect(priceOf(102, '202608')).toBe(102);
    expect(priceOf(102, '任何月份')).toBe(102);
  });

  it('有該月份就用該月份的價，沒有才退回 fallback', () => {
    expect(priceOf(book, '202608')).toBe(100);
    expect(priceOf(book, '202609')).toBe(100.5);
    expect(priceOf(book, '202610')).toBe(99);
  });

  it('平移與縮放都保住月份價差結構', () => {
    const up = shiftPrices(book, 8) as { byMonth: Record<string, number>; fallback: number };
    expect(up.byMonth['202608']).toBeCloseTo(108, 10);
    expect(up.byMonth['202609']).toBeCloseTo(108.5, 10); // 價差 0.5 不變
    const down = scalePrices(book, 0.9) as { byMonth: Record<string, number>; fallback: number };
    expect(down.byMonth['202608']).toBeCloseTo(90, 10);
    expect(down.byMonth['202609']).toBeCloseTo(90.45, 10);
  });

  it('價格不會被壓成負數', () => {
    const crash = shiftPrices(book, -500) as { byMonth: Record<string, number> };
    expect(crash.byMonth['202608']).toBe(0);
  });
});

describe('referenceMonthOf：口數最多的月份', () => {
  it('取口數最多的；平手取近月；沒部位回空字串', () => {
    expect(referenceMonthOf([pos({ id: 'a', month: '202608', lots: 2 }), pos({ id: 'b', month: '202609', lots: 5 })]))
      .toBe('202609');
    expect(referenceMonthOf([pos({ id: 'a', month: '202609', lots: 3 }), pos({ id: 'b', month: '202608', lots: 3 })]))
      .toBe('202608');
    expect(referenceMonthOf([])).toBe('');
  });
});

describe('summarizeAccount：多月份逐一計價', () => {
  const positions = [
    pos({ id: 'a', month: '202608', lots: 5, entry_price: 100 }),
    pos({ id: 'b', month: '202609', lots: 2, entry_price: 100 }),
  ];
  const book = { byMonth: { 202608: 102, 202609: 103 }, fallback: 102 };

  it('各月份用自己的價，不是全部套同一個數字', () => {
    const s = summarizeAccount(positions, book, spec, 100_000);
    // 名目 = 102×1000×5 + 103×1000×2 = 510,000 + 206,000
    expect(s.contract_value).toBeCloseTo(716_000, 6);
    // 若錯誤地全部用 102 會是 714,000
    expect(s.contract_value).not.toBeCloseTo(714_000, 6);
    expect(s.months).toEqual(['202608', '202609']);
    expect(s.reference_month).toBe('202608'); // 5 口 > 2 口
    expect(s.reference_price).toBe(102);
  });

  it('未實現損益等於逐月份加總', () => {
    const s = summarizeAccount(positions, book, spec, 100_000);
    const expected = positionPnl(positions[0], 102, spec).net_pnl + positionPnl(positions[1], 103, spec).net_pnl;
    expect(s.unrealized).toBeCloseTo(expected, 8);
  });

  it('追繳價是「各月份一起平移」的解，套回去確實命中維持保證金', () => {
    const s = summarizeAccount(positions, book, spec, 100_000);
    const shift = s.margin_call_shift as number;
    expect(shift).toBeLessThan(0); // 淨多單要跌才會追繳
    const atCall = summarizeAccount(positions, shiftPrices(book, shift), spec, 100_000);
    expect(atCall.equity).toBeCloseTo(s.required_maintenance, 4);
    expect(s.margin_call_price).toBeCloseTo(102 + shift, 8); // 用參考月份表示
  });

  it('斷頭價同樣命中維持保證金 × 25%', () => {
    const s = summarizeAccount(positions, book, spec, 100_000);
    const atCut = summarizeAccount(positions, shiftPrices(book, s.liquidation_shift as number), spec, 100_000);
    expect(atCut.equity).toBeCloseTo(s.required_maintenance * spec.liquidation_ratio, 4);
  });

  it('單一月份時與舊版的解析解完全相同（回歸保護）', () => {
    const single = [pos({ lots: 5, entry_price: 100 })];
    const s = summarizeAccount(single, 102, spec, 60_000);
    // 舊版公式：P·unit·(net−taxRate·total) = 門檻 − cash + unit·signedEntry + fees + taxRate·unit·grossEntry
    const unit = spec.contract_size;
    const taxRate = spec.tax_rate;
    const fees = spec.fee_per_lot * 5 * 2;
    const denom = unit * (5 - taxRate * 5);
    const numer = s.required_maintenance - 60_000 + unit * (5 * 100) + fees + taxRate * unit * (5 * 100);
    expect(s.margin_call_price as number).toBeCloseTo(numer / denom, 6);
  });

  it('多空完全對沖時沒有追繳價（平移也救不了）', () => {
    const hedged = [pos({ id: 'a', lots: 3 }), pos({ id: 'b', side: 'short', lots: 3 })];
    const s = summarizeAccount(hedged, book, spec, 60_000);
    expect(s.margin_call_shift).toBeNull();
    expect(s.margin_call_price).toBeNull();
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

  it('負的 drop ＝上漲情境，淨多單權益數上升', () => {
    const rows = stressTest(positions, spec, 80_000, 100, { drops: [-0.1, 0.1] });
    expect(rows[0].drop).toBe(-0.1);      // 排序後上漲在前
    expect(rows[0].price_after).toBeCloseTo(110, 10);
    expect(rows[0].equity).toBeGreaterThan(rows[1].equity);
  });

  it('多月份時各月份按比例一起動，價差結構不變', () => {
    const multi = [
      pos({ id: 'a', month: '202608', lots: 5, entry_price: 100 }),
      pos({ id: 'b', month: '202609', lots: 2, entry_price: 100 }),
    ];
    const book = { byMonth: { 202608: 100, 202609: 101 }, fallback: 100 };
    const rows = stressTest(multi, spec, 100_000, book, { drops: [0.1] });
    expect(rows[0].price_after).toBeCloseTo(90, 10); // 參考月 08
    const direct = summarizeAccount(multi, { byMonth: { 202608: 90, 202609: 90.9 }, fallback: 90 }, spec, 100_000);
    expect(rows[0].equity).toBeCloseTo(direct.equity, 8);
  });
});

describe('stressTest：停損模擬', () => {
  const positions = [pos({ id: 'p1', lots: 5, entry_price: 100 })];

  it('觸價的部位視為出場：保證金釋放、損益進現金、狀態變 flat', () => {
    const rows = stressTest(positions, spec, 80_000, 100, { drops: [0.2], stopLoss: { p1: 96 } });
    const r = rows[0];
    expect(r.stopped_lots).toBe(5);
    // 停損在 96 出場的損益，而不是抱到 80
    expect(r.stop_realized).toBeCloseTo(positionPnl(positions[0], 96, spec).net_pnl, 8);
    expect(r.status).toBe('flat');           // 沒有部位了
    expect(r.risk_indicator).toBeNull();
    expect(r.equity).toBeCloseTo(80_000 + r.stop_realized, 8);
  });

  it('沒觸價就維持原樣（停損價之上不出場）', () => {
    const rows = stressTest(positions, spec, 80_000, 100, { drops: [0.02], stopLoss: { p1: 96 } });
    expect(rows[0].stopped_lots).toBe(0);
    expect(rows[0].status).toBe('ok');
  });

  it('有停損時撐得過原本會斷頭的情境', () => {
    const noStop = stressTest(positions, spec, 45_000, 100, { drops: [0.25] })[0];
    const withStop = stressTest(positions, spec, 45_000, 100, { drops: [0.25], stopLoss: { p1: 96 } })[0];
    expect(noStop.status).toBe('danger');
    expect(withStop.status).toBe('flat');
    expect(withStop.equity).toBeGreaterThan(noStop.equity);
  });

  it('空單的停損方向相反：漲破才出場', () => {
    const shorts = [pos({ id: 'p1', side: 'short', lots: 5, entry_price: 100 })];
    const up = stressTest(shorts, spec, 80_000, 100, { drops: [-0.1], stopLoss: { p1: 104 } })[0];
    const down = stressTest(shorts, spec, 80_000, 100, { drops: [0.1], stopLoss: { p1: 104 } })[0];
    expect(up.stopped_lots).toBe(5);   // 漲到 110 → 破 104 出場
    expect(down.stopped_lots).toBe(0); // 跌到 90 → 空單爽賺，不出場
  });

  it('只有部分部位設停損時，其餘部位繼續承受行情', () => {
    const two = [pos({ id: 'p1', lots: 3, entry_price: 100 }), pos({ id: 'p2', lots: 2, entry_price: 100 })];
    const r = stressTest(two, spec, 80_000, 100, { drops: [0.2], stopLoss: { p1: 96 } })[0];
    expect(r.stopped_lots).toBe(3);
    expect(r.risk_indicator).not.toBeNull(); // p2 還在，還有維持保證金要求
    expect(r.status).not.toBe('flat');
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
    const r = trailingStopPlan(positions, spec, 102, 110, 2);
    expect(r.stop_price).toBeCloseTo(108, 10);
    expect(r.ticks).toBe(40);
    expect(r.locked_pnl).toBeGreaterThan(0); // 108 仍高於進場 100
    expect(r.give_back).toBeCloseTo(Math.abs(pnlAtPrice(positions, 110, spec) - r.locked_pnl), 10);
  });

  it('淨空單的停損價在最低價之上', () => {
    const r = trailingStopPlan([pos({ side: 'short', lots: 2 })], spec, 95, 90, 2);
    expect(r.stop_price).toBeCloseTo(92, 10);
    expect(r.locked_pnl).toBeGreaterThan(0); // 空單 100 → 92 仍是賺
  });

  it('沒填最高價時用參考月份的現價當最高價', () => {
    const r = trailingStopPlan([pos({ lots: 2 })], spec, 106, 0, 2);
    expect(r.peak_price).toBeCloseTo(106, 10);
    expect(r.stop_price).toBeCloseTo(104, 10);
  });

  it('多月份時 peak/stop 視為參考月份的價格，換算成整份報價的平移量', () => {
    // 08 月 5 口（參考月）、09 月 2 口，正價差 0.5
    const positions = [pos({ id: 'a', month: '202608', lots: 5 }), pos({ id: 'b', month: '202609', lots: 2 })];
    const prices = { byMonth: { 202608: 100, 202609: 100.5 }, fallback: 100 };
    const r = trailingStopPlan(positions, spec, prices, 110, 2);
    expect(r.stop_price).toBeCloseTo(108, 10); // 參考月 08 的停損價
    // 平移量 = 108 − 100 = +8 → 09 月變成 108.5
    const expected = pnlAtPrice(positions, { byMonth: { 202608: 108, 202609: 108.5 }, fallback: 108 }, spec);
    expect(r.locked_pnl).toBeCloseTo(expected, 8);
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

describe('equityStats', () => {
  const dummyRow = (date: string, equity: number, risk: number | null = 1.0) => ({
    date,
    equity,
    cash: 100000,
    unrealized: 0,
    contract_value: 1000000,
    net_lots: 1,
    total_lots: 1,
    risk_indicator: risk,
    price: 100,
    status: 'ok',
  });

  it('空陣列 -> first/last 為 null、max_drawdown 為 0、不噴錯', () => {
    const res = equityStats([]);
    expect(res.points).toEqual([]);
    expect(res.first).toBeNull();
    expect(res.last).toBeNull();
    expect(res.total_return).toBeNull();
    expect(res.max_drawdown).toBe(0);
    expect(res.max_drawdown_date).toBe('');
    expect(res.days).toBe(0);
  });

  it('單筆 -> total_return 為 0、max_drawdown 為 0', () => {
    const res = equityStats([dummyRow('2026-07-01', 1000)]);
    expect(res.days).toBe(1);
    expect(res.first?.equity).toBe(1000);
    expect(res.last?.equity).toBe(1000);
    expect(res.total_return).toBe(0);
    expect(res.max_drawdown).toBe(0);
    expect(res.max_drawdown_date).toBe('2026-07-01');
  });

  it('單調上升 -> max_drawdown 為 0', () => {
    const res = equityStats([
      dummyRow('2026-07-01', 1000),
      dummyRow('2026-07-02', 1200),
      dummyRow('2026-07-03', 1500),
    ]);
    expect(res.days).toBe(3);
    expect(res.total_return).toBe(0.5);
    expect(res.max_drawdown).toBe(0);
  });

  it('先漲後跌再漲 -> max_drawdown 抓到的是中間那段而不是最後一天', () => {
    const res = equityStats([
      dummyRow('2026-07-01', 1000),
      dummyRow('2026-07-02', 1200),
      dummyRow('2026-07-03', 900),
      dummyRow('2026-07-04', 1500),
      dummyRow('2026-07-05', 1350),
    ]);
    expect(res.max_drawdown).toBe(-0.25);
    expect(res.max_drawdown_date).toBe('2026-07-03');
  });

  it('權益數變負 -> 不出現 NaN / Infinity', () => {
    const res = equityStats([
      dummyRow('2026-07-01', 1000),
      dummyRow('2026-07-02', -200),
      dummyRow('2026-07-03', -500),
    ]);
    expect(res.max_drawdown).toBe(-1.5);
    expect(res.max_drawdown_date).toBe('2026-07-03');
    expect(Number.isFinite(res.max_drawdown)).toBe(true);
    expect(res.total_return).toBe(-1.5);
  });

  it('first.equity <= 0 -> total_return 為 null', () => {
    const res = equityStats([
      dummyRow('2026-07-01', -100),
      dummyRow('2026-07-02', 200),
    ]);
    expect(res.total_return).toBeNull();
  });

  it('日期亂序輸入 -> 函式內部會排好', () => {
    const res = equityStats([
      dummyRow('2026-07-03', 1500),
      dummyRow('2026-07-01', 1000),
      dummyRow('2026-07-02', 900),
    ]);
    expect(res.points.map(p => p.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(res.first?.date).toBe('2026-07-01');
    expect(res.last?.date).toBe('2026-07-03');
    expect(res.max_drawdown).toBe(-0.1);
    expect(res.max_drawdown_date).toBe('2026-07-02');
  });

  // range 是「近 1 個月／近 3 個月」選單唯一依賴的東西，必須釘住
  const spanRows = [
    dummyRow('2026-05-01', 1000),
    dummyRow('2026-06-01', 2000),
    dummyRow('2026-07-01', 1000),
    dummyRow('2026-08-01', 1500),
  ];

  it('range.from -> 只留起日之後，且高點只從該區間算起', () => {
    const res = equityStats(spanRows, { from: '2026-07-01' });
    expect(res.points.map(p => p.date)).toEqual(['2026-07-01', '2026-08-01']);
    // 6/01 的 2000 落在區間外，所以 7/01 是新高、回撤 0，不是 −50%
    expect(res.points[0].peak).toBe(1000);
    expect(res.max_drawdown).toBe(0);
    expect(res.total_return).toBeCloseTo(0.5, 10);
  });

  it('range.to -> 只留迄日之前（含當日）', () => {
    const res = equityStats(spanRows, { to: '2026-07-01' });
    expect(res.points.map(p => p.date)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(res.last?.date).toBe('2026-07-01');
    expect(res.max_drawdown).toBe(-0.5);
    expect(res.max_drawdown_date).toBe('2026-07-01');
  });

  it('range 起迄同一天 -> 只剩一筆，report 不噴錯', () => {
    const res = equityStats(spanRows, { from: '2026-06-01', to: '2026-06-01' });
    expect(res.days).toBe(1);
    expect(res.total_return).toBe(0);
    expect(res.max_drawdown).toBe(0);
  });

  it('range 完全落在資料之外 -> 視為沒有資料', () => {
    const res = equityStats(spanRows, { from: '2027-01-01' });
    expect(res.days).toBe(0);
    expect(res.first).toBeNull();
    expect(res.total_return).toBeNull();
  });
});

describe('holdingAsBatch：把現有部位壓成分批試算的第 1 筆', () => {
  it('平均成本是口數加權，不是各筆進場價的算術平均', () => {
    const h = holdingAsBatch([
      pos({ id: 'a', lots: 20, entry_price: 104.31 }),
      pos({ id: 'b', lots: 3, entry_price: 104.5 }),
    ]);
    expect(h.lots).toBe(23);
    // 算術平均會是 104.405，差 0.08 元＝23 口約 1,840 元的成本誤差
    expect(h.avg_price).toBeCloseTo((104.31 * 20 + 104.5 * 3) / 23, 10);
    expect(h.avg_price).not.toBeCloseTo(104.405, 3);
    expect(h.mixed).toBe(false);
  });

  it('多空並存 → 數字照給但標 mixed（成本混在一起沒有意義）', () => {
    const h = holdingAsBatch([
      pos({ id: 'a', lots: 2, side: 'long', entry_price: 100 }),
      pos({ id: 'b', lots: 1, side: 'short', entry_price: 106 }),
    ]);
    expect(h.long_lots).toBe(2);
    expect(h.short_lots).toBe(1);
    expect(h.mixed).toBe(true);
    expect(h.lots).toBe(3);
  });

  it('沒有部位／口數或價格為 0 的部位 → 全 0，不會生出 NaN', () => {
    expect(holdingAsBatch([])).toEqual({ lots: 0, avg_price: 0, long_lots: 0, short_lots: 0, mixed: false });
    const h = holdingAsBatch([pos({ lots: 0 }), pos({ id: 'z', entry_price: 0 })]);
    expect(h.lots).toBe(0);
    expect(h.avg_price).toBe(0);
  });

  it('壓成一筆後的名目金額與逐筆加總相同（這格會被拿去跑風險模型）', () => {
    const list = [pos({ id: 'a', lots: 20, entry_price: 104.31 }), pos({ id: 'b', lots: 3, entry_price: 104.5 })];
    const h = holdingAsBatch(list);
    const each = list.reduce((s, x) => s + x.entry_price * x.lots * spec.contract_size, 0);
    expect(h.avg_price * h.lots * spec.contract_size).toBeCloseTo(each, 6);
  });
});

describe('資金進出（入金／出金）', () => {
  const flow = (date: string, type: 'deposit' | 'withdraw', amount: number): CashFlow =>
    ({ id: `${date}_${type}`, date, type, amount });

  it('flowDelta：入金加、出金減，金額一律取絕對值', () => {
    expect(flowDelta(flow('2026-08-13', 'deposit', 100000))).toBe(100000);
    expect(flowDelta(flow('2026-08-13', 'withdraw', 100000))).toBe(-100000);
    // 舊資料把出金存成負數時，仍然是出金，不能翻成入金
    expect(flowDelta({ ...flow('2026-08-13', 'withdraw', 0), amount: -50000 })).toBe(-50000);
  });

  it('summarizeCashFlows：分開累計入出金，net 是淨投入', () => {
    const s = summarizeCashFlows([
      flow('2026-07-01', 'deposit', 500000),
      flow('2026-07-20', 'withdraw', 120000),
      flow('2026-08-13', 'deposit', 80000),
    ]);
    expect(s.deposit).toBe(580000);
    expect(s.withdraw).toBe(120000);
    expect(s.net).toBe(460000);
    expect(s.count).toBe(3);
  });

  it('summarizeCashFlows：range 兩端都含，區間外不計', () => {
    const list = [
      flow('2026-07-01', 'deposit', 100),
      flow('2026-07-02', 'deposit', 200),
      flow('2026-07-03', 'withdraw', 50),
    ];
    expect(summarizeCashFlows(list, { from: '2026-07-02' }).net).toBe(150);
    expect(summarizeCashFlows(list, { to: '2026-07-02' }).net).toBe(300);
    expect(summarizeCashFlows(list, { from: '2026-07-02', to: '2026-07-02' }).net).toBe(200);
  });

  it('summarizeCashFlows：壞日期與 0 金額直接忽略，不會污染統計', () => {
    const s = summarizeCashFlows([
      flow('2026-07-01', 'deposit', 100),
      { id: 'x', date: '2026/07/02', type: 'deposit', amount: 999 } as CashFlow,
      flow('2026-07-03', 'withdraw', 0),
    ]);
    expect(s.net).toBe(100);
    expect(s.count).toBe(1);
    expect(summarizeCashFlows(undefined).count).toBe(0);
  });
});

describe('equityStats × 資金進出', () => {
  const row = (date: string, equity: number) => ({
    date, equity, cash: equity, unrealized: 0, contract_value: 1000000,
    net_lots: 1, total_lots: 1, risk_indicator: 1, price: 100, status: 'ok',
  });
  const flow = (date: string, type: 'deposit' | 'withdraw', amount: number): CashFlow =>
    ({ id: `${date}_${type}`, date, type, amount });

  it('沒有入出金時，扣除版與原始版完全一致（不能因為多傳一個空陣列就變了）', () => {
    const rows = [row('2026-07-01', 1000), row('2026-07-02', 1200), row('2026-07-03', 1500)];
    const res = equityStats(rows, undefined, []);
    expect(res.has_flows).toBe(false);
    expect(res.net_flow).toBe(0);
    expect(res.twr_return).toBeCloseTo(res.total_return!, 10);
    expect(res.max_drawdown_twr).toBe(res.max_drawdown);
    expect(res.pnl_ex_flow).toBe(500);
  });

  it('入金不算獲利：權益數翻倍但實際一毛沒賺 → twr_return 為 0', () => {
    const res = equityStats(
      [row('2026-07-01', 1000), row('2026-07-02', 2000)],
      undefined,
      [flow('2026-07-02', 'deposit', 1000)],
    );
    expect(res.total_return).toBe(1);      // 原始口徑會說「賺一倍」
    expect(res.twr_return).toBeCloseTo(0, 10); // 實際是入金，沒賺
    expect(res.net_flow).toBe(1000);
    expect(res.pnl_ex_flow).toBe(0);
    expect(res.has_flows).toBe(true);
  });

  it('出金不算虧損：領走 800 造成的權益數下滑不該變成 53% 的假回撤', () => {
    const res = equityStats(
      [row('2026-07-01', 1000), row('2026-07-02', 1500), row('2026-07-03', 700)],
      undefined,
      [flow('2026-07-03', 'withdraw', 800)],
    );
    expect(res.max_drawdown).toBeCloseTo(-800 / 1500, 10); // 原始口徑的假回撤
    expect(res.max_drawdown_twr).toBeCloseTo(0, 10);       // 扣掉出金後其實沒回撤
    expect(res.twr_return).toBeCloseTo(0.5, 10);
    expect(res.net_flow).toBe(-800);
    expect(res.pnl_ex_flow).toBe(500);
  });

  it('基準日當天的入金已含在那天的權益數裡，不能再扣一次', () => {
    const res = equityStats(
      [row('2026-07-01', 1000), row('2026-07-02', 1100)],
      undefined,
      [flow('2026-07-01', 'deposit', 900)],
    );
    expect(res.net_flow).toBe(0);
    expect(res.has_flows).toBe(false);
    expect(res.twr_return).toBeCloseTo(0.1, 10);
  });

  it('區間外的入出金不影響區間內的報酬（range 與流水帳要對齊）', () => {
    const rows = [row('2026-06-01', 1000), row('2026-07-01', 1000), row('2026-08-01', 1200)];
    const res = equityStats(rows, { from: '2026-07-01' }, [
      flow('2026-06-15', 'deposit', 5000),  // 起日之前
      flow('2026-09-01', 'withdraw', 5000), // 迄日之後
    ]);
    expect(res.net_flow).toBe(0);
    expect(res.twr_return).toBeCloseTo(0.2, 10);
  });

  it('兩個快照之間的入出金會歸到後面那天（非交易日匯款也抓得到）', () => {
    // 7/03 是週五、7/06 是週一，週六匯的錢要算進 7/06 那一段
    const res = equityStats(
      [row('2026-07-03', 1000), row('2026-07-06', 2000)],
      undefined,
      [flow('2026-07-04', 'deposit', 1000)],
    );
    expect(res.points[1].net_flow).toBe(1000);
    expect(res.twr_return).toBeCloseTo(0, 10);
  });

  it('權益數穿價變負 → 扣除版不噴 NaN／Infinity', () => {
    const res = equityStats(
      [row('2026-07-01', 1000), row('2026-07-02', -200), row('2026-07-03', 300)],
      undefined,
      [flow('2026-07-03', 'deposit', 500)],
    );
    expect(Number.isFinite(res.twr_return!)).toBe(true);
    expect(Number.isFinite(res.max_drawdown_twr)).toBe(true);
    expect(res.points.every((p) => Number.isFinite(p.twr_index))).toBe(true);
  });

  it('單筆快照 → twr_return 為 null（一天算不出期間報酬）', () => {
    const res = equityStats([row('2026-07-01', 1000)], undefined, [flow('2026-07-01', 'deposit', 100)]);
    expect(res.twr_return).toBeNull();
    expect(res.net_flow).toBe(0);
  });
});

// @ts-ignore
import futuresRouter from '../../../routes/futures.js';

describe('期交所 MIS 即時報價解析與轉換測試', () => {
  const {
    getValidQuote, monthToSymbol, symbolToMonth, CONTRACT_TO_MIS,
    liveTimeFromClock, cacheTtlFor,
  } = futuresRouter;

  // 2026-08-05 00:04 實測踩到：23:57 抓的資料在 00:04 被當成收盤資料續發，
  // 同一時間 MIS 上 00:03:45 才剛成交。TTL 必須問「抓的當下市場在不在動」，
  // 不能問「這份資料現在還新不新」——後者是循環，資料會自己老到升級成長 TTL。
  it('cacheTtlFor：TTL 看抓取當下，不看資料現在多舊', () => {
    const LIVE = 20 * 1000;
    const CLOSED = 10 * 60 * 1000;
    const at = Date.parse('2026-08-04T23:57:40+08:00');

    // 抓的當下報價才剛成交 → 盤中，短 TTL；就算之後放了 7 分鐘沒人問也一樣
    expect(cacheTtlFor(at, '2026-08-04T23:57:37+08:00', false)).toBe(LIVE);
    // 抓的當下報價已經是 20 分鐘前的 → 收盤，長 TTL
    expect(cacheTtlFor(at, '2026-08-04T23:37:00+08:00', false)).toBe(CLOSED);
    // MIS 掛掉要快點重試
    expect(cacheTtlFor(at, null, true)).toBe(LIVE);
    // 完全沒有即時價（休市日）→ 長 TTL
    expect(cacheTtlFor(at, null, false)).toBe(CLOSED);
  });

  // 夜盤跨午夜是這支的唯一難點：-M 板已經是新的一天，-F 板還留著昨天下午的成交，
  // 兩者都只給 HHMMSS。日期必須從台北時鐘反推，不能吃 MIS 的 CDate。
  it('liveTimeFromClock：用台北時鐘反推日期，夜盤跨午夜也不會把日期算錯', () => {
    // 台北 2026-08-04 23:41（夜盤，同一天）
    const night = Date.UTC(2026, 7, 4, 15, 41, 0);
    expect(liveTimeFromClock('233628', night)).toBe('2026-08-04T23:36:28+08:00');
    expect(liveTimeFromClock('134458', night)).toBe('2026-08-04T13:44:58+08:00');

    // 台北 2026-08-05 00:30（夜盤已跨過午夜）
    const afterMidnight = Date.UTC(2026, 7, 4, 16, 30, 0);
    expect(liveTimeFromClock('002500', afterMidnight)).toBe('2026-08-05T00:25:00+08:00');
    // -F 板留著的 13:44 看起來「比現在晚」，代表那是昨天的
    expect(liveTimeFromClock('134458', afterMidnight)).toBe('2026-08-04T13:44:58+08:00');

    // 台北 2026-08-05 06:00（夜盤 05:00 收完、日盤還沒開）
    const preOpen = Date.UTC(2026, 7, 4, 22, 0, 0);
    expect(liveTimeFromClock('045959', preOpen)).toBe('2026-08-05T04:59:59+08:00');
    expect(liveTimeFromClock('134458', preOpen)).toBe('2026-08-04T13:44:58+08:00');

    // 月底跨月也要對
    expect(liveTimeFromClock('134458', Date.UTC(2026, 7, 31, 16, 30, 0)))
      .toBe('2026-08-31T13:44:58+08:00');

    expect(liveTimeFromClock('', night)).toBeNull();
    expect(liveTimeFromClock('abcdef', night)).toBeNull();
    expect(liveTimeFromClock(null, night)).toBeNull();
  });

  it('getValidQuote 驗證：無成交量或時間為空時判定為無效', () => {
    const valid = getValidQuote({
      CLastPrice: '100.95',
      CRefPrice: '101.65',
      CTotalVolume: '16356',
      CBestBidPrice: '100.95',
      CBestAskPrice: '101.00',
      CDate: '20260804',
      CTime: '134458',
    });
    expect(valid).not.toBeNull();
    expect(valid?.price).toBe(100.95);
    expect(valid?.volume).toBe(16356);

    const invalid1 = getValidQuote({
      CLastPrice: '0.00',
      CRefPrice: '101.65',
      CTotalVolume: '0',
      CDate: '20260804',
      CTime: '',
    });
    expect(invalid1).toBeNull();

    const invalid2 = getValidQuote({
      CLastPrice: '',
      CRefPrice: '101.65',
      CTotalVolume: '10',
      CDate: '20260804',
      CTime: '134458',
    });
    expect(invalid2).toBeNull();
  });

  it('月碼與 SymbolID 雙向轉換', () => {
    expect(monthToSymbol('SRF', '202608')).toBe('SRFH6');
    expect(monthToSymbol('SRF', '202703')).toBe('SRFC7');

    expect(symbolToMonth('SRFH6')).toBe('202608');
    expect(symbolToMonth('SRFC7')).toBe('202703');
    expect(symbolToMonth('SRFH6-F')).toBe('202608');
    expect(symbolToMonth('SRFH6-M')).toBe('202608');
  });

  it('商品代碼對照與無效代碼退回', () => {
    expect(CONTRACT_TO_MIS['TX']).toBe('TXF');
    expect(CONTRACT_TO_MIS['MTX']).toBe('MXF');
    expect(CONTRACT_TO_MIS['XYZ']).toBeUndefined();

    expect(monthToSymbol('XYZ', '202608')).toBeNull();
  });
});

describe('gateway sanitize：截圖匯入新增的欄位必須在白名單裡', () => {
  const { sanitizeClosed, sanitizePositions, sanitizeRefs } = futuresRouter;

  // opt29 踩過同一個坑：sanitizeFutures 是白名單，漏加欄位會在存雲端時被靜靜吃掉。
  // 這裡掉的是 fee/tax（已實現損益變推估值）與 ref（同一張截圖會被重複匯入）。
  it('平倉紀錄保留 fee / tax / ref / entry_date', () => {
    const out = sanitizeClosed([{
      id: 'c1', month: '202609', side: 'long', lots: 3,
      entry_price: 104.5, exit_price: 105.55, exit_date: '2026-08-18',
      entry_date: '2026-08-11', fee: 240, tax: 12, ref: 'c|2026-08-18|61469|61632|3',
    }]);
    expect(out[0]).toMatchObject({ fee: 240, tax: 12, ref: 'c|2026-08-18|61469|61632|3', entry_date: '2026-08-11' });
  });

  it('費用是負數或不是數字就當作沒有（退回 spec 推估，不會變成負費用）', () => {
    const out = sanitizeClosed([{
      id: 'c1', month: '202609', side: 'long', lots: 1,
      entry_price: 100, exit_price: 101, exit_date: '2026-08-18', fee: -5, tax: 'abc',
    }]);
    expect(out[0].fee).toBeUndefined();
    expect(out[0].tax).toBeUndefined();
  });

  it('部位保留 ref', () => {
    const out = sanitizePositions([{
      id: 'p1', month: '202609', side: 'long', lots: 5, entry_price: 103.5,
      entry_date: '2026-08-19', ref: 'f|2026-08-19 09:12:03|61166',
    }]);
    expect(out[0].ref).toBe('f|2026-08-19 09:12:03|61166');
  });

  it('匯入指紋帳本去重、丟掉空值、只留最近 300 筆', () => {
    expect(sanitizeRefs(['a', 'a', '', 'b'])).toEqual(['a', 'b']);
    expect(sanitizeRefs(Array.from({ length: 350 }, (_, i) => `r${i}`))).toHaveLength(300);
    expect(sanitizeRefs('nope')).toEqual([]);
  });
});

describe('gateway sanitizeCashFlows（伺服端也要擋壞資料，前端不是唯一防線）', () => {
  const { sanitizeCashFlows } = futuresRouter;

  it('保留合法紀錄並依日期排序，金額轉正、方向看 type', () => {
    const out = sanitizeCashFlows([
      { id: 'b', date: '2026-08-13', type: 'withdraw', amount: -50000, note: '領回' },
      { id: 'a', date: '2026-07-01', type: 'deposit', amount: 500000 },
    ]);
    expect(out.map((f: CashFlow) => f.id)).toEqual(['a', 'b']);
    expect(out[1].amount).toBe(50000);
    expect(out[1].type).toBe('withdraw');
    expect(out[1].note).toBe('領回');
  });

  it('沒日期、金額 0、不是物件的一律丟掉；type 亂填視為入金', () => {
    const out = sanitizeCashFlows([
      { date: '', type: 'deposit', amount: 100 },
      { date: '2026-08-13', type: 'deposit', amount: 0 },
      null,
      'nope',
      { date: '2026-08-13', type: '亂填', amount: 100 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('deposit');
    expect(out[0].id).toMatch(/^cf_2026-08-13_deposit_/);
  });

  it('非陣列 → 空陣列（舊檔案沒有這個欄位也不會爆）', () => {
    expect(sanitizeCashFlows(undefined)).toEqual([]);
    expect(sanitizeCashFlows({})).toEqual([]);
  });
});
