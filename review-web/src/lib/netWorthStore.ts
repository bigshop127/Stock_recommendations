/**
 * netWorthStore.ts — 淨資產快照的設定持久化（本機 localStorage ＋ 雲端 gateway）。
 *
 * 結構比照 stockRealizedStore.ts：所有讀寫都過 normalizeNetWorth()，缺欄位補
 * 預設、型別不對就 clamp。雲端那份（gateway 的 data/networth_snapshots.json）
 * 為事實來源，本機這份是離線快取。
 */
import { type NetWorthSnapshot } from './netWorth';

const VERSION = 'v1';
const KEY = `review:networth:${VERSION}`;

export interface NetWorthConfig {
  snapshots: NetWorthSnapshot[];
}

const SEED: NetWorthConfig = { snapshots: [] };

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

export function sanitizeSnapshot(v: unknown, i: number): NetWorthSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const date = safeDate(o.date);
  if (!date) return null;
  const id = str(o.id) || `nw_${date}_${i}`;
  const note = str(o.note).slice(0, 100);
  return {
    id,
    date,
    bank: Math.max(0, num(o.bank, 0)),
    stock_cash: Math.max(0, num(o.stock_cash, 0)),
    stock_pending_settlement: num(o.stock_pending_settlement, 0),
    stock_holdings_value: Math.max(0, num(o.stock_holdings_value, 0)),
    futures_equity: num(o.futures_equity, 0),
    ...(note ? { note } : {}),
  };
}

export function normalizeNetWorth(parsed: Record<string, unknown>): NetWorthConfig {
  const map = new Map<string, NetWorthSnapshot>();
  (Array.isArray(parsed.snapshots) ? parsed.snapshots : []).forEach((s, i) => {
    const item = sanitizeSnapshot(s, i);
    if (item) map.set(item.date, item);
  });
  const snapshots = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { snapshots };
}

export function getNetWorthConfig(): NetWorthConfig {
  const raw = localStorage.getItem(KEY);
  if (raw === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED));
    return { snapshots: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return normalizeNetWorth(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse net-worth config from localStorage, resetting to seed', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED));
  return { snapshots: [] };
}

export function saveNetWorthConfig(cfg: NetWorthConfig): void {
  const clean = normalizeNetWorth(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(clean));
  window.dispatchEvent(new CustomEvent('userstore:networth'));
}

export function subscribeNetWorth(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener('userstore:networth', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('userstore:networth', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
