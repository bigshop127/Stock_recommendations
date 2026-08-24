/**
 * futuresImport.test.ts — 券商截圖匯入的會計正確性（opt30）。
 *
 * 測資直接用 2026-08-19 那三張真實截圖上的數字（未平倉查詢／平倉查詢／成交回報），
 * 因為這個功能最怕的不是「辨識不出來」而是「辨識出來但併帳併錯」——重複計一次
 * 平倉損益，保證金專戶現金餘額就會憑空多出兩萬多塊，而那個數字沒有別的地方可以對。
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SPEC, closedPnl, type ClosedTrade, type FuturesPosition } from './futures';
import {
  buildImportPlan, fillSide, aggregatePositions,
  type ScanScreen, type ScanClosedRow, type ScanFillRow, type ScanOpenRow, type ImportState,
} from './futuresImport';

const spec = { ...DEFAULT_SPEC };
const TODAY = '2026-08-19';

function screen(over: Partial<ScanScreen>): ScanScreen {
  return {
    kind: 'unknown',
    title: '',
    open_rows: [],
    closed_rows: [],
    fill_rows: [],
    totals: { pnl: null, count: null },
    warnings: [],
    ...over,
  };
}

function emptyState(over: Partial<ImportState> = {}): ImportState {
  return { positions: [], closed: [], prices: {}, stop_loss: {}, cash: 0, imported_refs: [], ...over };
}

// ── 真實截圖 ② 平倉查詢：5 列，總損益 22,012 ────────────────────────────────
const CLOSED_ROWS: ScanClosedRow[] = [
  { product: '小型元大台灣50ETF 202608', month: '202608', side: 'long', lots: 3, entry_price: 103.8, entry_date: '2026-08-04', exit_price: 104.15, exit_date: '2026-08-11', pnl: 1050, fee: 240, tax: 12, net_pnl: 798, ref: 'c|2026-08-11|61303|63077|3|103.8|104.15' },
  { product: '小型元大台灣50ETF 202608', month: '202608', side: 'long', lots: 3, entry_price: 100.95, entry_date: '2026-08-04', exit_price: 104.15, exit_date: '2026-08-11', pnl: 9600, fee: 240, tax: 12, net_pnl: 9348, ref: 'c|2026-08-11|61303|62001|3|100.95|104.15' },
  { product: '小型元大台灣50ETF 202609', month: '202609', side: 'long', lots: 2, entry_price: 104.45, entry_date: '2026-08-11', exit_price: 105.55, exit_date: '2026-08-18', pnl: 2200, fee: 160, tax: 8, net_pnl: 2032, ref: 'c|2026-08-18|61469|61632|2|104.45|105.55' },
  { product: '小型元大台灣50ETF 202609', month: '202609', side: 'long', lots: 6, entry_price: 104.31, entry_date: '2026-08-11', exit_price: 105.55, exit_date: '2026-08-18', pnl: 7440, fee: 480, tax: 24, net_pnl: 6936, ref: 'c|2026-08-18|61469|61303|6|104.31|105.55' },
  { product: '小型元大台灣50ETF 202609', month: '202609', side: 'long', lots: 3, entry_price: 104.5, entry_date: '2026-08-11', exit_price: 105.55, exit_date: '2026-08-18', pnl: 3150, fee: 240, tax: 12, net_pnl: 2898, ref: 'c|2026-08-18|61469|61632|3|104.5|105.55' },
];
const CLOSED_SCREEN = screen({ kind: 'closed', title: '期權-平倉查詢', closed_rows: CLOSED_ROWS, totals: { pnl: 22012, count: 5 } });

// ── 真實截圖 ③ 成交回報：今天 09:12 買進 5 口新倉 ───────────────────────────
const FILL: ScanFillRow = {
  product: '小型元大台灣50ETF期 202609', month: '202609', direction: 'buy', action: 'open',
  lots: 5, price: 103.5, date: '2026-08-19', time: '09:12:03', ref: 'f|2026-08-19 09:12:03|61166|buy|open|5|103.5',
};
const FILL_SCREEN = screen({ kind: 'fills', title: '期權-成交回報', fill_rows: [FILL], totals: { pnl: null, count: 1 } });

// ── 真實截圖 ① 未平倉查詢：14 口 @105.5679，市價 103.75 ────────────────────
const OPEN_ROW: ScanOpenRow = {
  product: '小型元大台灣50ETF期202609', month: '202609', side: 'long',
  lots: 14, avg_price: 105.5679, market_price: 103.75, pnl: -25450,
};
const OPEN_SCREEN = screen({ kind: 'open', title: '期權-未平倉查詢', open_rows: [OPEN_ROW], totals: { pnl: -25450, count: 1 } });

describe('fillSide：買賣別 × 倉別 → 這是哪個方向的部位', () => {
  it('新倉買進＝多單、新倉賣出＝空單', () => {
    expect(fillSide({ direction: 'buy', action: 'open' })).toBe('long');
    expect(fillSide({ direction: 'sell', action: 'open' })).toBe('short');
  });

  it('平倉是反過來的：賣出平掉多單、買進回補空單', () => {
    expect(fillSide({ direction: 'sell', action: 'close' })).toBe('long');
    expect(fillSide({ direction: 'buy', action: 'close' })).toBe('short');
  });
});

describe('匯入平倉查詢', () => {
  it('五列全新 → 新增五筆紀錄，現金加總等於截圖上的總損益 22,012', () => {
    const plan = buildImportPlan(emptyState(), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    expect(plan.next.closed).toHaveLength(5);
    expect(plan.cash_delta).toBeCloseTo(22012, 0);
    expect(plan.next.cash).toBeCloseTo(22012, 0);
    expect(plan.changed).toBe(true);
  });

  it('用券商實收費用算損益，不用設定值推估（差 60 元/趟就是差在這）', () => {
    const plan = buildImportPlan(emptyState(), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    const first = plan.next.closed[0];
    expect(first.fee).toBe(240);   // 40 元/口 × 3 口 × 來回
    expect(first.tax).toBe(12);
    expect(closedPnl(first, spec)).toBeCloseTo(798, 0);
    // 若用 spec 的 30 元/口推估會變成 857.5——不是券商真的收的數字
    expect(closedPnl({ ...first, fee: undefined, tax: undefined }, spec)).toBeCloseTo(857.5, 0);
  });

  it('同一張截圖再匯一次不會重複計帳（ref 去重）', () => {
    const first = buildImportPlan(emptyState(), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    const again = buildImportPlan(first.next, [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    expect(again.changed).toBe(false);
    expect(again.cash_delta).toBe(0);
    expect(again.next.closed).toHaveLength(5);
    expect(again.ops.every((o) => o.kind === 'closed_skip')).toBe(true);
  });

  it('沒有 ref 的舊紀錄靠內容比對也認得出來，不會變成第二筆', () => {
    const manual: ClosedTrade = {
      id: 'c_manual', product: 'SRF', month: '202608', side: 'long', lots: 3,
      entry_price: 103.8, exit_price: 104.15, exit_date: '2026-08-11',
    };
    const plan = buildImportPlan(emptyState({ closed: [manual] }), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    expect(plan.next.closed).toHaveLength(5); // 4 筆新的 + 原本那筆
  });

  it('手動記的那筆會被補上券商實收費用，現金同步修正差額', () => {
    const manual: ClosedTrade = {
      id: 'c_manual', product: 'SRF', month: '202608', side: 'long', lots: 3,
      entry_price: 103.8, exit_price: 104.15, exit_date: '2026-08-11',
    };
    const plan = buildImportPlan(emptyState({ closed: [manual], cash: 100000 }), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    const fixed = plan.next.closed.find((t) => t.id === 'c_manual');
    expect(fixed?.fee).toBe(240);
    expect(fixed?.tax).toBe(12);
    // 原本推估 857.5、實際 798 → 現金要少 59.5
    expect(plan.ops.some((o) => o.kind === 'closed_fee')).toBe(true);
    expect(plan.next.cash - 100000 - (22012 - 798)).toBeCloseTo(-59.5, 0);
  });

  it('有對應的未平倉部位時會一起沖銷掉口數', () => {
    const held: FuturesPosition = {
      id: 'p1', product: 'SRF', month: '202608', side: 'long', lots: 6, entry_price: 103.8, entry_date: '2026-08-04',
    };
    const plan = buildImportPlan(emptyState({ positions: [held] }), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    // 202608 平掉 3+3＝6 口，正好清空
    expect(plan.next.positions.filter((p) => p.month === '202608')).toHaveLength(0);
    expect(plan.ops.some((o) => o.kind === 'position_reduce' && !o.warn)).toBe(true);
  });

  it('沒有部位可沖銷時照樣記帳，但要出警告（不能安靜吞掉）', () => {
    const plan = buildImportPlan(emptyState(), [CLOSED_SCREEN], spec, 'SRF', { today: TODAY });
    expect(plan.ops.some((o) => o.kind === 'position_reduce' && o.warn)).toBe(true);
  });
});

describe('匯入成交回報', () => {
  it('新倉成交 → 新增部位，日期用成交當天', () => {
    const plan = buildImportPlan(emptyState(), [FILL_SCREEN], spec, 'SRF', { today: TODAY });
    expect(plan.next.positions).toHaveLength(1);
    expect(plan.next.positions[0]).toMatchObject({
      month: '202609', side: 'long', lots: 5, entry_price: 103.5, entry_date: '2026-08-19',
    });
    expect(plan.cash_delta).toBe(0);
  });

  it('同一張成交回報再匯一次不會多開一次倉', () => {
    const first = buildImportPlan(emptyState(), [FILL_SCREEN], spec, 'SRF', { today: TODAY });
    const again = buildImportPlan(first.next, [FILL_SCREEN], spec, 'SRF', { today: TODAY });
    expect(again.next.positions).toHaveLength(1);
    expect(again.changed).toBe(false);
  });

  it('平倉成交會沖銷部位並產生平倉紀錄', () => {
    const held: FuturesPosition = {
      id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 5, entry_price: 103.5, entry_date: '2026-08-11',
    };
    const sell: ScanFillRow = {
      ...FILL, direction: 'sell', action: 'close', lots: 2, price: 105, ref: 'f|2026-08-19 10:00:00|9|sell|close|2|105',
    };
    const plan = buildImportPlan(
      emptyState({ positions: [held] }),
      [screen({ kind: 'fills', fill_rows: [sell], totals: { pnl: null, count: 1 } })],
      spec, 'SRF', { today: TODAY },
    );
    expect(plan.next.positions[0].lots).toBe(3); // 部分平倉，剩 3 口
    expect(plan.next.closed).toHaveLength(1);
    expect(plan.next.closed[0]).toMatchObject({ lots: 2, entry_price: 103.5, exit_price: 105 });
    expect(plan.cash_delta).toBeGreaterThan(0);
  });

  it('平倉查詢與成交回報講同一筆平倉時只算一次（兩張截圖一起匯的常態）', () => {
    const held: FuturesPosition = {
      id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 11, entry_price: 104.4, entry_date: '2026-08-11',
    };
    // 8/18 那三列平倉，成交回報上會是同一天同價位的三筆賣出
    const sells: ScanFillRow[] = [2, 6, 3].map((lots, i) => ({
      product: '小型元大台灣50ETF期 202609', month: '202609', direction: 'sell', action: 'close',
      lots, price: 105.55, date: '2026-08-18', time: `13:0${i}:00`,
      ref: `f|2026-08-18 13:0${i}:00|61469|sell|close|${lots}|105.55`,
    }));
    const plan = buildImportPlan(
      emptyState({ positions: [held] }),
      [CLOSED_SCREEN, screen({ kind: 'fills', fill_rows: sells, totals: { pnl: null, count: 3 } })],
      spec, 'SRF', { today: TODAY },
    );
    // 五筆平倉紀錄（來自平倉查詢），成交回報那三筆被認出是同一件事
    expect(plan.next.closed).toHaveLength(5);
    expect(plan.cash_delta).toBeCloseTo(22012, 0);
    expect(plan.ops.filter((o) => o.text.includes('平倉查詢已含這筆'))).toHaveLength(3);
  });
});

describe('未平倉快照驗收', () => {
  it('事件重放後與快照一致 → 不覆寫、對帳全綠', () => {
    const held: FuturesPosition = {
      id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 9, entry_price: 106.7166, entry_date: '2026-08-11',
    };
    const plan = buildImportPlan(emptyState({ positions: [held] }), [FILL_SCREEN, OPEN_SCREEN], spec, 'SRF', { today: TODAY });
    // 9 口 @106.7166 + 今天新倉 5 口 @103.5 = 14 口 @105.5679
    expect(plan.ops.some((o) => o.kind === 'position_rewrite')).toBe(false);
    expect(plan.checks.every((c) => c.ok)).toBe(true);
    expect(plan.next.positions).toHaveLength(2); // 分批明細保留下來，沒被壓成一筆
  });

  it('對不起來時以快照覆寫，並把分批合併成一筆（進場日取最早）', () => {
    const a: FuturesPosition = { id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 4, entry_price: 100, entry_date: '2026-08-05' };
    const b: FuturesPosition = { id: 'p2', product: 'SRF', month: '202609', side: 'long', lots: 4, entry_price: 101, entry_date: '2026-08-11' };
    const plan = buildImportPlan(emptyState({ positions: [a, b] }), [OPEN_SCREEN], spec, 'SRF', { today: TODAY });
    expect(plan.next.positions).toHaveLength(1);
    expect(plan.next.positions[0]).toMatchObject({ lots: 14, entry_price: 105.5679, entry_date: '2026-08-05' });
    expect(plan.checks.every((c) => c.ok)).toBe(true);
    expect(plan.ops.some((o) => o.kind === 'position_rewrite' && o.warn)).toBe(true);
  });

  it('覆寫後停損價沿用口數最大那筆，不會因為合併就不見', () => {
    const a: FuturesPosition = { id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 2, entry_price: 100, entry_date: '2026-08-05' };
    const b: FuturesPosition = { id: 'p2', product: 'SRF', month: '202609', side: 'long', lots: 6, entry_price: 101, entry_date: '2026-08-11' };
    const plan = buildImportPlan(
      emptyState({ positions: [a, b], stop_loss: { p1: 95, p2: 99 } }),
      [OPEN_SCREEN], spec, 'SRF', { today: TODAY },
    );
    const newId = plan.next.positions[0].id;
    expect(plan.next.stop_loss[newId]).toBe(99); // 來自口數較大的 p2
    expect(Object.keys(plan.next.stop_loss)).toHaveLength(1);
  });

  it('沒勾「以截圖為準」就不動部位，只留警告', () => {
    const a: FuturesPosition = { id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 4, entry_price: 100, entry_date: '2026-08-05' };
    const plan = buildImportPlan(emptyState({ positions: [a] }), [OPEN_SCREEN], spec, 'SRF', { today: TODAY, adoptSnapshot: false });
    expect(plan.next.positions).toEqual([a]);
    expect(plan.warnings.some((w) => w.includes('未勾選'))).toBe(true);
    expect(plan.checks.some((c) => !c.ok)).toBe(true);
  });

  it('快照上沒有的月份會被刪掉——但只有在「留倉筆數」對得上時才敢刪', () => {
    const stale: FuturesPosition = { id: 'p9', product: 'SRF', month: '202608', side: 'long', lots: 3, entry_price: 103, entry_date: '2026-07-01' };
    const ok = buildImportPlan(emptyState({ positions: [stale] }), [OPEN_SCREEN], spec, 'SRF', { today: TODAY });
    expect(ok.next.positions.some((p) => p.month === '202608')).toBe(false);

    // 截圖說有 2 筆但只認出 1 筆 → 不可信，不刪
    const partial = screen({ ...OPEN_SCREEN, totals: { pnl: -25450, count: 2 } });
    const held = buildImportPlan(emptyState({ positions: [stale] }), [partial], spec, 'SRF', { today: TODAY });
    expect(held.next.positions.some((p) => p.month === '202608')).toBe(true);
    expect(held.warnings.some((w) => w.includes('留倉筆數'))).toBe(true);
  });

  it('未平倉損益對得起來（14 口 × 均價 105.5679 × 市價 103.75 ≈ −25,450）', () => {
    const plan = buildImportPlan(emptyState(), [OPEN_SCREEN], spec, 'SRF', { today: TODAY });
    const check = plan.checks.find((c) => c.label.includes('未平倉損益'));
    expect(check?.ok).toBe(true);
  });

  it('現價預設不吃截圖，勾了才更新', () => {
    const off = buildImportPlan(emptyState({ prices: { 202609: 104.9 } }), [OPEN_SCREEN], spec, 'SRF', { today: TODAY });
    expect(off.next.prices['202609']).toBe(104.9);

    const on = buildImportPlan(emptyState({ prices: { 202609: 104.9 } }), [OPEN_SCREEN], spec, 'SRF', { today: TODAY, applyPrices: true });
    expect(on.next.prices['202609']).toBe(103.75);
  });
});

describe('三張截圖一起匯入（2026-08-19 真實情境）', () => {
  it('平倉、加倉、快照三者一次對完，且再匯一次是空操作', () => {
    const before: FuturesPosition = {
      id: 'p1', product: 'SRF', month: '202609', side: 'long', lots: 20, entry_price: 104.4, entry_date: '2026-08-11',
    };
    const screens = [OPEN_SCREEN, CLOSED_SCREEN, FILL_SCREEN];
    const plan = buildImportPlan(emptyState({ positions: [before], cash: 300000 }), screens, spec, 'SRF', { today: TODAY });

    expect(plan.next.closed).toHaveLength(5);
    expect(plan.cash_delta).toBeCloseTo(22012, 0);
    const agg = aggregatePositions(plan.next.positions);
    expect(agg.get('202609:long')?.lots).toBe(14);
    expect(agg.get('202609:long')?.avg).toBeCloseTo(105.5679, 4);
    expect(plan.checks.every((c) => c.ok)).toBe(true);

    const again = buildImportPlan(plan.next, screens, spec, 'SRF', { today: TODAY });
    expect(again.changed).toBe(false);
    expect(again.cash_delta).toBe(0);
  });
});

// 辨識層在 gateway（要 API key，不能進前端 bundle）。這裡不打網路，只驗「模型吐了
// 一包 JSON 之後，我們怎麼把它變成可以拿去記帳的資料」——那才是會靜靜算錯錢的地方。
// @ts-ignore
import ocrRouter from '../../../routes/futures_ocr.js';

describe('gateway 截圖辨識的正規化', () => {
  const { normalizeScreen, monthOf, isoDate, parseJson } = ocrRouter;

  it('到期月份從商品名稱結尾撈，不會被「50ETF」的數字騙走', () => {
    expect(monthOf('', '小型元大台灣50ETF期202609')).toBe('202609');
    expect(monthOf('', '小型元大台灣50ETF 202608')).toBe('202608');
    expect(monthOf('202609', '亂七八糟')).toBe('202609');
    expect(monthOf('2026-09', '')).toBe('202609');
    expect(monthOf('202613', '')).toBe('');   // 13 月不是月份
    expect(monthOf('', '沒有月份')).toBe('');
  });

  it('日期一律轉 ISO', () => {
    expect(isoDate('2026/08/11')).toBe('2026-08-11');
    expect(isoDate('2026-8-1')).toBe('2026-08-01');
    expect(isoDate('看不清楚')).toBe('');
  });

  it('模型包了 markdown code fence 也要能解', () => {
    expect(parseJson('```json\n{"kind":"open"}\n```')).toEqual({ kind: 'open' });
  });

  it('未平倉查詢：買進＝多單，千分位逗號要吃掉', () => {
    const s = normalizeScreen({
      kind: 'open',
      title: '期權-未平倉查詢',
      totals: { pnl: '-25,450', count: 1 },
      open_rows: [{
        product: '小型元大台灣50ETF期202609', direction: '買進',
        lots: 14, avg_price: 105.5679, market_price: 103.75, pnl: '-25,450',
      }],
    });
    expect(s.kind).toBe('open');
    expect(s.open_rows[0]).toMatchObject({ month: '202609', side: 'long', lots: 14, avg_price: 105.5679, market_price: 103.75, pnl: -25450 });
    expect(s.totals).toEqual({ pnl: -25450, count: 1 });
    expect(s.warnings).toHaveLength(0);
  });

  it('平倉查詢：兩腿的手續費與交易稅相加，方向由建倉腿決定', () => {
    const s = normalizeScreen({
      kind: 'closed',
      totals: { pnl: 22012, count: 1 },
      closed_rows: [{
        product: '小型元大台灣50ETF 202608', lots: 3, close_date: '2026/08/11',
        close_leg: { direction: '賣出', date: '2026/08/11', price: 104.15, fee: 120, tax: 6, order_id: '61303' },
        open_leg: { direction: '買進', date: '2026/08/04', price: 103.8, fee: 120, tax: 6, order_id: '63077' },
        pnl: 1050, net_pnl: 798,
      }],
    });
    expect(s.closed_rows[0]).toMatchObject({
      month: '202608', side: 'long', lots: 3,
      entry_price: 103.8, entry_date: '2026-08-04',
      exit_price: 104.15, exit_date: '2026-08-11',
      fee: 240, tax: 12, net_pnl: 798,
    });
    expect(s.closed_rows[0].ref).toContain('61303');
  });

  it('平倉查詢：先賣後買＝空單', () => {
    const s = normalizeScreen({
      kind: 'closed',
      closed_rows: [{
        product: 'X 202609', lots: 2, close_date: '2026/08/18',
        close_leg: { direction: '買進', date: '2026/08/18', price: 104, fee: 80, tax: 4, order_id: 'a' },
        open_leg: { direction: '賣出', date: '2026/08/11', price: 106, fee: 80, tax: 4, order_id: 'b' },
        pnl: 4000,
      }],
    });
    expect(s.closed_rows[0].side).toBe('short');
    expect(s.closed_rows[0].entry_price).toBe(106);
  });

  it('平倉查詢：兩腿被寫反時依日期救回來並留下警告', () => {
    const s = normalizeScreen({
      kind: 'closed',
      closed_rows: [{
        product: 'X 202609', lots: 1, close_date: '2026/08/18',
        close_leg: { direction: '買進', date: '2026/08/11', price: 104, order_id: 'a' },
        open_leg: { direction: '賣出', date: '2026/08/18', price: 105, order_id: 'b' },
      }],
    });
    expect(s.closed_rows[0]).toMatchObject({ entry_price: 104, exit_price: 105, side: 'long' });
    expect(s.warnings.some((w: string) => w.includes('相反'))).toBe(true);
  });

  it('成交回報：倉別轉成 open/close，成交時間拆成日期與時間', () => {
    const s = normalizeScreen({
      kind: 'fills',
      totals: { count: 1 },
      fill_rows: [{
        product: '小型元大台灣50ETF期 202609', datetime: '2026/08/19 09:12:03',
        direction: '買進', open_close: '新倉', lots: 5, price: 103.5, order_id: '61166',
      }],
    });
    expect(s.fill_rows[0]).toMatchObject({
      month: '202609', direction: 'buy', action: 'open', lots: 5, price: 103.5,
      date: '2026-08-19', time: '09:12:03',
    });
  });

  it('讀不完整的列直接丟掉並留警告，不猜數字', () => {
    const s = normalizeScreen({
      kind: 'open',
      open_rows: [
        { product: 'X 202609', direction: '買進', lots: 14, avg_price: 105 },
        { product: 'Y 202609', direction: null, lots: null, avg_price: null },
      ],
    });
    expect(s.open_rows).toHaveLength(1);
    expect(s.warnings.some((w: string) => w.includes('讀不完整'))).toBe(true);
  });

  it('截圖自己的筆數與認出的列數不符 → 警告（可能被裁切或要往下捲）', () => {
    const s = normalizeScreen({
      kind: 'open',
      totals: { count: 3 },
      open_rows: [{ product: 'X 202609', direction: '買進', lots: 1, avg_price: 100 }],
    });
    expect(s.warnings.some((w: string) => w.includes('只認出'))).toBe(true);
  });

  it('認不出畫面種類就什麼都不做', () => {
    const s = normalizeScreen({ kind: '首頁' });
    expect(s.kind).toBe('unknown');
    expect(s.open_rows).toHaveLength(0);
    expect(s.warnings.some((w: string) => w.includes('認不出'))).toBe(true);
  });
});
