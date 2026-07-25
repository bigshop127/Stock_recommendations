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
  // 真實同步（玉山證券）：觸發本機 self-hosted runner 執行，實際完成與否靠輪詢
  // getRebalanceHoldings() 的 saved_at 判斷（見 Rebalance.tsx）
  triggerRealSync: () =>
    req<{ ok: boolean; triggered_at: string }>('/rebalance/sync-holdings-trigger', { method: 'POST' }),
  // 宏觀 regime 指標同步（Yahoo：^IRX / ^TYX / TWD=X）——公開市場資料、不碰交易帳戶【regime-aware】
  getMacroIndicators: () => req<MacroIndicatorsResp>('/rebalance/macro-indicators'),
};

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



