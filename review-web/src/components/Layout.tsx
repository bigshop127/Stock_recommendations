import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  TrendingUp,
  BarChart2,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Trash2,
  Plus,
  X,
  MoreHorizontal,
  Pencil,
  Check,
  Waves,
  LayoutGrid,
  SlidersHorizontal,
  Activity,
  ListOrdered,
  Wallet
} from 'lucide-react';
import { api } from '../lib/api';
import type { Health } from '../lib/api';
import {
  getFolders,
  getFolderList,
  loadFoldersFromCloud,
  removeFromFolder,
  subscribeFolders,
  moveStock,
  addToFolder,
  addFolder,
  renameFolder,
  deleteFolder
} from '../lib/userStore';
import type { FolderId } from '../lib/userStore';
import { SymbolSearch } from './SymbolSearch';

interface LayoutProps {
  children: React.ReactNode;
}

/**
 * 完全不依賴 Python engine 的頁面——engine 掛掉時不該在這些頁面掛降級紅字。
 * 期貨頁的三個資料來源（期交所行情、gateway 的部位檔、證交所休市日曆）都在
 * Node gateway 裡，engine 死活跟它無關。
 *
 * 注意再平衡頁**不在**這個名單：它的「抓最新價」走 /api/stocks/:code/ohlcv，
 * 那條是 engine 的代理。
 */
const ENGINE_FREE_PATHS = new Set(['/futures', '/net-worth']);

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const match = location.pathname.match(/^\/stock\/([a-zA-Z0-9]+)/);
  const activeCode = match ? match[1] : null;
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState(() => getFolders());
  const [folderList, setFolderList] = useState(() => getFolderList());
  const [isStocksMenuOpen, setIsStocksMenuOpen] = useState(() => {
    const stored = localStorage.getItem('review:menu:expanded');
    if (stored !== null) return stored === 'true';
    return window.innerWidth >= 768;
  });
  const [expandedFolders, setExpandedFolders] = useState<Record<FolderId, boolean>>(() => {
    const stored = localStorage.getItem('review:folders:expanded');
    if (stored !== null) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        // ignore
      }
    }
    return { holdings: true, potential: true, others: true };
  });

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const data = await api.health();
        setHealth(data);
      } catch (err) {
        console.error('Failed to fetch health status:', err);
        setHealth(null);
      } finally {
        setLoading(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000); // 10s intervals
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeFolders(() => {
      setFolders(getFolders());
      setFolderList(getFolderList());
    });
    return unsubscribe;
  }, []);

  // 頁面啟動時撈一次雲端資料夾設定（成功會覆蓋本地快取並觸發上面的 subscribeFolders）
  useEffect(() => {
    void loadFoldersFromCloud();
  }, []);

  useEffect(() => {
    localStorage.setItem('review:menu:expanded', String(isStocksMenuOpen));
  }, [isStocksMenuOpen]);

  useEffect(() => {
    localStorage.setItem('review:folders:expanded', JSON.stringify(expandedFolders));
  }, [expandedFolders]);

  const [activeSearchFolder, setActiveSearchFolder] = useState<FolderId | null>(null);
  const [activeDropdownStock, setActiveDropdownStock] = useState<{ folderId: FolderId; code: string } | null>(null);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<FolderId | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const submitNewFolder = () => {
    const label = newFolderName.trim();
    if (label) addFolder(label);
    setNewFolderName('');
    setIsAddingFolder(false);
  };

  const submitRename = (id: FolderId) => {
    const label = renameValue.trim();
    if (label) renameFolder(id, label);
    setRenamingFolderId(null);
    setRenameValue('');
  };

  const handleDeleteFolder = (f: { id: FolderId; label: string }) => {
    const count = (folders[f.id] || []).length;
    const msg = count > 0
      ? `確定要刪除資料夾「${f.label}」嗎？裡面的 ${count} 檔個股會一併移除。`
      : `確定要刪除資料夾「${f.label}」嗎？`;
    if (!window.confirm(msg)) return;
    const ok = deleteFolder(f.id);
    if (!ok) window.alert('至少要保留一個資料夾，無法刪除最後一個。');
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      setActiveDropdownStock(null);
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  const toggleFolder = (folderId: FolderId) => {
    setExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  return (
    <div className="min-h-screen bg-background text-zinc-100 flex flex-col md:flex-row">
      {/* 側邊欄 Sidebar (桌面端顯示，行動端小螢幕警告) */}
      <aside className="w-full md:w-64 bg-card border-b md:border-b-0 md:border-r border-border flex flex-col justify-between shrink-0">
        <div>
          {/* Logo / 標題 */}
          <div className="p-6 border-b border-border flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center font-bold text-white shadow-md">
              審
            </div>
            <div>
              <h1 className="font-semibold text-zinc-100 tracking-tight">個股全面審視網</h1>
              <span className="text-xs text-zinc-500 font-mono">PWA Desktop & Mobile</span>
            </div>
          </div>

          {/* 導覽連結 */}
          <nav className="p-4 space-y-1">
            {/* 大盤與籌碼總覽 */}
            <Link
              to="/"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <TrendingUp className="w-5 h-5" />
              大盤與籌碼總覽
            </Link>

            {/* 資金潮汐 */}
            <Link
              to="/tide"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/tide'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <Waves className="w-5 h-5" />
              資金潮汐
            </Link>

            {/* 產業熱力圖 */}
            <Link
              to="/heatmap"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/heatmap'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <LayoutGrid className="w-5 h-5" />
              產業熱力圖
            </Link>

            {/* 再平衡計算機 */}
            <Link
              to="/rebalance"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/rebalance'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <SlidersHorizontal className="w-5 h-5" />
              再平衡計算機
            </Link>

            {/* 期貨損益總覽（2026-07-29 取代崩盤策略回測的位置） */}
            <Link
              to="/futures"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/futures'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <Activity className="w-5 h-5" />
              期貨損益總覽
            </Link>

            {/* 已實現損益總覽（opt36：期貨＋個股＋ETF 統一彙總與篩選） */}
            <Link
              to="/realized-pnl"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/realized-pnl'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <ListOrdered className="w-5 h-5" />
              已實現損益總覽
            </Link>

            {/* 資產變化圖（2026-08-28：銀行＋股市＋期貨統整成淨資產，含長期歷史線圖） */}
            <Link
              to="/net-worth"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/net-worth'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <Wallet className="w-5 h-5" />
              資產變化圖
            </Link>

            {/* 個股多維度審查 折疊選單 */}
            <div className="space-y-1">
              <button
                onClick={() => setIsStocksMenuOpen(!isStocksMenuOpen)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                  location.pathname.startsWith('/stock/')
                    ? 'text-zinc-200 font-medium'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
              >
                <div className="flex items-center gap-3">
                  <BarChart2 className="w-5 h-5" />
                  <span>個股多維度審查</span>
                </div>
                {isStocksMenuOpen ? (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-zinc-500" />
                )}
              </button>

              {/* 資料夾樹與股票列表 */}
              {isStocksMenuOpen && (
                <div className="pl-4 space-y-2 mt-1 border-l border-zinc-800/80 ml-6">
                  {folderList.map((f) => {
                    const isExpanded = expandedFolders[f.id] ?? true;
                    const stocks = folders[f.id] || [];
                    const isRenaming = renamingFolderId === f.id;
                    return (
                      <div key={f.id} className="space-y-1">
                        {/* 資料夾標頭 */}
                        <div className="group/folder flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/20 text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition-colors">
                          {isRenaming ? (
                            <div className="flex-1 flex items-center gap-1">
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') submitRename(f.id);
                                  if (e.key === 'Escape') setRenamingFolderId(null);
                                }}
                                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                              />
                              <button onClick={() => submitRename(f.id)} className="text-zinc-400 hover:text-zinc-200 p-0.5">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => setRenamingFolderId(null)} className="text-zinc-500 hover:text-zinc-300 p-0.5">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => toggleFolder(f.id)}
                              className="flex-1 flex items-center gap-1.5 text-left"
                            >
                              {isExpanded ? (
                                <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                              ) : (
                                <Folder className="w-3.5 h-3.5 text-zinc-400" />
                              )}
                              <span>
                                {f.label} ({stocks.length})
                              </span>
                            </button>
                          )}
                          {!isRenaming && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setActiveSearchFolder(activeSearchFolder === f.id ? null : f.id);
                                }}
                                className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all duration-150"
                                title="加入個股"
                              >
                                {activeSearchFolder === f.id ? (
                                  <X className="w-3 h-3" />
                                ) : (
                                  <Plus className="w-3 h-3" />
                                )}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setRenamingFolderId(f.id);
                                  setRenameValue(f.label);
                                }}
                                className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all duration-150"
                                title="重新命名資料夾"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDeleteFolder(f);
                                }}
                                className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-all duration-150"
                                title="刪除資料夾"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => toggleFolder(f.id)}
                                className="text-zinc-500"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3 h-3 text-zinc-500" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-zinc-500" />
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* 資料夾內搜尋框 */}
                        {activeSearchFolder === f.id && (
                          <div className="p-2 bg-zinc-900/50 rounded border border-zinc-800/80 my-1 mx-2">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[10px] text-zinc-500 font-semibold">搜尋股票加入 {f.label}</span>
                              <button
                                onClick={() => setActiveSearchFolder(null)}
                                className="text-zinc-500 hover:text-zinc-300"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <SymbolSearch
                              autoFocus
                              onPick={(hit) => {
                                addToFolder(f.id, {
                                  code: hit.code,
                                  name: hit.name,
                                  added_at: new Date().toISOString(),
                                });
                                setActiveSearchFolder(null);
                              }}
                            />
                          </div>
                        )}

                        {/* 資料夾內個股 */}
                        {isExpanded && (
                          <div className="pl-3.5 space-y-0.5">
                            {stocks.length === 0 ? (
                              <div className="py-1 px-2 text-[11px] text-zinc-600 italic">
                                尚無個股（用搜尋加入）
                              </div>
                            ) : (
                              stocks.map((stock) => {
                                const stockPath = `/stock/${stock.code}`;
                                const isStockActive = activeCode === stock.code;
                                return (
                                  <div
                                    key={stock.code}
                                    className={`group flex items-center justify-between rounded px-2 py-1 text-xs transition-all duration-150 ${
                                      isStockActive
                                        ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm font-medium'
                                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/30'
                                    }`}
                                  >
                                    <Link
                                      to={stockPath}
                                      className="flex-1 truncate mr-2"
                                    >
                                      {stock.name ? `${stock.name} ${stock.code}` : stock.code}
                                    </Link>
                                    <div className="flex items-center">
                                      {/* 移動至其他資料夾 */}
                                      <div className="relative">
                                        <button
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setActiveDropdownStock(
                                              activeDropdownStock?.code === stock.code && activeDropdownStock?.folderId === f.id
                                                ? null
                                                : { folderId: f.id, code: stock.code }
                                            );
                                          }}
                                          className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-all duration-150 mr-1"
                                          title="移動至其他資料夾"
                                        >
                                          <MoreHorizontal className="w-3.5 h-3.5" />
                                        </button>
                                        {activeDropdownStock?.code === stock.code && activeDropdownStock?.folderId === f.id && (
                                          <div className="absolute right-0 top-6 z-50 bg-zinc-900 border border-zinc-800 rounded shadow-xl py-1 w-44 text-[11px]">
                                            <div className="px-2 py-1 text-zinc-500 font-semibold border-b border-zinc-800">
                                              移動至（單選）：
                                            </div>
                                            {folderList.filter(dest => dest.id !== f.id).map(dest => (
                                              <button
                                                key={dest.id}
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  moveStock(f.id, dest.id, stock.code);
                                                  setActiveDropdownStock(null);
                                                }}
                                                className="w-full text-left px-2 py-1 hover:bg-primary/20 hover:text-primary transition-colors text-zinc-300"
                                              >
                                                {dest.label}
                                              </button>
                                            ))}
                                            <div className="px-2 py-1 text-zinc-500 font-semibold border-t border-b border-zinc-800 mt-1">
                                              同時加入（可複選）：
                                            </div>
                                            {folderList.filter(dest => dest.id !== f.id).map(dest => {
                                              const checked = (folders[dest.id] || []).some(s => s.code === stock.code);
                                              return (
                                                <button
                                                  key={`copy-${dest.id}`}
                                                  onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (checked) removeFromFolder(dest.id, stock.code);
                                                    else addToFolder(dest.id, { code: stock.code, name: stock.name, added_at: new Date().toISOString() });
                                                  }}
                                                  className="w-full flex items-center justify-between px-2 py-1 hover:bg-zinc-800/60 text-left text-zinc-300 transition-colors"
                                                >
                                                  <span className="truncate">{dest.label}</span>
                                                  <span className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-zinc-600'}`}>
                                                    {checked && <Check className="w-2.5 h-2.5 text-white" />}
                                                  </span>
                                                </button>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                      {/* 移除 */}
                                      <button
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          if (window.confirm(`確定要將 ${stock.name || stock.code} 從「${f.label}」移除嗎？`)) {
                                            removeFromFolder(f.id, stock.code);
                                          }
                                        }}
                                        className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 p-0.5 rounded transition-all duration-150"
                                        title={`自 ${f.label} 移除`}
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* 新增自訂資料夾 */}
                  {isAddingFolder ? (
                    <div className="flex items-center gap-1 py-1 px-2">
                      <input
                        autoFocus
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitNewFolder();
                          if (e.key === 'Escape') { setIsAddingFolder(false); setNewFolderName(''); }
                        }}
                        placeholder="資料夾名稱"
                        className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                      />
                      <button onClick={submitNewFolder} className="text-zinc-400 hover:text-zinc-200 p-0.5">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => { setIsAddingFolder(false); setNewFolderName(''); }} className="text-zinc-500 hover:text-zinc-300 p-0.5">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setIsAddingFolder(true)}
                      className="w-full flex items-center gap-1.5 py-1.5 px-2 rounded hover:bg-zinc-800/20 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>新增資料夾</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* 系統狀態與資訊面板 */}
        <div className="p-4 border-t border-border bg-zinc-950/40">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-500">Engine Status:</span>
            {loading ? (
              <span className="text-zinc-500 animate-pulse">Checking...</span>
            ) : health && health.engine === 'up' ? (
              <span className="flex items-center gap-1.5 text-bear font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" /> UP
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-bull font-semibold animate-pulse">
                <XCircle className="w-3.5 h-3.5" /> DOWN
              </span>
            )}
          </div>
          {health && (
            <div className="mt-2 text-[10px] text-zinc-600 font-mono break-all">
              <div>GW: {health.gateway}</div>
              <div>Time: {new Date(health.time).toLocaleTimeString()}</div>
            </div>
          )}
        </div>
      </aside>

      {/* 主工作區 Main Workspace */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* 頁首 Header Bar */}
        <header className="h-16 border-b border-border bg-card/60 backdrop-blur-md px-6 flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-400">
            {location.pathname === '/'
              ? '大盤儀表板'
              : location.pathname === '/tide'
              ? '資金潮汐'
              : location.pathname === '/heatmap'
              ? '產業熱力圖'
              : location.pathname === '/rebalance'
              ? '再平衡計算機'
              : location.pathname === '/futures'
              ? '期貨損益總覽'
              : location.pathname.startsWith('/heatmap/sector/')
              ? `產業熱力圖 · ${(() => { try { return decodeURIComponent(location.pathname.replace('/heatmap/sector/', '')); } catch { return location.pathname.replace('/heatmap/sector/', ''); } })()}`
              : location.pathname.startsWith('/heatmap/group/')
              ? `族群熱力圖 · ${(() => { try { return decodeURIComponent(location.pathname.replace('/heatmap/group/', '')); } catch { return location.pathname.replace('/heatmap/group/', ''); } })()}`
              : location.pathname.startsWith('/stock/')
              ? '個股審查中心'
              : 'RWD 規範驗證'}
          </div>
          <div className="flex items-center gap-4">
            {/*
              兩種故障要分開講，因為嚴重程度差很多：
                gateway 連不上 → 整個網站沒有任何資料，每一頁都掛（這是最常見的「忘了
                                 啟動 server.cjs」）。
                engine 掛掉    → 只有需要 Python 引擎的頁面降級；期貨頁完全不碰 engine
                                 （行情走期交所、部位存檔案、假日曆走證交所），在那一頁
                                 掛紅字只會讓人以為期貨數字有問題。
            */}
            {!loading && !health && (
              <div className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/30 text-rose-400 px-3 py-1 rounded-md text-xs font-semibold animate-pulse">
                <ShieldAlert className="w-4 h-4" />
                連不上後端 gateway——請確認 server.cjs 有在跑
              </div>
            )}
            {!loading && health && health.engine === 'down' && !ENGINE_FREE_PATHS.has(location.pathname) && (
              <div className="flex items-center gap-2 bg-bull/10 border border-bull/20 text-bull px-3 py-1 rounded-md text-xs font-semibold animate-pulse">
                <ShieldAlert className="w-4 h-4" />
                後端運算引擎異常斷線，目前使用降級降軌模式
              </div>
            )}
            <div className="text-xs text-zinc-500">
              {new Date().toLocaleDateString('zh-TW', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
          </div>
        </header>

        {/* 頁面內容區 */}
        <div className="flex-1 p-6 overflow-y-auto bg-background">
          {children}
        </div>
      </main>
    </div>
  );
};
