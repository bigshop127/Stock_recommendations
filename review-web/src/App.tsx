import { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';

const StockDetail = lazy(() => import('./pages/StockDetail').then(m => ({ default: m.StockDetail })));
const RwdVerify = lazy(() => import('./pages/RwdVerify').then(m => ({ default: m.RwdVerify })));
const CapitalTide = lazy(() => import('./pages/CapitalTide').then(m => ({ default: m.CapitalTide })));
const SectorHeatmap = lazy(() => import('./pages/SectorHeatmap').then(m => ({ default: m.SectorHeatmap })));
const SectorDetail = lazy(() => import('./pages/SectorDetail').then(m => ({ default: m.SectorDetail })));
const GroupDetail = lazy(() => import('./pages/GroupDetail').then(m => ({ default: m.GroupDetail })));
const Rebalance = lazy(() => import('./pages/Rebalance').then(m => ({ default: m.Rebalance })));
const FuturesPnl = lazy(() => import('./pages/FuturesPnl').then(m => ({ default: m.FuturesPnl })));
const RealizedPnl = lazy(() => import('./pages/RealizedPnl').then(m => ({ default: m.RealizedPnl })));

function App() {
  return (
    <Router basename="/review">
      <Layout>
        <Suspense fallback={
          <div className="flex h-64 items-center justify-center text-zinc-400">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
              <span className="text-xs font-medium font-mono animate-pulse">載入頁面中...</span>
            </div>
          </div>
        }>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/stock/:code" element={<StockDetail />} />
            <Route path="/rwd-verify" element={<RwdVerify />} />
            <Route path="/tide" element={<CapitalTide />} />
            <Route path="/heatmap" element={<SectorHeatmap />} />
            <Route path="/heatmap/sector/:name" element={<SectorDetail />} />
            <Route path="/heatmap/group/:name" element={<GroupDetail />} />
            <Route path="/rebalance" element={<Rebalance />} />
            <Route path="/futures" element={<FuturesPnl />} />
            <Route path="/realized-pnl" element={<RealizedPnl />} />
            {/* 2026-07-29：崩盤策略回測實驗室下架，位置改給期貨損益總覽。
                舊書籤/PWA 捷徑導到新頁，不要讓它落到 404 再彈回首頁。 */}
            <Route path="/backtest" element={<Navigate to="/futures" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </Router>
  );
}

export default App;
