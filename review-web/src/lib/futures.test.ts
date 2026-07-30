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
