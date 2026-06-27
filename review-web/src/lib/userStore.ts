// 使用者自管清單：純前端 localStorage，無後端。專案 1 建資料夾，專案 3 會在此加自選 watchlist。
const VERSION = 'v1';
const FOLDERS_KEY = `review:folders:${VERSION}`;

export interface UserStock {
  code: string;        // 台股代號，如 '2330'
  name: string;        // 加入當下解析到的股名（顯示用；空字串可接受）
  added_at: string;    // ISO 時間
  note?: string;
}

export type FolderId = 'holdings' | 'potential' | 'others';

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'holdings',  label: '我的持股' },
  { id: 'potential', label: '有潛力的' },
  { id: 'others',    label: '其他' },
];

export type FolderMap = Record<FolderId, UserStock[]>;

const SEED_DATA: FolderMap = {
  holdings: [],
  potential: [],
  others: [
    { code: '2330', name: '台積電', added_at: new Date().toISOString() },
    { code: '2454', name: '聯發科', added_at: new Date().toISOString() },
    { code: '2317', name: '鴻海', added_at: new Date().toISOString() },
  ],
};

// 讀取（含遷移/種子）
export function getFolders(): FolderMap {
  const dataStr = localStorage.getItem(FOLDERS_KEY);
  if (dataStr === null) {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(SEED_DATA));
    return JSON.parse(JSON.stringify(SEED_DATA));
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed && typeof parsed === 'object') {
      const folders: FolderMap = {
        holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
        potential: Array.isArray(parsed.potential) ? parsed.potential : [],
        others: Array.isArray(parsed.others) ? parsed.others : [],
      };
      return folders;
    }
  } catch (e) {
    console.error('Failed to parse folders from localStorage, resetting to seed data', e);
  }
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(SEED_DATA));
  return JSON.parse(JSON.stringify(SEED_DATA));
}

function saveFolders(folders: FolderMap): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  window.dispatchEvent(new CustomEvent('userstore:folders'));
}

// 加入
export function addToFolder(folder: FolderId, stock: UserStock): void {
  const folders = getFolders();
  const list = folders[folder] || [];
  // 去重：同一 code 在同一資料夾不重覆
  if (!list.some(s => s.code === stock.code)) {
    list.push(stock);
    folders[folder] = list;
    saveFolders(folders);
  }
}

// 移除
export function removeFromFolder(folder: FolderId, code: string): void {
  const folders = getFolders();
  const list = folders[folder] || [];
  const updatedList = list.filter(s => s.code !== code);
  if (list.length !== updatedList.length) {
    folders[folder] = updatedList;
    saveFolders(folders);
  }
}

// 跨資料夾移動
export function moveStock(from: FolderId, to: FolderId, code: string): void {
  const folders = getFolders();
  const fromList = folders[from] || [];
  const targetStock = fromList.find(s => s.code === code);
  if (targetStock) {
    folders[from] = fromList.filter(s => s.code !== code);
    const toList = folders[to] || [];
    if (!toList.some(s => s.code === code)) {
      toList.push({
        ...targetStock,
        added_at: new Date().toISOString(),
      });
      folders[to] = toList;
    }
    saveFolders(folders);
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

// 自選 watchlist 區
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
