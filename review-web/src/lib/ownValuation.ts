// 合理價（opt53，2026-11-08 使用者定案，套用到所有股票）：跟「自己過去 3 年」比，而且看未來 EPS。
//
//   推估未來四季 EPS ＝ 最近一季 EPS × 4 ×（最近 3 個月營收 ÷ 那一季 3 個月的營收）
//                     ＝ 最近 3 個月營收 × 4 × 最近一季淨利率 ÷ 股數（換個寫法，不用知道股數）
//   便宜／合理／昂貴 ＝ 推估 EPS × 自身近 3 年本益比 25／50／75 百分位
//   保守參考（營收不再成長）＝ 近四季實際 EPS × 同一組倍數
//
// 改用自身近 3 年淨值比 × 每股淨值的情況：金融股、近 3 年有虧損季、最近一季 EPS ≤ 0、
// 本益比區間太寬（75 分位 ≥ 25 分位 × 3，獲利忽高忽低，本益比不可靠）、算不出推估 EPS。
//
// 同業本益比中位數（peerValuation.ts）留在產業分析分頁當對照，不再當主數字。
import type { StockFundamentals, ValuationBand } from './api';

export const PE_DISPERSION_LIMIT = 3;
/** 月營收最新一個月離今天超過這麼多個月就不推估（停止公布、資料斷掉） */
export const REVENUE_STALE_MONTHS = 4;

/** below＝低於便宜價、cheap＝便宜～合理、fair＝合理～昂貴、above＝高於昂貴價 */
export type ValuationZone = 'below' | 'cheap' | 'fair' | 'above';
export const ZONE_LABEL: Record<ValuationZone, string> = {
  below: '低於便宜價',
  cheap: '便宜～合理',
  fair: '合理～昂貴',
  above: '高於昂貴價',
};

export interface PriceBand {
  cheap: number;
  fair: number;
  expensive: number;
}

export interface ForwardEps {
  eps: number;
  quarter: string;          // 最近一季，例 2026-Q2
  quarterEps: number;
  months: string[];         // 最近 3 個月，例 ['2026-07','2026-08','2026-09']
  revenue3m: number;        // 元
  quarterRevenue: number;   // 那一季 3 個月的營收（月營收加總；缺月才用損益表營收）
  growthPct: number;        // (最近 3 個月 ÷ 那一季 − 1) × 100
}

export interface OwnValuation {
  method: 'pe' | 'pb';
  /** 為什麼用淨值比（method='pb' 才有） */
  switchReason: string | null;
  band: ValuationBand;
  bandStart: string | null;
  bandEnd: string | null;
  years: number;
  /** pe：推估未來四季 EPS；pb：每股淨值 */
  base: number;
  prices: PriceBand;
  price: number | null;
  zone: ValuationZone | null;
  /** (現價 ÷ 合理價 − 1) × 100：正＝現價比合理價高 */
  vsFairPct: number | null;
  forward: ForwardEps | null;
  /** 保守參考：近四季實際 EPS × 同一組倍數（只有本益比法有） */
  conservative: { eps: number; prices: PriceBand } | null;
}

export type OwnValuationResult = { ok: true; v: OwnValuation } | { ok: false; reason: string };

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 'YYYY-MM' 往前後推 n 個月 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** '2026-Q2' → ['2026-04','2026-05','2026-06'] */
export function quarterMonths(q: string): string[] | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) return null;
  const first = `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}`;
  return [first, addMonths(first, 1), addMonths(first, 2)];
}

export function zoneOf(price: number, p: PriceBand): ValuationZone {
  if (price < p.cheap) return 'below';
  if (price < p.fair) return 'cheap';
  if (price < p.expensive) return 'fair';
  return 'above';
}

const bandPrices = (band: ValuationBand, base: number): PriceBand => ({
  cheap: band.p25 * base,
  fair: band.p50 * base,
  expensive: band.p75 * base,
});

/**
 * 推估未來四季 EPS。算不出來回 { reason }。
 * today 是 'YYYY-MM'（測試注入；預設台北時間的這個月）。
 */
export function forwardEps(
  f: Pick<StockFundamentals, 'revenue' | 'financials'>,
  today: string = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7),
): ForwardEps | { reason: string } {
  const fins = [...(f.financials || [])].filter((r) => /^\d{4}-Q[1-4]$/.test(r.quarter || '')).sort((a, b) => (a.quarter < b.quarter ? -1 : 1));
  const latest = fins[fins.length - 1];
  if (!latest) return { reason: '沒有季報資料' };
  if (latest.eps === null || latest.eps === undefined) return { reason: `${latest.quarter} 還沒有 EPS` };
  if (latest.eps <= 0) return { reason: `${latest.quarter} EPS ${latest.eps.toFixed(2)} 元（虧損）` };

  const revMap = new Map((f.revenue || []).filter((r) => positive(r.revenue)).map((r) => [r.month, r.revenue as number]));
  const lastMonth = [...revMap.keys()].sort().pop();
  if (!lastMonth) return { reason: '沒有月營收資料' };
  if (addMonths(lastMonth, REVENUE_STALE_MONTHS) < today) return { reason: `月營收停在 ${lastMonth}，太舊不推估` };
  const months = [addMonths(lastMonth, -2), addMonths(lastMonth, -1), lastMonth];
  if (!months.every((m) => revMap.has(m))) return { reason: '最近 3 個月營收不齊' };
  const revenue3m = months.reduce((s, m) => s + (revMap.get(m) as number), 0);

  const qm = quarterMonths(latest.quarter)!;
  let quarterRevenue: number | null = null;
  if (qm.every((m) => revMap.has(m))) quarterRevenue = qm.reduce((s, m) => s + (revMap.get(m) as number), 0);
  else if (positive(latest.revenue)) quarterRevenue = latest.revenue;
  if (!positive(quarterRevenue)) return { reason: `${latest.quarter} 營收不齊` };

  return {
    eps: latest.eps * 4 * (revenue3m / quarterRevenue),
    quarter: latest.quarter,
    quarterEps: latest.eps,
    months,
    revenue3m,
    quarterRevenue,
    growthPct: (revenue3m / quarterRevenue - 1) * 100,
  };
}

function pbValuation(f: StockFundamentals, price: number | null, switchReason: string): OwnValuationResult {
  const vb = f.valuation_bands!;
  if (!vb.pb) return { ok: false, reason: `${switchReason}，但淨值比資料不到半年，不估` };
  const bs = [...(f.balance_sheet || [])].sort((a, b) => (a.quarter < b.quarter ? -1 : 1));
  const bvps = [...bs].reverse().find((r) => positive(r.bvps))?.bvps;
  if (!positive(bvps)) return { ok: false, reason: `${switchReason}，但沒有每股淨值資料，不估` };
  const prices = bandPrices(vb.pb, bvps);
  return {
    ok: true,
    v: {
      method: 'pb',
      switchReason,
      band: vb.pb,
      bandStart: vb.start,
      bandEnd: vb.end,
      years: vb.years,
      base: bvps,
      prices,
      price,
      zone: positive(price) ? zoneOf(price, prices) : null,
      vsFairPct: positive(price) ? (price / prices.fair - 1) * 100 : null,
      forward: null,
      conservative: null,
    },
  };
}

/** price：現價（報價列即時價，沒有就用最近收盤）；today 給測試注入 */
export function buildOwnValuation(f: StockFundamentals | null, price: number | null, today?: string): OwnValuationResult {
  if (!f) return { ok: false, reason: '基本面資料還沒載入' };
  const vb = f.valuation_bands;
  if (!vb || (!vb.pe && !vb.pb)) return { ok: false, reason: '本益比／淨值比歷史不到半年（新上市或 ETF），不估' };
  if (f.is_financial) return pbValuation(f, price, '金融股看淨值');
  if ((vb.loss_quarters ?? 0) > 0) return pbValuation(f, price, `近 3 年有 ${vb.loss_quarters} 季虧損`);
  if (!vb.pe) return pbValuation(f, price, '本益比資料不足');
  if (vb.pe.p75 >= vb.pe.p25 * PE_DISPERSION_LIMIT) {
    return pbValuation(f, price, `本益比區間太寬（${vb.pe.p25.toFixed(1)}～${vb.pe.p75.toFixed(1)} 倍）`);
  }
  const fw = forwardEps(f, today);
  if ('reason' in fw) return pbValuation(f, price, `推估不了 EPS（${fw.reason}）`);

  const prices = bandPrices(vb.pe, fw.eps);
  const ttm = f.summary?.eps_ttm;
  return {
    ok: true,
    v: {
      method: 'pe',
      switchReason: null,
      band: vb.pe,
      bandStart: vb.start,
      bandEnd: vb.end,
      years: vb.years,
      base: fw.eps,
      prices,
      price,
      zone: positive(price) ? zoneOf(price, prices) : null,
      vsFairPct: positive(price) ? (price / prices.fair - 1) * 100 : null,
      forward: fw,
      conservative: positive(ttm) ? { eps: ttm, prices: bandPrices(vb.pe, ttm) } : null,
    },
  };
}

/**
 * 「現價比合理價高／低 X%」——X 一律是 (現價 ÷ 合理價 − 1)。
 * 舊版把 (合理價 ÷ 現價 − 1) 寫成「現價高於合理價」，日月光 527 vs 239.9 被寫成高 54.5%，實際是高 119.7%。
 */
export function vsFairText(price: number, fair: number): { text: string; cheap: boolean } {
  const pct = (price / fair - 1) * 100;
  if (Math.abs(pct) < 0.05) return { text: '現價約等於合理價', cheap: true };
  return pct > 0
    ? { text: `現價比合理價高 ${pct.toFixed(1)}%`, cheap: false }
    : { text: `現價比合理價低 ${Math.abs(pct).toFixed(1)}%`, cheap: true };
}
