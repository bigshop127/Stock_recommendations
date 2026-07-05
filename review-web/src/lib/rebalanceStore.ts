import { aggregatePosition, type Trade } from './rebalance';

const VERSION = 'v1';
const KEY = `review:rebalance:${VERSION}`;

export interface RebalanceConfig {
  shares: number;                // 期末總股數（衍生：由 opening + trades 累算，唯讀）
  avg_cost: number;              // 加權平均成本（衍生，唯讀）
  price: number;
  cash: number;
  target_beta: number;           // 預設 1.3
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑，預設 'abs'
  threshold_pct: number;         // 預設 10
  threshold_abs: number;         // 預設 0.1
  etf_beta: number;              // 預設 2.0
  // 買賣報價單機制
  opening: { shares: number; avg_cost: number }; // 期初/建倉部位（可編輯）
  trades: Trade[];               // 買賣紀錄（可增刪）
}

const SEED_CONFIG: RebalanceConfig = {
  shares: 0,
  avg_cost: 0,
  price: 0,
  cash: 0,
  target_beta: 1.3,
  tolerance_mode: 'abs',
  threshold_pct: 10,
  threshold_abs: 0.1,
  etf_beta: 2.0,
  opening: { shares: 0, avg_cost: 0 },
  trades: [],
};

function safeNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// 【增修A】容忍模式守衛：非 'pct'/'abs' 一律落 'abs'（含舊資料缺欄位）
function safeMode(val: unknown): 'pct' | 'abs' {
  return val === 'pct' ? 'pct' : 'abs';
}

// 清洗單筆交易；無效（負股數/負價）clamp，回傳仍保留供顯示
function sanitizeTrade(t: unknown, idx: number): Trade | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const shares = Math.max(0, safeNumber(o.shares, 0));
  const price = Math.max(0, safeNumber(o.price, 0));
  const side: 'buy' | 'sell' = o.side === 'sell' ? 'sell' : 'buy';
  const date = typeof o.date === 'string' && o.date ? o.date : '';
  const id = typeof o.id === 'string' && o.id ? o.id : `t_${date}_${idx}_${shares}_${price}`;
  return { id, date, side, shares, price };
}

function sanitizeTrades(val: unknown): Trade[] {
  if (!Array.isArray(val)) return [];
  return val.map((t, i) => sanitizeTrade(t, i)).filter((t): t is Trade => t !== null);
}

/**
 * 統一正規化：清洗所有欄位、遷移舊資料（無 opening → 用舊 shares/avg_cost 當期初），
 * 並「重算衍生 shares/avg_cost」＝ aggregatePosition(opening, trades)。
 * getRebalanceConfig / saveRebalanceConfig 皆走此函式，確保頂層 shares/avg_cost 永遠與報價單一致
 *（告警腳本 rebalance_alert.cjs 讀頂層 shares/avg_cost，故此為單一事實來源）。
 */
function normalizeConfig(parsed: Record<string, unknown>): RebalanceConfig {
  const trades = sanitizeTrades(parsed.trades);

  // 遷移：舊資料無 opening 欄位時，用舊頂層 shares/avg_cost 作為期初部位（不丟失原持倉）
  let opening: { shares: number; avg_cost: number };
  const op = parsed.opening as Record<string, unknown> | undefined;
  if (op && typeof op === 'object') {
    opening = {
      shares: Math.max(0, safeNumber(op.shares, 0)),
      avg_cost: Math.max(0, safeNumber(op.avg_cost, 0)),
    };
  } else {
    opening = {
      shares: Math.max(0, safeNumber(parsed.shares, 0)),
      avg_cost: Math.max(0, safeNumber(parsed.avg_cost, 0)),
    };
  }

  const agg = aggregatePosition(opening, trades);

  return {
    shares: agg.shares,       // 衍生
    avg_cost: agg.avg_cost,   // 衍生
    price: Math.max(0, safeNumber(parsed.price, SEED_CONFIG.price)),
    cash: Math.max(0, safeNumber(parsed.cash, SEED_CONFIG.cash)),
    target_beta: safeNumber(parsed.target_beta, SEED_CONFIG.target_beta),
    tolerance_mode: safeMode(parsed.tolerance_mode),
    threshold_pct: Math.max(0, safeNumber(parsed.threshold_pct, SEED_CONFIG.threshold_pct)),
    threshold_abs: Math.max(0, safeNumber(parsed.threshold_abs, SEED_CONFIG.threshold_abs)),
    etf_beta: Math.max(0.1, safeNumber(parsed.etf_beta, SEED_CONFIG.etf_beta)),
    opening,
    trades,
  };
}

export function getRebalanceConfig(): RebalanceConfig {
  const dataStr = localStorage.getItem(KEY);
  if (dataStr === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
    return { ...SEED_CONFIG, opening: { ...SEED_CONFIG.opening }, trades: [] };
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed && typeof parsed === 'object') {
      return normalizeConfig(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse rebalance config from localStorage, resetting to seed data', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
  return { ...SEED_CONFIG, opening: { ...SEED_CONFIG.opening }, trades: [] };
}

export function saveRebalanceConfig(cfg: RebalanceConfig): void {
  // 一律走 normalizeConfig：重算衍生 shares/avg_cost，避免呼叫端傳入不一致的頂層值
  const sanitized = normalizeConfig(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(sanitized));
  window.dispatchEvent(new CustomEvent('userstore:rebalance'));
}

export function subscribeRebalance(cb: () => void): () => void {
  const handleCustomEvent = () => cb();
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === KEY) {
      cb();
    }
  };

  window.addEventListener('userstore:rebalance', handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener('userstore:rebalance', handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}
