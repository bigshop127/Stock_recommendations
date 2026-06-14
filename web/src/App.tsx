import { Routes, Route } from 'react-router-dom';
import { api } from './lib/api';
import { useApi } from './hooks/useApi';
import { BottomNav } from './components/BottomNav';
import { DegradedBanner } from './components/DegradedBanner';
import { Dashboard } from './pages/Dashboard';
import { Daytrade } from './pages/Daytrade';
import { Watchlist } from './pages/Watchlist';
import { Reports } from './pages/Reports';
import { StockDetail } from './pages/StockDetail';

export default function App() {
  const { data: health } = useApi(() => api.health(), []);
  const engineDown = health?.engine === 'down';

  return (
    <div className="min-h-full pb-20">
      <DegradedBanner engineDown={engineDown} />
      <main className="mx-auto max-w-screen-sm px-4 py-4">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/daytrade" element={<Daytrade />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/stock/:code" element={<StockDetail />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}
