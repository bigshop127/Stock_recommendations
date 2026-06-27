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
  MoreHorizontal
} from 'lucide-react';
import { api } from '../lib/api';
import type { Health } from '../lib/api';
import {
  getFolders,
  removeFromFolder,
  subscribeFolders,
  moveStock,
  addToFolder,
  FOLDERS
} from '../lib/userStore';
import type { FolderId } from '../lib/userStore';
import { SymbolSearch } from './SymbolSearch';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const match = location.pathname.match(/^\/stock\/([a-zA-Z0-9]+)/);
  const activeCode = match ? match[1] : null;
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState(() => getFolders());
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
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    localStorage.setItem('review:menu:expanded', String(isStocksMenuOpen));
  }, [isStocksMenuOpen]);

  useEffect(() => {
    localStorage.setItem('review:folders:expanded', JSON.stringify(expandedFolders));
  }, [expandedFolders]);

  const [activeSearchFolder, setActiveSearchFolder] = useState<FolderId | null>(null);
  const [activeDropdownStock, setActiveDropdownStock] = useState<{ folderId: FolderId; code: string } | null>(null);

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
                  {FOLDERS.map((f) => {
                    const isExpanded = expandedFolders[f.id];
                    const stocks = folders[f.id] || [];
                    return (
                      <div key={f.id} className="space-y-1">
                        {/* 資料夾標頭 */}
                        <div className="group/folder flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/20 text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition-colors">
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
                                          <div className="absolute right-0 top-6 z-50 bg-zinc-900 border border-zinc-800 rounded shadow-xl py-1 w-28 text-[11px]">
                                            <div className="px-2 py-1 text-zinc-500 font-semibold border-b border-zinc-800">
                                              移動至：
                                            </div>
                                            {FOLDERS.filter(dest => dest.id !== f.id).map(dest => (
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
            {location.pathname === '/' ? '大盤儀表板' : location.pathname.startsWith('/stock/') ? '個股審查中心' : 'RWD 規範驗證'}
          </div>
          <div className="flex items-center gap-4">
            {/* Engine 下線警告 Banner */}
            {!loading && (!health || health.engine === 'down') && (
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
