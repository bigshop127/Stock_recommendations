import { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';

const StockDetail = lazy(() => import('./pages/StockDetail').then(m => ({ default: m.StockDetail })));
const RwdVerify = lazy(() => import('./pages/RwdVerify').then(m => ({ default: m.RwdVerify })));
const CapitalTide = lazy(() => import('./pages/CapitalTide').then(m => ({ default: m.CapitalTide })));

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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </Router>
  );
}

export default App;
