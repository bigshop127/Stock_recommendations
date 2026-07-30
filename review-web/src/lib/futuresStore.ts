/**
 * futuresStore.ts — 期貨損益總覽的設定持久化（本機 localStorage ＋ 雲端 gateway）。
 *
 * 結構刻意比照 rebalanceStore：所有讀寫都過 normalizeFutures()，缺欄位補預設、
 * 型別不對就 clamp，避免舊資料或手改的雲端檔把頁面弄爆。雲端那份（gateway 的
 * data/futures_positions.json）為事實來源，本機這份是離線快取。
 */
import {
  DEFAULT_SPEC,
  CONTRACT_CODE,
  DEFAULT_STRESS_DROPS,
  type FuturesSpec,
  type FuturesPosition,
  type ClosedTrade,
  type Side,
  type EntryBatch,
} from './futures';

const VERSION = 'v1';
const KEY = `review:futures:${VERSION}`;

/** 建倉試算的參數（純規劃用，不影響實際部位的損益計算） */
export interface PlannerConfig {
  capital: number;           // 帳戶可用本金（空著＝沿用保證金專戶現金）
  target_leverage: number;   // 槓桿滑桿的位置（1.0～10.0）
  gain_pct: number;          // 上漲目標（0.2＝+20%）
  reserve_multiple: number;  // 出金時要留下的原始保證金倍數
  trailing_peak: number;     // 移動停損的參考最高價（0＝用目標價）
  trailing_dist: number;     // 回檔多少就出場（元／點）
  batches: EntryBatch[];     // 分批進場的價格與口數
  stress_drops: number[];    // 壓力測試的情境
}

export interface FuturesConfig {
  contract: string;          // 商品／期交所行情代碼（SRF / NYF / MTX / TMF，可自訂）
  price: number;             // 參考價／缺月份時的退路（抓期交所或手動輸入）
  prices: Record<string, number>; // 各到期月份的價格 'YYYYMM' → 價；抓行情時全部存下來
  price_month: string;       // price 對應的到期月份（抓價時帶回）
  price_as_of: string;       // 報價日期 'YYYY-MM-DD'
  cash: number;              // 保證金專戶現金餘額（入金 ± 已實現損益）
  index_ref: number;         // 現價當下的加權指數（用來把價格翻譯成大盤點數）
  beta: number;              // 標的相對大盤的連動係數（0050 約 1.0～1.1；台指期＝1）
  spec: FuturesSpec;         // 契約規格與費用設定
  positions: FuturesPosition[];
  closed: ClosedTrade[];
  stop_loss: Record<string, number>; // 每筆部位的停損價（key＝position id）
  planner: PlannerConfig;
}

export const DEFAULT_PLANNER: PlannerConfig = {
  capital: 0,
  target_leverage: 3,
  gain_pct: 0.2,
  reserve_multiple: 2.5,
  trailing_peak: 0,
  trailing_dist: 2,
  batches: [{ price: 0, lots: 0 }, { price: 0, lots: 0 }, { price: 0, lots: 0 }],
  stress_drops: [...DEFAULT_STRESS_DROPS],
};

const SEED: FuturesConfig = {
  contract: CONTRACT_CODE,
  price: 0,
  prices: {},
  price_month: '',
  price_as_of: '',
  cash: 0,
  index_ref: 0,
  beta: 1,
  spec: { ...DEFAULT_SPEC },
  positions: [],
  closed: [],
  stop_loss: {},
  planner: { ...DEFAULT_PLANNER },
};

export function seedFuturesConfig(): FuturesConfig {
  return {
    ...SEED,
    spec: { ...DEFAULT_SPEC },
    positions: [],
    closed: [],
    stop_loss: {},
    planner: { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] },
  };
}

function num(v: unknown, fb: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    if (Number.isFinite(p)) return p;
  }
  return fb;
}

function str(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}

function safeSide(v: unknown): Side {
  return v === 'short' ? 'short' : 'long';
}

// 月份一律正規化成 'YYYYMM'；'2026-08' / '2026/08' 這類輸入也接受
function safeMonth(v: unknown): string {
  const s = str(v).replace(/[^0-9]/g, '');
  return /^\d{6}$/.test(s) ? s : '';
}

function safeDate(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function sanitizeSpec(v: unknown): FuturesSpec {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    contract_size: Math.max(1, num(o.contract_size, DEFAULT_SPEC.contract_size)),
    tick_size: Math.max(0.0001, num(o.tick_size, DEFAULT_SPEC.tick_size)),
    initial_margin: Math.max(0, num(o.initial_margin, DEFAULT_SPEC.initial_margin)),
    maintenance_margin: Math.max(0, num(o.maintenance_margin, DEFAULT_SPEC.maintenance_margin)),
    fee_per_lot: Math.max(0, num(o.fee_per_lot, DEFAULT_SPEC.fee_per_lot)),
    tax_rate: Math.max(0, num(o.tax_rate, DEFAULT_SPEC.tax_rate)),
    rollover_days: Math.max(0, Math.round(num(o.rollover_days, DEFAULT_SPEC.rollover_days))),
    liquidation_ratio: Math.min(1, Math.max(0, num(o.liquidation_ratio, DEFAULT_SPEC.liquidation_ratio))),
  };
}

function sanitizePosition(v: unknown, i: number): FuturesPosition | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const month = safeMonth(o.month);
  if (!month) return null; // 沒有到期月份的部位無法算轉倉，直接丟掉
  const lots = Math.max(0, num(o.lots, 0));
  const entry_price = Math.max(0, num(o.entry_price, 0));
  const entry_date = safeDate(o.entry_date);
  const side = safeSide(o.side);
  const id = str(o.id) || `f_${month}_${side}_${i}_${lots}_${entry_price}`;
  const note = str(o.note);
  return { id, month, side, lots, entry_price, entry_date, ...(note ? { note } : {}) };
}

function sanitizeClosed(v: unknown, i: number): ClosedTrade | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const month = safeMonth(o.month);
  if (!month) return null;
  const lots = Math.max(0, num(o.lots, 0));
  const entry_price = Math.max(0, num(o.entry_price, 0));
  const exit_price = Math.max(0, num(o.exit_price, 0));
  const exit_date = safeDate(o.exit_date);
  const side = safeSide(o.side);
  const id = str(o.id) || `c_${month}_${side}_${i}_${lots}_${exit_price}`;
  const note = str(o.note);
  return { id, month, side, lots, entry_price, exit_price, exit_date, ...(note ? { note } : {}) };
}

function sanitizeBatches(v: unknown): EntryBatch[] {
  const arr = Array.isArray(v) ? v : [];
  const out: EntryBatch[] = arr.slice(0, 6).map((b) => {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return { price: Math.max(0, num(o.price, 0)), lots: Math.max(0, num(o.lots, 0)) };
  });
  // 一律補滿 3 格，UI 才有固定的三張卡可以填
  while (out.length < 3) out.push({ price: 0, lots: 0 });
  return out;
}

// 負值＝上漲情境（空單看的是那一側），故區間是 (−1, 1) 而不是 (0, 1)
function sanitizeDrops(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  const out = [...new Set(arr
    .map((d) => num(d, NaN))
    .filter((d) => Number.isFinite(d) && d > -1 && d < 1 && d !== 0))]
    .slice(0, 14)
    .sort((a, b) => a - b);
  return out.length > 0 ? out : [...DEFAULT_PLANNER.stress_drops];
}

/** 各月份報價：key 必須是 'YYYYMM'，價格必須 > 0，否則丟掉 */
function sanitizePrices(v: unknown): Record<string, number> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    const m = safeMonth(k);
    if (!m) continue;
    const p = num(val, 0);
    if (p > 0) out[m] = p;
  }
  return out;
}

function sanitizePlanner(v: unknown): PlannerConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    capital: Math.max(0, num(o.capital, DEFAULT_PLANNER.capital)),
    target_leverage: Math.min(10, Math.max(0.1, num(o.target_leverage, DEFAULT_PLANNER.target_leverage))),
    gain_pct: Math.min(5, Math.max(-0.9, num(o.gain_pct, DEFAULT_PLANNER.gain_pct))),
    reserve_multiple: Math.min(10, Math.max(1, num(o.reserve_multiple, DEFAULT_PLANNER.reserve_multiple))),
    trailing_peak: Math.max(0, num(o.trailing_peak, DEFAULT_PLANNER.trailing_peak)),
    trailing_dist: Math.max(0, num(o.trailing_dist, DEFAULT_PLANNER.trailing_dist)),
    batches: sanitizeBatches(o.batches),
    stress_drops: sanitizeDrops(o.stress_drops),
  };
}

export function normalizeFutures(parsed: Record<string, unknown>): FuturesConfig {
  const positions = (Array.isArray(parsed.positions) ? parsed.positions : [])
    .map((p, i) => sanitizePosition(p, i))
    .filter((p): p is FuturesPosition => p !== null);
  const closed = (Array.isArray(parsed.closed) ? parsed.closed : [])
    .map((t, i) => sanitizeClosed(t, i))
    .filter((t): t is ClosedTrade => t !== null);

  // 停損價只保留還存在的部位，避免刪了部位後留下孤兒設定
  const ids = new Set(positions.map((p) => p.id));
  const stopIn = (parsed.stop_loss && typeof parsed.stop_loss === 'object'
    ? parsed.stop_loss : {}) as Record<string, unknown>;
  const stop_loss: Record<string, number> = {};
  for (const [k, v] of Object.entries(stopIn)) {
    if (!ids.has(k)) continue;
    const p = num(v, 0);
    if (p > 0) stop_loss[k] = p;
  }

  return {
    contract: (str(parsed.contract, CONTRACT_CODE) || CONTRACT_CODE).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || CONTRACT_CODE,
    price: Math.max(0, num(parsed.price, 0)),
    prices: sanitizePrices(parsed.prices),
    price_month: safeMonth(parsed.price_month),
    price_as_of: safeDate(parsed.price_as_of),
    cash: num(parsed.cash, 0), // 權益數可以是負的（穿價），不 clamp
    index_ref: Math.max(0, num(parsed.index_ref, 0)),
    beta: Math.min(5, Math.max(0.01, num(parsed.beta, 1))),
    spec: sanitizeSpec(parsed.spec),
    positions,
    closed,
    stop_loss,
    planner: sanitizePlanner(parsed.planner),
  };
}

export function getFuturesConfig(): FuturesConfig {
  const raw = localStorage.getItem(KEY);
  if (raw === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED));
    return seedFuturesConfig();
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return normalizeFutures(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse futures config from localStorage, resetting to seed', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED));
  return seedFuturesConfig();
}

export function saveFuturesConfig(cfg: FuturesConfig): void {
  const clean = normalizeFutures(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(clean));
  window.dispatchEvent(new CustomEvent('userstore:futures'));
}

export function subscribeFutures(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener('userstore:futures', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('userstore:futures', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
