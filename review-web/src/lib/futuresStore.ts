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
  type FuturesSpec,
  type FuturesPosition,
  type ClosedTrade,
  type Side,
} from './futures';

const VERSION = 'v1';
const KEY = `review:futures:${VERSION}`;

export interface FuturesConfig {
  contract: string;          // 商品代碼（目前只做 SRF，保留欄位以後可擴充大型 NYF）
  price: number;             // 現在價格（抓期交所或手動輸入）
  price_month: string;       // price 對應的到期月份（抓價時帶回）
  price_as_of: string;       // 報價日期 'YYYY-MM-DD'
  cash: number;              // 保證金專戶現金餘額（入金 ± 已實現損益）
  spec: FuturesSpec;         // 契約規格與費用設定
  positions: FuturesPosition[];
  closed: ClosedTrade[];
  stop_loss: Record<string, number>; // 每筆部位的停損價（key＝position id）
}

const SEED: FuturesConfig = {
  contract: CONTRACT_CODE,
  price: 0,
  price_month: '',
  price_as_of: '',
  cash: 0,
  spec: { ...DEFAULT_SPEC },
  positions: [],
  closed: [],
  stop_loss: {},
};

export function seedFuturesConfig(): FuturesConfig {
  return {
    ...SEED,
    spec: { ...DEFAULT_SPEC },
    positions: [],
    closed: [],
    stop_loss: {},
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
    contract: str(parsed.contract, CONTRACT_CODE) || CONTRACT_CODE,
    price: Math.max(0, num(parsed.price, 0)),
    price_month: safeMonth(parsed.price_month),
    price_as_of: safeDate(parsed.price_as_of),
    cash: num(parsed.cash, 0), // 權益數可以是負的（穿價），不 clamp
    spec: sanitizeSpec(parsed.spec),
    positions,
    closed,
    stop_loss,
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
