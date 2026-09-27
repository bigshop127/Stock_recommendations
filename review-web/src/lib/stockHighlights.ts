import type { OhlcvRow, StockChips, StockFundamentals, ChipRow } from './api';
import { upcomingDividend } from './financialStatements';

/**
 * 個股頁頂部重點標籤（2026-09-27，仿 Danny Quant 個股頁標題下那排小標籤）。
 * 全部由個股頁本來就有抓的資料算出來（日K、20 日籌碼、基本面），不打新請求。
 * 規則刻意寫死門檻、每個標籤都帶 detail 說明怎麼來的，滑過去看得到。
 */

export type HighlightTone = 'bull' | 'bear' | 'warn' | 'info';

export interface Highlight {
  key: string;
  text: string;
  tone: HighlightTone;
  /** 滑鼠移上去看的說明：資料日期＋算法 */
  detail: string;
}

export interface HighlightInput {
  dailyOhlcv: OhlcvRow[] | null;
  chips: StockChips | null;
  fundamentals: StockFundamentals | null;
  /** 台北今天 YYYY-MM-DD（除息倒數用；不給就不出這個標籤） */
  today?: string;
}

const MAX_TAGS = 8;

const pct1 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 從最新一天往回數同號天數；遇到 0 或反向就停。回 +n＝連買 n 日、−n＝連賣 n 日 */
export function netBuyStreak(rows: ChipRow[], pick: (r: ChipRow) => number): number {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const q = pick(rows[i]);
    if (!Number.isFinite(q) || q === 0) break;
    if (streak === 0) streak = q > 0 ? 1 : -1;
    else if ((q > 0) === (streak > 0)) streak += streak > 0 ? 1 : -1;
    else break;
  }
  return streak;
}

function revenueTags(f: StockFundamentals | null): Highlight[] {
  const out: Highlight[] = [];
  const rows = [...(f?.revenue ?? [])]
    .filter((r) => r.revenue !== null && Number.isFinite(r.revenue))
    .sort((a, b) => a.month.localeCompare(b.month));
  if (rows.length === 0) return out;

  const withYoy = rows.filter((r) => r.yoy !== null && Number.isFinite(r.yoy));
  const latest = withYoy[withYoy.length - 1];
  if (latest && latest.yoy !== null) {
    const yoy = latest.yoy;
    const detail = `${latest.month} 月營收年增率 ${pct1(yoy)}（與去年同月比）`;
    if (yoy >= 50) out.push({ key: 'rev-yoy', text: `營收爆發 ${pct1(yoy)} YoY`, tone: 'bull', detail });
    else if (yoy >= 20) out.push({ key: 'rev-yoy', text: `營收年增 ${pct1(yoy)}`, tone: 'bull', detail });
    else if (yoy <= -10) out.push({ key: 'rev-yoy', text: `營收年減 ${pct1(yoy)}`, tone: 'bear', detail });
  }

  // 創新高：最新一個月 ≥ 手上全部歷史（至少要有 13 個月才有意義）
  const last = rows[rows.length - 1];
  if (rows.length >= 13 && last.revenue !== null) {
    const prevMax = Math.max(...rows.slice(0, -1).map((r) => r.revenue as number));
    if (last.revenue >= prevMax) {
      out.push({
        key: 'rev-high',
        text: `月營收創 ${rows.length} 個月新高`,
        tone: 'bull',
        detail: `${last.month} 月營收是手上 ${rows.length} 個月資料裡最高的一個月`,
      });
    }
  }

  // 連續年增/年減 ≥ 6 個月；整段資料都同號時加「以上」，因為更早的月份看不到
  let streak = 0;
  for (let i = withYoy.length - 1; i >= 0; i--) {
    const y = withYoy[i].yoy as number;
    if (y === 0) break;
    if (streak === 0) streak = y > 0 ? 1 : -1;
    else if ((y > 0) === (streak > 0)) streak += streak > 0 ? 1 : -1;
    else break;
  }
  const n = Math.abs(streak);
  if (n >= 6) {
    const more = n === withYoy.length ? '以上' : '';
    const up = streak > 0;
    out.push({
      key: 'rev-streak',
      text: `營收連 ${n} 個月${more}年${up ? '增' : '減'}`,
      tone: up ? 'bull' : 'bear',
      detail: `截至 ${latest?.month ?? ''}，月營收連續 ${n} 個月${more}與去年同月相比${up ? '成長' : '衰退'}`,
    });
  }
  return out;
}

function valuationTags(f: StockFundamentals | null): Highlight[] {
  const out: Highlight[] = [];
  const eps = f?.summary?.eps_ttm;
  if (eps !== null && eps !== undefined && Number.isFinite(eps) && eps < 0) {
    out.push({ key: 'eps-loss', text: '近四季虧損', tone: 'bear', detail: `近四季 EPS 合計 ${eps.toFixed(2)} 元` });
  }

  // 本益比放在自己近一年的哪個位置（跟同業比要等合理價/同業排名那一項）
  const pe = f?.summary?.pe_ratio;
  const history = (f?.valuation ?? [])
    .map((v) => v.pe_ratio)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (pe !== null && pe !== undefined && Number.isFinite(pe) && pe > 0 && history.length >= 120) {
    const below = history.filter((v) => v < pe).length / history.length;
    const detail = `本益比 ${pe.toFixed(1)} 倍，高於近一年 ${Math.round(below * 100)}% 的交易日`;
    if (below >= 0.9) out.push({ key: 'pe-pos', text: '本益比在近一年高檔', tone: 'warn', detail });
    else if (below <= 0.1) out.push({ key: 'pe-pos', text: '本益比在近一年低檔', tone: 'info', detail });
  }
  return out;
}

function chipTags(chips: StockChips | null): Highlight[] {
  const out: Highlight[] = [];
  const rows = [...(chips?.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 3) return out;
  const asOf = rows[rows.length - 1].date;

  const streakTag = (key: string, who: string, pick: (r: ChipRow) => number) => {
    const s = netBuyStreak(rows, pick);
    const n = Math.abs(s);
    if (n < 3) return;
    const more = n === rows.length ? '以上' : '';
    const buy = s > 0;
    out.push({
      key,
      text: `${who}連${buy ? '買' : '賣'} ${n} 日${more}`,
      tone: buy ? 'bull' : 'bear',
      detail: `截至 ${asOf}，${who}連續 ${n} 個交易日${more}${buy ? '買超' : '賣超'}`,
    });
  };
  streakTag('foreign', '外資', (r) => r.foreign_net_buy_qty);
  streakTag('trust', '投信', (r) => r.investment_trust_net_buy_qty);

  // 融資餘額變化：底數太小（<1000 張）的百分比沒意義，不標
  const first = rows[0].margin_balance;
  const last = rows[rows.length - 1].margin_balance;
  if (Number.isFinite(first) && Number.isFinite(last) && first >= 1000) {
    const chg = ((last - first) / first) * 100;
    const detail = `融資餘額 ${rows[0].date} ${first.toLocaleString()} 張 → ${asOf} ${last.toLocaleString()} 張`;
    if (chg >= 20) out.push({ key: 'margin', text: `融資 ${rows.length} 日增 ${pct1(chg)}`, tone: 'warn', detail });
    else if (chg <= -20) out.push({ key: 'margin', text: `融資 ${rows.length} 日減 ${pct1(chg)}`, tone: 'info', detail });
  }
  return out;
}

function priceTags(daily: OhlcvRow[] | null): Highlight[] {
  const out: Highlight[] = [];
  const rows = [...(daily ?? [])]
    .filter((r) => Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const n = rows.length;
  if (n < 20) return out;
  const last = rows[n - 1];
  const closes = rows.map((r) => r.close);
  const date = last.date.slice(0, 10);

  if (n >= 240) {
    const year = closes.slice(n - 240);
    const hi = Math.max(...year);
    const lo = Math.min(...year);
    if (last.close >= hi) {
      out.push({ key: 'year-pos', text: '收盤創一年新高', tone: 'bull', detail: `${date} 收盤 ${last.close.toFixed(2)} 為近 240 個交易日最高（還原價）` });
    } else if (last.close <= lo) {
      out.push({ key: 'year-pos', text: '收盤創一年新低', tone: 'bear', detail: `${date} 收盤 ${last.close.toFixed(2)} 為近 240 個交易日最低（還原價）` });
    } else {
      const dd = ((last.close - hi) / hi) * 100;
      if (dd <= -20) {
        out.push({ key: 'year-pos', text: `距一年高點 ${pct1(dd)}`, tone: 'info', detail: `近 240 個交易日最高收盤 ${hi.toFixed(2)}（還原價），現在 ${last.close.toFixed(2)}` });
      }
    }
  }

  if (n >= 60) {
    const ma5 = avg(closes.slice(n - 5));
    const ma20 = avg(closes.slice(n - 20));
    const ma60 = avg(closes.slice(n - 60));
    const detail = `MA5 ${ma5.toFixed(2)}／MA20 ${ma20.toFixed(2)}／MA60 ${ma60.toFixed(2)}（${date}）`;
    if (ma5 > ma20 && ma20 > ma60) out.push({ key: 'ma', text: '均線多頭排列', tone: 'bull', detail });
    else if (ma5 < ma20 && ma20 < ma60) out.push({ key: 'ma', text: '均線空頭排列', tone: 'bear', detail });
  }

  const vols = rows.map((r) => r.volume).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vols.length >= 20) {
    const v5 = avg(vols.slice(vols.length - 5));
    const v20 = avg(vols.slice(vols.length - 20));
    if (v20 > 0) {
      const ratio = v5 / v20;
      const detail = `近 5 日均量 ÷ 近 20 日均量 = ${ratio.toFixed(2)} 倍`;
      if (ratio >= 2) out.push({ key: 'vol', text: `量能放大 ${ratio.toFixed(1)}×`, tone: 'info', detail });
      else if (ratio <= 0.5) out.push({ key: 'vol', text: `量能萎縮 ${ratio.toFixed(1)}×`, tone: 'info', detail });
    }
  }
  return out;
}

/** 順序＝基本面 → 估值 → 籌碼 → 價格 → 量能，最多 8 個 */
/** 14 天內要除權息：標出倒數與金額（已除息、日期未定都不標） */
function dividendTags(f: StockFundamentals | null, today: string | undefined): Highlight[] {
  if (!f || !today) return [];
  const up = upcomingDividend(f.dividend_events, today);
  const ex = up?.ex;
  if (!up || !ex?.date || up.status !== '待除息') return [];
  const days = up.next && up.next.date === ex.date ? up.next.daysLeft : null;
  if (days === null || days > 14) return [];
  const cash = up.event.cash_dividend ?? 0;
  const stock = up.event.stock_dividend ?? 0;
  const amount = [cash > 0 ? `現金 ${Number(cash.toFixed(4))} 元` : '', stock > 0 ? `股票 ${Number(stock.toFixed(4))} 元` : '']
    .filter(Boolean)
    .join('、');
  return [{
    key: 'dividend',
    text: days === 0 ? `今天${ex.label}` : `${days} 天後${ex.label}`,
    tone: 'info',
    detail: `${up.event.period}：${ex.label}交易日 ${ex.date}${up.event.payment_date ? `，發放日 ${up.event.payment_date}` : ''}；${amount}`,
  }];
}

export function buildStockHighlights(input: HighlightInput): Highlight[] {
  return [
    ...revenueTags(input.fundamentals),
    ...valuationTags(input.fundamentals),
    ...dividendTags(input.fundamentals, input.today),
    ...chipTags(input.chips),
    ...priceTags(input.dailyOhlcv),
  ].slice(0, MAX_TAGS);
}
