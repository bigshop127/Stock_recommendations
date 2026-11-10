import { describe, expect, it } from 'vitest';
import type { InstFlowPayload, InstitutionalTrades } from './api';
import { STOCK_GROUPS } from './stockGroups';
import {
  axisDomain,
  buildCube,
  buildFrames,
  buildUnits,
  conclusionText,
  flowHeadline,
  fmtMd,
  fmtYi,
  foreignVsTrust,
  instStreak,
  keyFlows,
  memberRows,
  pickLinThreshold,
  quadrantCounts,
  quadrantOf,
  quadrantTag,
  sizeRatio,
  streakAt,
  symScale,
  symTicks,
  unitAvgChange,
  upDownCounts,
  weekdayOf,
  FETCH_DAYS,
  type FlowFrame,
  type FlowUnit,
} from './capitalFlow';

// 2330、2303＝晶圓代工；2454＝IC設計·運算與網通（都在「半導體」大類）；8046＝ABF載板（電子零組件）；
// 9999 不在族群表
const CODES = ['2303', '2330', '2454', '8046', '9999'];
const NAMES = ['聯電', '台積電', '聯發科', '南電', '不存在'];

/** 每天每檔的外資買賣超（百萬元）；投信固定 +100、自營商固定 −100（互相抵銷，全體＝外資） */
function payloadOf(foreignByDay: number[][], quoteDays = 2): InstFlowPayload {
  const days = foreignByDay.map((f, di) => {
    const withQuotes = di >= foreignByDay.length - quoteDays;
    return {
      date: `2026-10-${String(di + 1).padStart(2, '0')}`,
      f,
      t: f.map(() => 100),
      d: f.map(() => -100),
      val: f.map((_, i) => (i + 1) * 1000),
      close: withQuotes ? [50, 1000, 1500, 300, 10] : null,
      chg: withQuotes ? [1, 2, -3, null, 9] : null,
    };
  });
  return {
    dates: days.map((d) => d.date),
    codes: CODES,
    names: NAMES,
    days,
    have: days.length,
    want: FETCH_DAYS,
    refreshing: false,
    fetched_at: null,
    source: 'test',
  };
}

/** 12 天：前 5 天台積電每天賣 1,000（百萬）、後 7 天每天買 2,000；聯發科每天賣 300；其他 0 */
const twelveDays = () =>
  payloadOf(Array.from({ length: 12 }, (_, d) => [0, d < 5 ? -1000 : 2000, -300, 0, 5000]));

describe('buildUnits', () => {
  it('族群層級：依族群表分組，表裡沒有的代號不計入', () => {
    const units = buildUnits(CODES, 'group');
    const byName = Object.fromEntries(units.map((u) => [u.name, u]));
    expect(byName['晶圓代工'].members).toEqual([0, 1]);
    expect(byName['晶圓代工'].category).toBe('半導體');
    expect(byName['IC設計·運算與網通'].members).toEqual([2]);
    expect(byName['ABF載板'].members).toEqual([3]);
    expect(units).toHaveLength(3); // 沒有成分股出現的族群不產生泡泡
  });

  it('大類層級：同一大類的族群併成一顆', () => {
    const units = buildUnits(CODES, 'category');
    expect(units.map((u) => [u.name, u.members])).toEqual([
      ['半導體', [0, 1, 2]],
      ['電子零組件', [3]],
    ]);
  });

  it('族群名稱全表不重複（泡泡用名稱當 key）', () => {
    const names = Object.values(STOCK_GROUPS).flatMap((g) => Object.keys(g));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('buildCube / buildFrames', () => {
  const p = twelveDays();
  const units = buildUnits(p.codes, 'group');
  const foundry = units.findIndex((u) => u.name === '晶圓代工');
  const icDesign = units.findIndex((u) => u.name === 'IC設計·運算與網通');

  it('金額換成億、依法人別加總', () => {
    const cube = buildCube(p, units, 'foreign');
    expect(cube.net[0][foundry]).toBe(-10); // −1,000 百萬＝−10 億
    expect(cube.net[11][foundry]).toBe(20);
    expect(cube.turnover[0][foundry]).toBe(30); // 聯電 1,000＋台積電 2,000 百萬
    expect(buildCube(p, units, 'trust').net[0][foundry]).toBe(2); // 兩檔各 +100 百萬
    expect(buildCube(p, units, 'dealer').net[0][foundry]).toBe(-2);
    expect(buildCube(p, units, 'all').net[0][foundry]).toBe(-10); // 投信與自營商相抵
  });

  it('要滿 10 天才有第一個播放日；橫軸＝近 5 日合計、縱軸＝比前 5 日平均每天多買多少', () => {
    const frames = buildFrames(buildCube(p, units, 'foreign'));
    expect(frames.map((f) => f.date)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    const first = frames[0];
    // 第 6–10 天各 +20 億＝+100；第 1–5 天各 −10 億＝−50 → 每天多買 (100 − (−50)) ÷ 5＝30
    expect(first.x[foundry]).toBe(100);
    expect(first.y[foundry]).toBe(30);
    expect(first.today[foundry]).toBe(20);
    expect(first.size[foundry]).toBe(150);
    expect(first.long[foundry]).toBeNull(); // 不滿 20 天
    // 聯發科每天賣 3 億：近 5 日 −15、沒有加速
    expect(first.x[icDesign]).toBe(-15);
    expect(first.y[icDesign]).toBe(0);
    // 最後一天：近 5 日與前 5 日都是全買（第 3–7 天有 3 天賣、2 天買 → −30＋40＝10）
    const last = frames[2];
    expect(last.x[foundry]).toBe(100);
    expect(last.y[foundry]).toBe((100 - 10) / 5);
  });

  it('最多只取最後 maxFrames 天；資料不滿 10 天回空陣列', () => {
    expect(buildFrames(buildCube(p, units, 'all'), 2).map((f) => f.dayIndex)).toEqual([10, 11]);
    const short = payloadOf(Array.from({ length: 9 }, () => [0, 1, 2, 3, 4]));
    expect(buildFrames(buildCube(short, buildUnits(short.codes, 'group'), 'all'))).toEqual([]);
  });

  it('滿 20 天後有近 20 日累計', () => {
    const p30 = payloadOf(Array.from({ length: FETCH_DAYS }, () => [0, 100, 0, 0, 0]));
    const u = buildUnits(p30.codes, 'group');
    const frames = buildFrames(buildCube(p30, u, 'foreign'));
    expect(frames).toHaveLength(10);
    expect(frames[0].dayIndex).toBe(20);
    expect(frames[0].long[u.findIndex((x) => x.name === '晶圓代工')]).toBe(20); // 每天 1 億 × 20
  });
});

describe('象限', () => {
  it('右上加碼、左上收斂、左下減碼、右下降溫；剛好 0 歸買方／加速那一側', () => {
    expect(quadrantOf(5, 1)).toBe('accumulate');
    expect(quadrantOf(-5, 1)).toBe('converge');
    expect(quadrantOf(-5, -1)).toBe('reduce');
    expect(quadrantOf(5, -1)).toBe('cooling');
    expect(quadrantOf(0, 0)).toBe('accumulate');
  });

  it('標籤文字與各象限顆數', () => {
    expect(quadrantTag(5, 1)).toBe('持續加碼・近 5 日買超・還在加快');
    expect(quadrantTag(-5, 1)).toBe('賣壓收斂・近 5 日賣超・賣壓減輕');
    const frame = { x: [1, -1, -1, 1, 2], y: [1, 1, -1, -1, 3] } as FlowFrame;
    expect(quadrantCounts(frame)).toEqual({ accumulate: 2, converge: 1, reduce: 1, cooling: 1 });
  });
});

describe('座標刻度', () => {
  it('symScale：正負對稱、單調、兩端是 ±1、超出範圍夾住', () => {
    const s = symScale(1000, 1);
    expect(s(0)).toBe(0);
    expect(s(1000)).toBeCloseTo(1);
    expect(s(-1000)).toBeCloseTo(-1);
    expect(s(5000)).toBeCloseTo(1);
    expect(s(-10)).toBeCloseTo(-s(10));
    expect(s(10)).toBeLessThan(s(100));
    // 中間放大：10 億（最大值的 1%）已經畫在三分之一的位置
    expect(s(10)).toBeGreaterThan(0.33);
  });

  it('symTicks：1-2-5 序列、不超過範圍、太密的跳過', () => {
    const s = symScale(1200, 0.2);
    expect(symTicks(s, 0.15)).toEqual([1, 5, 20, 100, 500]);
    const loose = symTicks(s, 0.01);
    expect(loose[0]).toBe(0.02); // 0.01 離原點不到 minGap
    expect(loose[loose.length - 1]).toBe(1000);
    expect(symTicks(s, 0.6)).toEqual([50]);
  });

  it('pickLinThreshold：取第 25 百分位，並夾在 max/20000～max/8', () => {
    expect(pickLinThreshold([1, -2, 3, 4, 0, 0], 100)).toBe(2);
    expect(pickLinThreshold([50, 60, 70, 80], 100)).toBe(12.5); // 上限 max/8
    expect(pickLinThreshold([0.0001, 0.0002, 0.0003, 0.0004, 5, 6, 7, 8], 100)).toBe(0.005); // 下限 max/20000
    expect(pickLinThreshold([], 80)).toBe(10);
  });

  it('axisDomain：整段播放共用一組範圍，留 12% 邊；全 0 也不會除以 0', () => {
    const frames = [
      { x: [10, -200], y: [3, -4] },
      { x: [50, 20], y: [-40, 1] },
    ] as FlowFrame[];
    const d = axisDomain(frames);
    expect(d.xMax).toBeCloseTo(224);
    expect(d.yMax).toBeCloseTo(44.8);
    expect(d.xC).toBeGreaterThan(0);
    const zero = axisDomain([{ x: [0, 0], y: [0, 0] }] as FlowFrame[]);
    expect(zero.xMax).toBe(1);
    expect(Number.isFinite(symScale(zero.xMax, zero.xC)(0))).toBe(true);
  });

  it('sizeRatio：開立方根，0 或負值是 0', () => {
    expect(sizeRatio(1000, 1000)).toBe(1);
    expect(sizeRatio(125, 1000)).toBeCloseTo(0.5);
    expect(sizeRatio(0, 1000)).toBe(0);
    expect(sizeRatio(5, 0)).toBe(0);
  });
});

describe('摘要', () => {
  const units = ['甲', '乙', '丙', '丁'].map((name) => ({ name, category: name, members: [] })) as FlowUnit[];
  //            甲     乙    丙    丁
  const frame = { x: [30, -50, 8, -2], y: [4, -1, 5, 2] } as FlowFrame;

  it('flowHeadline：賣最多的流向買最多的；單邊沒有時是 null', () => {
    expect(flowHeadline(units, frame)).toEqual({
      from: { unit: 1, name: '乙', value: -50 },
      to: { unit: 0, name: '甲', value: 30 },
    });
    expect(flowHeadline(units, { x: [1, 2, 3, 4] } as FlowFrame).from).toBeNull();
  });

  it('keyFlows：流入流出、加速降溫、由賣轉買', () => {
    const k = keyFlows(units, frame, 2);
    expect(k.inflow.map((r) => r.name)).toEqual(['甲', '丙']);
    expect(k.outflow.map((r) => r.name)).toEqual(['乙', '丁']);
    expect(k.speedUp.map((r) => r.name)).toEqual(['丙', '甲']);
    expect(k.slowDown.map((r) => r.name)).toEqual(['乙']);
    // 前 5 日＝x − 5y：甲 10（一直買）、丙 −17（由賣轉買）、乙 −45（一直賣）、丁 −12
    expect(k.turnedBuy.map((r) => r.name)).toEqual(['丙']);
    expect(k.turnedSell).toEqual([]);
  });

  it('foreignVsTrust：同買、同賣、對作；金額太小的不列', () => {
    const r = foreignVsTrust(units, [10, -8, 5, 0.1], [3, -2, -6, 9]);
    expect(r.bothBuy.map((x) => x.name)).toEqual(['甲']);
    expect(r.bothSell.map((x) => x.name)).toEqual(['乙']);
    expect(r.foreignBuyTrustSell.map((x) => x.name)).toEqual(['丙']);
    expect(r.trustBuyForeignSell).toEqual([]); // 丁的外資只有 0.1 億
  });
});

describe('成分股', () => {
  it('streakAt：連買為正、連賣為負、當天沒進出是 0', () => {
    expect(streakAt([-1, 2, 3, 4], 3)).toBe(3);
    expect(streakAt([1, -2, -3], 2)).toBe(-2);
    expect(streakAt([1, 2, 0], 2)).toBe(0);
    expect(streakAt([5, 5, 5], 2)).toBe(3);
    expect(streakAt([5, 0, 5], 2)).toBe(1);
  });

  it('memberRows：依近 5 日買賣超排序，帶當天行情與連買天數', () => {
    const p = twelveDays();
    const units = buildUnits(p.codes, 'group');
    const foundry = units.find((u) => u.name === '晶圓代工')!;
    const rows = memberRows(p, foundry, 'foreign', 11);
    expect(rows.map((r) => r.code)).toEqual(['2330', '2303']);
    expect(rows[0]).toEqual({ code: '2330', name: '台積電', close: 1000, chg: 2, today: 20, sum5: 100, streak: 7 });
    expect(rows[1]).toMatchObject({ today: 0, sum5: 0, streak: 0 });
    // 沒帶行情的那幾天：價格是 null、金額照算
    expect(memberRows(p, foundry, 'foreign', 4)[1]).toMatchObject({ code: '2330', close: null, chg: null, today: -10, sum5: -50, streak: -5 });
  });

  it('unitAvgChange／upDownCounts：成分股簡單平均，沒比價的不算', () => {
    const p = twelveDays();
    const units = buildUnits(p.codes, 'group');
    const avg = unitAvgChange(p, units, 11);
    const byName = Object.fromEntries(units.map((u, i) => [u.name, avg[i]]));
    expect(byName['晶圓代工']).toBe(1.5);
    expect(byName['IC設計·運算與網通']).toBe(-3);
    expect(byName['ABF載板']).toBeNull();
    expect(upDownCounts(avg)).toEqual({ up: 1, down: 1, total: 3 });
    expect(unitAvgChange(p, units, 0)).toEqual([null, null, null]); // 那天沒帶行情
  });
});

describe('盤後結論', () => {
  const row = (foreign: number, investment_trust: number): InstitutionalTrades => ({ foreign, investment_trust, dealer: 0, total: 0 });

  it('instStreak：從最後一天往回數', () => {
    const trend = [row(-1, 5), row(2, 5), row(3, -5), row(4, -5)];
    expect(instStreak(trend, 'foreign')).toEqual({ dir: 'buy', days: 3, capped: false });
    expect(instStreak(trend, 'investment_trust')).toEqual({ dir: 'sell', days: 2, capped: false });
    expect(instStreak([row(1, 1), row(1, 1)], 'foreign')).toEqual({ dir: 'buy', days: 2, capped: true });
    expect(instStreak([], 'foreign').dir).toBe('flat');
  });

  it('conclusionText：組成一句話', () => {
    const streaks = {
      foreign: { dir: 'buy' as const, days: 5, capped: false },
      trust: { dir: 'sell' as const, days: 2, capped: false },
    };
    expect(conclusionText(streaks, { up: 37, down: 50 })).toBe('外資連 5 日買超、投信連 2 日賣超，類股跌多漲少。');
    expect(conclusionText({ foreign: { dir: 'sell', days: 1, capped: false }, trust: { dir: 'buy', days: 20, capped: true } }, { up: 80, down: 40 }))
      .toBe('外資轉為賣超、投信連 20 日以上買超，類股漲多跌少。');
    expect(conclusionText(null, { up: 71, down: 70 })).toBe('類股漲跌互見。');
    expect(conclusionText(null, null)).toBe('');
  });
});

describe('顯示', () => {
  it('fmtYi：10 億以上一位小數、以下兩位，帶正負號與千分位', () => {
    expect(fmtYi(909.74)).toBe('+909.7');
    expect(fmtYi(-1731.62)).toBe('-1,731.6');
    expect(fmtYi(3.456)).toBe('+3.46');
    expect(fmtYi(-0.004)).toBe('0.00');
    expect(fmtYi(12.34, { sign: false })).toBe('12.3');
    expect(fmtYi(null)).toBe('—');
  });

  it('日期', () => {
    expect(fmtMd('2026-11-10')).toBe('11/10');
    expect(weekdayOf('2026-11-10')).toBe('二');
  });
});
