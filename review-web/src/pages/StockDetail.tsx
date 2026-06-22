import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { StockDetail as IStockDetail, StockChips, StockFundamentals, StockNews } from '../lib/api';
import { RefreshCw, BarChart2, TrendingUp, Cpu, Newspaper, DollarSign } from 'lucide-react';

export const StockDetail: React.FC = () => {
  const { code } = useParams<{ code: string }>();
  const activeCode = code || '2330';

  const [detail, setDetail] = useState<IStockDetail | null>(null);
  const [chips, setChips] = useState<StockChips | null>(null);
  const [fundamentals, setFundamentals] = useState<StockFundamentals | null>(null);
  const [news, setNews] = useState<StockNews | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);

  const fetchStockData = async () => {
    setLoading(true);
    try {
      // 1. 嘗試調用舊有的單股訊號介面
      let detailData: IStockDetail;
      try {
        detailData = await api.stock(activeCode);
        setDetail(detailData);
      } catch (err) {
        console.warn('api.stock failed, loading baseline mock details');
        detailData = getMockStockDetail(activeCode);
        setDetail(detailData);
      }

      // 2. 調用 Phase 0 新增之籌碼、基本面、新聞 API
      const [chipsData, fundData, newsData] = await Promise.all([
        api.stockChips(activeCode),
        api.stockFundamentals(activeCode),
        api.stockNews(activeCode)
      ]);

      setChips(chipsData);
      setFundamentals(fundData);
      setNews(newsData);
      setIsMock(false);
    } catch (err) {
      console.warn('New Phase 0 API endpoints failed, loading mock details:', err);
      // 載入符合 API 合約 Schema 的 Mock 資料以利驗收
      loadMockData(activeCode);
      setIsMock(true);
    } finally {
      setLoading(false);
    }
  };

  const getMockStockDetail = (c: string): IStockDetail => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : '個股',
      date: new Date().toISOString().split('T')[0],
      swing: {
        code: c, name: '台積電', date: new Date().toISOString().split('T')[0],
        mode: 'swing', action: 'HOLD', score: 65, confidence: 0.85
      },
      daytrade: {
        code: c, name: '台積電', date: new Date().toISOString().split('T')[0],
        mode: 'daytrade', action: 'BUY', score: 82, confidence: 0.78
      },
      blended: {
        code: c, name: '台積電', date: new Date().toISOString().split('T')[0],
        mode: 'blended', action: 'BUY', score: 75, confidence: 0.81
      },
      puhui: null,
      generated_at: new Date().toISOString()
    };
  };

  const loadMockData = (c: string) => {
    setChips({
      code: c,
      data: [
        { date: '2026-06-19', foreign_holding_ratio: 74.2, investment_trust_net_buy_qty: 1200, foreign_net_buy_qty: 3500, dealer_net_buy_qty: -450, margin_balance: 12500, short_balance: 820, source: 'TWSE' },
        { date: '2026-06-18', foreign_holding_ratio: 74.1, investment_trust_net_buy_qty: 850, foreign_net_buy_qty: -1200, dealer_net_buy_qty: 120, margin_balance: 12350, short_balance: 780, source: 'TWSE' },
        { date: '2026-06-17', foreign_holding_ratio: 74.2, investment_trust_net_buy_qty: -320, foreign_net_buy_qty: 4800, dealer_net_buy_qty: 50, margin_balance: 12100, short_balance: 900, source: 'TWSE' }
      ]
    });

    setFundamentals({
      code: c,
      metrics: [
        { date: '2026-Q1', pe_ratio: 24.5, pb_ratio: 6.8, dividend_yield: 2.45, revenue_yoy: 15.4, eps: 8.7, source: 'TWSE' }
      ]
    });

    setNews({
      code: c,
      news: [
        { id: '1', title: '台積電 3 奈米產能供不應求，傳蘋果與超微包下產能', date: '2026-06-20', url: '#', summary: '半導體供應鏈指出，台積電 3 奈米製程持續滿載，訂單已排至明年。', sentiment: 'positive', sentiment_score: 92, source: 'Anue 鉅亨' },
        { id: '2', title: '外資持續回流！單日大舉買超台積電逾 3,500 張', date: '2026-06-19', url: '#', summary: '受到美股 ADR 大漲鼓舞，外資現貨市場再度成為推升台積電股價的主力。', sentiment: 'positive', sentiment_score: 88, source: '經濟日報' },
        { id: '3', title: '地緣政治風險升溫，分析師示警供應鏈過度集中之疑慮', date: '2026-06-18', url: '#', summary: '地緣政治智庫指出，雖然台積電技術領先，但集中在台海的製造產能仍面臨宏觀風險挑戰。', sentiment: 'neutral', sentiment_score: 50, source: '工商時報' }
      ]
    });
  };

  useEffect(() => {
    fetchStockData();
  }, [activeCode]);

  return (
    <div className="space-y-6">
      {/* 標題與個股快速搜尋 */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 border border-primary/20 text-primary w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg">
            {activeCode}
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
              {detail?.name || '台積電'} ({activeCode})
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              個股多維度籌碼審查、基本面診斷與輿情分析。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-zinc-950/60 p-1 rounded-lg border border-border/80 text-xs">
            <Link to="/stock/2330" className={`px-3 py-1 rounded-md transition ${activeCode === '2330' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}>
              台積電 (2330)
            </Link>
            <Link to="/stock/2454" className={`px-3 py-1 rounded-md transition ${activeCode === '2454' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}>
              聯發科 (2454)
            </Link>
            <Link to="/stock/2317" className={`px-3 py-1 rounded-md transition ${activeCode === '2317' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}>
              鴻海 (2317)
            </Link>
          </div>
          {isMock && (
            <span className="text-[10px] bg-neutral/10 border border-neutral/20 text-neutral px-2 py-1 rounded-md font-mono">
              Phase 1: Mock Mode
            </span>
          )}
          <button
            onClick={fetchStockData}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 text-xs hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-semibold"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            整理
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="text-sm text-zinc-500 animate-pulse">載入個股資料中...</div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 主區塊 1: K 線圖佔位與基本資訊 */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* K 線圖 */}
            <div className="xl:col-span-2 bg-card border border-border rounded-xl p-6 flex flex-col justify-between min-h-[350px]">
              <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-5 h-5 text-primary" />
                  <span className="text-sm font-semibold text-zinc-200">輕量化 K 線技術圖表 (lightweight-charts)</span>
                </div>
                <span className="text-xs text-zinc-500 font-mono">日 K 線圖 (前復權)</span>
              </div>
              <div className="flex-1 bg-zinc-950/80 border border-border/40 rounded-lg flex items-center justify-center flex-col p-6 text-center border-dashed">
                <div className="text-primary font-bold text-lg mb-2">Lightweight Charts Placeholder</div>
                <p className="text-xs text-zinc-500 max-w-sm">
                  圖表套件 `lightweight-charts` 已安裝。此處將在 Phase 1 正式掛載與 API 連線的 K 線與量能圖。
                </p>
              </div>
            </div>

            {/* 量化訊號 */}
            <div className="bg-card border border-border rounded-xl p-6 flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
                <Cpu className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">AI 交易決策訊號</h3>
              </div>
              {detail && (
                <div className="space-y-4 flex-1">
                  <div className="flex justify-between items-center p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                    <span className="text-xs text-zinc-400">波段決策 (Swing)</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${detail.swing.action === 'BUY' ? 'bg-bull/10 text-bull' : 'bg-zinc-800 text-zinc-400'}`}>
                      {detail.swing.action} ({detail.swing.score}分)
                    </span>
                  </div>
                  <div className="flex justify-between items-center p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                    <span className="text-xs text-zinc-400">當沖決策 (Daytrade)</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${detail.daytrade.action === 'BUY' ? 'bg-bull/10 text-bull' : 'bg-zinc-800 text-zinc-400'}`}>
                      {detail.daytrade.action} ({detail.daytrade.score}分)
                    </span>
                  </div>
                  <div className="flex justify-between items-center p-3.5 rounded-lg bg-primary/5 border border-primary/20">
                    <span className="text-xs font-semibold text-zinc-200">融合訊號 (Blended)</span>
                    <span className="text-sm font-bold text-primary font-mono">{detail.blended.action} ({detail.blended.score}分)</span>
                  </div>
                </div>
              )}
              <div className="mt-4 pt-3 border-t border-border/40 text-[10px] text-zinc-500 font-mono">
                更新於: {new Date(detail?.generated_at || '').toLocaleString()}
              </div>
            </div>
          </div>

          {/* 主區塊 2: 籌碼與基本面詳細指標 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 籌碼流向 */}
            <div className="bg-card border border-border rounded-xl p-6">
              <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
                <TrendingUp className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">多天期主力與法人籌碼</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="text-zinc-500 border-b border-border/60">
                      <th className="pb-2 font-semibold">日期</th>
                      <th className="pb-2 font-semibold text-right">投信買超 (張)</th>
                      <th className="pb-2 font-semibold text-right">外資買超 (張)</th>
                      <th className="pb-2 font-semibold text-right">外資持股比 (%)</th>
                      <th className="pb-2 font-semibold text-right">融資餘額 (張)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chips?.data.map((row) => (
                      <tr key={row.date} className="border-b border-border/30 last:border-0 hover:bg-zinc-800/10">
                        <td className="py-2.5 font-mono text-zinc-300">{row.date}</td>
                        <td className={`py-2.5 text-right font-mono font-medium ${row.investment_trust_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}`}>
                          {row.investment_trust_net_buy_qty > 0 ? '+' : ''}{row.investment_trust_net_buy_qty}
                        </td>
                        <td className={`py-2.5 text-right font-mono font-medium ${row.foreign_net_buy_qty >= 0 ? 'text-bull' : 'text-bear'}`}>
                          {row.foreign_net_buy_qty > 0 ? '+' : ''}{row.foreign_net_buy_qty}
                        </td>
                        <td className="py-2.5 text-right font-mono text-zinc-300">{row.foreign_holding_ratio}%</td>
                        <td className="py-2.5 text-right font-mono text-zinc-400">{row.margin_balance.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 基本面診斷 */}
            <div className="bg-card border border-border rounded-xl p-6">
              <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
                <DollarSign className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">基本面估值與增長率</h3>
              </div>
              {fundamentals && fundamentals.metrics.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">本益比 (PE Ratio)</div>
                    <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentals.metrics[0].pe_ratio}x</div>
                  </div>
                  <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">股淨比 (PB Ratio)</div>
                    <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentals.metrics[0].pb_ratio}x</div>
                  </div>
                  <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">現金殖利率 (Yield)</div>
                    <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentals.metrics[0].dividend_yield}%</div>
                  </div>
                  <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">單季營收年增率 (YoY)</div>
                    <div className="text-base font-semibold font-mono text-bull mt-1">+{fundamentals.metrics[0].revenue_yoy}%</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 主區塊 3: 輿情與新聞 */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <Newspaper className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">即時市場輿情與新聞情緒</h3>
            </div>
            <div className="space-y-4">
              {news?.news.map((item) => (
                <div key={item.id} className="p-4 rounded-lg bg-zinc-950/40 border border-border/30 flex items-start gap-4">
                  <div className={`shrink-0 text-[10px] font-semibold px-2 py-1 rounded ${
                    item.sentiment === 'positive' ? 'bg-bull/10 text-bull' : item.sentiment === 'negative' ? 'bg-bear/10 text-bear' : 'bg-zinc-800 text-zinc-400'
                  }`}>
                    {item.sentiment.toUpperCase()} ({item.sentiment_score}分)
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-zinc-200 hover:text-primary transition">
                      <a href={item.url}>{item.title}</a>
                    </h4>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">{item.summary}</p>
                    <div className="flex gap-3 text-[10px] text-zinc-600 font-mono pt-1">
                      <span>來源: {item.source}</span>
                      <span>•</span>
                      <span>日期: {item.date}</span>
                    </div>
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
