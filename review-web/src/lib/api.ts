// 前端 API 資料接口：只對接 Node gateway /api，絕對不直連 Python engine
// 統一錯誤格式 { error: { code, message, detail? } }
const BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function qs(params?: Record<string, string | number | boolean | undefined | null>): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    throw new ApiError(0, 'NETWORK', '無法連線至網關 (gateway)', String(e));
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; detail?: unknown } })?.error || {};
    throw new ApiError(res.status, err.code || 'ERROR', err.message || `HTTP ${res.status}`, err.detail);
  }
  return data as T;
}

// === 既有介面定義 ===
export interface Health {
  gateway: string;
  engine: 'up' | 'down';
  engine_base_url: string;
  time: string;
}

export interface MarketRegime {
  label: string;
  score: number;
  gate: number;
  confidence?: number;
  note?: string;
  inputs?: Record<string, unknown>;
}

export interface WatchItem {
  code: string;
  name: string;
  source: string[];
  puhui_signal?: string | null;
  puhui_reason?: string | null;
  swing_score: number;
  daytrade_prob: number | null;
  rank_swing: number;
  rank_daytrade: number;
  tags?: string[];
}

export interface Dashboard {
  date: string | null;
  as_of_date: string | null;
  market_regime: MarketRegime | null;
  water_level: number | null;
  water_level_text: string | null;
  puhui_sentiment: { label: string; score: number } | null;
  watchlist: WatchItem[];
  degraded: boolean;
  notes?: string[];
  generated_at: string;
}

export interface FactorScore {
  key: string;
  name: string;
  score: number;
  weight: number;
  confidence?: number;
  live_only?: boolean;
}

export interface StockSignal {
  code: string;
  name: string;
  date: string;
  mode: 'swing' | 'daytrade' | 'blended';
  action: string;
  score: number;
  confidence: number;
  factors?: FactorScore[];
  reasons?: string[];
  regime_gate?: number | null;
  regime?: MarketRegime | null;
  live_only?: boolean;
  unavailable?: boolean;
  reason?: string;
  agreement?: string;
  conflict?: boolean;
  blend?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface StockDetail {
  code: string;
  name: string | null;
  date: string | null;
  swing: StockSignal;
  daytrade: StockSignal;
  blended: StockSignal;
  puhui: Record<string, unknown> | null;
  backtest?: Record<string, unknown>;
  generated_at: string;
}

export interface OhlcvRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
export interface Ohlcv {
  code: string;
  name?: string;
  source: string;
  rows: number;
  data: OhlcvRow[];
}

export interface BookLevel {
  price: number | null;
  size: number | null;
}
export interface Book {
  code: string;
  source: string;
  live_only: boolean;
  note?: string;
  book: {
    last_price?: number | null;
    name?: string | null;
    bids?: BookLevel[];
    asks?: BookLevel[];
    total?: Record<string, unknown>;
    inner_outer?: { at_bid?: number | null; at_ask?: number | null };
    [k: string]: unknown;
  };
}

export interface Intraday {
  code: string;
  date: string;
  timeframe: string;
  source: string;
  rows: number;
  data: OhlcvRow[];
}

export interface ReportMeta {
  date: string;
  path: string;
  month: string;
  week: string;
}
export interface ReportsList {
  count: number;
  latest: string | null;
  dates: string[];
  reports: ReportMeta[];
}
export interface Report {
  date: string;
  path: string;
  markdown: string;
  emoji_semantics: string;
}

export interface BacktestResult {
  strategy?: string;
  period?: { start?: string; end?: string };
  params?: Record<string, unknown>;
  metrics?: {
    cum_return?: number;
    annual_return?: number;
    sharpe?: number;
    max_drawdown?: number;
    win_rate?: number;
    trades?: number;
    avg_holding_days?: number;
    [k: string]: unknown;
  };
  equity_curve?: Array<Record<string, unknown>>;
  benchmark?: { name?: string; cum_return?: number; equity_curve?: Array<Record<string, unknown>>; [k: string]: unknown };
  [k: string]: unknown;
}

export interface DecideResp {
  date: string;
  count: number;
  decisions: Record<string, unknown>[];
  errors: unknown[];
  usage?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

// === Phase 0 新增 API 介面定義 (市場資訊與個股多維度資料) ===
export interface IndexRow {
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  source: string;
}
export interface MarketIndices {
  date: string;
  indices: IndexRow[];
}

export interface MarketBreadth {
  date: string;
  advance: number;
  decline: number;
  flat: number;
  above20MaRatio: number;
  above50MaRatio: number;
  source: string;
}

export interface SectorPerformance {
  name: string;
  changePercent: number;
  netAmount: number;
  source: string;
}
export interface MarketSectors {
  date: string;
  sectors: SectorPerformance[];
}

export interface InstitutionalTrades {
  foreignNetBuy: number;
  investmentTrustNetBuy: number;
  dealerNetBuy: number;
  totalNetBuy: number;
  source: string;
}
export interface MarketInstitutional {
  date: string;
  trades: InstitutionalTrades;
}

export interface ChipRow {
  date: string;
  foreignHoldingRatio: number;
  investmentTrustNetBuyQty: number;
  foreignNetBuyQty: number;
  dealerNetBuyQty: number;
  marginBalance: number;
  shortBalance: number;
  source: string;
}
export interface StockChips {
  code: string;
  data: ChipRow[];
}

export interface FundamentalMetric {
  date: string;
  peRatio: number;
  pbRatio: number;
  dividendYield: number;
  revenueYoY: number;
  eps: number;
  source: string;
}
export interface StockFundamentals {
  code: string;
  metrics: FundamentalMetric[];
}

export interface NewsItem {
  id: string;
  title: string;
  date: string;
  url: string;
  summary: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  sentimentScore: number; // 0 - 100
  source: string;
}
export interface StockNews {
  code: string;
  news: NewsItem[];
}

// === API Client 整合出口 ===
export const api = {
  health: () => req<Health>('/health'),
  dashboard: (date?: string) => req<Dashboard>(`/dashboard${qs({ date })}`),
  stock: (code: string, o?: { date?: string; backtest?: boolean }) =>
    req<StockDetail>(`/stocks/${code}${qs({ date: o?.date, backtest: o?.backtest ? 1 : undefined })}`),
  ohlcv: (code: string, o?: { start?: string; end?: string; adjust?: boolean }) =>
    req<Ohlcv>(`/stocks/${code}/ohlcv${qs({ start: o?.start, end: o?.end, adjust: o?.adjust ? 1 : undefined })}`),
  book: (code: string) => req<Book>(`/stocks/${code}/book`),
  intraday: (code: string, o?: { date?: string; timeframe?: string }) =>
    req<Intraday>(`/stocks/${code}/intraday${qs({ date: o?.date, timeframe: o?.timeframe })}`),
  watchlist: (date?: string) =>
    req<{ date?: string; as_of_date?: string; items: WatchItem[] }>(`/watchlist${qs({ date })}`),
  backtest: (body: { codes: string[]; start?: string; end?: string; [k: string]: unknown }) =>
    req<BacktestResult>('/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  reportsList: () => req<ReportsList>('/reports/list'),
  report: (date?: string) => req<Report>(`/reports${qs({ date })}`),
  decide: (codes: string[]) =>
    req<DecideResp>('/agents/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes }),
    }),

  // Phase 0 新增 API 端點
  marketIndices: () => req<MarketIndices>('/market/indices'),
  marketBreadth: () => req<MarketBreadth>('/market/breadth'),
  marketSectors: () => req<MarketSectors>('/market/sectors'),
  marketInstitutional: () => req<MarketInstitutional>('/market/institutional'),
  stockChips: (code: string) => req<StockChips>(`/stocks/${code}/chips`),
  stockFundamentals: (code: string) => req<StockFundamentals>(`/stocks/${code}/fundamentals`),
  stockNews: (code: string) => req<StockNews>(`/stocks/${code}/news`),
};
