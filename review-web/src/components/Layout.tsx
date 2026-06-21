import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, TrendingUp, BarChart2, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { Health } from '../lib/api';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

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

  const navItems = [
    { path: '/', label: '大盤與籌碼總覽', icon: <TrendingUp className="w-5 h-5" /> },
    { path: '/stock/2330', label: '個股多維度審查 (TSMC)', icon: <BarChart2 className="w-5 h-5" /> },
    { path: '/rwd-verify', label: 'RWD 策略與驗證', icon: <Activity className="w-5 h-5" /> },
  ];

  return (
    <div className="min-h-screen bg-background text-zinc-100 flex flex-col md:flex-row">
      {/* 側邊欄 Sidebar (桌面端顯示，行動端小螢幕警告) */}
      <aside className="w-full md:w-64 bg-card border-b md:border-b-0 md:border-r border-border flex flex-col justify-between shrink-0">
        <div>
          {/* Logo / 標題 */}
          <div className="p-6 border-b border-border flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center font-bold text-white shadow-md">
              台
            </div>
            <div>
              <h1 className="font-semibold text-zinc-100 tracking-tight">台股籌碼審查</h1>
              <span className="text-xs text-zinc-500 font-mono">Phase 0 Skeleton</span>
            </div>
          </div>

          {/* 導覽連結 */}
          <nav className="p-4 space-y-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path || (item.path.startsWith('/stock/') && location.pathname.startsWith('/stock/'));
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
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
