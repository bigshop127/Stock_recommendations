const VERSION = 'v1';
const KEY = `review:rebalance:${VERSION}`;

export interface RebalanceConfig {
  shares: number;
  price: number;
  cash: number;
  target_beta: number;           // 預設 1.3
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑，預設 'abs'
  threshold_pct: number;         // 預設 10
  threshold_abs: number;         // 預設 0.1
  etf_beta: number;              // 預設 2.0
}

const SEED_CONFIG: RebalanceConfig = {
  shares: 0,
  price: 0,
  cash: 0,
  target_beta: 1.3,
  tolerance_mode: 'abs',
  threshold_pct: 10,
  threshold_abs: 0.1,
  etf_beta: 2.0,
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

export function getRebalanceConfig(): RebalanceConfig {
  const dataStr = localStorage.getItem(KEY);
  if (dataStr === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
    return { ...SEED_CONFIG };
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed && typeof parsed === 'object') {
      return {
        shares: Math.max(0, safeNumber(parsed.shares, SEED_CONFIG.shares)),
        price: Math.max(0, safeNumber(parsed.price, SEED_CONFIG.price)),
        cash: Math.max(0, safeNumber(parsed.cash, SEED_CONFIG.cash)),
        target_beta: safeNumber(parsed.target_beta, SEED_CONFIG.target_beta),
        tolerance_mode: safeMode(parsed.tolerance_mode),
        threshold_pct: Math.max(0, safeNumber(parsed.threshold_pct, SEED_CONFIG.threshold_pct)),
        threshold_abs: Math.max(0, safeNumber(parsed.threshold_abs, SEED_CONFIG.threshold_abs)),
        etf_beta: Math.max(0.1, safeNumber(parsed.etf_beta, SEED_CONFIG.etf_beta)),
      };
    }
  } catch (e) {
    console.error('Failed to parse rebalance config from localStorage, resetting to seed data', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
  return { ...SEED_CONFIG };
}

export function saveRebalanceConfig(cfg: RebalanceConfig): void {
  const sanitized: RebalanceConfig = {
    shares: Math.max(0, safeNumber(cfg.shares, 0)),
    price: Math.max(0, safeNumber(cfg.price, 0)),
    cash: Math.max(0, safeNumber(cfg.cash, 0)),
    target_beta: safeNumber(cfg.target_beta, 1.3),
    tolerance_mode: safeMode(cfg.tolerance_mode),
    threshold_pct: Math.max(0, safeNumber(cfg.threshold_pct, 10)),
    threshold_abs: Math.max(0, safeNumber(cfg.threshold_abs, 0.1)),
    etf_beta: Math.max(0.1, safeNumber(cfg.etf_beta, 2.0)),
  };
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
