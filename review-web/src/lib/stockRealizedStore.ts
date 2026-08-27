/**
 * stockRealizedStore.ts — 個股／ETF 已實現損益的設定持久化（本機 localStorage ＋ 雲端 gateway）。
 *
 * 結構刻意比照 futuresStore.ts：所有讀寫都過 normalizeStockRealized()，缺欄位補
 * 預設、型別不對就 clamp，避免舊資料或手改的雲端檔把頁面弄爆。雲端那份（gateway 的
 * data/stock_realized_trades.json）為事實來源，本機這份是離線快取。
 */
import {
  DEFAULT_FEE_RATES,
  detectKind,
  type FeeRates,
  type Side,
  type StockKind,
  type StockRealizedTrade,
} from './stockRealized';

const MAX_IMPORTED_REFS = 300;
const VERSION = 'v1';
const KEY = `review:stock-realized:${VERSION}`;

export interface StockRealizedConfig {
  trades: StockRealizedTrade[];
  fee_rates: FeeRates;
  /** 截圖匯入已經吃過的成交指紋（見 stockRealizedImport.ts） */
  imported_refs: string[];
}

const SEED: StockRealizedConfig = {
  trades: [],
  fee_rates: { ...DEFAULT_FEE_RATES },
  imported_refs: [],
};

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

function safeDate(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function safeSide(v: unknown): Side {
  return v === 'short' ? 'short' : 'long';
}

function safeSymbol(v: unknown): string {
  return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function safeKind(v: unknown, symbol: string): StockKind {
  return v === 'etf' || v === 'stock' ? v : detectKind(symbol);
}

/** 券商實收費用：非負有限數才留，其餘 null＝沒這個資料，請用費率設定推估 */
function feeOrNull(v: unknown): number | null {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function safeRef(v: unknown): string {
  return str(v).slice(0, 160);
}

export function sanitizeFeeRates(v: unknown): FeeRates {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    fee_rate: Math.min(0.01, Math.max(0, num(o.fee_rate, DEFAULT_FEE_RATES.fee_rate))),
    fee_discount: Math.min(1, Math.max(0, num(o.fee_discount, DEFAULT_FEE_RATES.fee_discount))),
    stock_tax_rate: Math.min(0.01, Math.max(0, num(o.stock_tax_rate, DEFAULT_FEE_RATES.stock_tax_rate))),
    etf_tax_rate: Math.min(0.01, Math.max(0, num(o.etf_tax_rate, DEFAULT_FEE_RATES.etf_tax_rate))),
  };
}

export function sanitizeTrade(v: unknown, i: number): StockRealizedTrade | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const symbol = safeSymbol(o.symbol);
  if (!symbol) return null;
  const sell_date = safeDate(o.sell_date);
  if (!sell_date) return null; // 沒有賣出日就沒辦法歸到哪個月份/區間，直接丟掉
  const qty = Math.max(0, num(o.qty, 0));
  const buy_price = Math.max(0, num(o.buy_price, 0));
  const sell_price = Math.max(0, num(o.sell_price, 0));
  const buy_date = safeDate(o.buy_date);
  const side = safeSide(o.side);
  const kind = safeKind(o.kind, symbol);
  const name = str(o.name).slice(0, 40) || symbol;
  const id = str(o.id) || `s_${symbol}_${sell_date}_${side}_${i}_${qty}_${sell_price}`;
  const note = str(o.note).slice(0, 100);
  const ref = safeRef(o.ref);
  const fee = feeOrNull(o.fee);
  const tax = feeOrNull(o.tax);
  return {
    id, symbol, name, kind, side, qty, buy_price, sell_price, buy_date, sell_date,
    fee, tax,
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
  };
}

/** 匯入指紋帳本：字串、去重、只留最近 MAX_IMPORTED_REFS 筆，免得雲端檔無限長大 */
function sanitizeRefs(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out = arr.map((x) => str(x).slice(0, 160)).filter(Boolean);
  return [...new Set(out)].slice(-MAX_IMPORTED_REFS);
}

export function normalizeStockRealized(parsed: Record<string, unknown>): StockRealizedConfig {
  const trades = (Array.isArray(parsed.trades) ? parsed.trades : [])
    .map((t, i) => sanitizeTrade(t, i))
    .filter((t): t is StockRealizedTrade => t !== null)
    .sort((a, b) => (a.sell_date < b.sell_date ? -1 : a.sell_date > b.sell_date ? 1 : 0));
  return {
    trades,
    fee_rates: sanitizeFeeRates(parsed.fee_rates),
    imported_refs: sanitizeRefs(parsed.imported_refs),
  };
}

export function seedStockRealizedConfig(): StockRealizedConfig {
  return { trades: [], fee_rates: { ...DEFAULT_FEE_RATES }, imported_refs: [] };
}

export function getStockRealizedConfig(): StockRealizedConfig {
  const raw = localStorage.getItem(KEY);
  if (raw === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED));
    return seedStockRealizedConfig();
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return normalizeStockRealized(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse stock-realized config from localStorage, resetting to seed', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED));
  return seedStockRealizedConfig();
}

export function saveStockRealizedConfig(cfg: StockRealizedConfig): void {
  const clean = normalizeStockRealized(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(clean));
  window.dispatchEvent(new CustomEvent('userstore:stock-realized'));
}

export function subscribeStockRealized(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener('userstore:stock-realized', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('userstore:stock-realized', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
