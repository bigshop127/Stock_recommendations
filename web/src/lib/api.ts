// 前端唯一資料入口：只打 Node gateway 的 /api，**絕不**直接打 Python engine。
// 統一錯誤格式 { error: { code, message, detail? } }（見 docs/api.md）。

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
    throw new ApiError(0, 'NETWORK', '無法連線到後端 gateway（請確認 server.cjs 已啟動）', String(e));
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

// ── 型別（對應 docs/contracts/*.md，寬鬆容錯）──────────────────────────────────
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
  // daytrade 盤後無盤口
  unavailable?: boolean;
  reason?: string;
  // blended 額外欄位
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

// ── 端點 ──────────────────────────────────────────────────────────────────────
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
};
