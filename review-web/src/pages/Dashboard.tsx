import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MarketIndices, MarketBreadth, MarketSectors, MarketInstitutional } from '../lib/api';
import { Activity, BarChart3, TrendingUp, Users, RefreshCw } from 'lucide-react';

export const Dashboard: React.FC = () => {
  const [indices, setIndices] = useState<MarketIndices | null>(null);
  const [breadth, setBreadth] = useState<MarketBreadth | null>(null);
  const [sectors, setSectors] = useState<MarketSectors | null>(null);
  const [institutional, setInstitutional] = useState<MarketInstitutional | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      // 在 Phase 0 中，後端端點尚未實作。我們調用 client API，若失敗則回退至 Mock 模式以利畫面呈現驗收。
      const [idxData, breadthData, sectorData, instData] = await Promise.all([
        api.marketIndices(),
        api.marketBreadth(),
        api.marketSectors(),
        api.marketInstitutional()
      ]);
      setIndices(idxData);
      setBreadth(breadthData);
      setSectors(sectorData);
      setInstitutional(instData);
      setIsMock(false);
    } catch (err: any) {
      console.warn('API endpoints failed (expected in Phase 0), loading mock data:', err);
      // 載入符合 API 合約 Schema 的 Mock 資料以利驗收
      loadMockData();
      setIsMock(true);
    } finally {
      setLoading(false);
    }
  };

  const loadMockData = () => {
    setIndices({
      date: new Date().toISOString().split('T')[0],
      indices: [
        { name: '加權指數 (TAIEX)', price: 22845.81, change: 182.42, changePercent: 0.81, volume: 382400000000, source: 'TWSE MIS' },
        { name: '櫃買指數 (OTC)', price: 268.45, change: -1.25, changePercent: -0.46, volume: 82400000000, source: 'TWSE MIS' },
        { name: '台指期 (FITX)', price: 22860.00, change: 195.00, changePercent: 0.86, volume: 120000, source: 'TAIFEX' }
      ]
    });

    setBreadth({
      date: new Date().toISOString().split('T')[0],
      advance: 582,
      decline: 324,
      flat: 92,
      above20MaRatio: 0.625,
      above50MaRatio: 0.584,
      source: 'TWSE'
    });

    setSectors({
      date: new Date().toISOString().split('T')[0],
      sectors: [
        { name: '半導體', changePercent: 1.45, netAmount: 12450000000, source: 'TWSE' },
        { name: '電腦及週邊', changePercent: 0.82, netAmount: 2450000000, source: 'TWSE' },
        { name: '金融保險', changePercent: 0.35, netAmount: 1820000000, source: 'TWSE' },
        { name: '航運業', changePercent: -1.82, netAmount: -3200000000, source: 'TWSE' },
        { name: '鋼鐵工業', changePercent: -0.95, netAmount: -85000000, source: 'TWSE' }
      ]
    });

    setInstitutional({
      date: new Date().toISOString().split('T')[0],
      trades: {
        foreignNetBuy: 8520000000,
        investmentTrustNetBuy: 2410000000,
        dealerNetBuy: -1540000000,
        totalNetBuy: 9390000000,
        source: 'TWSE'
      }
    });
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  return (
    <div className="space-y-6">
      {/* 標題與更新控制 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
            大盤與市場籌碼總覽
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            整合台股加權指數、大盤寬度、各類股漲跌及三大法人籌碼流向。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isMock && (
            <span className="text-[10px] bg-neutral/10 border border-neutral/20 text-neutral px-2.5 py-1 rounded-md font-mono">
              Phase 0: Mock Mode
            </span>
          )}
          <button
            onClick={fetchDashboardData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 transition disabled:opacity-50 text-zinc-300"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="text-sm text-zinc-500 animate-pulse">載入大盤資料中...</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 1. 大盤主要指數 */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <TrendingUp className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">加權與期現貨指數</h3>
            </div>
            <div className="space-y-4">
              {indices?.indices.map((idx) => (
                <div key={idx.name} className="flex items-center justify-between p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                  <div>
                    <div className="text-xs font-medium text-zinc-200">{idx.name}</div>
                    <div className="text-[10px] text-zinc-500 font-mono mt-0.5">來源: {idx.source}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold font-mono text-zinc-100">{idx.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    <div className={`text-xs font-mono font-medium mt-0.5 ${idx.change >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {idx.change >= 0 ? '+' : ''}{idx.change.toFixed(2)} ({idx.change >= 0 ? '+' : ''}{idx.changePercent.toFixed(2)}%)
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 2. 三大法人大盤買賣超 */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <Users className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">三大法人現貨買賣超 (TWD)</h3>
            </div>
            {institutional && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                    <div className="text-[10px] text-zinc-500">外資與陸資</div>
                    <div className={`text-xs font-semibold font-mono mt-1.5 ${institutional.trades.foreignNetBuy >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {(institutional.trades.foreignNetBuy / 100000000).toFixed(2)} 億
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                    <div className="text-[10px] text-zinc-500">投信</div>
                    <div className={`text-xs font-semibold font-mono mt-1.5 ${institutional.trades.investmentTrustNetBuy >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {(institutional.trades.investmentTrustNetBuy / 100000000).toFixed(2)} 億
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                    <div className="text-[10px] text-zinc-500">自營商</div>
                    <div className={`text-xs font-semibold font-mono mt-1.5 ${institutional.trades.dealerNetBuy >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {(institutional.trades.dealerNetBuy / 100000000).toFixed(2)} 億
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3.5 rounded-lg bg-primary/5 border border-primary/20">
                  <span className="text-xs font-medium text-zinc-300">合計買賣超</span>
                  <span className={`text-sm font-bold font-mono ${institutional.trades.totalNetBuy >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {institutional.trades.totalNetBuy >= 0 ? '+' : ''}{(institutional.trades.totalNetBuy / 100000000).toFixed(2)} 億
                  </span>
                </div>
                <div className="text-[10px] text-zinc-500 font-mono text-right">來源: {institutional.trades.source}</div>
              </div>
            )}
          </div>

          {/* 3. 大盤寬度指標 */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <Activity className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">市場多空寬度</h3>
            </div>
            {breadth && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>上漲家數: <strong className="text-bull font-mono">{breadth.advance}</strong></span>
                  <span>下跌家數: <strong className="text-bear font-mono">{breadth.decline}</strong></span>
                  <span>平盤家數: <strong className="text-zinc-500 font-mono">{breadth.flat}</strong></span>
                </div>
                {/* 比例條 Bar */}
                <div className="w-full h-3 rounded-full bg-zinc-800 flex overflow-hidden">
                  <div className="bg-bull h-full" style={{ width: `${(breadth.advance / (breadth.advance + breadth.decline + breadth.flat)) * 100}%` }}></div>
                  <div className="bg-zinc-600 h-full" style={{ width: `${(breadth.flat / (breadth.advance + breadth.decline + breadth.flat)) * 100}%` }}></div>
                  <div className="bg-bear h-full" style={{ width: `${(breadth.decline / (breadth.advance + breadth.decline + breadth.flat)) * 100}%` }}></div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">站上 20MA 均線比例</div>
                    <div className="text-sm font-semibold font-mono text-zinc-100 mt-1">{(breadth.above20MaRatio * 100).toFixed(1)}%</div>
                  </div>
                  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">站上 50MA 均線比例</div>
                    <div className="text-sm font-semibold font-mono text-zinc-100 mt-1">{(breadth.above50MaRatio * 100).toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 4. 類股表現排名 */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <BarChart3 className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">產業類股漲幅排行</h3>
            </div>
            <div className="space-y-3">
              {sectors?.sectors.map((sec) => (
                <div key={sec.name} className="flex items-center justify-between text-xs">
                  <span className="font-medium text-zinc-300">{sec.name}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-zinc-500 font-mono">{(sec.netAmount / 100000000).toFixed(1)} 億</span>
                    <span className={`font-mono font-semibold min-w-[60px] text-right ${sec.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {sec.changePercent >= 0 ? '+' : ''}{sec.changePercent.toFixed(2)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
