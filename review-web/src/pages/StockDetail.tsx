import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { StockDetail as IStockDetail, StockChips, StockFundamentals, StockNews, Book, OhlcvRow, CompanyProfile, ShareholdingDispersion, StockHeatmap, HeatmapStock } from '../lib/api';
import { BarChart2, TrendingUp, Newspaper, DollarSign, Users, Info, ArrowLeft, Bell, Trash2 } from 'lucide-react';
import { PriceChart } from '../components/PriceChart';
import { ChipsCharts } from '../components/ChipsCharts';
import { StockBriefCard } from '../components/StockBriefCard';
import { FolderPickerButton } from '../components/FolderPickerButton';
import { buildStockBrief } from '../lib/stockBrief';
import type { StockBriefInput } from '../lib/stockBrief';
import { CODE_TO_GROUP } from '../lib/stockGroups';

export type StockTab = 'basic' | 'industry' | 'financials' | 'chips' | 'technical' | 'news';

interface TabItem {
  id: StockTab;
  label: string;
  isSoon?: boolean;
}

const STOCK_TABS: TabItem[] = [
  { id: 'basic', label: '基本資料' },
  { id: 'industry', label: '產業分析' },
  { id: 'financials', label: '財務分析' },
  { id: 'chips', label: '籌碼分析' },
  { id: 'technical', label: '技術分析' },
  { id: 'news', label: '相關新聞' },
];

const DEFAULT_STOCK_TAB: StockTab = 'technical';

type AlertConditionType =
  | 'price_above' | 'price_below'
  | 'kd_golden_cross' | 'kd_death_cross'
  | 'ma5_break_below' | 'ma5_break_above'
  | 'ma10_break_below' | 'ma10_break_above'
  | 'ma20_break_below' | 'ma20_break_above'
  | 'ma60_break_below' | 'ma60_break_above';

const ALERT_CONDITION_LABEL: Record<AlertConditionType, string> = {
  price_above: '收盤高於',
  price_below: '收盤低於',
  kd_golden_cross: 'KD 黃金交叉（K 由下往上穿越 D）',
  kd_death_cross: 'KD 死亡交叉（K 由上往下穿越 D）',
  ma5_break_below: '跌破 5 日均線',
  ma5_break_above: '站回 5 日均線',
  ma10_break_below: '跌破 10 日均線',
  ma10_break_above: '站回 10 日均線',
  ma20_break_below: '跌破 月線 (20MA)',
  ma20_break_above: '站回 月線 (20MA)',
  ma60_break_below: '跌破 季線 (60MA)',
  ma60_break_above: '站回 季線 (60MA)',
};

const isPriceCondition = (c: AlertConditionType) => c === 'price_above' || c === 'price_below';

const describeAlert = (a: StockAlertItem): string =>
  isPriceCondition(a.conditionType)
    ? `${ALERT_CONDITION_LABEL[a.conditionType]} ${a.price}`
    : ALERT_CONDITION_LABEL[a.conditionType];

interface StockAlertItem {
  id: string;
  conditionType: AlertConditionType;
  price?: number;
  enabled: boolean;
  note?: string;
}
interface StockAlertEntry {
  name: string;
  alerts: StockAlertItem[];
}
type StockAlertsConfig = Record<string, StockAlertEntry>;

export const StockDetail: React.FC = () => {
  const { code } = useParams<{ code: string }>();
  const activeCode = code || '2330';

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as StockTab | null;
  const activeTab: StockTab = useMemo(() => {
    if (rawTab && STOCK_TABS.some(t => t.id === rawTab)) {
      return rawTab;
    }
    return DEFAULT_STOCK_TAB;
  }, [rawTab]);

  const handleTabChange = (tabId: StockTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', tabId);
    setSearchParams(nextParams, { replace: true });
  };

  // Section States
  const [headerBookState, setHeaderBookState] = useState<{ data: Book | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [klineState, setKlineState] = useState<{ data: OhlcvRow[] | null; loading: boolean; error: string | null; type: 'daily' | 'intraday' }>({ data: null, loading: true, error: null, type: 'daily' });
  const [dailyRows, setDailyRows] = useState<OhlcvRow[] | null>(null);
  const [signalState, setSignalState] = useState<{ data: IStockDetail | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [chipsState, setChipsState] = useState<{ data: StockChips | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [fundamentalsState, setFundamentalsState] = useState<{ data: StockFundamentals | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [profileState, setProfileState] = useState<{ data: CompanyProfile | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [dispersionState, setDispersionState] = useState<{ data: ShareholdingDispersion | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [peersState, setPeersState] = useState<{ data: StockHeatmap | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const [peerSortKey, setPeerSortKey] = useState<'turnover' | 'change_pct'>('turnover');
  const [peerSortOrder, setPeerSortOrder] = useState<'asc' | 'desc'>('desc');
  const [chipsSubTab, setChipsSubTab] = useState<'dispersion' | 'inst' | 'margin'>('dispersion');
  const [dispersionMode, setDispersionMode] = useState<'people' | 'pct'>('people');
  const [dispHoverIdx, setDispHoverIdx] = useState<number | null>(null);
  // 大戶/散戶結構折線圖也用實際量測像素當 viewBox，理由同 fundChartSize（避免 letterbox 導致滑鼠座標對不上）
  const [dispChartSize, setDispChartSize] = useState({ w: 600, h: 220 });
  const dispChartRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () => setDispChartSize({ w: node.clientWidth, h: node.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const [newsState, setNewsState] = useState<{ data: StockNews | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [fundTab, setFundTab] = useState<'valuation' | 'revenue' | 'financials' | 'dividend'>('valuation');
  const [fundHoverIdx, setFundHoverIdx] = useState<number | null>(null);
  // 基本面 4 張圖表共用一組實際量測到的容器像素尺寸，讓 SVG viewBox 與畫面 1:1 對應，
  // 滑鼠座標才不會因 preserveAspectRatio 縮放置中（letterbox）而跟 viewBox 座標系對不上。
  const [fundChartSize, setFundChartSize] = useState({ w: 880, h: 520 });
  const fundChartRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () => setFundChartSize({ w: node.clientWidth, h: node.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const [alertsConfig, setAlertsConfig] = useState<StockAlertsConfig>({});
  const [alertsSaveStatus, setAlertsSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [alertForm, setAlertForm] = useState<{ conditionType: AlertConditionType; price: string }>({ conditionType: 'price_above', price: '' });

  useEffect(() => {
    setFundHoverIdx(null);
  }, [fundTab, activeCode]);

  // 個股價格警示設定：全站共用一份設定檔（data/stock_price_alerts.json），只在掛載時讀一次，
  // 之後每次新增/切換/刪除都本地樂觀更新＋整份寫回雲端（比照 RealizedPnl.tsx 的 saveToCloud 模式）。
  useEffect(() => {
    let cancelled = false;
    api.getStockAlerts().then((resp) => {
      if (cancelled) return;
      if (resp.exists && resp.data && resp.data.stocks) {
        setAlertsConfig(resp.data.stocks as unknown as StockAlertsConfig);
      }
    }).catch((e) => {
      console.error('讀取價格警示設定失敗', e);
    });
    return () => { cancelled = true; };
  }, []);

  const saveAlertsConfig = async (next: StockAlertsConfig) => {
    setAlertsConfig(next);
    setAlertsSaveStatus('saving');
    try {
      await api.saveStockAlerts({ stocks: next });
      setAlertsSaveStatus('saved');
    } catch (e) {
      console.error('儲存價格警示設定失敗', e);
      setAlertsSaveStatus('error');
    }
  };

  const addAlert = () => {
    const { conditionType } = alertForm;
    let price: number | undefined;
    if (isPriceCondition(conditionType)) {
      price = parseFloat(alertForm.price);
      if (!Number.isFinite(price) || price <= 0) return;
    }
    const entry = alertsConfig[activeCode] || { name: signalState.data?.name || activeCode, alerts: [] };
    const newAlert: StockAlertItem = {
      id: `a_${conditionType}_${price ?? ''}_${Date.now()}`,
      conditionType,
      ...(price !== undefined ? { price } : {}),
      enabled: true,
    };
    const nextEntry: StockAlertEntry = { ...entry, alerts: [...entry.alerts, newAlert] };
    void saveAlertsConfig({ ...alertsConfig, [activeCode]: nextEntry });
    setAlertForm({ conditionType: 'price_above', price: '' });
  };

  const toggleAlertEnabled = (id: string) => {
    const entry = alertsConfig[activeCode];
    if (!entry) return;
    const nextEntry: StockAlertEntry = {
      ...entry,
      alerts: entry.alerts.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    };
    void saveAlertsConfig({ ...alertsConfig, [activeCode]: nextEntry });
  };

  const deleteAlert = (id: string) => {
    const entry = alertsConfig[activeCode];
    if (!entry) return;
    const remaining = entry.alerts.filter((a) => a.id !== id);
    const next = { ...alertsConfig };
    if (remaining.length === 0) {
      delete next[activeCode];
    } else {
      next[activeCode] = { ...entry, alerts: remaining };
    }
    void saveAlertsConfig(next);
  };

  // 日K快照只在換股時清空（不可綁 fundTab，否則切基本面 tab 會清掉摘要卡動能軸與觀察點）
  useEffect(() => {
    setDailyRows(null);
  }, [activeCode]);

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

  const getMockShareholdingDispersion = (c: string): ShareholdingDispersion => {
    const dates = [
      '2026-03-20', '2026-03-27', '2026-04-03', '2026-04-10', '2026-04-17',
      '2026-04-24', '2026-05-02', '2026-05-09', '2026-05-16', '2026-05-23',
      '2026-05-30', '2026-06-06', '2026-06-13', '2026-06-20', '2026-06-27', '2026-07-03'
    ];
    const baseRetail = c === '3450' ? 71000 : c === '2330' ? 550000 : 120000;
    const baseMid = c === '3450' ? 145 : c === '2330' ? 2500 : 800;
    const baseLarge = c === '3450' ? 49 : c === '2330' ? 1500 : 350;

    let prevR: number | null = null;
    let prevM: number | null = null;
    let prevL: number | null = null;

    const weekly = dates.map((d, idx) => {
      const r = baseRetail + (idx * 120) + (idx % 3 * 50);
      const m = baseMid + (idx * 1) - (idx % 2 * 2);
      const l = Math.max(10, baseLarge - (idx * 1) + (idx % 4 * 1));

      const item = {
        date: d,
        retail: { people: r, people_delta: prevR !== null ? r - prevR : null, shares_pct: Number((42.1 + (idx % 3) * 0.1).toFixed(2)) },
        mid: { people: m, people_delta: prevM !== null ? m - prevM : null, shares_pct: Number((18.3 + (idx % 2) * 0.1).toFixed(2)) },
        large: { people: l, people_delta: prevL !== null ? l - prevL : null, shares_pct: Number((39.6 - (idx % 3) * 0.1).toFixed(2)) }
      };

      prevR = r;
      prevM = m;
      prevL = l;
      return item;
    });

    return {
      code: c,
      name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : c === '3450' ? '聯鈞' : '鴻海',
      levels: { retail: '≤50 張', mid: '50–400 張', large: '>400 張' },
      weekly,
      source: 'FinMind TaiwanStockHoldingSharesPer (Mock)',
      as_of: '2026-07-03'
    };
  };

  const getMockCompanyProfile = (c: string): CompanyProfile => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海',
      full_name: c === '2330' ? '台灣積體電路製造股份有限公司' : c === '2454' ? '聯發科技股份有限公司' : '鴻海精密工業股份有限公司',
      industry: c === '2330' ? '半導體業' : c === '2454' ? '半導體業' : '其他電子業',
      founded: c === '2330' ? '1987' : c === '2454' ? '1997' : '1974',
      chairman: c === '2330' ? '魏哲家' : c === '2454' ? '蔡明介' : '劉揚偉',
      address: c === '2330' ? '新竹科學園區力行六路8號' : c === '2454' ? '新竹科學園區展業一路1號' : '新北市土城區自由街2號',
      website: c === '2330' ? 'https://www.tsmc.com' : c === '2454' ? 'https://www.mediatek.tw' : 'https://www.honhai.com',
      capital: c === '2330' ? 259303804580 : c === '2454' ? 15998000000 : 138629900000,
      source: 'TWSE OpenAPI t187ap03_L (Mock)',
      as_of: new Date().toISOString().split('T')[0]
    };
  };

  const getMockFundamentals = (c: string): StockFundamentals => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : c === '2454' ? '聯發科' : '鴻海',
      as_of: '2026-06-19',
      summary: {
        pe_ratio: 24.5,
        pb_ratio: 6.8,
        dividend_yield: 2.45,
        market_cap: c === '2330' ? 18250000000000 : c === '2454' ? 2200000000000 : 2900000000000,
        eps_ttm: 42.1
      },
      valuation: [
        { date: '2025-06-19', pe_ratio: 22.0, pb_ratio: 6.0, dividend_yield: 2.70 },
        { date: '2025-09-19', pe_ratio: 23.1, pb_ratio: 6.3, dividend_yield: 2.60 },
        { date: '2025-12-19', pe_ratio: 23.5, pb_ratio: 6.4, dividend_yield: 2.55 },
        { date: '2026-03-19', pe_ratio: 24.0, pb_ratio: 6.6, dividend_yield: 2.50 },
        { date: '2026-06-19', pe_ratio: 24.5, pb_ratio: 6.8, dividend_yield: 2.45 }
      ],
      revenue: [
        { month: '2025-10', revenue: 235000000000, yoy: 12.5, mom: 5.2 },
        { month: '2025-11', revenue: 240000000000, yoy: 14.1, mom: 2.1 },
        { month: '2025-12', revenue: 245000000000, yoy: 15.0, mom: 2.08 },
        { month: '2026-01', revenue: 230000000000, yoy: 11.2, mom: -6.1 },
        { month: '2026-02', revenue: 220000000000, yoy: 9.8, mom: -4.3 },
        { month: '2026-03', revenue: 240000000000, yoy: 13.4, mom: 9.1 },
        { month: '2026-04', revenue: 245000000000, yoy: 14.2, mom: 2.08 },
        { month: '2026-05', revenue: 250000000000, yoy: 15.4, mom: 2.04 }
      ],
      financials: [
        { quarter: '2024-Q3', eps: 7.2, gross_margin: 54.1, operating_margin: 40.2, net_margin: 36.1 },
        { quarter: '2024-Q4', eps: 8.1, gross_margin: 54.8, operating_margin: 40.8, net_margin: 36.9 },
        { quarter: '2025-Q1', eps: 8.3, gross_margin: 55.0, operating_margin: 41.0, net_margin: 37.1 },
        { quarter: '2025-Q2', eps: 8.5, gross_margin: 55.5, operating_margin: 41.5, net_margin: 37.8 },
        { quarter: '2025-Q3', eps: 9.2, gross_margin: 56.0, operating_margin: 42.0, net_margin: 38.2 },
        { quarter: '2025-Q4', eps: 9.5, gross_margin: 55.8, operating_margin: 41.8, net_margin: 38.0 },
        { quarter: '2026-Q1', eps: 8.7, gross_margin: 56.2, operating_margin: 42.1, net_margin: 38.5 }
      ],
      dividend: [
        { year: '2021', cash_dividend: 11.0, stock_dividend: 0.0 },
        { year: '2022', cash_dividend: 11.0, stock_dividend: 0.0 },
        { year: '2023', cash_dividend: 11.5, stock_dividend: 0.0 },
        { year: '2024', cash_dividend: 13.0, stock_dividend: 0.0 },
        { year: '2025', cash_dividend: 13.5, stock_dividend: 0.0 }
      ],
      unit: {
        revenue: '元',
        market_cap: '元',
        dividend: '元/股',
        ratio: '%'
      },
      source: 'FinMind (Mock)'
    };
  };

  const getMockNews = (c: string): StockNews => {
    return {
      code: c,
      name: c === '2330' ? '台積電' : '個股',
      as_of: new Date().toISOString(),
      summary: {
        overall_label: 'positive',
        overall_score: 76.7,
        positive: 2,
        negative: 0,
        neutral: 1,
        total: 3
      },
      items: [
        { title: '台積電 3 奈米產能供不應求，傳蘋果與超微包下產能', published: '2026-06-20T10:00:00+08:00', url: '#', summary: '半導體供應鏈指出，台積電 3 奈米製程持續滿載，訂單已排至明年。', sentiment: { label: 'positive', score: 92, hits: ['訂單', '成長'] }, source: 'Anue 鉅亨' },
        { title: '外資持續回流！單日大舉買超台積電逾 3,500 張', published: '2026-06-19T14:30:00+08:00', url: '#', summary: '受到美股 ADR 大漲鼓舞，外資現貨市場再度成為推升台積電股價的主力。', sentiment: { label: 'positive', score: 88, hits: ['買超', '大漲'] }, source: '經濟日報' },
        { title: '地緣政治風險升溫，分析師示警供應鏈過度集中之疑慮', published: '2026-06-18T09:15:00+08:00', url: '#', summary: '地緣政治智庫指出，雖然台積電技術領先，但集中在台海的製造產能仍面臨宏觀風險挑戰。', sentiment: { label: 'neutral', score: 50, hits: [] }, source: '工商時報' }
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
      if (klineType === 'daily') {
        setDailyRows(rows);
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

  const fetchProfile = async () => {
    setProfileState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: CompanyProfile;
      if (useMock) {
        data = getMockCompanyProfile(activeCode);
      } else {
        data = await api.stockProfile(activeCode);
      }
      setProfileState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch company profile failed:', err);
      setProfileState({ data: null, loading: false, error: err.message || '無法載入公司基本檔' });
    }
  };

  const fetchShareholding = async () => {
    setDispersionState(prev => ({ ...prev, loading: true, error: null }));
    try {
      let data: ShareholdingDispersion;
      if (useMock) {
        data = getMockShareholdingDispersion(activeCode);
      } else {
        data = await api.stockShareholding(activeCode, 16);
      }
      setDispersionState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch shareholding dispersion failed:', err);
      setDispersionState({ data: null, loading: false, error: err.message || '無法載入股權分散資料' });
    }
  };

  const fetchPeers = async () => {
    if (peersState.data && !peersState.error) return;
    setPeersState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketStockHeatmap();
      setPeersState({ data, loading: false, error: null });
    } catch (err: any) {
      console.error('Fetch industry peers failed:', err);
      setPeersState({ data: null, loading: false, error: err.message || '無法載入同產業數據' });
    }
  };

  useEffect(() => {
    if (activeTab === 'industry') {
      fetchPeers();
    }
  }, [activeTab, activeCode]);

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

  const fetchAllData = (klineType?: 'daily' | 'intraday') => {
    fetchHeaderAndBook();
    fetchKlineData(klineType ?? klineState.type);
    fetchSignal();
    fetchChips();
    fetchFundamentals();
    fetchProfile();
    fetchShareholding();
    fetchNews();
  };

  // Change K-line Type
  const handleKlineTypeChange = (type: 'daily' | 'intraday') => {
    if (type !== klineState.type) {
      fetchKlineData(type);
    }
  };

  // Initial Fetch（換股一律以日K載入，確保摘要卡動能軸/觀察點有日K快照可算；請求數不變）
  useEffect(() => {
    fetchAllData('daily');
  }, [activeCode, useMock]);

  // Opt 8: Build Research Brief Input and Memoized StockBrief
  const briefInput: StockBriefInput = useMemo(() => ({
    blended: signalState.data?.blended || null,
    dailyOhlcv: dailyRows,
    chips: chipsState.data,
    fundamentals: fundamentalsState.data,
    news: newsState.data,
  }), [signalState.data, dailyRows, chipsState.data, fundamentalsState.data, newsState.data]);

  const stockBrief = useMemo(() => buildStockBrief(briefInput), [briefInput]);

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

    const fundamentals = fundamentalsState.data;
    const pe = fundamentals?.summary?.pe_ratio;
    const mc = fundamentals?.summary?.market_cap;
    const peValText = pe !== undefined && pe !== null ? `${pe.toFixed(1)}x` : '--';
    const marketCapText = mc !== undefined && mc !== null
      ? mc >= 1e12
        ? `${(mc / 1e12).toFixed(2)} 兆`
        : mc >= 1e8
          ? `${(mc / 1e8).toFixed(1)} 億`
          : `${mc.toLocaleString()} 元`
      : '—';

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
          <FolderPickerButton code={activeCode} name={name} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-7 gap-x-4 gap-y-2 border-t sm:border-t-0 sm:border-l border-border/80 pt-3 sm:pt-0 sm:pl-6 text-xs font-mono w-full sm:w-auto">
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
          <div>
            <div className="text-zinc-500 text-[10px]">本益比</div>
            <div className="text-zinc-300 font-semibold mt-0.5">
              {peValText}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-[10px]">市值</div>
            <div className="text-zinc-300 font-semibold mt-0.5 whitespace-nowrap">
              {marketCapText}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-[10px]">成交量</div>
            <div className="text-zinc-300 font-semibold mt-0.5">
              {book?.total?.trade_volume !== undefined && book?.total?.trade_volume !== null ? `${book.total.trade_volume.toLocaleString()} 張` : '--'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderFundamentals = () => {
    if (fundamentalsState.loading) {
      return <div className="text-xs text-zinc-500 animate-pulse text-center py-16">載入基本面資料中...</div>;
    }
    if (fundamentalsState.error) {
      return (
        <div className="p-6 border border-bull/20 bg-bull/5 rounded-lg text-center">
          <p className="text-xs text-bull font-semibold mb-2">無法取得基本面資料</p>
          <p className="text-[10px] text-zinc-500 font-mono mb-4">{fundamentalsState.error}</p>
          <button
            onClick={fetchFundamentals}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs transition border border-border"
          >
            重試
          </button>
        </div>
      );
    }
    const data = fundamentalsState.data;
    if (!data) return <div className="text-xs text-zinc-500 text-center py-16">無基本面資料</div>;

    // Helper to calculate percentile label
    const getPercentileLabel = (current: number | null | undefined, history: (number | null)[]) => {
      if (current === undefined || current === null) return null;
      const validHistory = history.filter((v): v is number => v !== null && v !== undefined);
      if (validHistory.length === 0) return null;
      const sorted = [...validHistory].sort((a, b) => a - b);
      const index = sorted.findIndex(v => v >= current);
      const pct = (index / sorted.length) * 100;
      if (pct < 25) return { label: '近一年偏低', pct, color: 'text-zinc-400 bg-zinc-800 border-zinc-700' };
      if (pct > 75) return { label: '近一年偏高', pct, color: 'text-zinc-300 bg-zinc-800 border-zinc-700' };
      return { label: '近一年適中', pct, color: 'text-zinc-400 bg-zinc-800 border-zinc-700/60' };
    };

    const formatMC = (mc: number | null | undefined) => {
      if (mc === undefined || mc === null) return '—';
      if (mc >= 1e12) return `${(mc / 1e12).toFixed(2)} 兆`;
      if (mc >= 1e8) return `${(mc / 1e8).toFixed(1)} 億`;
      return `${mc.toLocaleString()} 元`;
    };

    const fmt = (v: number) => {
      if (Math.abs(v) >= 1000000000000) return `${(v / 1000000000000).toFixed(2)}T`;
      if (Math.abs(v) >= 100000000) return `${(v / 100000000).toFixed(1)}Y`;
      if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(0)}k`;
      return v.toFixed(0);
    };

    return (
      <div className="flex flex-col h-full justify-between">
        {/* Tab selection */}
        <div className="flex border-b border-border/60 mb-4 bg-zinc-950/20 p-0.5 rounded-lg shrink-0">
          {(['valuation', 'revenue', 'financials', 'dividend'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setFundTab(tab); setFundHoverIdx(null); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                fundTab === tab
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab === 'valuation' && '估值分析'}
              {tab === 'revenue' && '月營收趨勢'}
              {tab === 'financials' && '獲利能力'}
              {tab === 'dividend' && '股利政策'}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 flex flex-col justify-between min-h-[220px]">
          {fundTab === 'valuation' && (() => {
            const valuation = data.valuation || [];
            if (valuation.length === 0) {
              return <div className="text-xs text-zinc-500 text-center py-16">估值分析資料尚未提供</div>;
            }
            const pe = data.summary?.pe_ratio;
            const pb = data.summary?.pb_ratio;
            const dy = data.summary?.dividend_yield;
            const mc = data.summary?.market_cap;

            const peLabel = getPercentileLabel(pe, valuation.map(v => v.pe_ratio));
            const pbLabel = getPercentileLabel(pb, valuation.map(v => v.pb_ratio));

            const svgWidth = fundChartSize.w;
            const svgHeight = fundChartSize.h;
            const paddingLeft = 45;
            const paddingRight = 15;
            const paddingTop = 15;
            const paddingBottom = 20;
            const plotWidth = svgWidth - paddingLeft - paddingRight;
            const plotHeight = svgHeight - paddingTop - paddingBottom;
            const stepX = plotWidth / (valuation.length - 1 || 1);

            const peVals = valuation.map(v => v.pe_ratio).filter((v): v is number => v !== null);
            const maxPE = peVals.length > 0 ? Math.max(...peVals) : 35;
            const minPE = peVals.length > 0 ? Math.min(...peVals) : 10;
            const peDiff = maxPE - minPE || 1;
            const peMaxY = maxPE + peDiff * 0.1;
            const peMinY = Math.max(0, minPE - peDiff * 0.1);

            const hoverRow = fundHoverIdx !== null ? valuation[fundHoverIdx] : null;

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">本益比 (PE)</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100 flex items-baseline gap-1.5 flex-wrap">
                      {pe !== null ? `${pe.toFixed(1)}x` : '—'}
                      {peLabel && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border leading-none ${peLabel.color}`}>
                          {peLabel.label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">股淨比 (PB)</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100 flex items-baseline gap-1.5 flex-wrap">
                      {pb !== null ? `${pb.toFixed(1)}x` : '—'}
                      {pbLabel && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border leading-none ${pbLabel.color}`}>
                          {pbLabel.label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">殖利率</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100">
                      {dy !== null ? `${dy.toFixed(2)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">市值</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100">
                      {formatMC(mc)}
                    </div>
                  </div>
                </div>

                <div ref={fundChartRef} className="relative bg-zinc-950/30 rounded-xl border border-border/40 p-2 h-[520px]">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    preserveAspectRatio="none"
                    className="overflow-visible select-none cursor-crosshair"
                    onMouseMove={(e) => {
                      const svgRect = e.currentTarget.getBoundingClientRect();
                      const mouseX = (e.clientX - svgRect.left) - paddingLeft;
                      if (mouseX < -stepX / 2 || mouseX > plotWidth + stepX / 2) {
                        setFundHoverIdx(null);
                        return;
                      }
                      const idx = Math.max(0, Math.min(valuation.length - 1, Math.round(mouseX / stepX)));
                      setFundHoverIdx(idx);
                    }}
                    onMouseLeave={() => setFundHoverIdx(null)}
                  >
                    {/* Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((val) => {
                      const y = paddingTop + val * plotHeight;
                      return (
                        <line
                          key={val}
                          x1={paddingLeft}
                          y1={y}
                          x2={svgWidth - paddingRight}
                          y2={y}
                          stroke="#27272a"
                          strokeWidth="1"
                          strokeDasharray="2,2"
                        />
                      );
                    })}

                    {/* Y-axis labels */}
                    <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {peMaxY.toFixed(1)}x
                    </text>
                    <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {peMinY.toFixed(1)}x
                    </text>

                    {/* PE line */}
                    {(() => {
                      const points = valuation.map((v, idx) => {
                        const val = v.pe_ratio ?? peMinY;
                        const x = paddingLeft + idx * stepX;
                        const y = paddingTop + plotHeight - ((val - peMinY) / (peMaxY - peMinY || 1)) * plotHeight;
                        return `${x},${y}`;
                      }).join(' ');
                      return <polyline points={points} fill="none" stroke="#6366f1" strokeWidth="1.75" opacity={fundHoverIdx === null ? 0.9 : 0.4} />;
                    })()}

                    {/* Active dot */}
                    {valuation.map((v, idx) => {
                      if (fundHoverIdx !== idx || v.pe_ratio === null) return null;
                      const x = paddingLeft + idx * stepX;
                      const y = paddingTop + plotHeight - ((v.pe_ratio - peMinY) / (peMaxY - peMinY || 1)) * plotHeight;
                      return (
                        <circle key={`pe-dot-${idx}`} cx={x} cy={y} r="4" fill="#6366f1" stroke="#09090b" strokeWidth="1" />
                      );
                    })}

                    {/* X-axis labels */}
                    {(() => {
                      const count = valuation.length;
                      const indices = [0, Math.floor(count / 2), count - 1];
                      return indices.map((idx) => {
                        const row = valuation[idx];
                        if (!row) return null;
                        const x = paddingLeft + idx * stepX;
                        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
                        if (idx === 0) textAnchor = 'start';
                        if (idx === count - 1) textAnchor = 'end';
                        return (
                          <text key={`lbl-${idx}`} x={x} y={paddingTop + plotHeight + 14} textAnchor={textAnchor} className="fill-zinc-500 font-mono text-[9px]">
                            {row.date.slice(5)}
                          </text>
                        );
                      });
                    })()}

                    {/* Vertical Tracker */}
                    {fundHoverIdx !== null && (
                      <line
                        x1={paddingLeft + fundHoverIdx * stepX}
                        y1={paddingTop}
                        x2={paddingLeft + fundHoverIdx * stepX}
                        y2={paddingTop + plotHeight}
                        stroke="#52525b"
                        strokeWidth="1.2"
                        strokeDasharray="3,3"
                      />
                    )}
                  </svg>

                  {/* Tooltip */}
                  {fundHoverIdx !== null && hoverRow && (
                    <div
                      className={`absolute top-2 z-10 p-2.5 rounded-lg border border-border bg-zinc-950/95 shadow-xl text-[10px] w-[140px] pointer-events-none flex flex-col gap-1 ${
                        fundHoverIdx > valuation.length / 2 ? 'left-12' : 'right-12'
                      }`}
                    >
                      <div className="font-mono text-zinc-400 font-bold border-b border-border/50 pb-1">
                        {hoverRow.date}
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">本益比 PE</span>
                        <span className="text-indigo-400 font-semibold">{hoverRow.pe_ratio !== null ? `${hoverRow.pe_ratio.toFixed(1)}x` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">股淨比 PB</span>
                        <span className="text-zinc-300 font-semibold">{hoverRow.pb_ratio !== null ? `${hoverRow.pb_ratio.toFixed(2)}x` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">殖利率</span>
                        <span className="text-zinc-300 font-semibold">{hoverRow.dividend_yield !== null ? `${hoverRow.dividend_yield.toFixed(2)}%` : '—'}</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono mt-1 px-1">
                  <span>線圖: 近一年 PER 日頻走勢 (藍)</span>
                  <span>資料來源: {data.source}</span>
                </div>
              </div>
            );
          })()}

          {fundTab === 'revenue' && (() => {
            const revenue = data.revenue || [];
            if (revenue.length === 0) {
              return <div className="text-xs text-zinc-500 text-center py-16">營收資料尚未提供</div>;
            }
            const latest = revenue[revenue.length - 1];
            const revVal = latest.revenue;
            const yoyVal = latest.yoy;
            const momVal = latest.mom;

            const formatRev = (val: number | null | undefined) => {
              if (val === undefined || val === null) return '—';
              if (val >= 1e12) return `${(val / 1e12).toFixed(2)} 兆元`;
              if (val >= 1e8) return `${(val / 1e8).toFixed(1)} 億元`;
              return `${val.toLocaleString()} 元`;
            };

            const svgWidth = fundChartSize.w;
            const svgHeight = fundChartSize.h;
            const paddingLeft = 45;
            const paddingRight = 40;
            const paddingTop = 15;
            const paddingBottom = 20;
            const plotWidth = svgWidth - paddingLeft - paddingRight;
            const plotHeight = svgHeight - paddingTop - paddingBottom;
            const stepX = plotWidth / (revenue.length - 1 || 1);

            const revVals = revenue.map(r => r.revenue).filter((v): v is number => v !== null);
            const maxRev = revVals.length > 0 ? Math.max(...revVals) : 1e10;
            const revMaxY = maxRev * 1.15;

            const yoyVals = revenue.map(r => r.yoy).filter((v): v is number => v !== null);
            const maxYoY = yoyVals.length > 0 ? Math.max(...yoyVals) : 20;
            const minYoY = yoyVals.length > 0 ? Math.min(...yoyVals) : -10;
            const yoyDiff = maxYoY - minYoY || 1;
            const yoyMaxY = maxYoY + yoyDiff * 0.15;
            const yoyMinY = minYoY - yoyDiff * 0.15;

            const hoverRow = fundHoverIdx !== null ? revenue[fundHoverIdx] : null;

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">當月營收 ({latest.month})</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100">
                      {formatRev(revVal)}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">年增率 (YoY)</div>
                    <div className={`text-xs font-semibold mt-1 font-mono flex items-center gap-1 ${yoyVal === null ? 'text-zinc-400' : (yoyVal >= 0 ? 'text-bull' : 'text-bear')}`}>
                      {yoyVal !== null ? `${yoyVal >= 0 ? '▲' : '▼'} ${Math.abs(yoyVal).toFixed(2)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">月增率 (MoM)</div>
                    <div className={`text-xs font-semibold mt-1 font-mono flex items-center gap-1 ${momVal === null ? 'text-zinc-400' : (momVal >= 0 ? 'text-bull' : 'text-bear')}`}>
                      {momVal !== null ? `${momVal >= 0 ? '▲' : '▼'} ${Math.abs(momVal).toFixed(2)}%` : '—'}
                    </div>
                  </div>
                </div>

                <div ref={fundChartRef} className="relative bg-zinc-950/30 rounded-xl border border-border/40 p-2 h-[520px]">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    preserveAspectRatio="none"
                    className="overflow-visible select-none cursor-crosshair"
                    onMouseMove={(e) => {
                      const svgRect = e.currentTarget.getBoundingClientRect();
                      const mouseX = (e.clientX - svgRect.left) - paddingLeft;
                      if (mouseX < -stepX / 2 || mouseX > plotWidth + stepX / 2) {
                        setFundHoverIdx(null);
                        return;
                      }
                      const idx = Math.max(0, Math.min(revenue.length - 1, Math.round(mouseX / stepX)));
                      setFundHoverIdx(idx);
                    }}
                    onMouseLeave={() => setFundHoverIdx(null)}
                  >
                    {/* Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((val) => {
                      const y = paddingTop + val * plotHeight;
                      return (
                        <line
                          key={val}
                          x1={paddingLeft}
                          y1={y}
                          x2={svgWidth - paddingRight}
                          y2={y}
                          stroke="#27272a"
                          strokeWidth="1"
                          strokeDasharray="2,2"
                        />
                      );
                    })}

                    {/* YoY zero line */}
                    {yoyMinY < 0 && yoyMaxY > 0 && (() => {
                      const y = paddingTop + plotHeight - ((-yoyMinY) / (yoyMaxY - yoyMinY)) * plotHeight;
                      return <line x1={paddingLeft} y1={y} x2={svgWidth - paddingRight} y2={y} stroke="#3f3f46" strokeWidth="1" />;
                    })()}

                    {/* Y-axis Left (Revenue) */}
                    <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {fmt(revMaxY)}
                    </text>
                    <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      0
                    </text>

                    {/* Y-axis Right (YoY) */}
                    <text x={svgWidth - paddingRight + 8} y={paddingTop + 4} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                      {yoyMaxY.toFixed(0)}%
                    </text>
                    <text x={svgWidth - paddingRight + 8} y={paddingTop + plotHeight + 3} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                      {yoyMinY.toFixed(0)}%
                    </text>

                    {/* Revenue Bars */}
                    {revenue.map((r, idx) => {
                      if (r.revenue === null) return null;
                      const x = paddingLeft + idx * stepX;
                      const barWidth = Math.max(3, Math.min(10, stepX * 0.45));
                      const h = (r.revenue / revMaxY) * plotHeight;
                      const rectY = paddingTop + plotHeight - h;
                      return (
                        <rect
                          key={`rev-bar-${idx}`}
                          x={x - barWidth / 2}
                          y={rectY}
                          width={barWidth}
                          height={Math.max(1, h)}
                          fill="#3f3f46"
                          opacity={fundHoverIdx === null || fundHoverIdx === idx ? 0.7 : 0.3}
                        />
                      );
                    })}

                    {/* YoY Line */}
                    {(() => {
                      const points = revenue.map((r, idx) => {
                        const val = r.yoy ?? yoyMinY;
                        const x = paddingLeft + idx * stepX;
                        const y = paddingTop + plotHeight - ((val - yoyMinY) / (yoyMaxY - yoyMinY || 1)) * plotHeight;
                        return `${x},${y}`;
                      }).join(' ');
                      return <polyline points={points} fill="none" stroke="#f59e0b" strokeWidth="1.75" opacity={fundHoverIdx === null ? 0.9 : 0.4} />;
                    })()}

                    {/* YoY Dots */}
                    {revenue.map((r, idx) => {
                      if (r.yoy === null) return null;
                      const x = paddingLeft + idx * stepX;
                      const y = paddingTop + plotHeight - ((r.yoy - yoyMinY) / (yoyMaxY - yoyMinY || 1)) * plotHeight;
                      return (
                        <circle
                          key={`yoy-dot-${idx}`}
                          cx={x}
                          cy={y}
                          r={fundHoverIdx === idx ? 3.5 : 2}
                          fill="#f59e0b"
                          stroke="#09090b"
                          strokeWidth="1"
                        />
                      );
                    })}

                    {/* X-axis labels */}
                    {(() => {
                      const count = revenue.length;
                      const indices = [0, Math.floor(count / 2), count - 1];
                      return indices.map((idx) => {
                        const row = revenue[idx];
                        if (!row) return null;
                        const x = paddingLeft + idx * stepX;
                        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
                        if (idx === 0) textAnchor = 'start';
                        if (idx === count - 1) textAnchor = 'end';
                        return (
                          <text key={`rev-lbl-${idx}`} x={x} y={paddingTop + plotHeight + 14} textAnchor={textAnchor} className="fill-zinc-500 font-mono text-[9px]">
                            {row.month.slice(2)}
                          </text>
                        );
                      });
                    })()}

                    {/* Vertical Tracker */}
                    {fundHoverIdx !== null && (
                      <line
                        x1={paddingLeft + fundHoverIdx * stepX}
                        y1={paddingTop}
                        x2={paddingLeft + fundHoverIdx * stepX}
                        y2={paddingTop + plotHeight}
                        stroke="#52525b"
                        strokeWidth="1.2"
                        strokeDasharray="3,3"
                      />
                    )}
                  </svg>

                  {/* Tooltip */}
                  {fundHoverIdx !== null && hoverRow && (
                    <div
                      className={`absolute top-2 z-10 p-2.5 rounded-lg border border-border bg-zinc-950/95 shadow-xl text-[10px] w-[150px] pointer-events-none flex flex-col gap-1 ${
                        fundHoverIdx > revenue.length / 2 ? 'left-12' : 'right-12'
                      }`}
                    >
                      <div className="font-mono text-zinc-400 font-bold border-b border-border/50 pb-1">
                        {hoverRow.month}
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">月營收</span>
                        <span className="text-zinc-300 font-semibold">{formatRev(hoverRow.revenue)}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">年增 YoY</span>
                        <span className={`font-semibold ${hoverRow.yoy === null ? 'text-zinc-400' : (hoverRow.yoy >= 0 ? 'text-bull' : 'text-bear')}`}>
                          {hoverRow.yoy !== null ? `${hoverRow.yoy > 0 ? '+' : ''}${hoverRow.yoy}%` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">月增 MoM</span>
                        <span className={`font-semibold ${hoverRow.mom === null ? 'text-zinc-400' : (hoverRow.mom >= 0 ? 'text-bull' : 'text-bear')}`}>
                          {hoverRow.mom !== null ? `${hoverRow.mom > 0 ? '+' : ''}${hoverRow.mom}%` : '—'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono mt-1 px-1">
                  <span>圖例: 柱狀 = 月營收 (灰)，折線 = YoY (橘)</span>
                  <span>資料來源: {data.source}</span>
                </div>
              </div>
            );
          })()}

          {fundTab === 'financials' && (() => {
            const financials = data.financials || [];
            if (financials.length === 0) {
              return <div className="text-xs text-zinc-500 text-center py-16">獲利資料尚未提供</div>;
            }
            const latest = financials[financials.length - 1];
            const epsVal = latest.eps;
            const gm = latest.gross_margin;
            const om = latest.operating_margin;
            const nm = latest.net_margin;

            const svgWidth = fundChartSize.w;
            const svgHeight = fundChartSize.h;
            const paddingLeft = 40;
            const paddingRight = 40;
            const paddingTop = 15;
            const paddingBottom = 20;
            const plotWidth = svgWidth - paddingLeft - paddingRight;
            const plotHeight = svgHeight - paddingTop - paddingBottom;
            const stepX = plotWidth / (financials.length - 1 || 1);

            const epsVals = financials.map(f => f.eps).filter((v): v is number => v !== null);
            const maxEps = epsVals.length > 0 ? Math.max(...epsVals) : 5;
            const minEps = epsVals.length > 0 ? Math.min(...epsVals) : 0;
            const epsMaxY = maxEps * 1.15;
            const epsMinY = Math.min(0, minEps - 0.5);

            const hasMargins = financials.some(f => f.gross_margin !== null);

            const hoverRow = fundHoverIdx !== null ? financials[fundHoverIdx] : null;

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-2">
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">單季 EPS ({latest.quarter})</div>
                    <div className="text-xs font-semibold mt-0.5 font-mono text-zinc-100">
                      {epsVal !== null ? `${epsVal.toFixed(2)} 元` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">毛利率</div>
                    <div className="text-xs font-semibold mt-0.5 font-mono text-pink-400">
                      {gm !== null ? `${gm.toFixed(1)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">營益率</div>
                    <div className="text-xs font-semibold mt-0.5 font-mono text-teal-400">
                      {om !== null ? `${om.toFixed(1)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">淨利率</div>
                    <div className="text-xs font-semibold mt-0.5 font-mono text-indigo-400">
                      {nm !== null ? `${nm.toFixed(1)}%` : '—'}
                    </div>
                  </div>
                </div>

                <div ref={fundChartRef} className="relative bg-zinc-950/30 rounded-xl border border-border/40 p-2 h-[520px]">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    preserveAspectRatio="none"
                    className="overflow-visible select-none cursor-crosshair"
                    onMouseMove={(e) => {
                      const svgRect = e.currentTarget.getBoundingClientRect();
                      const mouseX = (e.clientX - svgRect.left) - paddingLeft;
                      if (mouseX < -stepX / 2 || mouseX > plotWidth + stepX / 2) {
                        setFundHoverIdx(null);
                        return;
                      }
                      const idx = Math.max(0, Math.min(financials.length - 1, Math.round(mouseX / stepX)));
                      setFundHoverIdx(idx);
                    }}
                    onMouseLeave={() => setFundHoverIdx(null)}
                  >
                    {/* Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((val) => {
                      const y = paddingTop + val * plotHeight;
                      return (
                        <line
                          key={val}
                          x1={paddingLeft}
                          y1={y}
                          x2={svgWidth - paddingRight}
                          y2={y}
                          stroke="#27272a"
                          strokeWidth="1"
                          strokeDasharray="2,2"
                        />
                      );
                    })}

                    {/* Y-axis Left (EPS) */}
                    <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {epsMaxY.toFixed(1)}
                    </text>
                    <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {epsMinY.toFixed(1)}
                    </text>

                    {/* Y-axis Right (Margins %) */}
                    <text x={svgWidth - paddingRight + 8} y={paddingTop + 4} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                      100%
                    </text>
                    <text x={svgWidth - paddingRight + 8} y={paddingTop + plotHeight + 3} textAnchor="start" className="fill-zinc-500 font-mono text-[9px]">
                      0%
                    </text>

                    {/* EPS Bars */}
                    {financials.map((f, idx) => {
                      if (f.eps === null) return null;
                      const x = paddingLeft + idx * stepX;
                      const barWidth = Math.max(3, Math.min(10, stepX * 0.45));
                      const h = ((f.eps - epsMinY) / (epsMaxY - epsMinY || 1)) * plotHeight;
                      const rectY = paddingTop + plotHeight - h;
                      return (
                        <rect
                          key={`eps-bar-${idx}`}
                          x={x - barWidth / 2}
                          y={rectY}
                          width={barWidth}
                          height={Math.max(1, h)}
                          fill="#3b82f6"
                          opacity={fundHoverIdx === null || fundHoverIdx === idx ? 0.7 : 0.3}
                        />
                      );
                    })}

                    {/* Margin lines */}
                    {hasMargins && (() => {
                      const createLine = (key: 'gross_margin' | 'operating_margin' | 'net_margin', color: string) => {
                        const points = financials.map((f, idx) => {
                          const val = f[key] ?? 0;
                          const x = paddingLeft + idx * stepX;
                          const y = paddingTop + plotHeight - (val / 100) * plotHeight;
                          return `${x},${y}`;
                        }).join(' ');
                        return <polyline points={points} fill="none" stroke={color} strokeWidth="1.25" opacity={fundHoverIdx === null ? 0.85 : 0.35} />;
                      };
                      return (
                        <>
                          {createLine('gross_margin', '#f472b6')}
                          {createLine('operating_margin', '#2dd4bf')}
                          {createLine('net_margin', '#818cf8')}
                        </>
                      );
                    })()}

                    {/* Active Dots for Margins */}
                    {fundHoverIdx !== null && hoverRow && hasMargins && (() => {
                      const x = paddingLeft + fundHoverIdx * stepX;
                      const renderDot = (val: number | null, color: string) => {
                        if (val === null) return null;
                        const y = paddingTop + plotHeight - (val / 100) * plotHeight;
                        return <circle cx={x} cy={y} r="3" fill={color} stroke="#09090b" strokeWidth="1" />;
                      };
                      return (
                        <g>
                          {renderDot(hoverRow.gross_margin, '#f472b6')}
                          {renderDot(hoverRow.operating_margin, '#2dd4bf')}
                          {renderDot(hoverRow.net_margin, '#818cf8')}
                        </g>
                      );
                    })()}

                    {/* X-axis labels */}
                    {(() => {
                      const count = financials.length;
                      const indices = [0, Math.floor(count / 2), count - 1];
                      return indices.map((idx) => {
                        const row = financials[idx];
                        if (!row) return null;
                        const x = paddingLeft + idx * stepX;
                        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
                        if (idx === 0) textAnchor = 'start';
                        if (idx === count - 1) textAnchor = 'end';
                        return (
                          <text key={`fin-lbl-${idx}`} x={x} y={paddingTop + plotHeight + 14} textAnchor={textAnchor} className="fill-zinc-500 font-mono text-[9px]">
                            {row.quarter.slice(2)}
                          </text>
                        );
                      });
                    })()}

                    {/* Vertical Tracker */}
                    {fundHoverIdx !== null && (
                      <line
                        x1={paddingLeft + fundHoverIdx * stepX}
                        y1={paddingTop}
                        x2={paddingLeft + fundHoverIdx * stepX}
                        y2={paddingTop + plotHeight}
                        stroke="#52525b"
                        strokeWidth="1.2"
                        strokeDasharray="3,3"
                      />
                    )}
                  </svg>

                  {/* Tooltip */}
                  {fundHoverIdx !== null && hoverRow && (
                    <div
                      className={`absolute top-2 z-10 p-2.5 rounded-lg border border-border bg-zinc-950/95 shadow-xl text-[10px] w-[145px] pointer-events-none flex flex-col gap-1 ${
                        fundHoverIdx > financials.length / 2 ? 'left-12' : 'right-12'
                      }`}
                    >
                      <div className="font-mono text-zinc-400 font-bold border-b border-border/50 pb-1">
                        {hoverRow.quarter}
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500 font-medium">單季 EPS</span>
                        <span className="text-blue-400 font-bold">{hoverRow.eps !== null ? `${hoverRow.eps.toFixed(2)}元` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">毛利率</span>
                        <span className="text-pink-400 font-semibold">{hoverRow.gross_margin !== null ? `${hoverRow.gross_margin.toFixed(1)}%` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">營益率</span>
                        <span className="text-teal-400 font-semibold">{hoverRow.operating_margin !== null ? `${hoverRow.operating_margin.toFixed(1)}%` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">淨利率</span>
                        <span className="text-indigo-400 font-semibold">{hoverRow.net_margin !== null ? `${hoverRow.net_margin.toFixed(1)}%` : '—'}</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono mt-1 px-1">
                  <span>圖例: 柱狀 = EPS (藍，左軸)；折線 = 三率 (粉/綠/紫，右軸)</span>
                  <span>資料來源: {data.source}</span>
                </div>
              </div>
            );
          })()}

          {fundTab === 'dividend' && (() => {
            const dividend = data.dividend || [];
            if (dividend.length === 0) {
              return <div className="text-xs text-zinc-500 text-center py-16">股利資料尚未提供</div>;
            }
            const latest = dividend[dividend.length - 1];

            const svgWidth = fundChartSize.w;
            const svgHeight = fundChartSize.h;
            const paddingLeft = 45;
            const paddingRight = 15;
            const paddingTop = 15;
            const paddingBottom = 20;
            const plotWidth = svgWidth - paddingLeft - paddingRight;
            const plotHeight = svgHeight - paddingTop - paddingBottom;
            const stepX = plotWidth / (dividend.length - 1 || 1);

            const totals = dividend.map(d => (d.cash_dividend || 0) + (d.stock_dividend || 0));
            const maxDiv = totals.length > 0 ? Math.max(...totals) : 10;
            const divMaxY = maxDiv * 1.15;

            const hoverRow = fundHoverIdx !== null ? dividend[fundHoverIdx] : null;

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">當前年度股利分配 ({latest.year})</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-zinc-100 flex gap-4">
                      <span>現金: {latest.cash_dividend !== null ? `${latest.cash_dividend.toFixed(2)}元` : '—'}</span>
                      <span>股票: {latest.stock_dividend !== null ? `${latest.stock_dividend.toFixed(2)}股` : '—'}</span>
                    </div>
                  </div>
                  <div className="bg-zinc-950/40 p-2 rounded-lg border border-border/30">
                    <div className="text-[9px] text-zinc-500 font-medium">總股利合計</div>
                    <div className="text-xs font-semibold mt-1 font-mono text-primary">
                      {latest.cash_dividend !== null && latest.stock_dividend !== null ? `${(latest.cash_dividend + latest.stock_dividend).toFixed(2)} 元` : '—'}
                    </div>
                  </div>
                </div>

                <div ref={fundChartRef} className="relative bg-zinc-950/30 rounded-xl border border-border/40 p-2 h-[520px]">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    preserveAspectRatio="none"
                    className="overflow-visible select-none cursor-crosshair"
                    onMouseMove={(e) => {
                      const svgRect = e.currentTarget.getBoundingClientRect();
                      const mouseX = (e.clientX - svgRect.left) - paddingLeft;
                      if (mouseX < -stepX / 2 || mouseX > plotWidth + stepX / 2) {
                        setFundHoverIdx(null);
                        return;
                      }
                      const idx = Math.max(0, Math.min(dividend.length - 1, Math.round(mouseX / stepX)));
                      setFundHoverIdx(idx);
                    }}
                    onMouseLeave={() => setFundHoverIdx(null)}
                  >
                    {/* Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((val) => {
                      const y = paddingTop + val * plotHeight;
                      return (
                        <line
                          key={val}
                          x1={paddingLeft}
                          y1={y}
                          x2={svgWidth - paddingRight}
                          y2={y}
                          stroke="#27272a"
                          strokeWidth="1"
                          strokeDasharray="2,2"
                        />
                      );
                    })}

                    {/* Y-axis labels */}
                    <text x={paddingLeft - 8} y={paddingTop + 4} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      {divMaxY.toFixed(1)}元
                    </text>
                    <text x={paddingLeft - 8} y={paddingTop + plotHeight + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[9px]">
                      0
                    </text>

                    {/* Stacked Bars */}
                    {dividend.map((d, idx) => {
                      const cash = d.cash_dividend ?? 0;
                      const stock = d.stock_dividend ?? 0;
                      if (cash === 0 && stock === 0) return null;

                      const x = paddingLeft + idx * stepX;
                      const barWidth = Math.max(3, Math.min(10, stepX * 0.45));

                      const hCash = (cash / divMaxY) * plotHeight;
                      const hStock = (stock / divMaxY) * plotHeight;

                      const cashY = paddingTop + plotHeight - hCash;
                      const stockY = cashY - hStock;

                      return (
                        <g key={`div-bar-group-${idx}`} opacity={fundHoverIdx === null || fundHoverIdx === idx ? 1 : 0.4}>
                          {/* Cash Bar (Teal) */}
                          {cash > 0 && (
                            <rect
                              x={x - barWidth / 2}
                              y={cashY}
                              width={barWidth}
                              height={Math.max(1, hCash)}
                              fill="#14b8a6"
                            />
                          )}
                          {/* Stock Bar (Indigo) */}
                          {stock > 0 && (
                            <rect
                              x={x - barWidth / 2}
                              y={stockY}
                              width={barWidth}
                              height={Math.max(1, hStock)}
                              fill="#6366f1"
                            />
                          )}
                        </g>
                      );
                    })}

                    {/* X-axis labels */}
                    {(() => {
                      const count = dividend.length;
                      const indices = [0, Math.floor(count / 2), count - 1];
                      return indices.map((idx) => {
                        const row = dividend[idx];
                        if (!row) return null;
                        const x = paddingLeft + idx * stepX;
                        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
                        if (idx === 0) textAnchor = 'start';
                        if (idx === count - 1) textAnchor = 'end';
                        return (
                          <text key={`div-lbl-${idx}`} x={x} y={paddingTop + plotHeight + 14} textAnchor={textAnchor} className="fill-zinc-500 font-mono text-[9px]">
                            {row.year}年
                          </text>
                        );
                      });
                    })()}

                    {/* Vertical Tracker */}
                    {fundHoverIdx !== null && (
                      <line
                        x1={paddingLeft + fundHoverIdx * stepX}
                        y1={paddingTop}
                        x2={paddingLeft + fundHoverIdx * stepX}
                        y2={paddingTop + plotHeight}
                        stroke="#52525b"
                        strokeWidth="1.2"
                        strokeDasharray="3,3"
                      />
                    )}
                  </svg>

                  {/* Tooltip */}
                  {fundHoverIdx !== null && hoverRow && (
                    <div
                      className={`absolute top-2 z-10 p-2.5 rounded-lg border border-border bg-zinc-950/95 shadow-xl text-[10px] w-[140px] pointer-events-none flex flex-col gap-1 ${
                        fundHoverIdx > dividend.length / 2 ? 'left-12' : 'right-12'
                      }`}
                    >
                      <div className="font-mono text-zinc-400 font-bold border-b border-border/50 pb-1">
                        {hoverRow.year} 年度分配
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">現金股利</span>
                        <span className="text-teal-400 font-semibold">{hoverRow.cash_dividend !== null ? `${hoverRow.cash_dividend.toFixed(2)}元` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-zinc-500">股票股利</span>
                        <span className="text-indigo-400 font-semibold">{hoverRow.stock_dividend !== null ? `${hoverRow.stock_dividend.toFixed(2)}股` : '—'}</span>
                      </div>
                      <div className="flex justify-between font-mono border-t border-border/30 pt-1 mt-0.5 font-bold">
                        <span className="text-zinc-300">股利合計</span>
                        <span className="text-primary font-bold">
                          {hoverRow.cash_dividend !== null && hoverRow.stock_dividend !== null ? `${(hoverRow.cash_dividend + hoverRow.stock_dividend).toFixed(2)}元` : '—'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono mt-1 px-1">
                  <span>圖例: 柱狀 = 現金股利 (綠)，股票股利 (藍) 堆疊顯示</span>
                  <span>資料來源: {data.source}</span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const getRelativeTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;

      const now = new Date();
      const diffMs = now.getTime() - d.getTime();

      const diffSecs = Math.floor(diffMs / 1000);
      if (diffSecs < 60) {
        return '剛剛';
      }
      const mins = Math.floor(diffSecs / 60);
      if (mins < 60) {
        return `${mins} 分鐘前`;
      }
      const hours = Math.floor(mins / 60);
      if (hours < 24) {
        return `${hours} 小時前`;
      }
      const days = Math.floor(hours / 24);
      if (days < 7) {
        return `${days} 天前`;
      }

      return isoString.substring(0, 10);
    } catch (e) {
      return isoString;
    }
  };

  const renderDispersionSection = () => {
    const disp = dispersionState.data;
    if (dispersionState.loading) {
      return <div className="text-xs text-zinc-500 animate-pulse text-center py-12">載入集保戶股權分散資料中...</div>;
    }
    if (dispersionState.error && !disp) {
      return (
        <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
          <div>{dispersionState.error}</div>
          <button onClick={fetchShareholding} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
        </div>
      );
    }
    if (!disp || !disp.weekly || disp.weekly.length === 0) {
      return (
        <div className="bg-card border border-border rounded-xl p-12 flex flex-col items-center justify-center text-center">
          <Info className="w-8 h-8 text-primary mb-3" />
          <h4 className="text-sm font-semibold text-zinc-200 mb-1">集保股權分散資料累積中</h4>
          <p className="text-xs text-zinc-500">TDCC 開放資料每週更新，趨勢圖將隨時間逐週增長。</p>
        </div>
      );
    }

    const weekly = disp.weekly;
    const isSingleWeek = weekly.length === 1;
    const svgWidth = dispChartSize.w;
    const svgHeight = dispChartSize.h;
    const padL = 60;
    const padR = 60;
    const padT = 20;
    const padB = 35;
    const plotW = svgWidth - padL - padR;
    const plotH = svgHeight - padT - padB;

    const retailVals = weekly.map(w => w.retail.people);
    const minRetail = Math.min(...retailVals);
    const maxRetail = Math.max(...retailVals);
    const rangeRetail = maxRetail - minRetail || (maxRetail * 0.1) || 1;

    const lmVals = weekly.flatMap(w => [w.large.people, w.mid.people]);
    const minLM = Math.min(...lmVals);
    const maxLM = Math.max(...lmVals);
    const rangeLM = maxLM - minLM || (maxLM * 0.1) || 1;

    const stepX = isSingleWeek ? plotW / 2 : plotW / Math.max(1, weekly.length - 1);
    const getX = (i: number) => isSingleWeek ? padL + plotW / 2 : padL + i * stepX;

    const getRetailY = (val: number) => isSingleWeek ? padT + plotH / 2 : padT + plotH - ((val - minRetail) / rangeRetail) * plotH;
    const getLMY = (val: number) => isSingleWeek ? padT + plotH / 2 : padT + plotH - ((val - minLM) / rangeLM) * plotH;

    const retailPoints = weekly.map((w, i) => `${getX(i)},${getRetailY(w.retail.people)}`).join(' ');
    const midPoints = weekly.map((w, i) => `${getX(i)},${getLMY(w.mid.people)}`).join(' ');
    const largePoints = weekly.map((w, i) => `${getX(i)},${getLMY(w.large.people)}`).join(' ');

    const hoverRow = dispHoverIdx !== null && dispHoverIdx >= 0 && dispHoverIdx < weekly.length ? weekly[dispHoverIdx] : (isSingleWeek ? weekly[0] : null);

    const formatDelta = (delta: number | null) => {
      if (delta === null || delta === undefined) return <span className="text-zinc-500">—</span>;
      if (delta > 0) return <span className="text-bull font-semibold">+{delta.toLocaleString()}</span>;
      if (delta < 0) return <span className="text-bear font-semibold">{delta.toLocaleString()}</span>;
      return <span className="text-zinc-400">0</span>;
    };

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3 items-stretch">
        <div className="bg-zinc-950/40 rounded-xl border border-border/40 p-4">
          <div className="flex items-center justify-between mb-3 text-xs flex-wrap gap-2">
            <div className="flex items-center gap-4 text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-[#10b981] inline-block"></span>
                <span className="text-zinc-300">散戶 ≤50張 (左軸)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-[#3b82f6] inline-block"></span>
                <span className="text-zinc-300">中實戶 50-400張 (右軸)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-[#a855f7] inline-block"></span>
                <span className="text-zinc-300">大戶 &gt;400張 (右軸)</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isSingleWeek && (
                <span className="text-[10px] bg-primary/10 border border-primary/20 text-primary px-2 py-0.5 rounded font-mono">
                  趨勢資料累積中 (第 1 週快照)
                </span>
              )}
              {disp.source && (
                <span className="text-[10px] text-zinc-500 font-mono">來源: {disp.source}</span>
              )}
            </div>
          </div>

          <div ref={dispChartRef} className="relative h-[220px]">
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              preserveAspectRatio="none"
              className="overflow-visible select-none cursor-crosshair"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = (e.clientX - rect.left) - padL;
                const idx = isSingleWeek ? 0 : Math.max(0, Math.min(weekly.length - 1, Math.round(mouseX / stepX)));
                setDispHoverIdx(idx);
              }}
              onMouseLeave={() => setDispHoverIdx(null)}
            >
              {[0, 0.25, 0.5, 0.75, 1].map((val) => {
                const y = padT + val * plotH;
                return (
                  <line key={val} x1={padL} y1={y} x2={svgWidth - padR} y2={y} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
                );
              })}

              {!isSingleWeek && (
                <>
                  <polyline fill="none" stroke="#10b981" strokeWidth="2" points={retailPoints} />
                  <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={midPoints} />
                  <polyline fill="none" stroke="#a855f7" strokeWidth="2" points={largePoints} />
                </>
              )}

              {weekly.map((w, i) => {
                const cx = getX(i);
                return (
                  <g key={i}>
                    <circle cx={cx} cy={getRetailY(w.retail.people)} r={isSingleWeek ? 6 : 4} fill="#10b981" />
                    <circle cx={cx} cy={getLMY(w.mid.people)} r={isSingleWeek ? 6 : 4} fill="#3b82f6" />
                    <circle cx={cx} cy={getLMY(w.large.people)} r={isSingleWeek ? 6 : 4} fill="#a855f7" />
                  </g>
                );
              })}

              {dispHoverIdx !== null && (
                <line
                  x1={padL + dispHoverIdx * stepX}
                  y1={padT}
                  x2={padL + dispHoverIdx * stepX}
                  y2={padT + plotH}
                  stroke="#a1a1aa"
                  strokeWidth="1"
                  strokeDasharray="3,3"
                />
              )}

              {weekly.map((w, i) => {
                if (i % Math.ceil(weekly.length / 6) === 0 || i === weekly.length - 1) {
                  return (
                    <text key={i} x={padL + i * stepX} y={svgHeight - 10} fill="#71717a" fontSize="9" textAnchor="middle" className="font-mono">
                      {w.date.slice(5)}
                    </text>
                  );
                }
                return null;
              })}
            </svg>

            {hoverRow && (
              <div className="absolute top-2 right-2 bg-zinc-900/90 border border-zinc-700/60 p-2.5 rounded-lg text-[11px] space-y-1 backdrop-blur shadow-lg z-10 font-mono">
                <div className="text-zinc-400 font-bold border-b border-border/50 pb-1 mb-1">{hoverRow.date} 週報</div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#10b981]">散戶 ≤50張</span>
                  <span className="text-zinc-200 font-bold">{hoverRow.retail.people.toLocaleString()} 人 ({hoverRow.retail.shares_pct}%)</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#3b82f6]">中實戶 50-400張</span>
                  <span className="text-zinc-200 font-bold">{hoverRow.mid.people.toLocaleString()} 人 ({hoverRow.mid.shares_pct}%)</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#a855f7]">大戶 &gt;400張</span>
                  <span className="text-zinc-200 font-bold">{hoverRow.large.people.toLocaleString()} 人 ({hoverRow.large.shares_pct}%)</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {(() => {
          const pieRow = hoverRow || weekly[weekly.length - 1];
          const segs = [
            { key: 'large', label: '大戶 >400張', pct: pieRow.large.shares_pct, color: '#a855f7' },
            { key: 'mid', label: '中實戶 50-400張', pct: pieRow.mid.shares_pct, color: '#3b82f6' },
            { key: 'retail', label: '散戶 ≤50張', pct: pieRow.retail.shares_pct, color: '#10b981' },
          ];
          const total = segs.reduce((s, seg) => s + Math.max(0, seg.pct), 0);
          if (total <= 0) return null;

          // 累積角度：從 12 點鐘方向（-90°）順時針展開，SVG y 軸朝下所以角度遞增＝順時針
          let angleCursor = -90;
          const arcs = segs.map((seg) => {
            const norm = (Math.max(0, seg.pct) / total) * 100;
            const startAngle = angleCursor;
            const sweep = (norm / 100) * 360;
            const endAngle = startAngle + sweep;
            angleCursor = endAngle;
            return { ...seg, norm, startAngle, endAngle, midAngle: startAngle + sweep / 2 };
          });

          const cx = 50, cy = 50, r = 38, explode = 4;
          const toRad = (deg: number) => (deg * Math.PI) / 180;
          const pointAt = (angleDeg: number, radius: number, ox: number, oy: number): [number, number] => {
            const rad = toRad(angleDeg);
            return [cx + ox + radius * Math.cos(rad), cy + oy + radius * Math.sin(rad)];
          };

          return (
            <div className="bg-zinc-950/40 rounded-xl border border-border/40 p-3 flex flex-col">
              <h4 className="font-semibold text-xs text-zinc-300 mb-1.5">持股比例三大分佈（{pieRow.date} 週報）</h4>
              <div className="flex-1 flex items-center justify-center py-1">
                <svg viewBox="0 0 100 100" className="w-full max-w-[248px] aspect-square">
                  {arcs.map((seg) => {
                    const midRad = toRad(seg.midAngle);
                    const ox = Math.cos(midRad) * explode;
                    const oy = Math.sin(midRad) * explode;
                    const [x1, y1] = pointAt(seg.startAngle, r, ox, oy);
                    const [x2, y2] = pointAt(seg.endAngle, r, ox, oy);
                    const largeArcFlag = seg.endAngle - seg.startAngle > 180 ? 1 : 0;
                    const d = `M ${cx + ox} ${cy + oy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
                    const [lx, ly] = pointAt(seg.midAngle, r * 0.6, ox, oy);
                    return (
                      <g key={seg.key}>
                        <path d={d} fill={seg.color} stroke="#09090b" strokeWidth="1.5" />
                        {seg.norm >= 12 && (
                          <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="8.5" fontWeight="700" fill="#fff">
                            {seg.pct.toFixed(1)}%
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex flex-col gap-1.5 text-[10px] mt-1">
                {arcs.map((seg) => (
                  <div key={seg.key} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: seg.color }} />
                    <span className="text-zinc-400 truncate">{seg.label}</span>
                    <span className="ml-auto font-mono font-semibold text-zinc-200">{seg.pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h4 className="font-semibold text-xs text-zinc-300">每週股權分散明細</h4>
            <div className="flex bg-zinc-950 p-1 rounded-lg border border-border/80 text-[11px]">
              <button
                onClick={() => setDispersionMode('people')}
                className={`px-2.5 py-0.5 rounded transition ${dispersionMode === 'people' ? 'bg-zinc-800 text-zinc-100 font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                人數模式
              </button>
              <button
                onClick={() => setDispersionMode('pct')}
                className={`px-2.5 py-0.5 rounded transition ${dispersionMode === 'pct' ? 'bg-zinc-800 text-zinc-100 font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                佔比模式 (%)
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-xs text-left">
              <thead className="bg-zinc-900/60 text-zinc-400 font-mono text-[11px] border-b border-border/60">
                <tr>
                  <th className="p-3">日期</th>
                  <th className="p-3 text-right">大戶 &gt;400張</th>
                  <th className="p-3 text-right">大戶增減</th>
                  <th className="p-3 text-right">中實戶 50-400張</th>
                  <th className="p-3 text-right">中實戶增減</th>
                  <th className="p-3 text-right">散戶 ≤50張</th>
                  <th className="p-3 text-right">散戶增減</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30 font-mono">
                {[...weekly].reverse().map((row) => (
                  <tr key={row.date} className="hover:bg-zinc-800/30 transition">
                    <td className="p-3 font-semibold text-zinc-300">{row.date}</td>
                    
                    <td className="p-3 text-right text-zinc-200 font-semibold">
                      {dispersionMode === 'people' ? `${row.large.people.toLocaleString()} 人` : `${row.large.shares_pct}%`}
                    </td>
                    <td className="p-3 text-right">
                      {formatDelta(row.large.people_delta)}
                    </td>

                    <td className="p-3 text-right text-zinc-200 font-semibold">
                      {dispersionMode === 'people' ? `${row.mid.people.toLocaleString()} 人` : `${row.mid.shares_pct}%`}
                    </td>
                    <td className="p-3 text-right">
                      {formatDelta(row.mid.people_delta)}
                    </td>

                    <td className="p-3 text-right text-zinc-200 font-semibold">
                      {dispersionMode === 'people' ? `${row.retail.people.toLocaleString()} 人` : `${row.retail.shares_pct}%`}
                    </td>
                    <td className="p-3 text-right">
                      {formatDelta(row.retail.people_delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderIndustryTab = () => {
    const heatmap = peersState.data;
    const allStocks = heatmap?.stocks || [];

    // 優先用自建的細分族群表（stockGroups.ts，如「封測」），比 TWSE 官方產業別（如「電子工業」）
    // 更貼近實際同業比較；該股不在 523 檔族群 universe 內時（如上櫃股），退回官方產業別、不限筆數。
    const groupRef = CODE_TO_GROUP.get(activeCode);

    let targetSector: string;
    let peerStocks: HeatmapStock[];

    if (groupRef) {
      targetSector = groupRef.group;
      const groupPeers = allStocks.filter(s => CODE_TO_GROUP.get(s.code)?.group === groupRef.group);
      const self = groupPeers.find(s => s.code === activeCode);
      const others = groupPeers
        .filter(s => s.code !== activeCode)
        .sort((a, b) => (b.turnover ?? -Infinity) - (a.turnover ?? -Infinity))
        .slice(0, self ? 4 : 5);
      peerStocks = self ? [self, ...others] : others;
    } else {
      // 同儕清單來自 heatmap.sector，故 targetSector 必須同源：優先取 heatmap 裡本股那筆的 sector，
      // 保證本股一定落在自己的同儕圈並可高亮；本股不在 heatmap 時才退回 profile.industry。
      // （heatmap 與 profile 是兩套產業詞彙，直接用 profile.industry 會導致本股被濾掉，例如 2330＝電子工業 vs 半導體業）
      const selfSector = allStocks.find(s => s.code === activeCode)?.sector;
      targetSector = selfSector || profileState.data?.industry || '';
      peerStocks = allStocks.filter(s => !!targetSector && s.sector === targetSector);
    }

    const peerCount = peerStocks.length;
    const validChanges = peerStocks.map(s => s.change_pct).filter((v): v is number => v !== null && v !== undefined);
    const avgChange = validChanges.length > 0 ? validChanges.reduce((a, b) => a + b, 0) / validChanges.length : null;
    const totalTurnover = peerStocks.reduce((sum, s) => sum + (s.turnover || 0), 0);

    const formatMoney = (val: number | null | undefined) => {
      if (val === null || val === undefined) return '—';
      if (val >= 1e12) return `${(val / 1e12).toFixed(2)} 兆`;
      if (val >= 1e8) return `${(val / 1e8).toFixed(1)} 億`;
      if (val >= 1e4) return `${(val / 1e4).toFixed(0)} 萬`;
      return `${val.toLocaleString()} 元`;
    };

    const sortedPeers = [...peerStocks].sort((a, b) => {
      let valA = a[peerSortKey] ?? -Infinity;
      let valB = b[peerSortKey] ?? -Infinity;
      if (peerSortOrder === 'asc') {
        return valA > valB ? 1 : -1;
      }
      return valA < valB ? 1 : -1;
    });

    const handleSort = (key: 'turnover' | 'change_pct') => {
      if (peerSortKey === key) {
        setPeerSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
      } else {
        setPeerSortKey(key);
        setPeerSortOrder('desc');
      }
    };

    return (
      <div className="space-y-6">
        {/* Industry Position Summary Bar */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">產業同儕與市場定位</h3>
            </div>
            {targetSector && (
              <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-primary/10 text-primary border border-primary/20">
                {targetSector}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-3.5 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">所屬產業</div>
              <div className="text-base font-bold text-zinc-100 truncate">
                {targetSector || '同儕分析'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">產業成分股</div>
              <div className="text-base font-bold text-zinc-100 font-mono">
                {peerCount > 0 ? `${peerCount} 檔` : '—'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">同業今日平均漲跌</div>
              <div className="text-base font-bold font-mono">
                {avgChange !== null ? (
                  <span className={avgChange >= 0 ? 'text-bull' : 'text-bear'}>
                    {avgChange >= 0 ? '+' : ''}{avgChange.toFixed(2)}%
                  </span>
                ) : '—'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">同業總成交值</div>
              <div className="text-base font-bold text-zinc-100 font-mono">
                {formatMoney(totalTurnover)}
              </div>
            </div>
          </div>
        </div>

        {/* Peer Comparison Table */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="font-semibold text-sm text-zinc-200">同產業個股即時比較</h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">點擊同業可快速切換審查；高亮標示當前查看之個股</p>
            </div>
            
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">排序:</span>
              <button
                onClick={() => handleSort('turnover')}
                className={`px-2.5 py-1 rounded-lg transition border ${peerSortKey === 'turnover' ? 'bg-zinc-800 text-zinc-100 border-zinc-700 font-semibold' : 'bg-zinc-950 text-zinc-400 border-border/60 hover:text-zinc-200'}`}
              >
                成交金額 {peerSortKey === 'turnover' ? (peerSortOrder === 'desc' ? '↓' : '↑') : ''}
              </button>
              <button
                onClick={() => handleSort('change_pct')}
                className={`px-2.5 py-1 rounded-lg transition border ${peerSortKey === 'change_pct' ? 'bg-zinc-800 text-zinc-100 border-zinc-700 font-semibold' : 'bg-zinc-950 text-zinc-400 border-border/60 hover:text-zinc-200'}`}
              >
                漲跌幅 {peerSortKey === 'change_pct' ? (peerSortOrder === 'desc' ? '↓' : '↑') : ''}
              </button>
            </div>
          </div>

          {peersState.loading ? (
            <div className="text-xs text-zinc-500 animate-pulse text-center py-12">載入同產業個股中...</div>
          ) : peersState.error && !heatmap ? (
            <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
              <div>{peersState.error}</div>
              <button onClick={fetchPeers} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
            </div>
          ) : sortedPeers.length === 0 ? (
            <div className="text-xs text-zinc-500 text-center py-12">同產業可比個股不足</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full text-xs text-left">
                <thead className="bg-zinc-900/60 text-zinc-400 font-mono text-[11px] border-b border-border/60">
                  <tr>
                    <th className="p-3">股票代號 / 名稱</th>
                    <th className="p-3 text-right">當前成交價</th>
                    <th className="p-3 text-right cursor-pointer hover:text-zinc-200" onClick={() => handleSort('change_pct')}>
                      今日漲跌幅 {peerSortKey === 'change_pct' ? (peerSortOrder === 'desc' ? '↓' : '↑') : ''}
                    </th>
                    <th className="p-3 text-right cursor-pointer hover:text-zinc-200" onClick={() => handleSort('turnover')}>
                      成交金額 {peerSortKey === 'turnover' ? (peerSortOrder === 'desc' ? '↓' : '↑') : ''}
                    </th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 font-mono">
                  {sortedPeers.map((item) => {
                    const isSelf = item.code === activeCode;
                    const chg = item.change_pct;
                    return (
                      <tr
                        key={item.code}
                        className={`transition ${isSelf ? 'bg-primary/10 border-l-4 border-l-primary font-bold' : 'hover:bg-zinc-800/40'}`}
                      >
                        <td className="p-3">
                          <Link to={`/stock/${item.code}`} className="flex items-center gap-2 hover:text-primary">
                            <span className="font-semibold text-zinc-200">{item.name}</span>
                            <span className="text-[11px] text-zinc-500">({item.code})</span>
                            {isSelf && (
                              <span className="text-[10px] bg-primary text-white px-1.5 py-0.5 rounded font-sans font-medium">
                                本股
                              </span>
                            )}
                          </Link>
                        </td>

                        <td className="p-3 text-right font-semibold text-zinc-200">
                          {item.close !== null && item.close !== undefined ? item.close.toFixed(2) : '—'}
                        </td>

                        <td className="p-3 text-right font-semibold">
                          {chg !== null && chg !== undefined ? (
                            <span className={`px-1.5 py-0.5 rounded ${chg >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                              {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-zinc-500">—</span>
                          )}
                        </td>

                        <td className="p-3 text-right text-zinc-300">
                          {formatMoney(item.turnover)}
                        </td>

                        <td className="p-3 text-center">
                          {!isSelf && (
                            <Link
                              to={`/stock/${item.code}`}
                              className="text-[11px] px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-sans inline-block"
                            >
                              檢視 ↗
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-[10px] text-zinc-500 pt-2 border-t border-border/40 font-mono">
            同儕圈＝TWSE 官方產業別，非第三方策展題材；資料源 TWSE
          </div>
        </div>
      </div>
    );
  };

  const renderBasicTab = () => {
    const profile = profileState.data;
    const fundamentals = fundamentalsState.data;
    const summary = fundamentals?.summary;

    const financialsList = fundamentals?.financials || [];
    const latestFin = financialsList.length > 0 ? financialsList[financialsList.length - 1] : null;

    const valuationList = fundamentals?.valuation || [];
    const latestVal = valuationList.length > 0 ? valuationList[valuationList.length - 1] : null;

    const revenueList = fundamentals?.revenue || [];
    const latestRev = revenueList.length > 0 ? revenueList[revenueList.length - 1] : null;

    const pe = summary?.pe_ratio ?? latestVal?.pe_ratio;
    const pb = summary?.pb_ratio ?? latestVal?.pb_ratio;
    const marketCap = summary?.market_cap;

    const formatMoney = (val: number | null | undefined) => {
      if (val === null || val === undefined) return '—';
      if (val >= 1e12) return `${(val / 1e12).toFixed(2)} 兆`;
      if (val >= 1e8) return `${(val / 1e8).toFixed(1)} 億`;
      return `${val.toLocaleString()} 元`;
    };

    return (
      <div className="space-y-6">
        {/* Company Profile Card */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-6">
            <div className="flex items-center gap-2">
              <Info className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">公司基本檔</h3>
            </div>
            {profile?.source && (
              <span className="text-[10px] text-zinc-500 font-mono">
                來源: {profile.source}
              </span>
            )}
          </div>

          {profileState.loading ? (
            <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入公司基本檔中...</div>
          ) : profileState.error && !profile ? (
            <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
              <div>{profileState.error}</div>
              <button onClick={fetchProfile} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div className="space-y-1">
                <div className="text-[11px] text-zinc-500 font-medium">公司全名</div>
                <div className="text-sm font-semibold text-zinc-200">
                  {profile?.full_name || profile?.name || activeCode}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-zinc-500 font-medium">產業分類</div>
                <div className="text-sm font-semibold text-zinc-200">
                  {profile?.industry || '—'}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-zinc-500 font-medium">成立年份</div>
                <div className="text-sm font-semibold text-zinc-200 font-mono">
                  {profile?.founded ? `${profile.founded} 年` : '—'}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-zinc-500 font-medium">董事長</div>
                <div className="text-sm font-semibold text-zinc-200">
                  {profile?.chairman || '—'}
                </div>
              </div>

              <div className="space-y-1 md:col-span-2">
                <div className="text-[11px] text-zinc-500 font-medium">總部地址</div>
                <div className="text-sm font-semibold text-zinc-200 truncate" title={profile?.address || ''}>
                  {profile?.address || '—'}
                </div>
              </div>

              <div className="space-y-1 md:col-span-2">
                <div className="text-[11px] text-zinc-500 font-medium">官方網站</div>
                <div className="text-sm font-semibold text-zinc-200">
                  {profile?.website ? (
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-mono text-xs inline-flex items-center gap-1"
                    >
                      {profile.website.replace(/^https?:\/\//, '')} ↗
                    </a>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Latest Financial Overview Card (Six-to-Eight Grid) */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-6">
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">最新財務概況</h3>
            </div>
            {latestFin?.quarter && (
              <span className="text-[10px] text-zinc-500 font-mono">
                最新一季: {latestFin.quarter}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* 1. 市值 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">總市值</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {formatMoney(marketCap)}
              </div>
            </div>

            {/* 2. 本益比 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">本益比 (PE)</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {pe !== undefined && pe !== null ? `${pe.toFixed(1)} x` : '—'}
              </div>
            </div>

            {/* 3. 股價淨值比 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">股價淨值比 (PB)</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {pb !== undefined && pb !== null ? `${pb.toFixed(1)} x` : '—'}
              </div>
            </div>

            {/* 4. 最新單季 EPS */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">最新單季 EPS</div>
              <div className="text-lg font-bold text-primary font-mono tracking-tight">
                {latestFin?.eps !== undefined && latestFin?.eps !== null ? `${latestFin.eps.toFixed(2)} 元` : '—'}
              </div>
            </div>

            {/* 5. 毛利率 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">毛利率</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {latestFin?.gross_margin !== undefined && latestFin?.gross_margin !== null ? `${latestFin.gross_margin.toFixed(1)} %` : '—'}
              </div>
            </div>

            {/* 6. 營益率 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">營利事業率 (營益率)</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {latestFin?.operating_margin !== undefined && latestFin?.operating_margin !== null ? `${latestFin.operating_margin.toFixed(1)} %` : '—'}
              </div>
            </div>

            {/* 7. 淨利率 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500 font-medium">稅後淨利率</div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {latestFin?.net_margin !== undefined && latestFin?.net_margin !== null ? `${latestFin.net_margin.toFixed(1)} %` : '—'}
              </div>
            </div>

            {/* 8. 最新月營收 */}
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500 font-medium">最新月營收</span>
                {(() => {
                  const yoy = latestRev?.yoy;
                  if (yoy === undefined || yoy === null) return null;
                  return (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${yoy >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                      YoY {yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}%
                    </span>
                  );
                })()}
              </div>
              <div className="text-lg font-bold text-zinc-100 font-mono tracking-tight">
                {latestRev?.revenue ? formatMoney(latestRev.revenue) : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Price Alert Settings Card */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-6 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">價格警示設定</h3>
            </div>
            <span className="text-[10px] text-zinc-500">
              {alertsSaveStatus === 'saving' ? '儲存中…' : alertsSaveStatus === 'error' ? '儲存失敗' : '收盤後自動檢查，達標會寄 Email 通知'}
            </span>
          </div>

          {(alertsConfig[activeCode]?.alerts.length ?? 0) > 0 && (
            <ul className="space-y-2 mb-4">
              {alertsConfig[activeCode]!.alerts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-950/40 border border-border/30">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={() => toggleAlertEnabled(a.id)}
                      className="rounded border-zinc-800 bg-zinc-950 text-primary focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5"
                    />
                  </label>
                  <span className={`text-xs flex-1 ${a.enabled ? 'text-zinc-200' : 'text-zinc-600 line-through'}`}>
                    {describeAlert(a)}
                  </span>
                  <button
                    onClick={() => deleteAlert(a.id)}
                    className="text-zinc-500 hover:text-red-400 p-1 rounded transition-colors"
                    title="刪除警示"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={alertForm.conditionType}
              onChange={(e) => setAlertForm((prev) => ({ ...prev, conditionType: e.target.value as AlertConditionType }))}
              className="px-2.5 py-1.5 rounded-lg text-xs bg-zinc-900 border border-border text-zinc-300"
            >
              <optgroup label="收盤價">
                <option value="price_above">收盤高於</option>
                <option value="price_below">收盤低於</option>
              </optgroup>
              <optgroup label="KD 反轉">
                <option value="kd_golden_cross">KD 黃金交叉</option>
                <option value="kd_death_cross">KD 死亡交叉</option>
              </optgroup>
              <optgroup label="均線">
                <option value="ma5_break_below">跌破 5 日均線</option>
                <option value="ma5_break_above">站回 5 日均線</option>
                <option value="ma10_break_below">跌破 10 日均線</option>
                <option value="ma10_break_above">站回 10 日均線</option>
                <option value="ma20_break_below">跌破 月線 (20MA)</option>
                <option value="ma20_break_above">站回 月線 (20MA)</option>
                <option value="ma60_break_below">跌破 季線 (60MA)</option>
                <option value="ma60_break_above">站回 季線 (60MA)</option>
              </optgroup>
            </select>
            {isPriceCondition(alertForm.conditionType) && (
              <input
                type="number"
                value={alertForm.price}
                onChange={(e) => setAlertForm((prev) => ({ ...prev, price: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') addAlert(); }}
                placeholder="價位"
                className="w-28 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-900 border border-border text-zinc-300"
              />
            )}
            <button
              onClick={addAlert}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition"
            >
              新增警示
            </button>
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
          <Link
            to="/"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 text-zinc-300 rounded-lg border border-border transition-colors duration-150"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            返回大盤總覽
          </Link>
          <div>
            <h1 className="text-lg font-bold text-zinc-300">個股多維度審查</h1>
          </div>
        </div>
        {useMock && (
          <span className="text-[10px] bg-neutral/10 border border-neutral/20 text-neutral px-2 py-1 rounded-md font-mono">
            Mock Mode (DEV)
          </span>
        )}
      </div>

      {/* Quote Header */}
      {renderHeader()}

      {/* Stock Research Brief Card (Opt 8) */}
      <StockBriefCard
        brief={stockBrief}
        loading={signalState.loading && !signalState.data}
        error={signalState.error}
        onRetry={() => fetchAllData()}
      />

      {/* Tab Navigation Bar */}
      <div className="border-b border-border/80">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {STOCK_TABS.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
              >
                <span>{t.label}</span>
                {t.isSoon && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-normal ${
                    isActive ? 'bg-white/20 text-white' : 'bg-zinc-800 text-zinc-400 border border-zinc-700/50'
                  }`}>
                    soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content Section */}
      <div className="space-y-6">
        {activeTab === 'basic' && renderBasicTab()}
        {activeTab === 'industry' && renderIndustryTab()}

        {activeTab === 'financials' && (
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4 border-b border-border/60 pb-3">
              <DollarSign className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-sm text-zinc-200">基本面估值與增長率</h3>
            </div>
            {renderFundamentals()}
          </div>
        )}

        {activeTab === 'chips' && (
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-6 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">籌碼與股權結構分析</h3>
              </div>

              <div className="flex bg-zinc-950/60 p-1 rounded-lg border border-border/80 text-xs">
                <button
                  onClick={() => setChipsSubTab('dispersion')}
                  className={`px-3 py-1 rounded-md transition ${chipsSubTab === 'dispersion' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  大戶／散戶結構
                </button>
                <button
                  onClick={() => setChipsSubTab('inst')}
                  className={`px-3 py-1 rounded-md transition ${chipsSubTab === 'inst' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  三大法人
                </button>
                <button
                  onClick={() => setChipsSubTab('margin')}
                  className={`px-3 py-1 rounded-md transition ${chipsSubTab === 'margin' ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  融資融券
                </button>
              </div>
            </div>

            {chipsSubTab === 'dispersion' && renderDispersionSection()}

            {chipsSubTab === 'inst' && (
              chipsState.loading ? (
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
                  only="inst"
                />
              ) : (
                <div className="text-xs text-zinc-500 text-center py-8">無三大法人籌碼資料</div>
              )
            )}

            {chipsSubTab === 'margin' && (
              chipsState.loading ? (
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
                  only="margin"
                />
              ) : (
                <div className="text-xs text-zinc-500 text-center py-8">無融資融券籌碼資料</div>
              )
            )}
          </div>
        )}

        {activeTab === 'technical' && (
          <div className="grid grid-cols-1 gap-6">
            {/* K-line Chart */}
            <div className="bg-card border border-border rounded-xl p-6 flex flex-col justify-between min-h-[560px]">
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

              <div className="flex-1 flex flex-col justify-center min-h-[420px]">
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
          </div>
        )}

        {activeTab === 'news' && (
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between gap-2 mb-4 border-b border-border/60 pb-3">
              <div className="flex items-center gap-2">
                <Newspaper className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-sm text-zinc-200">即時市場輿情與新聞情緒</h3>
              </div>
              <button
                onClick={fetchNews}
                disabled={newsState.loading}
                className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600 rounded text-xs text-zinc-300 transition flex items-center gap-1"
              >
                刷新
              </button>
            </div>

            {newsState.loading ? (
              <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入新聞輿情中...</div>
            ) : newsState.error ? (
              <div className="p-4 border border-bull/20 bg-bull/5 rounded-lg text-center text-xs text-bull">
                <div>{newsState.error}</div>
                <button onClick={fetchNews} className="mt-2 px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-zinc-300">重試</button>
              </div>
            ) : newsState.data ? (
              <div className="space-y-6">
                {/* Summary Statistics */}
                <div className="p-4 rounded-xl bg-zinc-950/20 border border-border/50 grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-zinc-400">整體輿情傾向:</span>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1.5 ${
                      newsState.data.summary.overall_label === 'positive'
                        ? 'bg-bull/10 text-bull border border-bull/20'
                        : newsState.data.summary.overall_label === 'negative'
                        ? 'bg-bear/10 text-bear border border-bear/20'
                        : 'bg-zinc-800 text-zinc-400 border border-zinc-750'
                    }`}>
                      {newsState.data.summary.overall_label === 'positive' ? '利多' : newsState.data.summary.overall_label === 'negative' ? '利空' : '中性'}
                      <span className="font-mono">({newsState.data.summary.overall_score.toFixed(1)}分)</span>
                    </span>

                    {(() => {
                      const fSentimentScore = signalState.data?.swing?.factors?.find(f => f.key === 'sentiment')?.score;
                      return fSentimentScore !== undefined ? (
                        <span className="text-xs text-zinc-500 border border-border/40 px-2 py-0.5 rounded font-mono">
                          F_sentiment 因子分: {fSentimentScore}分
                        </span>
                      ) : null;
                    })()}
                  </div>

                  <div className="flex items-center justify-start md:justify-end gap-3 text-xs">
                    <span className="text-zinc-400 font-medium">統計結果:</span>
                    <div className="flex gap-2">
                      <span className="text-bull px-2 py-0.5 bg-bull/5 rounded-md border border-bull/10 font-mono">
                        利多 {newsState.data.summary.positive}
                      </span>
                      <span className="text-bear px-2 py-0.5 bg-bear/5 rounded-md border border-bear/10 font-mono">
                        利空 {newsState.data.summary.negative}
                      </span>
                      <span className="text-zinc-400 px-2 py-0.5 bg-zinc-800/40 rounded-md border border-zinc-700/50 font-mono">
                        中性 {newsState.data.summary.neutral}
                      </span>
                      <span className="text-zinc-500 font-mono">
                        共 {newsState.data.summary.total} 則
                      </span>
                    </div>
                  </div>
                </div>

                {/* News Items List */}
                {newsState.data.items.length > 0 ? (
                  <div className="space-y-4">
                    {newsState.data.items.map((item, idx) => (
                      <div key={idx} className="p-4 rounded-lg bg-zinc-950/40 border border-border/30 flex items-start gap-4">
                        <div className={`shrink-0 text-[10px] font-semibold px-2 py-1.5 rounded text-center min-w-[70px] ${
                          item.sentiment.label === 'positive'
                            ? 'bg-bull/10 text-bull border border-bull/20'
                            : item.sentiment.label === 'negative'
                            ? 'bg-bear/10 text-bear border border-bear/20'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}>
                          <div>{item.sentiment.label === 'positive' ? '利多' : item.sentiment.label === 'negative' ? '利空' : '中性'}</div>
                          <div className="font-mono text-[9px] mt-0.5">{item.sentiment.score.toFixed(0)}分</div>
                        </div>

                        <div className="space-y-1 flex-1">
                          <h4 className="text-xs font-semibold text-zinc-200 hover:text-primary transition">
                            <a href={item.url ?? undefined} target="_blank" rel="noopener noreferrer">
                              {item.title}
                            </a>
                          </h4>
                          {item.summary && (
                            <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-2">{item.summary}</p>
                          )}

                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500 font-mono pt-1">
                            <span>來源: {item.source}</span>
                            <span>•</span>
                            <span>發布時間: {getRelativeTime(item.published)}</span>
                            {item.sentiment.hits && item.sentiment.hits.length > 0 && (
                              <>
                                <span>•</span>
                                <span className="text-zinc-500">命詞: {item.sentiment.hits.slice(0, 5).join(', ')}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500 text-center py-8">近期無相關新聞</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-500 text-center py-8">無即時新聞輿情</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

