// 使用者自管清單：資料夾清單＋內容雲端持久化（2026-08-30 起，data/stock_folders.json），
// localStorage 僅作即時快取／離線 fallback，避免每次網站改版清瀏覽器快取時分類全部消失。
// 專案 3 的自選 watchlist 仍是純 localStorage（用途不同，未跟著搬雲端）。
import { api } from './api';

const VERSION = 'v2';
const FOLDERS_KEY = `review:folders:${VERSION}`;
const LEGACY_FOLDERS_KEY = 'review:folders:v1';

export interface UserStock {
  code: string;        // 台股代號，如 '2330'
  name: string;        // 加入當下解析到的股名（顯示用；空字串可接受）
  added_at: string;    // ISO 時間
  note?: string;
}

export type FolderId = string;

export interface FolderDef {
  id: FolderId;
  label: string;
}

export type FolderMap = Record<FolderId, UserStock[]>;

interface FoldersState {
  folders: FolderDef[];
  stocks: FolderMap;
}

const DEFAULT_FOLDERS: FolderDef[] = [
  { id: 'holdings', label: '我的持股' },
  { id: 'potential', label: '有潛力的' },
  { id: 'others', label: '其他' },
];

const SEED_DATA: FoldersState = {
  folders: DEFAULT_FOLDERS,
  stocks: {
    holdings: [],
    potential: [],
    others: [
      { code: '2330', name: '台積電', added_at: new Date().toISOString() },
      { code: '2454', name: '聯發科', added_at: new Date().toISOString() },
      { code: '2317', name: '鴻海', added_at: new Date().toISOString() },
    ],
  },
};

function migrateLegacy(): FoldersState | null {
  const legacy = localStorage.getItem(LEGACY_FOLDERS_KEY);
  if (!legacy) return null;
  try {
    const parsed = JSON.parse(legacy);
    if (parsed && typeof parsed === 'object') {
      return {
        folders: DEFAULT_FOLDERS,
        stocks: {
          holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
          potential: Array.isArray(parsed.potential) ? parsed.potential : [],
          others: Array.isArray(parsed.others) ? parsed.others : [],
        },
      };
    }
  } catch {
    // 舊資料壞掉就當作沒有，往下走種子資料
  }
  return null;
}

function readLocal(): FoldersState {
  const dataStr = localStorage.getItem(FOLDERS_KEY);
  if (dataStr === null) {
    const migrated = migrateLegacy();
    const initial = migrated || JSON.parse(JSON.stringify(SEED_DATA));
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(initial));
    return initial;
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.folders)) {
      const stocks: FolderMap = {};
      for (const f of parsed.folders) {
        stocks[f.id] = Array.isArray(parsed.stocks?.[f.id]) ? parsed.stocks[f.id] : [];
      }
      return { folders: parsed.folders, stocks };
    }
  } catch (e) {
    console.error('Failed to parse folders from localStorage, resetting to seed data', e);
  }
  const seed = JSON.parse(JSON.stringify(SEED_DATA));
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(seed));
  return seed;
}

let state: FoldersState = readLocal();

function persist(next: FoldersState, opts: { skipCloud?: boolean } = {}): void {
  state = next;
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('userstore:folders'));
  if (!opts.skipCloud) {
    // fire-and-forget：本地已經是事實來源的即時快取，雲端失敗不影響當下操作，
    // 只在下次 loadFoldersFromCloud() 時可能撈到舊資料（比照 RealizedPnl.tsx saveToCloud 的模式）
    void api.saveStockFolders(next).catch((e) => {
      console.error('儲存資料夾設定到雲端失敗（本地已儲存，不影響當下使用）', e);
    });
  }
}

/** 頁面啟動時呼叫一次：雲端有資料就覆蓋本地快取（成功後不再自動輪詢） */
export async function loadFoldersFromCloud(): Promise<void> {
  try {
    const resp = await api.getStockFolders();
    if (resp.exists && resp.data && Array.isArray(resp.data.folders) && resp.data.folders.length > 0) {
      const cloudFolders = resp.data.folders as FolderDef[];
      const cloudStocksRaw = (resp.data.stocks || {}) as Record<string, UserStock[]>;
      const stocks: FolderMap = {};
      for (const f of cloudFolders) stocks[f.id] = Array.isArray(cloudStocksRaw[f.id]) ? cloudStocksRaw[f.id] : [];
      persist({ folders: cloudFolders, stocks }, { skipCloud: true });
    }
  } catch (e) {
    console.error('讀取雲端資料夾設定失敗，沿用本地快取', e);
  }
}

export function getFolderList(): FolderDef[] {
  return state.folders;
}

// 讀取（含遷移/種子）
export function getFolders(): FolderMap {
  return state.stocks;
}

/**
 * 產生 ASCII-only 的隨機資料夾 id（跟 label 內容無關，中文資料夾名稱不會反映在 id 裡）。
 * 這裡刻意不從中文 label 直接 slugify——後端 routes/stock_folders.js 的 safeFolderId()
 * 只允許 [a-z0-9_-]（比照其餘既有資料夾 id 如 holdings/potential/others 的 ASCII 慣例），
 * 若 id 帶中文字會被後端 sanitize 整條拿掉，導致新增的資料夾在雲端存檔時被靜靜丟棄。
 */
function randomFolderId(): FolderId {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 新增資料夾，回傳新資料夾 id。 */
export function addFolder(label: string): FolderId {
  const trimmed = label.trim().slice(0, 30) || '未命名資料夾';
  let id = randomFolderId();
  while (state.folders.some((f) => f.id === id)) {
    id = randomFolderId();
  }
  const nextFolders = [...state.folders, { id, label: trimmed }];
  const nextStocks = { ...state.stocks, [id]: [] };
  persist({ folders: nextFolders, stocks: nextStocks });
  return id;
}

export function renameFolder(id: FolderId, label: string): void {
  const trimmed = label.trim().slice(0, 30);
  if (!trimmed) return;
  const nextFolders = state.folders.map((f) => (f.id === id ? { ...f, label: trimmed } : f));
  persist({ folders: nextFolders, stocks: state.stocks });
}

/** 刪除資料夾（含其中個股）。至少保留 1 個資料夾，最後一個時拒絕刪除並回傳 false。 */
export function deleteFolder(id: FolderId): boolean {
  if (state.folders.length <= 1) return false;
  const nextFolders = state.folders.filter((f) => f.id !== id);
  const nextStocks = { ...state.stocks };
  delete nextStocks[id];
  persist({ folders: nextFolders, stocks: nextStocks });
  return true;
}

// 加入
export function addToFolder(folder: FolderId, stock: UserStock): void {
  const list = state.stocks[folder] || [];
  // 去重：同一 code 在同一資料夾不重覆
  if (!list.some((s) => s.code === stock.code)) {
    const nextStocks = { ...state.stocks, [folder]: [...list, stock] };
    persist({ folders: state.folders, stocks: nextStocks });
  }
}

// 移除
export function removeFromFolder(folder: FolderId, code: string): void {
  const list = state.stocks[folder] || [];
  const updatedList = list.filter((s) => s.code !== code);
  if (list.length !== updatedList.length) {
    const nextStocks = { ...state.stocks, [folder]: updatedList };
    persist({ folders: state.folders, stocks: nextStocks });
  }
}

// 跨資料夾移動
export function moveStock(from: FolderId, to: FolderId, code: string): void {
  const fromList = state.stocks[from] || [];
  const targetStock = fromList.find((s) => s.code === code);
  if (targetStock) {
    const toList = state.stocks[to] || [];
    const nextStocks = { ...state.stocks, [from]: fromList.filter((s) => s.code !== code) };
    if (!toList.some((s) => s.code === code)) {
      nextStocks[to] = [...toList, { ...targetStock, added_at: new Date().toISOString() }];
    } else {
      nextStocks[to] = toList;
    }
    persist({ folders: state.folders, stocks: nextStocks });
  }
}

// 訂閱變更
export function subscribeFolders(cb: () => void): () => void {
  const handleCustomEvent = () => cb();
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === FOLDERS_KEY) {
      cb();
    }
  };

  window.addEventListener('userstore:folders', handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener('userstore:folders', handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}

// 自選 watchlist 區（純前端 localStorage，未跟著搬雲端——用途與資料夾不同，見檔頭註解）
const WATCHLIST_KEY = `review:watchlist:${VERSION}`;

export function getUserWatchlist(): UserStock[] {
  const dataStr = localStorage.getItem(WATCHLIST_KEY);
  if (dataStr === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    console.error('Failed to parse watchlist from localStorage', e);
  }
  return [];
}

function saveUserWatchlist(watchlist: UserStock[]): void {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
  window.dispatchEvent(new CustomEvent('userstore:watchlist'));
}

export function addToWatchlist(stock: UserStock): void {
  const watchlist = getUserWatchlist();
  if (!watchlist.some(s => s.code === stock.code)) {
    watchlist.push(stock);
    saveUserWatchlist(watchlist);
  }
}

export function removeFromWatchlist(code: string): void {
  const watchlist = getUserWatchlist();
  const updated = watchlist.filter(s => s.code !== code);
  if (watchlist.length !== updated.length) {
    saveUserWatchlist(updated);
  }
}

export function subscribeWatchlist(cb: () => void): () => void {
  const handleCustomEvent = () => cb();
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === WATCHLIST_KEY) {
      cb();
    }
  };

  window.addEventListener('userstore:watchlist', handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener('userstore:watchlist', handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}
