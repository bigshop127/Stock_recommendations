import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { StockDetail } from './pages/StockDetail';
import { RwdVerify } from './pages/RwdVerify';

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/stock/:code" element={<StockDetail />} />
          <Route path="/rwd-verify" element={<RwdVerify />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
