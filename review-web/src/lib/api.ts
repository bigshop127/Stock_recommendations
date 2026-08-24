// 前端 API 資料接口：只對接 Node gateway /api，絕對不直連 Python engine
// 統一錯誤格式 { error: { code, message, detail? } }
import type { FuturesEquityRow } from './futures';
import type { ScanScreen } from './futuresImport';

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

export interface LlmUsage {
  provider: string;
  switched: boolean;
  elapsed_s: number;
  est_tokens?: number;
  error?: string | null;
}

export interface FactBase {
  blended_score: number;
  blended_action: string;
  conflict: boolean;
}

export interface AnalystDetail {
  stance: 'bull' | 'bullish' | 'bear' | 'bearish' | 'neutral';
  confidence: number | null;
  summary: string;
  key_points: string[];
  llm_failed?: boolean;
  role: string;
  _llm?: LlmUsage;
}

export interface DebateParticipant {
  side: 'bull' | 'bear';
  stance: 'bull' | 'bullish' | 'bear' | 'bearish' | 'neutral';
  confidence: number | null;
  summary: string;
  key_points: string[];
}

export interface TraderDecision {
  decision: string;
  confidence: number | null;
  rationale: string;
  role: string;
  _llm?: LlmUsage;
}

export interface RiskManagement {
  final_decision: string;
  confidence: number | null;
  risk_notes: string;
  conflict_acknowledged: boolean;
  role: string;
  _llm?: LlmUsage;
}

export interface ConsistencyStatus {
  blended_direction: string;
  agent_direction: string;
  blended_conflict_quant_vs_puhui: boolean;
  divergent_from_quant: boolean;
  divergence_flagged: boolean;
  warning: string | null;
}

export interface AgentDecision {
  code: string;
  name: string;
  date: string;
  fact_base: FactBase;
  analysts: {
    technical: AnalystDetail;
    news_sentiment: AnalystDetail;
    puhui: AnalystDetail;
  };
  debate: DebateParticipant[];
  trader: TraderDecision;
  risk: RiskManagement;
  final_decision: string;
  confidence: number | null;
  consistency: ConsistencyStatus;
  degraded?: string[];
}

export interface DecideResp {
  date: string;
  count: number;
  decisions: AgentDecision[];
  errors: any[];
  usage?: Record<string, unknown>;
  config?: {
    analysts: string[];
    debate_rounds: number;
    primary_provider: string;
    fallback_provider: string;
  };
}

// === Phase 1 新增 API 介面定義 (市場資訊與個股多維度資料) ===
export interface SparklinePoint {
  t: string;
  v: number;
}
export interface HistorySparklinePoint {
  date: string;
  close: number;
}
export interface IndexRow {
  key: string;
  name: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  intraday?: SparklinePoint[];
  history?: HistorySparklinePoint[];
  source: string;
}
export interface MarketIndices {
  date: string;
  as_of: string;
  indices: IndexRow[];
}

export interface MarketBreadth {
  date: string;
  advancing: number;
  declining: number;
  unchanged: number;
  limit_up: number;
  limit_down: number;
  total: number;
  advancing_pct: number;
  above_ma20_ratio: number;
  above_ma50_ratio: number;
  universe: string;
  sample_size: number;
  source: string;
}

export interface SectorPerformance {
  name: string;
  change_pct: number | null;
  turnover: number;
  source: string;
}
export interface MarketSectors {
  date: string;
  sectors: SectorPerformance[];
}

export interface InstitutionalTrades {
  foreign: number;
  investment_trust: number;
  dealer: number;
  total: number;
}
export interface MarketInstitutional {
  date: string;
  unit: string;
  latest: InstitutionalTrades;
  trend: Array<InstitutionalTrades & { date: string }>;
  source: string;
}

export interface ChipRow {
  date: string;
  foreign_holding_ratio: number | null;
  investment_trust_net_buy_qty: number;
  foreign_net_buy_qty: number;
  dealer_net_buy_qty: number;
  total_net_buy_qty: number;
  margin_balance: number;
  margin_change: number;
  short_balance: number;
  short_change: number;
}
export interface StockChips {
  code: string;
  name: string | null;
  as_of: string | null;
  unit: {
    net_buy_qty: string;
    balance: string;
    holding_ratio: string;
  };
  data: ChipRow[];
  source: string;
}

export interface FundamentalSummary {
  pe_ratio: number | null;
  pb_ratio: number | null;
  dividend_yield: number | null;
  market_cap: number | null;
  eps_ttm: number | null;
}

export interface ValuationRow {
  date: string;
  pe_ratio: number | null;
  pb_ratio: number | null;
  dividend_yield: number | null;
}

export interface RevenueRow {
  month: string;
  revenue: number | null;
  yoy: number | null;
  mom: number | null;
}

export interface FinancialsRow {
  quarter: string;
  eps: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  net_margin: number | null;
}

export interface DividendRow {
  year: string;
  cash_dividend: number | null;
  stock_dividend: number | null;
}

export interface StockFundamentals {
  code: string;
  name: string | null;
  as_of: string;
  summary: FundamentalSummary;
  valuation: ValuationRow[];
  revenue: RevenueRow[];
  financials: FinancialsRow[];
  dividend: DividendRow[];
  unit: {
    revenue: string;
    market_cap: string;
    dividend: string;
    ratio: string;
  };
  source: string;
}

export interface NewsSentiment {
  label: 'positive' | 'negative' | 'neutral';
  score: number;
  hits: string[];
}

export interface NewsItem {
  title: string;
  summary: string | null;
  url: string | null;
  source: string;
  published: string | null;
  sentiment: NewsSentiment;
}

export interface SentimentSummary {
  overall_label: 'positive' | 'negative' | 'neutral';
  overall_score: number;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

export interface StockNews {
  code: string;
  name: string;
  as_of: string;
  summary: SentimentSummary;
  items: NewsItem[];
}

export interface ShareholdingLevelItem {
  people: number;
  people_delta: number | null;
  shares_pct: number;
}

export interface ShareholdingWeek {
  date: string;
  retail: ShareholdingLevelItem;
  mid: ShareholdingLevelItem;
  large: ShareholdingLevelItem;
}

export interface ShareholdingDispersion {
  code: string;
  name: string;
  levels: { retail: string; mid: string; large: string };
  weekly: ShareholdingWeek[];
  source: string;
  as_of: string;
}

export interface CompanyProfile {
  code: string;
  name: string | null;
  full_name?: string | null;
  industry: string | null;
  founded: string | null;
  chairman: string | null;
  address: string | null;
  website: string | null;
  capital: number | null;
  source: string;
  as_of: string;
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
  decide: (codes: string[], date?: string) =>
    req<DecideResp>('/agents/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes, date }),
    }),

  // Phase 1 新增 API 端點
  marketIndices: (o?: { range?: '1d' | '5d' | '1m' }) => req<MarketIndices>(`/market/indices${qs(o)}`),
  marketBreadth: (o?: { date?: string }) => req<MarketBreadth>(`/market/breadth${qs(o)}`),
  marketSectors: (o?: { date?: string }) => req<MarketSectors>(`/market/sectors${qs(o)}`),
  marketInstitutional: (o?: { date?: string; days?: number }) => req<MarketInstitutional>(`/market/institutional${qs(o)}`),
  stockChips: (code: string, o?: { days?: number; start?: string; end?: string }) =>
    req<StockChips>(`/stocks/${code}/chips${qs({ days: o?.days, start: o?.start, end: o?.end })}`),
  stockFundamentals: (code: string) => req<StockFundamentals>(`/stocks/${code}/fundamentals`),
  stockProfile: (code: string) => req<CompanyProfile>(`/stocks/${code}/profile`),
  stockShareholding: (code: string, weeks?: number) => req<ShareholdingDispersion>(`/stocks/${code}/shareholding${qs({ weeks })}`),
  stockNews: (code: string) => req<StockNews>(`/stocks/${code}/news`),
  symbolSearch: (q: string, limit?: number) => req<SymbolSearch>(`/symbols/search${qs({ q, limit })}`),
  marketCapitalTide: (o?: { date?: string; universe?: string }) => req<CapitalTideData>(`/market/capital-tide${qs(o)}`),
  marketStockHeatmap: (o?: { period?: string; date?: string }, force?: boolean) => marketStockHeatmap(o, force),

  // 再平衡持倉雲端同步（gateway 讀寫 data/rebalance_holdings.json，與告警腳本同一份）
  getRebalanceHoldings: () => req<RebalanceHoldingsResp>('/rebalance/holdings'),
  saveRebalanceHoldings: (holdings: RebalanceHoldingsPayload) =>
    req<RebalanceHoldingsSaveResp>('/rebalance/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(holdings),
    }),
  // 真實同步（玉山證券）：gateway 直接在 VM 上跑同步腳本（2026-07-29 起不再靠本機
  // runner，電腦關機也能同步）。立即回 202，完成與否輪詢 getRealSyncStatus()。
  triggerRealSync: () =>
    req<{ ok: boolean; triggered_at: string }>('/rebalance/sync-holdings-trigger', { method: 'POST' }),
  getRealSyncStatus: () => req<RealSyncStatus>('/rebalance/sync-holdings-status'),
  // 宏觀 regime 指標同步（Yahoo：^IRX / ^TYX / TWD=X）——公開市場資料、不碰交易帳戶【regime-aware】
  getMacroIndicators: () => req<MacroIndicatorsResp>('/rebalance/macro-indicators'),

  // 期貨損益總覽（gateway 讀寫 data/futures_positions.json；報價代抓期交所 OpenAPI）
  getFuturesPositions: () => req<FuturesPositionsResp>('/futures/positions'),
  saveFuturesPositions: (payload: unknown) =>
    req<FuturesPositionsSaveResp>('/futures/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  getFuturesQuote: (contract = 'SRF') =>
    req<FuturesQuoteResp>(`/futures/quote${qs({ contract })}`),
  getFuturesMargins: () => req<FuturesMarginsResp>('/futures/margins'),
  // 個股/ETF期貨保證金（沒有 OpenAPI，gateway 代抓期交所 stockMargining 頁面解析）
  getFuturesStockMargins: () => req<FuturesStockMarginsResp>('/futures/stock-margins'),
  // 台股休市日曆（證交所 OpenAPI，只涵蓋當年度）——期貨最後交易日遇假日要順延
  getMarketHolidays: () => req<MarketHolidaysResp>('/market/holidays'),
  getFuturesEquityHistory: () => req<FuturesEquityHistoryResp>('/futures/equity-history'),
  /**
   * 券商 App 截圖辨識（opt30）。圖片以 base64 送給 gateway，由它呼叫視覺模型，
   * key 不進前端 bundle。回來的只是「畫面上有哪些列」，怎麼併帳在 lib/futuresImport.ts。
   */
  scanFuturesScreens: (images: { mime: string; data: string }[]) =>
    req<FuturesOcrResp>('/futures/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    }),
  // 加權指數：gateway 自己抓 TWSE（盤中走 MIS 即時、收盤後退每日 OpenAPI），不經 engine
  getTaiex: () => req<TaiexResp>('/market/taiex'),
};

// 快照列的形狀定義在 lib/futures.ts（純計算層），這裡只轉出去給呼叫端用——
// 傳輸層依賴領域層，反過來不行。
export type { FuturesEquityRow } from './futures';

export interface FuturesEquityHistoryResp {
  exists: boolean;
  rows: FuturesEquityRow[];
  updated_at: string | null;
}

/** 台股休市日曆。stale＝證交所抓不到、回的是磁碟快取（假日曆一年才變，仍可用）。 */
export interface MarketHolidaysResp {
  year: number;
  dates: string[];             // 'YYYY-MM-DD'
  source: string;
  fetched_at: string;
  cached?: boolean;
  stale?: boolean;
  stale_reason?: string;
}

// ── 期貨損益總覽 ────────────────────────────────────────────────────────────
export interface FuturesOcrResp {
  ok: boolean;
  screens: ScanScreen[];
  warnings: string[];
  model: string;
  scanned_at: string;
}

export interface FuturesPositionsResp {
  exists: boolean;
  futures: Record<string, unknown> | null;
  saved_at: string | null;
}
export interface FuturesPositionsSaveResp {
  ok: boolean;
  futures: Record<string, unknown>;
  saved_at: string;
}
export interface FuturesMonthQuote {
  month: string;             // 'YYYYMM'
  date: string;              // 期交所原始 'YYYYMMDD'
  last: number | null;
  settlement: number | null; // 結算價（只有一般交易時段有）
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  volume: number | null;
  open_interest: number | null;
  best_bid: number | null;
  best_ask: number | null;

  // 新增即時報價欄位
  live: number | null;
  live_session: 'day' | 'night' | null;
  live_time: string | null;
  live_volume: number | null;
  live_bid: number | null;
  live_ask: number | null;
}
export interface FuturesQuoteResp {
  contract: string;
  date: string;              // 'YYYY-MM-DD'
  months: FuturesMonthQuote[];
  fetched_at: string;
  cached?: boolean;

  // 新增即時報價欄位
  live_source: string | null;
  live_as_of: string | null;
  intraday?: boolean;
  live_error: string | null;
}

export interface FuturesMarginInfo {
  initial: number;
  maintenance: number;
  clearing: number;
  contract_name: string;
}

/** 個股期貨的保證金是「比例」不是金額——要乘上標的期貨現價 × 契約單位才是實際金額，且會隨標的價格每天變動 */
export interface StockMarginInfo {
  stock_code: string;
  name: string;
  tier: string;
  settlement_pct: number;
  maintenance_pct: number;
  initial_pct: number;
}

/** ETF 期貨（SRF/NYF 這類）的保證金跟指數類一樣是固定金額 */
export interface EtfMarginInfo {
  stock_code: string;
  name: string;
  settlement: number;
  maintenance: number;
  initial: number;
}

export interface FuturesStockMarginsResp {
  source: string;
  fetched_at: string;
  stock_date: string;  // 個股期貨那張表自己標的「更新日期」，'YYYY-MM-DD'
  etf_date: string;    // ETF期貨那張表自己標的「更新日期」
  stocks: Record<string, StockMarginInfo>;  // key＝股票期貨英文代碼，如 CCF（聯電期）
  etfs: Record<string, EtfMarginInfo>;      // key＝ETF期貨英文代碼，如 SRF／NYF
  cached?: boolean;
  stale?: boolean;
  stale_reason?: string;
}

export interface TaiexResp {
  index: number;              // 最新加權指數（盤中＝成交價，收盤後＝收盤價）
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  change_pct: number | null;  // 小數，0.01 ＝ +1%
  date: string;               // YYYY-MM-DD
  time: string;               // HH:MM:SS，只有 MIS 來源才有
  source: 'twse-mis' | 'twse-openapi' | string;
  intraday: boolean;          // true ＝ 盤中即時價；false ＝ 收盤／昨收
  fetched_at: string;
  cached?: boolean;
  stale?: boolean;
  stale_reason?: string;
}

export interface FuturesMarginsResp {
  date: string;
  source: string;
  fetched_at: string;
  margins: Record<string, FuturesMarginInfo>;
  unmapped: string[];
  cached?: boolean;
  stale?: boolean;
  stale_reason?: string;
}

// 真實同步的最近一次執行結果（gateway 寫 data/sync_holdings_status.json）。
// message 已經是「人看得懂的失敗原因」（AGA0002 白名單、AWA0005 時鐘…），可直接顯示。
export interface RealSyncStatus {
  state: 'idle' | 'running' | 'ok' | 'error';
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  message?: string | null;
  log_tail?: string;
}

// 宏觀 regime 指標（gateway 直抓 Yahoo）：每個指標的最新值 + 回看基準值
export interface MacroIndicatorResp {
  symbol: string;
  label: string;
  lookback_days: number;
  current: number | null;
  reference: number | null;
  as_of: string | null;
  ref_date: string | null;
  ok: boolean;
  error?: string;
}
export interface MacroIndicatorsResp {
  fetched_at: string;
  fed_rate: MacroIndicatorResp;
  treasury_yield: MacroIndicatorResp;
  fx: MacroIndicatorResp;
}

// 再平衡持倉（雲端 JSON）— 與 rebalanceStore.RebalanceConfig 對齊
export interface RebalanceTrade {
  id: string;
  date: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  code?: string;        // 標的代碼（缺省＝00631L，舊資料相容）【增修I】
}
export interface RebalanceBondHolding {
  code: string;
  shares: number;       // 衍生
  avg_cost: number;     // 衍生
  price: number;
}
export interface RebalanceHoldingsPayload {
  shares: number;       // 衍生（伺服端會再重算）
  avg_cost: number;     // 衍生
  price: number;
  cash: number;         // 衍生【增修H】（期初現金 − 買進 ＋ 賣出，伺服端會再重算）
  bonds: RebalanceBondHolding[]; // 防守端債券 ETF（00687B / 00953B）【增修I】
  cash_reserve: number; // 固定保留現金【增修I】
  bond_split: number;   // 債券池 00687B 佔比【增修I】
  bond_priority?: 'bond1_first' | 'bond2_first' | 'regime_aware'; // 變現優先順序【regime-aware】
  macro?: {             // 宏觀 regime 指標與門檻【regime-aware】
    fed_rate?: { current: number | null; reference: number | null; as_of?: string; ref_date?: string };
    treasury_yield?: { current: number | null; reference: number | null; as_of?: string; ref_date?: string };
    fx?: { current: number | null; reference: number | null; as_of?: string; ref_date?: string };
    thresholds?: { fed_rate_rise: number; treasury_yield_rise: number; fx_rise_pct: number };
    combination?: 'any' | 'majority' | 'all';
    fetched_at?: string;
  };
  locked: {
    cash: boolean;
    bonds: Record<string, boolean>;
  };
  target_beta: number;
  tolerance_mode: 'pct' | 'abs';
  threshold_pct: number;
  threshold_abs: number;
  etf_beta: number;
  opening: {
    shares: number;
    avg_cost: number;
    cash: number;
    bonds: { code: string; shares: number; avg_cost: number }[];
  };
  trades: RebalanceTrade[];
}
// 在途交割款（由「真實同步」帶入，玉山證券 get_settlements()）：交割日晚於今天、
// 尚未反映在可用餘額的滾動交割淨額。receivable＝賣出應收(正)、payable＝買進應付(負)、
// net＝已計入閒置現金的淨調整。屬同步 metadata，非使用者可編輯的持倉欄位。
export interface SettlementRow {
  trade_date: string;   // 成交日 YYYYMMDD
  settle_date: string;  // 交割日 YYYYMMDD（T+2）
  amount: number;       // 淨額，正＝應收、負＝應付
}
export interface Settlement {
  as_of: string;        // 快照基準日 YYYYMMDD
  net: number;          // 淨額（已計入 cash）
  receivable: number;   // 應收合計（正）
  payable: number;      // 應付合計（負）
  rows: SettlementRow[];
}
export interface RebalanceHoldingsResp {
  exists: boolean;
  holdings: RebalanceHoldingsPayload | null;
  saved_at: string | null;
  settlement?: Settlement | null;
}
export interface RebalanceHoldingsSaveResp {
  ok: boolean;
  holdings: RebalanceHoldingsPayload;
  saved_at: string;
}

export interface SymbolHit {
  code: string;
  name: string;
}

export interface SymbolSearch {
  query: string;
  count: number;
  results: SymbolHit[];
  source: string;
  degraded?: boolean;
}

export interface CapitalTideStock {
  code: string;
  name: string;
  sector: string;
  flow_x: number;
  flow_raw: number;
  momentum_y: number;
  momentum_raw: number;
  size: number;
  size_raw: number;
  strength: number;
  quadrant: 'inflow_up' | 'inflow_down' | 'outflow_up' | 'outflow_down';
}

export interface CapitalTideData {
  date: string;
  window_days: number;
  universe: string;
  axes: {
    x: { label: string; unit: string };
    y: { label: string; unit: string };
  };
  stocks: CapitalTideStock[];
  source: string;
  degraded?: boolean;
  errors?: string[];
}

export interface HeatmapStock {
  code: string;
  name: string;
  sector: string;
  close: number | null;
  change_pct: number | null;
  turnover: number | null;
}

export interface StockHeatmap {
  date: string;
  period: 'day' | 'week' | 'month';
  base_date: string;
  market: string;
  stocks: HeatmapStock[];
  source: string;
}

const heatmapCache = new Map<string, { timestamp: number; data: StockHeatmap }>();

export function marketStockHeatmap(o?: { period?: string; date?: string }, force = false): Promise<StockHeatmap> {
  const key = `${o?.period || 'day'}_${o?.date || 'latest'}`;
  const cached = heatmapCache.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.timestamp < 5 * 60 * 1000) {
    return Promise.resolve(cached.data);
  }
  return req<StockHeatmap>(`/market/stock-heatmap${qs(o)}`).then((data) => {
    heatmapCache.set(key, { timestamp: Date.now(), data });
    return data;
  });
}



