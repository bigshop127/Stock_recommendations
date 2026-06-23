import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { StockDetail as IStockDetail, StockChips, StockFundamentals, StockNews, Book, OhlcvRow } from '../lib/api';
import { RefreshCw, BarChart2, TrendingUp, Cpu, Newspaper, DollarSign } from 'lucide-react';
import { PriceChart } from '../components/PriceChart';
import { ChipsCharts } from '../components/ChipsCharts';

export const StockDetail: React.FC = () => {
  const { code } = useParams<{ code: string }>();
  const activeCode = code || '2330';

  // Section States
  const [headerBookState, setHeaderBookState] = useState<{ data: Book | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [klineState, setKlineState] = useState<{ data: OhlcvRow[] | null; loading: boolean; error: string | null; type: 'daily' | 'intraday' }>({ data: null, loading: true, error: null, type: 'daily' });
  const [signalState, setSignalState] = useState<{ data: IStockDetail | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [chipsState, setChipsState] = useState<{ data: StockChips | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [fundamentalsState, setFundamentalsState] = useState<{ data: StockFundamentals | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [newsState, setNewsState] = useState<{ data: StockNews | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });

  // Refresh & Polling
  const [autoPoll, setAutoPoll] = useState(false);

  // Check if mock mode is requested in Dev env
  const isDev = import.meta.env.DEV;
  const isMockParam = new URLSearchParams(window.location.search).get('mock') === '1';
  const useMock = isDev && isMockParam;

  // Mock Generators
  const getMockStockDetail = (c: string): IStockDetail => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海',
      date: new Date().toISOString().split('T')[0],
      swing: {
        code: c, name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海', date: new Date().toISOString().split('T')[0],
        mode: 'swing', action: 'HOLD', score: 65, confidence: 0.85
      },
      daytrade: {
        code: c, name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海', date: new Date().toISOString().split('T')[0],
        mode: 'daytrade', action: 'BUY', score: 82, confidence: 0.78
      },
      blended: {
        code: c, name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海', date: new Date().toISOString().split('T')[0],
        mode: 'blended', action: 'BUY', score: 75, confidence: 0.81
      },
      puhui: null,
      generated_at: new Date().toISOString()
    };
  };

  const getMockChips = (c: string): StockChips => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海',
      as_of: '2026-06-19',
      unit: {
        net_buy_qty: '張',
        balance: '張',
        holding_ratio: '%',
      },
      data: [
        {
          date: '2026-06-19',
          foreign_holding_ratio: 74.2,
          investment_trust_net_buy_qty: 1200,
          foreign_net_buy_qty: 3500,
          dealer_net_buy_qty: -450,
          total_net_buy_qty: 4250,
          margin_balance: 12500,
          margin_change: 320,
          short_balance: 820,
          short_change: -45,
        },
        {
          date: '2026-06-18',
          foreign_holding_ratio: 74.1,
          investment_trust_net_buy_qty: 850,
          foreign_net_buy_qty: -1200,
          dealer_net_buy_qty: 120,
          total_net_buy_qty: -230,
          margin_balance: 12350,
          margin_change: -150,
          short_balance: 780,
          short_change: -40,
        },
        {
          date: '2026-06-17',
          foreign_holding_ratio: 74.2,
          investment_trust_net_buy_qty: -320,
          foreign_net_buy_qty: 4800,
          dealer_net_buy_qty: 50,
          total_net_buy_qty: 4530,
          margin_balance: 12500,
          margin_change: 150,
          short_balance: 820,
          short_change: 40,
        }
      ],
      source: 'FinMind'
    };
  };

  const getMockFundamentals = (c: string): StockFundamentals => {
    return {
      code: c,
      metrics: [
        { date: '2026-Q1', pe_ratio: 24.5, pb_ratio: 6.8, dividend_yield: 2.45, revenue_yoy: 15.4, eps: 8.7, source: 'TWSE' }
      ]
    };
  };

  const getMockNews = (c: string): StockNews => {
    return {
      code: c,
      news: [
        { id: '1', title: '台積電 3 奈米產能供不應求，傳蘋果與超微包下產能', date: '2026-06-20', url: '#', summary: '半導體供應鏈指出，台積電 3 奈米製程持續滿載，訂單已排至明年。', sentiment: 'positive', sentiment_score: 92, source: 'Anue 鉅亨' },
        { id: '2', title: '外資持續回流！單日大舉買超台積電逾 3,500 張', date: '2026-06-19', url: '#', summary: '受到美股 ADR 大漲鼓舞，外資現貨市場再度成為推升台積電股價的主力。', sentiment: 'positive', sentiment_score: 88, source: '經濟日報' },
        { id: '3', title: '地緣政治風險升溫，分析師示警供應鏈過度集中之疑慮', date: '2026-06-18', url: '#', summary: '地緣政治智庫指出，雖然台積電技術領先，但集中在台海的製造產能仍面臨宏觀風險挑戰。', sentiment: 'neutral', sentiment_score: 50, source: '工商時報' }
      ]
    };
  };

  const getMockBook = (c: string): Book => {
    const basePrice = c === '2330' ? 980 : c === '2454' ? 1420 : 210;
    const name = c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海';
    return {
      code: c,
      source: 'TWSE MIS getStockInfo (Mock)',
      live_only: true,
      book: {
        last_price: basePrice,
        name: name,
        bids: [
          { price: basePrice - 1, size: 120 },
          { price: basePrice - 2, size: 85 },
          { price: basePrice - 3, size: 240 },
          { price: basePrice - 4, size: 310 },
          { price: basePrice - 5, size: 150 },
        ],
        asks: [
          { price: basePrice, size: 90 },
          { price: basePrice + 1, size: 140 },
          { price: basePrice + 2, size: 180 },
          { price: basePrice + 3, size: 210 },
          { price: basePrice + 4, size: 95 },
        ],
        total: {
          trade_volume: 24500
        },
        day: {
          open: basePrice - 5,
          high: basePrice + 5,
          low: basePrice - 8,
          prev_close: basePrice - 10
        }
      }
    };
  };

  const generateMockOHLCV = (c: string): OhlcvRow[] => {
    const basePrice = c === '2330' ? 980 : c === '2454' ? 1420 : 210;
    const rows: OhlcvRow[] = [];
    const days = 60;
    const start = new Date();
    start.setDate(start.getDate() - days);
    
    let currentPrice = basePrice - days * 0.5;
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      
      const change = (Math.random() - 0.48) * (basePrice * 0.02);
      const open = currentPrice;
      const close = currentPrice + change;
      const high = Math.max(open, close) + Math.random() * (basePrice * 0.01);
      const low = Math.min(open, close) - Math.random() * (basePrice * 0.01);
      
      rows.push({
        date: d.toISOString().split('T')[0],
        open: parseFloat(open.toFixed(1)),
        high: parseFloat(high.toFixed(1)),
        low: parseFloat(low.toFixed(1)),
        close: parseFloat(close.toFixed(1)),
        volume: Math.floor(Math.random() * 20000) + 5000
      });
      currentPrice = close;
    }
    return rows;
  };

  const generateMockIntraday = (c: string): OhlcvRow[] => {
    const basePrice = c === '2330' ? 980 : c === '2454' ? 1420 : 210;
    const rows: OhlcvRow[] = [];
    const todayStr = new Date().toISOString().split('T')[0];
    
    let currentPrice = basePrice;
    const startTime = new Date();
    startTime.setHours(9, 0, 0, 0);
    
    for (let i = 0; i < 54; i++) {
      const time = new Date(startTime.getTime() + i * 5 * 60 * 1000);
      const timeStr = time.toTimeString().split(' ')[0].substring(0, 5);
      
      const change = (Math.random() - 0.5) * (basePrice * 0.003);
      const open = currentPrice;
      const close = currentPrice + change;
      const high = Math.max(open, close) + Math.random() * (basePrice * 0.001);
      const low = Math.min(open, close) - Math.random() * (basePrice * 0.001);
      
      rows.push({
        date: `${todayStr}T${timeStr}:00`,
        open: parseFloat(open.toFixed(1)),
        high: parseFloat(high.toFixed(1)),
        low: parseFloat(low.toFixed(1)),
        close: parseFloat(close.toFixed(1)),
        volume: Math.floor(Math.random() * 1000) + 100
      });
      currentPrice = close;
    }
    return rows;
  };

  // Fetch Functions
  const fetchHeaderAndBook = async () => {
    setHeaderBookState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: Book;
      if (useMock) {
        data = getMockBook(activeCode);
      } else {
        data = await api.book(activeCode);
      }
      setHeaderBookState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch book failed:', err);
      setHeaderBookState({ data: null, loading: false, error: err.message || '無法載入報價與五檔資料' });
    }
  };

  const fetchKlineData = async (klineType: 'daily' | 'intraday') => {
    setKlineState(prev => ({ ...prev, loading: true, error: null, type: klineType }));
    try {
      let rows: OhlcvRow[];
      if (useMock) {
        rows = klineType === 'daily' ? generateMockOHLCV(activeCode) : generateMockIntraday(activeCode);
      } else {
        if (klineType === 'daily') {
          const res = await api.ohlcv(activeCode, { adjust: true });
          rows = res.data || [];
        } else {
          const res = await api.intraday(activeCode, { timeframe: '1' });
          rows = res.data || [];
        }
      }
      setKlineState({ data: rows, loading: false, error: null, type: klineType });
    } catch (err: any) {
      console.error(`Fetch ${klineType} K-line failed:`, err);
      setKlineState(prev => ({ ...prev, data: null, loading: false, error: err.message || '無法載入 K 線圖表' }));
    }
  };

  const fetchSignal = async () => {
    setSignalState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: IStockDetail;
      if (useMock) {
        data = getMockStockDetail(activeCode);
      } else {
        data = await api.stock(activeCode);
      }
      setSignalState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch signal failed:', err);
      setSignalState({ data: null, loading: false, error: err.message || '無法載入交易訊號' });
    }
  };

  const fetchChips = async () => {
    setChipsState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: StockChips;
      if (useMock) {
        data = getMockChips(activeCode);
      } else {
        data = await api.stockChips(activeCode, { days: 20 });
      }
      setChipsState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch chips failed:', err);
      setChipsState({ data: null, loading: false, error: err.message || '無法載入籌碼資料' });
    }
  };

  const fetchFundamentals = async () => {
    setFundamentalsState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: StockFundamentals;
      if (useMock) {
        data = getMockFundamentals(activeCode);
      } else {
        data = await api.stockFundamentals(activeCode);
      }
      setFundamentalsState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch fundamentals failed:', err);
      setFundamentalsState({ data: null, loading: false, error: err.message || '無法載入基本面資料' });
    }
  };

  const fetchNews = async () => {
    setNewsState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: StockNews;
      if (useMock) {
        data = getMockNews(activeCode);
      } else {
        data = await api.stockNews(activeCode);
      }
      setNewsState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch news failed:', err);
      setNewsState({ data: null, loading: false, error: err.message || '無法載入新聞與輿情' });
    }
  };

  const fetchAllData = () => {
    fetchHeaderAndBook();
    fetchKlineData(klineState.type);
    fetchSignal();
    fetchChips();
    fetchFundamentals();
    fetchNews();
  };

  // Change K-line Type
  const handleKlineTypeChange = (type: 'daily' | 'intraday') => {
    if (type !== klineState.type) {
      fetchKlineData(type);
    }
  };

  // Auto-polling for Book
  useEffect(() => {
    if (!autoPoll) return;
    const interval = setInterval(() => {
      fetchHeaderAndBook();
    }, 5000);
    return () => clearInterval(interval);
  }, [autoPoll, activeCode, useMock]);

  // Initial Fetch
  useEffect(() => {
    fetchAllData();
  }, [activeCode, useMock]);

  // Render Quote Header
  const renderHeader = () => {
    if (headerBookState.loading && !headerBookState.data) {
      return (
        <div className="flex items-center justify-between flex-wrap gap-4 w-full bg-card border border-border rounded-xl p-4 sm:p-6 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="bg-zinc-800 w-12 h-12 rounded-xl" />
            <div className="space-y-2">
              <div className="bg-zinc-800 h-5 w-32 rounded" />
              <div className="bg-zinc-800 h-3.5 w-48 rounded" />
            </div>
          </div>
          <div className="h-10 w-64 bg-zinc-800 rounded-lg hidden sm:block" />
        </div>
      );
    }

    const book = headerBookState.data?.book as any;
    const name = book?.name || (signalState.data?.name) || '個股';
    const lastPrice = book?.last_price || 0;
    const prevClose = book?.day?.prev_close || 0;
    const change = lastPrice - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const isUp = change >= 0;

    const getPriceColor = (val: number) => {
      if (!val || !prevClose) return 'text-zinc-300';
      if (val > prevClose) return 'text-bull';
      if (val < prevClose) return 'text-bear';
      return 'text-zinc-400';
    };

    return (
      <div className="flex items-center justify-between flex-wrap gap-4 w-full bg-card border border-border rounded-xl p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 border border-primary/20 text-primary w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg">
            {activeCode}
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
              {name} ({activeCode})
            </h2>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {lastPrice > 0 ? (
                <>
                  <span className={`text-2xl font-black font-mono tracking-tight ${getPriceColor(lastPrice)}`}>
                    {lastPrice.toFixed(1)}
                  </span>
                  <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded ${isUp ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                    {isUp ? '▲' : '▼'} {Math.abs(change).toFixed(1)} ({isUp ? '+' : ''}{changePct.toFixed(2)}%)
                  </span>
                </>
              ) : (
                <span className="text-zinc-500 font-mono text-xs">暫無即時價格</span>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-2 border-t sm:border-t-0 sm:border-l border-border/80 pt-3 sm:pt-0 sm:pl-6 text-xs font-mono w-full sm:w-auto">
          <div>
            <div className="text-zinc-500 text-[10px]">開盤</div>
            <div className={`font-semibold mt-0.5 ${book?.day?.open ? getPriceColor(book.day.open) : 'text-zinc-400'}`}>
              {book?.day?.open?.toFixed(1) || '--'}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-[10px]">最高</div>
            <div className={`font-semibold mt-0.5 ${book?.day?.high ? getPriceColor(book.day.high) : 'text-zinc-400'}`}>
              {book?.day?.high?.toFixed(1) || '--'}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-[10px]">最低</div>
            <div className={`font-semibold mt-0.5 ${book?.day?.low ? getPriceColor(book.day.low) : 'text-zinc-400'}`}>
              {book?.day?.low?.toFixed(1) || '--'}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-[10px]">昨收</div>
            <div className="text-zinc-400 font-semibold mt-0.5">
              {book?.day?.prev_close?.toFixed(1) || '--'}
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <div className="text-zinc-500 text-[10px]">成交量</div>
            <div className="text-zinc-300 font-semibold mt-0.5">
              {book?.total?.trade_volume !== undefined && book?.total?.trade_volume !== null ? `${book.total.trade_volume.toLocaleString()} 張` : '--'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render Order Book
  const renderOrderBook = () => {
    if (headerBookState.loading && !headerBookState.data) {
      return <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入五檔中...</div>;
    }
    if (headerBookState.error) {
      return (
        <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
          <div>{headerBookState.error}</div>
          <button onClick={fetchHeaderAndBook} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
        </div>
      );
    }
    const book = headerBookState.data?.book as any;
    if (!book) return <div className="text-xs text-zinc-500 text-center py-8">無五檔資料</div>;

    const bids = book.bids || [];
    const asks = book.asks || [];
    const prevClose = book.day?.prev_close || 0;

    const allVols = [...bids.map((b: any) => (b.size || 0)), ...asks.map((a: any) => (a.size || 0))];
    const maxVol = Math.max(...allVols, 1);

    const getPriceColor = (price: number | null) => {
      if (!price || !prevClose) return 'text-zinc-300';
      if (price > prevClose) return 'text-bull font-semibold';
      if (price < prevClose) return 'text-bear font-semibold';
      return 'text-zinc-400';
    };

    const totalBidVol = bids.reduce((sum: number, b: any) => sum + (b.size || 0), 0);
    const totalAskVol = asks.reduce((sum: number, a: any) => sum + (a.size || 0), 0);
    const totalVol = totalBidVol + totalAskVol || 1;
    const bidPct = (totalBidVol / totalVol) * 100;
    const askPct = (totalAskVol / totalVol) * 100;

    const sortedAsks = [...asks].reverse();

    return (
      <div className="space-y-3 flex-1 flex flex-col justify-between">
        <div className="space-y-1">
          {sortedAsks.map((ask: any, idx: number) => {
            const pct = ((ask.size || 0) / maxVol) * 100;
            return (
              <div key={`ask-${idx}`} className="relative flex justify-between items-center text-xs py-1 px-2 rounded hover:bg-zinc-850/40">
                <div className="absolute right-0 top-0 bottom-0 bg-bear/10 transition-all duration-300" style={{ width: `${pct}%`, zIndex: 0 }} />
                <span className="text-zinc-500 z-10 font-mono">賣 {sortedAsks.length - idx}</span>
                <span className={`${getPriceColor(ask.price)} z-10 font-mono`}>{ask.price?.toFixed(1) || '--'}</span>
                <span className="text-zinc-400 z-10 font-mono">{ask.size?.toLocaleString() || '--'}</span>
              </div>
            );
          })}
        </div>

        <div className="border-t border-b border-border/80 py-1.5 px-2 flex justify-between items-center bg-zinc-950/40 font-mono text-xs my-1">
          <span className="text-zinc-500">成交</span>
          <span className={`${getPriceColor(book.last_price || null)} font-bold text-sm`}>
            {book.last_price?.toFixed(1) || '--'}
          </span>
          <span className="text-zinc-500">
            量: {book.total?.trade_volume?.toLocaleString() || '--'}
          </span>
        </div>

        <div className="space-y-1">
          {bids.map((bid: any, idx: number) => {
            const pct = ((bid.size || 0) / maxVol) * 100;
            return (
              <div key={`bid-${idx}`} className="relative flex justify-between items-center text-xs py-1 px-2 rounded hover:bg-zinc-850/40">
                <div className="absolute right-0 top-0 bottom-0 bg-bull/10 transition-all duration-300" style={{ width: `${pct}%`, zIndex: 0 }} />
                <span className="text-zinc-500 z-10 font-mono">買 {idx + 1}</span>
                <span className={`${getPriceColor(bid.price)} z-10 font-mono`}>{bid.price?.toFixed(1) || '--'}</span>
                <span className="text-zinc-400 z-10 font-mono">{bid.size?.toLocaleString() || '--'}</span>
              </div>
            );
          })}
        </div>

        <div className="pt-2 border-t border-border/60 mt-2">
          <div className="flex justify-between text-[10px] text-zinc-500 mb-1 font-mono">
            <span>委買比 (買氣): {bidPct.toFixed(1)}%</span>
            <span>委賣比 (賣氣): {askPct.toFixed(1)}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-zinc-800 flex overflow-hidden">
            <div className="bg-bull h-full transition-all duration-300" style={{ width: `${bidPct}%` }} />
            <div className="bg-bear h-full transition-all duration-300" style={{ width: `${askPct}%` }} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* 標題與個股快速搜尋 */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-bold text-zinc-300">個股多維度審查</h1>
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
          {useMock && (
            <span className="text-[10px] bg-neutral/10 border border-neutral/20 text-neutral px-2 py-1 rounded-md font-mono">
              Mock Mode (DEV)
            </span>
          )}
          <button
            onClick={fetchAllData}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 text-xs hover:bg-zinc-700 text-zinc-300 font-semibold"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            整理
          </button>
        </div>
      </div>

      {/* Quote Header */}
      {renderHeader()}

      <div className="space-y-6">
        {/* Main Section: Chart on Left, Signals/OrderBook on Right */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* K-line Chart */}
          <div className="xl:col-span-2 bg-card border border-border rounded-xl p-6 flex flex-col justify-between min-h-[420px]">
            <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-5 h-5 text-primary" />
                <span className="text-sm font-semibold text-zinc-200">互動式 K 線技術圖表</span>
              </div>
              <div className="flex bg-zinc-950/60 p-1 rounded-lg border border-border/80 text-xs">
                <button
                  onClick={() => handleKlineTypeChange('daily')}
                  className={`px-3 py-1 rounded-md transition ${klineState.type === 'daily' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  還原日 K 線
                </button>
                <button
                  onClick={() => handleKlineTypeChange('intraday')}
                  className={`px-3 py-1 rounded-md transition ${klineState.type === 'intraday' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  盤中分 K 線
                </button>
              </div>
            </div>

            <div className="flex-1 flex flex-col justify-center min-h-[300px]">
              {klineState.loading ? (
                <div className="text-xs text-zinc-500 animate-pulse text-center py-16">載入 K 線圖表中...</div>
              ) : klineState.error ? (
                <div className="p-6 border border-bull/20 bg-bull/5 rounded-lg text-center">
                  <p className="text-xs text-bull font-semibold mb-2">無法取得 K 線資料</p>
                  <p className="text-[10px] text-zinc-500 font-mono mb-4">{klineState.error}</p>
                  <button
                    onClick={() => fetchKlineData(klineState.type)}
                    className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs transition border border-border"
                  >
                    重試
                  </button>
                </div>
              ) : klineState.data && klineState.data.length > 0 ? (
                <PriceChart rows={klineState.data} isIntraday={klineState.type === 'intraday'} />
              ) : (
                <div className="text-center py-16 text-zinc-500 text-xs">無圖表資料</div>
              )}
            </div>
          </div>

          {/* Right Column: AI Decision & Order Book */}
          <div className="flex flex-col gap-6">
            {/* AI Decision */}
            <div className="bg-card border border-border rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
                <Cpu className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">AI 交易決策訊號</h3>
              </div>
              {signalState.loading ? (
                <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入交易決策中...</div>
              ) : signalState.error ? (
                <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
                  <div>{signalState.error}</div>
                  <button onClick={fetchSignal} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-750 rounded text-[10px] text-zinc-300">重試</button>
                </div>
              ) : signalState.data ? (
                <div className="space-y-4 flex-1 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                      <span className="text-xs text-zinc-400">波段決策 (Swing)</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${signalState.data.swing.action === 'BUY' ? 'bg-bull/10 text-bull' : signalState.data.swing.action === 'SELL' ? 'bg-bear/10 text-bear' : 'bg-zinc-800 text-zinc-400'}`}>
                        {signalState.data.swing.action} ({signalState.data.swing.score}分)
                      </span>
                    </div>
                    <div className="flex justify-between items-center p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                      <span className="text-xs text-zinc-400">當沖決策 (Daytrade)</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${signalState.data.daytrade.action === 'BUY' ? 'bg-bull/10 text-bull' : signalState.data.daytrade.action === 'SELL' ? 'bg-bear/10 text-bear' : 'bg-zinc-800 text-zinc-400'}`}>
                        {signalState.data.daytrade.action} ({signalState.data.daytrade.score}分)
                      </span>
                    </div>
                    <div className="flex justify-between items-center p-3.5 rounded-lg bg-primary/5 border border-primary/20">
                      <span className="text-xs font-semibold text-zinc-200">融合訊號 (Blended)</span>
                      <span className="text-sm font-bold text-primary font-mono">{signalState.data.blended.action} ({signalState.data.blended.score}分)</span>
                    </div>
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/40 text-[10px] text-zinc-500 font-mono text-right">
                    更新於: {new Date(signalState.data.generated_at || '').toLocaleString()}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-zinc-500 text-center py-8">無決策資料</div>
              )}
            </div>

            {/* Best 5 Order Book */}
            <div className="bg-card border border-border rounded-xl p-6 flex flex-col">
              <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />
                  <h3 className="font-semibold text-sm text-zinc-200">即時最佳五檔</h3>
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-zinc-400 select-none">
                  <input
                    type="checkbox"
                    checked={autoPoll}
                    onChange={(e) => setAutoPoll(e.target.checked)}
                    className="rounded border-zinc-800 bg-zinc-950 text-primary focus:ring-0 focus:ring-offset-0 w-3 h-3"
                  />
                  <span>自動更新(5s)</span>
                </label>
              </div>
              {renderOrderBook()}
            </div>
          </div>
        </div>

        {/* Chips & Fundamentals */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Chips */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <TrendingUp className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">多天期主力與法人籌碼</h3>
            </div>
            {chipsState.loading ? (
              <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入籌碼資料中...</div>
            ) : chipsState.error ? (
              <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
                <div>{chipsState.error}</div>
                <button onClick={fetchChips} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
              </div>
            ) : chipsState.data && chipsState.data.data.length > 0 ? (
              <ChipsCharts
                data={chipsState.data.data}
                name={chipsState.data.name || chipsState.data.code}
                asOf={chipsState.data.as_of || ''}
              />
            ) : (
              <div className="text-xs text-zinc-500 text-center py-8">無籌碼資料</div>
            )}
          </div>

          {/* Fundamentals */}
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <DollarSign className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">基本面估值與增長率</h3>
            </div>
            {fundamentalsState.loading ? (
              <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入基本面資料中...</div>
            ) : fundamentalsState.error ? (
              <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
                <div>{fundamentalsState.error}</div>
                <button onClick={fetchFundamentals} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
              </div>
            ) : fundamentalsState.data && fundamentalsState.data.metrics.length > 0 ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500 font-mono">本益比 (PE Ratio)</div>
                  <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentalsState.data.metrics[0].pe_ratio}x</div>
                </div>
                <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500 font-mono">股淨比 (PB Ratio)</div>
                  <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentalsState.data.metrics[0].pb_ratio}x</div>
                </div>
                <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500 font-mono">現金殖利率 (Yield)</div>
                  <div className="text-base font-semibold font-mono text-zinc-100 mt-1">{fundamentalsState.data.metrics[0].dividend_yield}%</div>
                </div>
                <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500 font-mono">單季營收年增率 (YoY)</div>
                  <div className={`text-base font-semibold font-mono mt-1 ${fundamentalsState.data.metrics[0].revenue_yoy >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {fundamentalsState.data.metrics[0].revenue_yoy >= 0 ? '+' : ''}{fundamentalsState.data.metrics[0].revenue_yoy}%
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-500 text-center py-8">無基本面資料</div>
            )}
          </div>
        </div>

        {/* News */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
            <Newspaper className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-sm text-zinc-200">即時市場輿情與新聞情緒</h3>
          </div>
          {newsState.loading ? (
            <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入新聞輿情中...</div>
          ) : newsState.error ? (
            <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
              <div>{newsState.error}</div>
              <button onClick={fetchNews} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
            </div>
          ) : newsState.data && newsState.data.news.length > 0 ? (
            <div className="space-y-4">
              {newsState.data.news.map((item) => (
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
          ) : (
            <div className="text-xs text-zinc-500 text-center py-8">無即時新聞輿情</div>
          )}
        </div>
      </div>
    </div>
  );
};
