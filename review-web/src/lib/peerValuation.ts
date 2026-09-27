// 合理價＋同業排名（opt45，仿 Danny Quant 個股頁「合理價估算」「同業排名」兩區）。
//
// 同業＝細分族群（stockGroups.ts，例：CCL銅箔基板），比官方產業別（電子零組件業 200 多家）貼近；
// 族群裡有資料的同業不到 3 檔時，整張卡改用大類（例：電子零組件）並標明。
// 合理價：
//   本益比法＝同業本益比中位數 × 本股近四季 EPS（證交所收盤 ÷ 本益比反推），區間用同業 25～75 百分位
//   淨值比法＝同業淨值比中位數 × 本股每股淨值
// 虧損股（證交所不列本益比）、同業不足 3 檔 → 不估，直接說原因，不印空值
// （參考站畫面上印著「peer PE median None × trailing EPS None」就是沒擋這個）。
import type { StockMetric, HeatmapStock } from './api';

export type PeerMetricKey = 'pe' | 'pb' | 'dy' | 'rev_yoy' | 'gross_margin' | 'operating_margin' | 'turnover';

export interface PeerMetricDef {
  key: PeerMetricKey;
  label: string;
  /** low＝越低排越前面（估值便宜）；high＝越高越前面 */
  order: 'low' | 'high';
  unit: 'x' | '%' | 'money';
  hint: string;
}

export const PEER_METRICS: PeerMetricDef[] = [
  { key: 'pe', label: '本益比', order: 'low', unit: 'x', hint: '近四季，越低越便宜；虧損股不列' },
  { key: 'pb', label: '股價淨值比', order: 'low', unit: 'x', hint: '越低越便宜' },
  { key: 'dy', label: '殖利率', order: 'high', unit: '%', hint: '近一年現金股利 ÷ 收盤' },
  { key: 'rev_yoy', label: '月營收年增', order: 'high', unit: '%', hint: '最新一個月' },
  { key: 'gross_margin', label: '毛利率', order: 'high', unit: '%', hint: '今年累計' },
  { key: 'operating_margin', label: '營業利益率', order: 'high', unit: '%', hint: '今年累計' },
  { key: 'turnover', label: '成交值', order: 'high', unit: 'money', hint: '最近一個交易日' },
];

export interface PeerRow {
  code: string;
  name: string;
  isSelf: boolean;
  close: number | null;
  values: Record<PeerMetricKey, number | null>;
}

export interface MetricRank {
  def: PeerMetricDef;
  own: number | null;
  median: number | null;
  /** 1＝最前面（依 order）；本股沒有數值時 null */
  rank: number | null;
  total: number;
  /** 由低到高排好的數值（畫分布條用） */
  sorted: { code: string; name: string; value: number; isSelf: boolean }[];
}

export interface FairValue {
  method: 'pe' | 'pb';
  base: number;           // 近四季 EPS 或每股淨值
  median: number;         // 同業倍數中位數
  p25: number;
  p75: number;
  fair: number;
  low: number;
  high: number;
  gapPct: number | null;  // (合理價 ÷ 現價 − 1) × 100，正＝現價低於合理價
  peers: number;          // 用了幾檔同業
}

export interface PeerValuation {
  scope: 'group' | 'category';
  scopeName: string;
  group: string;
  category: string;
  rows: PeerRow[];        // 含本股
  self: PeerRow;
  price: number | null;
  pe: FairValue | null;
  peReason: string | null;
  pb: FairValue | null;
  pbReason: string | null;
  ranks: MetricRank[];
}

const MIN_PEERS = 3;

const fmtMoney = (v: number) => {
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 億`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)} 萬`;
  return v.toLocaleString();
};

/** 顯示用：倍數一位小數、營收年增帶正負號、殖利率兩位、成交值換成億／兆 */
export function fmtMetric(def: PeerMetricDef, v: number | null): string {
  if (v === null) return '—';
  if (def.unit === 'x') return `${v.toFixed(1)}x`;
  if (def.unit === '%') {
    if (def.key === 'dy') return `${v.toFixed(2)}%`;
    const sign = def.key === 'rev_yoy' && v > 0 ? '+' : '';
    return `${sign}${v.toFixed(1)}%`;
  }
  return fmtMoney(v);
}

/** 線性內插百分位（p 介於 0～1），values 需已排序 */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function toRow(code: string, m: StockMetric | undefined, h: HeatmapStock | undefined, selfCode: string): PeerRow {
  return {
    code,
    name: m?.name || h?.name || code,
    isSelf: code === selfCode,
    close: m?.close ?? h?.close ?? null,
    values: {
      pe: positive(m?.pe) ? m!.pe : null,
      pb: positive(m?.pb) ? m!.pb : null,
      dy: finite(m?.dy) ? m!.dy : null,
      rev_yoy: finite(m?.rev_yoy) ? m!.rev_yoy : null,
      gross_margin: finite(m?.gross_margin) ? m!.gross_margin : null,
      operating_margin: finite(m?.operating_margin) ? m!.operating_margin : null,
      turnover: positive(h?.turnover) ? h!.turnover : null,
    },
  };
}

function fairValue(
  method: 'pe' | 'pb',
  base: number | null | undefined,
  peers: PeerRow[],
  price: number | null,
): { value: FairValue | null; reason: string | null } {
  const multiples = peers
    .map((r) => r.values[method])
    .filter(positive)
    .sort((a, b) => a - b);
  if (!positive(base)) {
    return {
      value: null,
      reason: method === 'pe' ? '近四季虧損（證交所不列本益比），本益比法不適用' : '沒有每股淨值資料',
    };
  }
  if (multiples.length < MIN_PEERS) {
    return { value: null, reason: `有${method === 'pe' ? '本益比' : '淨值比'}的同業只有 ${multiples.length} 檔，不足 ${MIN_PEERS} 檔不估` };
  }
  const median = quantile(multiples, 0.5)!;
  const p25 = quantile(multiples, 0.25)!;
  const p75 = quantile(multiples, 0.75)!;
  const fair = median * base;
  return {
    value: {
      method,
      base,
      median,
      p25,
      p75,
      fair,
      low: p25 * base,
      high: p75 * base,
      gapPct: positive(price) ? (fair / price - 1) * 100 : null,
      peers: multiples.length,
    },
    reason: null,
  };
}

function rankMetric(def: PeerMetricDef, rows: PeerRow[]): MetricRank {
  const sorted = rows
    .filter((r) => r.values[def.key] !== null)
    .map((r) => ({ code: r.code, name: r.name, value: r.values[def.key] as number, isSelf: r.isSelf }))
    .sort((a, b) => a.value - b.value);
  const self = rows.find((r) => r.isSelf);
  const own = self ? self.values[def.key] : null;
  let rank: number | null = null;
  if (own !== null) {
    // 同值並列取較前面的名次
    const better = sorted.filter((s) => (def.order === 'low' ? s.value < own : s.value > own)).length;
    rank = better + 1;
  }
  return {
    def,
    own,
    median: quantile(sorted.map((s) => s.value), 0.5),
    rank,
    total: sorted.length,
    sorted,
  };
}

/**
 * @param groups   STOCK_GROUPS（大類 → 族群 → 代號）
 * @param metrics  /api/market/stock-metrics 回來的列（至少要含本股與同業）
 * @param heat     今日個股熱力圖（成交值、收盤；可為 null）
 * @param price    現價（報價列的即時價；沒有就用證交所收盤）
 */
export function buildPeerValuation(
  code: string,
  groupRef: { group: string; category: string } | undefined,
  groups: Record<string, Record<string, string[]>>,
  metrics: StockMetric[],
  heat: HeatmapStock[] | null,
  price: number | null,
): PeerValuation | null {
  if (!groupRef) return null;
  const byCode = new Map(metrics.map((m) => [m.code, m]));
  const selfMetric = byCode.get(code);
  if (!selfMetric) return null;
  const heatByCode = new Map((heat || []).map((h) => [h.code, h]));

  const groupCodes = groups[groupRef.category]?.[groupRef.group] ?? [];
  const categoryCodes = Object.values(groups[groupRef.category] ?? {}).flat();
  const withData = (codes: string[]) => codes.filter((c) => c !== code && byCode.has(c));

  const scope: 'group' | 'category' = withData(groupCodes).length >= MIN_PEERS ? 'group' : 'category';
  const scopeCodes = [...new Set(scope === 'group' ? groupCodes : categoryCodes)];
  if (!scopeCodes.includes(code)) scopeCodes.unshift(code);

  const rows = scopeCodes
    .filter((c) => c === code || byCode.has(c))
    .map((c) => toRow(c, byCode.get(c), heatByCode.get(c), code));
  const self = rows.find((r) => r.isSelf)!;
  const peers = rows.filter((r) => !r.isSelf);
  const px = positive(price) ? price : self.close;

  const pe = fairValue('pe', selfMetric.eps_ttm, peers, px);
  const pb = fairValue('pb', selfMetric.bvps, peers, px);

  return {
    scope,
    scopeName: scope === 'group' ? groupRef.group : groupRef.category,
    group: groupRef.group,
    category: groupRef.category,
    rows,
    self,
    price: px,
    pe: pe.value,
    peReason: pe.reason,
    pb: pb.value,
    pbReason: pb.reason,
    ranks: PEER_METRICS.map((def) => rankMetric(def, rows)),
  };
}

/** 要跟 gateway 要哪些代號的數字：族群全部＋大類全部（族群同業不夠時才用得到大類，一次抓齊省一趟） */
export function peerCodesFor(
  code: string,
  groupRef: { group: string; category: string } | undefined,
  groups: Record<string, Record<string, string[]>>,
): string[] {
  if (!groupRef) return [code];
  const groupCodes = groups[groupRef.category]?.[groupRef.group] ?? [];
  const out = new Set<string>([code, ...groupCodes]);
  if (groupCodes.length - (groupCodes.includes(code) ? 1 : 0) < MIN_PEERS + 2) {
    for (const c of Object.values(groups[groupRef.category] ?? {}).flat()) out.add(c);
  }
  return [...out];
}
