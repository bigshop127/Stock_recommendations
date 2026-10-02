import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  TrendingUp,
  BarChart2,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  ChevronRight,
  ChevronDown,
  X,
  Waves,
  LayoutGrid,
  SlidersHorizontal,
  Activity,
  ListOrdered,
  Wallet,
  Newspaper,
  Menu,
  LayoutDashboard
} from 'lucide-react';
import { api } from '../lib/api';
import type { Health } from '../lib/api';
import { loadFoldersFromCloud } from '../lib/userStore';
import { FolderSidebar } from './FolderSidebar';

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
const ENGINE_FREE_PATHS = new Set(['/futures', '/net-worth', '/reports']);

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const match = location.pathname.match(/^\/stock\/([a-zA-Z0-9]+)/);
  const activeCode = match ? match[1] : null;
  // 手機版：側邊欄預設收起（不然導覽列就佔滿一整個螢幕，內容要捲一大段才看得到）；桌機恆展開
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStocksMenuOpen, setIsStocksMenuOpen] = useState(() => {
    const stored = localStorage.getItem('review:menu:expanded');
    if (stored !== null) return stored === 'true';
    return window.innerWidth >= 768;
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

  // 頁面啟動時撈一次雲端資料夾設定（成功會覆蓋本地快取並通知各處的 subscribeFolders）
  useEffect(() => {
    void loadFoldersFromCloud();
  }, []);

  useEffect(() => {
    localStorage.setItem('review:menu:expanded', String(isStocksMenuOpen));
  }, [isStocksMenuOpen]);

  return (
    <div className="min-h-screen bg-background text-zinc-100 flex flex-col md:flex-row">
      {/* 側邊欄 Sidebar (桌面端顯示，行動端小螢幕警告) */}
      <aside className="w-full md:w-64 bg-card border-b md:border-b-0 md:border-r border-border flex flex-col justify-between shrink-0">
        <div>
          {/* Logo / 標題 */}
          <div className="px-4 py-3 md:p-6 border-b border-border flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center font-bold text-white shadow-md">
              審
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="font-semibold text-zinc-100 tracking-tight">個股全面審視網</h1>
              <span className="text-xs text-zinc-500 font-mono">PWA Desktop & Mobile</span>
            </div>
            <button
              type="button"
              className="md:hidden p-2 rounded-lg border border-border text-zinc-300 hover:bg-zinc-800/60"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label={mobileNavOpen ? '收起選單' : '展開選單'}
              aria-expanded={mobileNavOpen}
            >
              {mobileNavOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>

          {/* 導覽連結 */}
          <nav
            className={`p-4 space-y-1 ${mobileNavOpen ? 'block' : 'hidden'} md:block`}
            onClick={(e) => {
              // 手機上點了連結就把選單收回去（點資料夾展開/新增等按鈕不收）
              if ((e.target as HTMLElement).closest('a')) setMobileNavOpen(false);
            }}
          >
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

            {/* 老王每日報告（純讀 gateway 的 reports/，不依賴 engine） */}
            <Link
              to="/reports"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/reports'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <Newspaper className="w-5 h-5" />
              老王每日報告
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

            {/* 資料夾卡片牆（opt45）：每檔一張迷你 K 線＋量比／法人／營收 */}
            <Link
              to="/folders"
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                location.pathname === '/folders'
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
              }`}
            >
              <LayoutDashboard className="w-5 h-5" />
              資料夾卡片牆
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

              {/* 資料夾樹與股票列表（2026-10-02 改手風琴＋分區＋篩選＋拖曳，見 FolderSidebar） */}
              {isStocksMenuOpen && <FolderSidebar activeCode={activeCode} />}
            </div>
          </nav>
        </div>

        {/* 系統狀態與資訊面板 */}
        <div className={`p-4 border-t border-border bg-zinc-950/40 ${mobileNavOpen ? 'block' : 'hidden'} md:block`}>
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
              : location.pathname === '/reports'
              ? '老王每日報告'
              : location.pathname === '/folders'
              ? '資料夾卡片牆'
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
