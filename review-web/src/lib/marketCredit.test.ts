import { describe, it, expect } from 'vitest';
import type { MarketCreditResp, DefaultDisclosuresResp, MarketCreditRow } from './api';
import {
  buildLeverageSnapshot,
  latestPoint,
  rangeStat,
  historyPosition,
  describePosition,
  describeRank,
  recentPoints,
  summarizeDisclosures,
  disclosuresForCode,
  daysBetween,
  tpeToday,
  fmtYuan,
  shortDate,
} from './marketCredit';
// 2026-09-26 由 gateway /api/market/credit、/api/market/default-disclosures 實際抓下來的回應
import creditFixture from './__fixtures__/market_credit.json';
import disclosuresFixture from './__fixtures__/default_disclosures.json';

const credit = creditFixture as unknown as MarketCreditResp;
const disclosures = disclosuresFixture as unknown as DefaultDisclosuresResp;

const row = (date: string, patch: Partial<MarketCreditRow>): MarketCreditRow => ({
  date,
  keep_rate: null,
  below_130_accounts: null,
  call_amount: null,
  disposal_accounts: null,
  disposal_amount: null,
  credit_turnover: null,
  margin_balance: null,
  margin_shares: null,
  short_shares: null,
  market_value: null,
  ...patch,
});

describe('buildLeverageSnapshot（真實資料 2026-09-24）', () => {
  const snap = buildLeverageSnapshot(credit);

  it('維持率最新值與較前日', () => {
    expect(snap.date).toBe('2026-09-24');
    expect(snap.keepRate?.value).toBe(193.94);
    expect(snap.keepRate?.prevDate).toBe('2026-09-23');
    expect(snap.keepRate?.change).toBeCloseTo(0.09, 6);
  });

  it('維持率區間：8/3 起 39 個交易日', () => {
    expect(snap.keepRange?.since).toBe('2026-08-03');
    expect(snap.keepRange?.n).toBe(39);
    expect(snap.keepRange?.min).toBe(178.76);
    expect(snap.keepRange?.max).toBe(196.28);
    expect(describePosition(snap.keepRange)).toBe('接近區間高點');
  });

  it('處分戶數與低於 130% 戶數的名次', () => {
    expect(snap.disposal?.value).toBe(30);
    expect(snap.disposal?.change).toBe(22);
    expect(snap.disposalAmount).toBe(20787605);
    // 55、52、33 比 30 高，兩個 30 並列取第 4
    expect(snap.disposalRange?.rankHigh).toBe(4);
    expect(describeRank(snap.disposalRange)).toBe('8/3 以來第 4 高');
    expect(snap.below130?.value).toBe(145);
    expect(snap.below130Range?.rankHigh).toBe(7);
  });

  it('上市融資餘額與占市值比', () => {
    expect(snap.marginBalance?.value).toBe(615103402000);
    expect(Math.round((snap.marginBalance?.change ?? 0) / 1e6) / 100).toBe(87.36);
    expect(snap.shortShares?.change).toBe(-11051);
    expect(snap.marginRatio).toBeCloseTo(0.3916, 3);
    // 年度歷史：最高 2002 的 2.42%、最低 2025 的 0.36%；比今天低的只有 2025、2022、2026/08
    expect(snap.history?.max).toEqual({ label: '2002', value: 2.42 });
    expect(snap.history?.min).toEqual({ label: '2025', value: 0.36 });
    expect(snap.history?.lowerYears).toBe(3);
    expect(snap.history?.totalYears).toBe(27);
  });

  it('小圖只取有值的最近 30 日（維持率 8/3 前沒有值）', () => {
    const pts = recentPoints(credit.series, 'keep_rate', 30);
    expect(pts).toHaveLength(30);
    expect(pts[pts.length - 1]).toEqual({ date: '2026-09-24', value: 193.94 });
    expect(recentPoints(credit.series, 'keep_rate', 100)).toHaveLength(39);
  });
});

describe('邊界情況', () => {
  it('空序列不炸', () => {
    const snap = buildLeverageSnapshot({ ...credit, series: [], history: [] });
    expect(snap.keepRate).toBeNull();
    expect(snap.keepRange).toBeNull();
    expect(snap.marginRatio).toBeNull();
    expect(snap.history).toBeNull();
    expect(describePosition(null)).toBe('');
    expect(describeRank(null)).toBe('');
  });

  it('只有一天資料：沒有較前日、不給區間說法', () => {
    const s = [row('2026-09-24', { keep_rate: 190 })];
    expect(latestPoint(s, 'keep_rate')).toEqual({
      date: '2026-09-24', value: 190, prevDate: null, prev: null, change: null,
    });
    const r = rangeStat(s, 'keep_rate');
    expect(r?.position).toBeNull();
    expect(describePosition(r)).toBe('');
  });

  it('中間缺值時，較前日要跳過缺的那天', () => {
    const s = [
      row('2026-09-22', { keep_rate: 190 }),
      row('2026-09-23', {}),
      row('2026-09-24', { keep_rate: 191.5 }),
    ];
    const p = latestPoint(s, 'keep_rate');
    expect(p?.prevDate).toBe('2026-09-22');
    expect(p?.change).toBeCloseTo(1.5, 6);
  });

  it('區間最高最低的說法', () => {
    const mk = (vals: number[]) => vals.map((v, i) => row(`2026-09-${String(10 + i).padStart(2, '0')}`, { disposal_accounts: v }));
    expect(describePosition(rangeStat(mk([1, 2, 3, 4, 9]), 'disposal_accounts'))).toBe('區間最高');
    expect(describeRank(rangeStat(mk([1, 2, 3, 4, 9]), 'disposal_accounts'))).toBe('9/10 以來最高');
    expect(describePosition(rangeStat(mk([5, 2, 3, 4, 1]), 'disposal_accounts'))).toBe('區間最低');
    // 少於 5 天不下評語
    expect(describePosition(rangeStat(mk([1, 9]), 'disposal_accounts'))).toBe('');
  });

  it('今天比歷史任何一年都低時，position 可以小於 0', () => {
    const h = historyPosition(credit.history, 0.3);
    expect(h?.lowerYears).toBe(0);
    expect(h!.position).toBeLessThan(0);
  });
});

describe('個股違約揭露', () => {
  const today = '2026-09-26';
  const map = summarizeDisclosures(disclosures.items, today);

  it('6213 聯茂：9/21 上榜、5 天前、近期', () => {
    const s = map.get('6213');
    expect(s?.latest.date).toBe('2026-09-21');
    expect(s?.latest.amount).toBe(319306000);
    expect(s?.daysAgo).toBe(5);
    expect(s?.recent).toBe(true);
    expect(s?.count).toBe(1);
  });

  it('同一檔多次上榜要合併次數與金額，latest 取最新一筆', () => {
    const items = disclosuresForCode(disclosures.items, '2408');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const s = map.get('2408')!;
    expect(s.count).toBe(items.length);
    expect(s.latest.date).toBe(items[0].date);
    expect(s.totalAmount).toBe(items.reduce((a, b) => a + (b.amount || 0), 0));
  });

  it('超過 90 天不算近期', () => {
    const s = summarizeDisclosures(
      [{ date: '2026-03-05', code: '2337', name: '旺宏', brokers: [], amount: 59023900 }],
      today,
    ).get('2337');
    expect(s?.daysAgo).toBe(205);
    expect(s?.recent).toBe(false);
  });

  it('沒上榜的股票查不到', () => {
    expect(map.get('2330')).toBeUndefined();
    expect(disclosuresForCode(disclosures.items, '2330')).toEqual([]);
  });
});

describe('小工具', () => {
  it('daysBetween 跨月跨年', () => {
    expect(daysBetween('2026-09-21', '2026-09-26')).toBe(5);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('tpeToday 以台北時間換日（UTC 16:00 已是隔天）', () => {
    expect(tpeToday(new Date('2026-09-26T15:59:00Z'))).toBe('2026-09-26');
    expect(tpeToday(new Date('2026-09-26T16:00:00Z'))).toBe('2026-09-27');
  });

  it('金額格式', () => {
    expect(fmtYuan(319306000)).toBe('3.19 億');
    expect(fmtYuan(20787605)).toBe('2,079 萬');
    expect(fmtYuan(null)).toBe('—');
    expect(shortDate('2026-08-03')).toBe('8/3');
  });
});
