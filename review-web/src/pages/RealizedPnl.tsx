/**
 * RealizedPnl.tsx — 已實現損益總覽（opt36）。
 *
 * 把期貨（`/futures` 頁既有的平倉紀錄，唯讀）、個股、ETF 三種已實現損益整合進
 * 一個獨立頁面，並提供「單一標的／單一月份／自訂日期區間」三種篩選。
 *
 * 期貨的平倉紀錄本身仍在 `/futures` 頁管理（新增/刪除/修改），這裡只唯讀彙總；
 * 個股／ETF 沒有現成的管理頁面，因此手動新增/編輯/刪除與截圖匯入都直接做在
 * 這一頁（見 StockScreenshotImport.tsx 與下方的 TradeForm）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type Time, type BusinessDay, type HistogramData } from 'lightweight-charts';
import {
  ListOrdered, ScanLine, PlusCircle, Trash2, Pencil, X, Settings2,
  Cloud, CloudOff, Loader2, Filter, ExternalLink, RefreshCw, AlertTriangle,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Panel, StatTile, Chip } from '../components/futures/ui';
import { closedBreakdown, DEFAULT_SPEC, type ClosedTrade, type FuturesSpec } from '../lib/futures';
import { getFuturesConfig, saveFuturesConfig, subscribeFutures, type FuturesConfig } from '../lib/futuresStore';
import {
  detectKind, monthOf, inDateRange, stockRealizedBreakdown,
  type FeeRates, type StockKind, type Side, type StockRealizedTrade,
} from '../lib/stockRealized';
import {
  getStockRealizedConfig, saveStockRealizedConfig, subscribeStockRealized,
  type StockRealizedConfig,
} from '../lib/stockRealizedStore';
import type { ImportPlan } from '../lib/stockRealizedImport';
import { StockScreenshotImport } from '../components/stocks/StockScreenshotImport';
import { SymbolSearch } from '../components/SymbolSearch';

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const pnlCls = (v: number) => (v >= 0 ? 'text-bull' : 'text-bear');

type Category = 'futures' | 'stock' | 'etf';
const CATEGORY_LABEL: Record<Category, string> = { futures: '期貨', stock: '個股', etf: 'ETF' };
/** 圓餅圖用的分類色——刻意不用 bull/bear（紅漲綠跌是損益語意，這裡是純分類，混用會誤導） */
const CATEGORY_COLOR: Record<Category, string> = { futures: '#38bdf8', stock: '#a78bfa', etf: '#34d399' };

/** 合併後的單一列，畫面顯示用；`raw` 保留原始物件供編輯/刪除用 */
interface RealizedRow {
  key: string;
  category: Category;
  symbol: string;
  name: string;
  date: string;       // 平倉日／賣出日，篩選用的主要日期
  side: Side;
  qtyLabel: string;   // 已經帶單位（口/股）
  gross: number;
  fee: number;
  tax: number;
  net: number;
  actualCost: boolean;
  editable: boolean;  // 只有個股/ETF 可以在這頁編輯/刪除
}

function futuresRows(config: FuturesConfig): RealizedRow[] {
  return config.closed.map((t: ClosedTrade) => {
    const spec: FuturesSpec = config.products[t.product]?.spec ?? DEFAULT_SPEC;
    const b = closedBreakdown(t, spec);
    const name = config.products[t.product]?.name || t.product;
    return {
      key: t.id,
      category: 'futures',
      symbol: t.product,
      name,
      date: t.exit_date,
      side: t.side,
      qtyLabel: `${t.lots} 口`,
      gross: b.gross,
      fee: b.fees,
      tax: b.tax,
      net: b.net,
      actualCost: b.actual_cost,
      editable: false,
    };
  });
}

function stockRows(config: StockRealizedConfig): RealizedRow[] {
  return config.trades.map((t: StockRealizedTrade) => {
    const b = stockRealizedBreakdown(t, config.fee_rates);
    return {
      key: t.id,
      category: t.kind,
      symbol: t.symbol,
      name: t.name,
      date: t.sell_date,
      side: t.side,
      qtyLabel: `${t.qty.toLocaleString()} 股`,
      gross: b.gross,
      fee: b.fee,
      tax: b.tax,
      net: b.net,
      actualCost: b.actual_cost,
      editable: true,
    };
  });
}

const emptyForm = (): {
  id: string | null;
  symbol: string; name: string; kind: StockKind; side: Side;
  qty: string; buy_price: string; sell_price: string;
  buy_date: string; sell_date: string; fee: string; tax: string; note: string;
} => ({
  id: null, symbol: '', name: '', kind: 'stock', side: 'long',
  qty: '', buy_price: '', sell_price: '', buy_date: '', sell_date: '', fee: '', tax: '', note: '',
});

export const RealizedPnl: React.FC = () => {
  const [futures, setFutures] = useState<FuturesConfig>(getFuturesConfig());
  const [stock, setStock] = useState<StockRealizedConfig>(getStockRealizedConfig());
  const [cloud, setCloud] = useState<{ status: 'idle' | 'loading' | 'saved' | 'error'; msg: string | null }>({ status: 'idle', msg: null });

  useEffect(() => subscribeFutures(() => setFutures(getFuturesConfig())), []);
  useEffect(() => subscribeStockRealized(() => setStock(getStockRealizedConfig())), []);

  // 掛載：雲端為事實來源，兩邊都拉一次（這頁不寫回期貨那份，只讀）
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setCloud({ status: 'loading', msg: null });
    Promise.allSettled([api.getFuturesPositions(), api.getStockRealized()])
      .then(([f, s]) => {
        if (f.status === 'fulfilled' && f.value.exists && f.value.futures) {
          // 只更新本機快取讓這頁讀得到最新資料，這裡不會再把它 POST 回雲端
          // （saveFuturesConfig 只碰 localStorage，寫雲端要另外呼叫 saveFuturesPositions）
          saveFuturesConfig(f.value.futures as unknown as FuturesConfig);
        }
        if (s.status === 'fulfilled' && s.value.exists && s.value.data) {
          saveStockRealizedConfig(s.value.data as unknown as StockRealizedConfig);
        }
        setCloud({ status: 'saved', msg: '已從雲端載入' });
      })
      .catch((e) => setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端載入失敗' }));
  }, []);

  const patchStock = (updater: (c: StockRealizedConfig) => StockRealizedConfig) => {
    const next = updater(getStockRealizedConfig());
    saveStockRealizedConfig(next);
    setStock(getStockRealizedConfig());
    return next;
  };

  const saveToCloud = async (cfg?: StockRealizedConfig) => {
    const payload = cfg ?? getStockRealizedConfig();
    setCloud({ status: 'loading', msg: null });
    try {
      const resp = await api.saveStockRealized(payload);
      setCloud({ status: 'saved', msg: `已同步雲端 ${new Date(resp.saved_at).toLocaleTimeString('zh-TW', { hour12: false })}` });
    } catch (e) {
      setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端同步失敗（已存本機）' });
    }
  };

  // ── 合併三種來源 ──────────────────────────────────────────────────────────
  const allRows = useMemo(() => [...futuresRows(futures), ...stockRows(stock)], [futures, stock]);

  // ── 篩選 ──────────────────────────────────────────────────────────────────
  const [category, setCategory] = useState<'all' | Category>('all');
  const [symbol, setSymbol] = useState<string>('');
  const [timeMode, setTimeMode] = useState<'all' | 'month' | 'range'>('all');
  const [month, setMonth] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const symbolOptions = useMemo(() => {
    const seen = new Map<string, { symbol: string; name: string; category: Category }>();
    allRows
      .filter((r) => category === 'all' || r.category === category)
      .forEach((r) => seen.set(`${r.category}|${r.symbol}`, { symbol: r.symbol, name: r.name, category: r.category }));
    return [...seen.entries()].sort((a, b) => a[1].symbol.localeCompare(b[1].symbol));
  }, [allRows, category]);

  /**
   * 月份快選：故意用 `allRows`（不隨類別篩選變動）算，切換「期貨/個股/ETF」
   * 分類時月份按鈕不會跳動位置。近 6 個月直接排成按鈕一鍵點選（使用者要的
   * 「點 7 月」體驗）；更舊的塞進一個下拉選單，不然月份一多按鈕會爆版。
   */
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    allRows.forEach((r) => { const m = monthOf(r.date); if (m) set.add(m); });
    return [...set].sort().reverse(); // 新到舊
  }, [allRows]);
  const RECENT_MONTHS_SHOWN = 6;
  const recentMonths = monthOptions.slice(0, RECENT_MONTHS_SHOWN);
  const olderMonths = monthOptions.slice(RECENT_MONTHS_SHOWN);
  const monthChipLabel = (m: string) => {
    const [y, mm] = m.split('-');
    return Number(y) === new Date().getFullYear() ? `${Number(mm)}月` : `${y.slice(2)}/${mm}`;
  };

  /**
   * 切換分類時，若目前選的標的不屬於新分類，重置成「全部標的」，避免篩出空
   * 清單卻看不出原因。故意在點擊當下算，不用 useEffect 監看 category
   * ——這是使用者動作的直接後果，不是外部系統回撥，effect 只會多一次重繪。
   */
  const changeCategory = (c: typeof category) => {
    setCategory(c);
    const stillValid = allRows
      .filter((r) => c === 'all' || r.category === c)
      .some((r) => `${r.category}|${r.symbol}` === symbol);
    if (symbol && !stillValid) setSymbol('');
  };

  const filteredRows = useMemo(() => {
    return allRows
      .filter((r) => category === 'all' || r.category === category)
      .filter((r) => !symbol || `${r.category}|${r.symbol}` === symbol)
      .filter((r) => {
        if (timeMode === 'month') return !month || monthOf(r.date) === month;
        if (timeMode === 'range') return inDateRange(r.date, dateStart, dateEnd);
        return true;
      })
      .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  }, [allRows, category, symbol, timeMode, month, dateStart, dateEnd]);

  const totals = useMemo(() => {
    const net = filteredRows.reduce((s, r) => s + r.net, 0);
    const gross = filteredRows.reduce((s, r) => s + r.gross, 0);
    const cost = filteredRows.reduce((s, r) => s + r.fee + r.tax, 0);
    const wins = filteredRows.filter((r) => r.net > 0).length;
    const byCategory: Record<Category, number> = { futures: 0, stock: 0, etf: 0 };
    filteredRows.forEach((r) => { byCategory[r.category] += r.net; });
    return { net, gross, cost, wins, byCategory };
  }, [filteredRows]);

  /**
   * 明細表按標的收合：同一檔（類別＋代號）常常一堆筆數（尤其期貨、當沖股），
   * 攤開來看很亂。`filteredRows` 已經是日期新到舊排序，用 reduce 依 key 分組時
   * 組內順序會自然沿用，不必再排一次。單筆的組直接當一般列顯示，不長 chevron。
   */
  interface RowGroup {
    key: string; category: Category; symbol: string; name: string;
    rows: RealizedRow[]; gross: number; fee: number; tax: number; net: number; latestDate: string;
  }
  const groupedRows = useMemo<RowGroup[]>(() => {
    const map = new Map<string, RowGroup>();
    filteredRows.forEach((r) => {
      const key = `${r.category}|${r.symbol}`;
      let g = map.get(key);
      if (!g) {
        g = { key, category: r.category, symbol: r.symbol, name: r.name, rows: [], gross: 0, fee: 0, tax: 0, net: 0, latestDate: r.date };
        map.set(key, g);
      }
      g.rows.push(r);
      g.gross += r.gross; g.fee += r.fee; g.tax += r.tax; g.net += r.net;
      if (r.date > g.latestDate) g.latestDate = r.date;
    });
    return [...map.values()].sort((a, b) => (b.latestDate < a.latestDate ? -1 : b.latestDate > a.latestDate ? 1 : 0));
  }, [filteredRows]);

  /**
   * 類別占比圓餅圖的資料：用絕對值算占比（損益本身有正有負，直接用淨值算
   * 占比在有虧有賺時會出現「占比>100%」或負占比這種看了更困惑的數字），
   * 圖例仍顯示真正的正負淨損益，不會誤導成「這塊都是賺的」。
   */
  const donutData = useMemo(() => {
    const cats: Category[] = ['futures', 'stock', 'etf'];
    const abs = cats.map((c) => Math.abs(totals.byCategory[c]));
    const sum = abs.reduce((s, v) => s + v, 0);
    if (sum <= 0) return [];
    let cursor = 0;
    return cats
      .map((c, i) => {
        const pct = abs[i] / sum;
        const seg = { category: c, pct, net: totals.byCategory[c], offset: cursor };
        cursor += pct;
        return seg;
      })
      .filter((s) => s.pct > 0);
  }, [totals]);

  /** 每月淨損益趨勢：依目前篩選結果彙總，時間軸由舊到新（跟月份快選鈕的新到舊排序刻意不同——長條圖是看趨勢，習慣由左到右愈來愈新）*/
  const monthlyPnl = useMemo(() => {
    const map = new Map<string, number>();
    filteredRows.forEach((r) => {
      const m = monthOf(r.date);
      if (!m) return;
      map.set(m, (map.get(m) || 0) + r.net);
    });
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, net]) => ({ month, net }));
  }, [filteredRows]);

  /** 前五大貢獻標的：依淨損益絕對值排序，虧最多跟賺最多的都算「貢獻」，不是只挑賺錢的 */
  const topContributors = useMemo(
    () => [...groupedRows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 5),
    [groupedRows],
  );
  const maxAbsContributor = Math.max(1, ...topContributors.map((g) => Math.abs(g.net)));

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // 篩到只剩單一類別時「類別」欄每一列都長一樣，是純雜訊，整欄拿掉
  const showCategoryCol = category === 'all';

  // ── 個股/ETF 新增/編輯表單 ────────────────────────────────────────────────
  const [form, setForm] = useState(emptyForm());
  const [showForm, setShowForm] = useState(false);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const submitForm = () => {
    const qty = Math.max(0, parseFloat(form.qty) || 0);
    const buy_price = Math.max(0, parseFloat(form.buy_price) || 0);
    const sell_price = Math.max(0, parseFloat(form.sell_price) || 0);
    const symbolClean = form.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!symbolClean || !qty || !buy_price || !sell_price || !form.sell_date) return;
    const trade: StockRealizedTrade = {
      id: form.id || `s_${symbolClean}_${form.sell_date}_${form.side}_${Date.now()}`,
      symbol: symbolClean,
      name: form.name.trim() || symbolClean,
      kind: form.kind,
      side: form.side,
      qty,
      buy_price,
      sell_price,
      buy_date: form.buy_date,
      sell_date: form.sell_date,
      fee: form.fee.trim() === '' ? null : Math.max(0, parseFloat(form.fee) || 0),
      tax: form.tax.trim() === '' ? null : Math.max(0, parseFloat(form.tax) || 0),
      ...(form.note.trim() ? { note: form.note.trim().slice(0, 100) } : {}),
    };
    const next = patchStock((c) => {
      const exists = c.trades.some((t) => t.id === trade.id);
      return { ...c, trades: exists ? c.trades.map((t) => (t.id === trade.id ? trade : t)) : [...c.trades, trade] };
    });
    void saveToCloud(next);
    setForm(emptyForm());
    setShowForm(false);
  };

  const editTrade = (t: StockRealizedTrade) => {
    setForm({
      id: t.id, symbol: t.symbol, name: t.name, kind: t.kind, side: t.side,
      qty: String(t.qty), buy_price: String(t.buy_price), sell_price: String(t.sell_price),
      buy_date: t.buy_date, sell_date: t.sell_date,
      fee: t.fee === null ? '' : String(t.fee), tax: t.tax === null ? '' : String(t.tax),
      note: t.note || '',
    });
    setShowForm(true);
  };

  const deleteTrade = (id: string) => {
    const next = patchStock((c) => ({ ...c, trades: c.trades.filter((t) => t.id !== id) }));
    void saveToCloud(next);
    // 刪掉的剛好是正在編輯的那筆，表單留著會變成「儲存修改」把它當新交易重新生出來
    if (form.id === id) { setForm(emptyForm()); setShowForm(false); }
  };

  const applyImportPlan = (plan: ImportPlan) => {
    saveStockRealizedConfig(plan.next);
    setStock(getStockRealizedConfig());
    void saveToCloud(plan.next);
  };

  // ── 玉山 API 真實同步（opt37）：gateway 在 VM 上跑 sync_fugle_realized.py，立即回
  // 202，實際結果寫進 data/sync_realized_status.json，這裡輪詢到 ok/error 為止。
  // 觸發後 gateway 會先同步寫入 state:'running' 才回應，故不需要另外記 baseline
  // 時間戳來排除「看到舊一輪殘留的 ok/error」——這點跟 Rebalance.tsx 的持倉同步不同。
  const [realSync, setRealSync] = useState<{
    status: 'idle' | 'triggering' | 'waiting' | 'done' | 'error' | 'timeout'; msg: string | null;
  }>({ status: 'idle', msg: null });

  const syncRealFromApi = async () => {
    setRealSync({ status: 'triggering', msg: null });
    try {
      await api.triggerStockRealizedSync();
    } catch (e) {
      setRealSync({ status: 'error', msg: e instanceof Error ? e.message : '觸發失敗' });
      return;
    }
    setRealSync({ status: 'waiting', msg: null });
    const maxAttempts = 60; // 3 秒一次，約 3 分鐘逾時（容器在 qemu 模擬下啟動較慢＋多段查詢）
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const st = await api.getStockRealizedSyncStatus();
        if (st.state === 'error') {
          setRealSync({ status: 'error', msg: st.message || '同步失敗' });
          return;
        }
        if (st.state === 'ok') {
          const resp = await api.getStockRealized();
          if (resp.exists && resp.data) saveStockRealizedConfig(resp.data as unknown as StockRealizedConfig);
          setStock(getStockRealizedConfig());
          const s = st.summary;
          setRealSync({
            status: 'done',
            msg: s ? `新增 ${s.added} 筆（${s.skipped_already + s.skipped_duplicate} 筆已存在，略過）` : '同步完成',
          });
          return;
        }
      } catch {
        // 單次輪詢失敗不中斷，繼續重試到逾時
      }
    }
    setRealSync({ status: 'timeout', msg: '逾時未收到更新。同步跑在 VM 上（與電腦是否開機無關），稍後重新整理頁面查看結果。' });
  };

  const cloudIcon = cloud.status === 'loading'
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
    : cloud.status === 'error'
      ? <CloudOff className="w-3.5 h-3.5" />
      : <Cloud className="w-3.5 h-3.5" />;

  return (
    <div className="space-y-5 pb-10">
      <Panel
        title="已實現損益總覽"
        icon={<ListOrdered className="w-4 h-4" />}
        tone="zinc"
        right={
          <Chip tone={cloud.status === 'error' ? 'rose' : 'sky'} title={cloud.msg ?? ''}>
            {cloudIcon} {cloud.status === 'loading' ? '同步中…' : cloud.status === 'error' ? '同步失敗' : '雲端已同步'}
          </Chip>
        }
        desc="彙整期貨、個股、ETF 三種已實現損益，可依標的／月份／日期區間篩選。期貨的平倉紀錄仍在「期貨損益總覽」頁管理，這裡只唯讀彙總。"
      >
        {/* ── 篩選列 ── */}
        <div className="space-y-2 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] text-zinc-500 mr-1">
              <Filter className="w-3.5 h-3.5" /> 篩選
            </span>
            {(['all', 'futures', 'stock', 'etf'] as const).map((c) => (
              <button
                key={c}
                onClick={() => changeCategory(c)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                  category === c
                    ? 'bg-primary/15 text-primary border-primary/30'
                    : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                {c === 'all' ? '全部類別' : CATEGORY_LABEL[c]}
              </button>
            ))}

            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300"
            >
              <option value="">全部標的</option>
              {symbolOptions.map(([key, v]) => (
                <option key={key} value={key}>{CATEGORY_LABEL[v.category]}・{v.name}（{v.symbol}）</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-zinc-500 mr-1 pl-[19px]">區間</span>
            <button
              onClick={() => { setTimeMode('all'); setMonth(''); setDateStart(''); setDateEnd(''); }}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                timeMode === 'all'
                  ? 'bg-primary/15 text-primary border-primary/30'
                  : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
              }`}
            >
              全部時間
            </button>
            {recentMonths.map((m) => (
              <button
                key={m}
                onClick={() => { setTimeMode('month'); setMonth(m); }}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                  timeMode === 'month' && month === m
                    ? 'bg-primary/15 text-primary border-primary/30'
                    : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                {monthChipLabel(m)}
              </button>
            ))}
            {olderMonths.length > 0 && (
              <select
                value={timeMode === 'month' && olderMonths.includes(month) ? month : ''}
                onChange={(e) => { if (e.target.value) { setTimeMode('month'); setMonth(e.target.value); } }}
                className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300"
              >
                <option value="">更早月份…</option>
                {olderMonths.map((m) => (
                  <option key={m} value={m}>{m.replace('-', '/')}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => setTimeMode('range')}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                timeMode === 'range'
                  ? 'bg-primary/15 text-primary border-primary/30'
                  : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
              }`}
            >
              自訂區間
            </button>
            {timeMode === 'range' && (
              <>
                <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300" />
                <span className="text-zinc-600 text-[11px]">至</span>
                <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300" />
              </>
            )}
          </div>
        </div>

        {/* ── 彙總卡：期貨/個股/ETF 三類分開列，不合併成一格 ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatTile label="淨已實現損益" value={money(totals.net)} valueCls={pnlCls(totals.net)} tone="primary"
            sub={`毛損益 ${money(totals.gross)} － 費用 ${money(totals.cost)}`} />
          <StatTile label="交易筆數" value={String(filteredRows.length)} tone="zinc"
            sub={filteredRows.length > 0 ? `勝率 ${pct(totals.wins / filteredRows.length, 0)}` : '尚無資料'} />
          <StatTile label="期貨小計" value={money(totals.byCategory.futures)} valueCls={pnlCls(totals.byCategory.futures)} tone="sky" />
          <StatTile label="個股小計" value={money(totals.byCategory.stock)} valueCls={pnlCls(totals.byCategory.stock)} tone="sky" />
          <StatTile label="ETF小計" value={money(totals.byCategory.etf)} valueCls={pnlCls(totals.byCategory.etf)} tone="sky" />
        </div>

        {/* ── 圖表區：類別占比／每月趨勢／前五大貢獻標的，皆跟著上面的篩選走 ── */}
        {filteredRows.length > 0 && (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="border border-border rounded-xl p-4 bg-zinc-900/40">
              <div className="text-[11px] text-zinc-500 mb-3">類別占比</div>
              {donutData.length > 0 ? (
                <div className="flex items-center gap-4">
                  <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90 shrink-0">
                    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#27272a" strokeWidth="4" />
                    {donutData.map((seg) => (
                      <circle
                        key={seg.category}
                        cx="18" cy="18" r="15.9155" fill="none"
                        stroke={CATEGORY_COLOR[seg.category]}
                        strokeWidth="4"
                        strokeDasharray={`${seg.pct * 100} ${100 - seg.pct * 100}`}
                        strokeDashoffset={-seg.offset * 100}
                      />
                    ))}
                  </svg>
                  <ul className="space-y-1.5 text-[11px] flex-1 min-w-0">
                    {donutData.map((seg) => (
                      <li key={seg.category} className="flex items-center gap-1.5" title={money(seg.net)}>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CATEGORY_COLOR[seg.category] }} />
                        <span className="text-zinc-400 truncate">{CATEGORY_LABEL[seg.category]}</span>
                        <span className="ml-auto font-mono font-semibold text-zinc-300">{Math.round(seg.pct * 100)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="h-20 flex items-center justify-center text-xs text-zinc-600">尚無資料</div>
              )}
            </div>

            <div className="lg:col-span-2 border border-border rounded-xl p-4 bg-zinc-900/40">
              <div className="text-[11px] text-zinc-500 mb-1">每月淨損益</div>
              <MonthlyPnlChart data={monthlyPnl} />
            </div>

            {topContributors.length > 0 && (
              <div className="lg:col-span-3 border border-border rounded-xl p-4 bg-zinc-900/40">
                <div className="text-[11px] text-zinc-500 mb-3">前五大貢獻標的（依淨損益絕對值排序）</div>
                <div className="space-y-2">
                  {topContributors.map((g) => (
                    <div key={g.key} className="flex items-center gap-2 text-xs">
                      <span className="w-24 sm:w-36 shrink-0 truncate text-zinc-300" title={`${g.name}（${g.symbol}）`}>
                        {g.name}（{g.symbol}）
                      </span>
                      <div className="flex-1 h-4 rounded bg-zinc-950 overflow-hidden">
                        <div
                          className={`h-full ${g.net >= 0 ? 'bg-bull/80' : 'bg-bear/80'}`}
                          style={{ width: `${(Math.abs(g.net) / maxAbsContributor) * 100}%` }}
                        />
                      </div>
                      <span className={`w-20 shrink-0 text-right font-mono font-semibold ${pnlCls(g.net)}`}>{money(g.net)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 明細表 ── */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs min-w-[720px]">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                {showCategoryCol && <th className="text-left font-medium py-2 pr-3">類別</th>}
                <th className="text-left font-medium py-2 pr-3">標的</th>
                <th className="text-left font-medium py-2 pr-3">日期</th>
                <th className="text-left font-medium py-2 pr-3">方向</th>
                <th className="text-right font-medium py-2 pr-3">數量</th>
                <th className="text-right font-medium py-2 pr-3">毛損益</th>
                <th className="text-right font-medium py-2 pr-3">費用</th>
                <th className="text-right font-medium py-2 pr-3">淨損益</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {groupedRows.length === 0 && (
                <tr><td colSpan={showCategoryCol ? 9 : 8} className="py-6 text-center text-zinc-600">沒有符合篩選條件的紀錄</td></tr>
              )}
              {groupedRows.map((g) => {
                const single = g.rows.length === 1;
                const expanded = single || groupedRows.length === 1 || expandedGroups.has(g.key);
                return (
                  <React.Fragment key={g.key}>
                    {!single && (
                      <tr
                        onClick={() => toggleGroup(g.key)}
                        className="border-b border-border/50 bg-zinc-900/40 hover:bg-zinc-900/70 cursor-pointer select-none"
                      >
                        {showCategoryCol && <td className="py-2 pr-3 text-zinc-400">{CATEGORY_LABEL[g.category]}</td>}
                        <td className="py-2 pr-3 text-zinc-200 font-semibold">
                          <span className="inline-flex items-center gap-1.5">
                            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
                            {g.name}（{g.symbol}）
                            <span className="text-[10px] font-normal text-zinc-500">× {g.rows.length} 筆</span>
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[10px] text-zinc-500">最近 {g.latestDate}</td>
                        <td className="py-2 pr-3" />
                        <td className="py-2 pr-3" />
                        <td className={`py-2 pr-3 text-right font-mono ${pnlCls(g.gross)}`}>{money(g.gross)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-zinc-500">{money(g.fee + g.tax)}</td>
                        <td className={`py-2 pr-3 text-right font-mono font-bold ${pnlCls(g.net)}`}>{money(g.net)}</td>
                        <td className="py-2" />
                      </tr>
                    )}
                    {expanded && g.rows.map((r) => (
                      <tr key={r.key} className={`border-b border-border/50 last:border-0 ${single ? '' : 'bg-zinc-950/40'}`}>
                        {showCategoryCol && <td className="py-2 pr-3 text-zinc-400">{single ? CATEGORY_LABEL[r.category] : ''}</td>}
                        <td className="py-2 pr-3 text-zinc-300">
                          {single ? <>{r.name}（{r.symbol}）</> : <span className="pl-4 text-zinc-600">└</span>}
                        </td>
                        <td className="py-2 pr-3 font-mono text-zinc-400">{r.date || '—'}</td>
                        <td className={`py-2 pr-3 ${r.side === 'long' ? 'text-bull' : 'text-bear'}`}>{r.side === 'long' ? '多' : '空'}</td>
                        <td className="py-2 pr-3 text-right font-mono text-zinc-300">{r.qtyLabel}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${pnlCls(r.gross)}`}>{money(r.gross)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-zinc-500" title={r.actualCost ? '券商實收金額' : '依費率設定推估'}>
                          {money(r.fee + r.tax)}{r.actualCost ? '' : ' 估'}
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono font-semibold ${pnlCls(r.net)}`}>{money(r.net)}</td>
                        <td className="py-2 text-right">
                          {r.editable ? (
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => editTrade(stock.trades.find((t) => t.id === r.key)!)}
                                className="p-1 text-zinc-500 hover:text-zinc-200" title="編輯">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => deleteTrade(r.key)} className="p-1 text-zinc-500 hover:text-rose-400" title="刪除">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <Link to="/futures" className="inline-flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-300" title="到期貨頁編輯">
                              <ExternalLink className="w-3 h-3" />
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── 個股/ETF 管理：手動新增/編輯、費率設定、截圖匯入 ── */}
      <Panel
        title="個股／ETF 已實現損益管理"
        icon={<PlusCircle className="w-4 h-4" />}
        tone="zinc"
        desc="期貨部位請到「期貨損益總覽」頁管理；這裡只管個股與 ETF。"
        right={
          <>
            <button onClick={() => void syncRealFromApi()} disabled={realSync.status === 'triggering' || realSync.status === 'waiting'}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${realSync.status === 'triggering' || realSync.status === 'waiting' ? 'animate-spin' : ''}`} />
              真實同步
            </button>
            <button onClick={() => setShowRates((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 hover:border-zinc-600">
              <Settings2 className="w-3.5 h-3.5" /> 費率設定
            </button>
            <button onClick={() => setShowImport((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 hover:border-zinc-600">
              <ScanLine className="w-3.5 h-3.5" /> 截圖匯入
            </button>
            <button onClick={() => { setForm(emptyForm()); setShowForm((v) => !v); }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-semibold hover:bg-primary/90">
              <PlusCircle className="w-3.5 h-3.5" /> 手動新增
            </button>
          </>
        }
      >
        {realSync.status !== 'idle' && (
          <div className={`flex items-center gap-1.5 text-[11px] mb-3 ${
            realSync.status === 'error' ? 'text-rose-400' : realSync.status === 'timeout' ? 'text-amber-400' : realSync.status === 'done' ? 'text-emerald-400' : 'text-zinc-400'
          }`}>
            {(realSync.status === 'triggering' || realSync.status === 'waiting') && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {(realSync.status === 'error' || realSync.status === 'timeout') && <AlertTriangle className="w-3.5 h-3.5" />}
            {realSync.status === 'triggering' && '真實同步觸發中…'}
            {realSync.status === 'waiting' && '真實同步：VM 執行中…（呼叫玉山 API 抓已實現交易）'}
            {realSync.status === 'done' && `真實同步完成：${realSync.msg}`}
            {realSync.status === 'error' && `真實同步失敗：${realSync.msg}`}
            {realSync.status === 'timeout' && realSync.msg}
          </div>
        )}

        {showRates && (
          <FeeRateForm
            key={JSON.stringify(stock.fee_rates)}
            rates={stock.fee_rates}
            onSave={(rates: FeeRates) => {
              const next = patchStock((c) => ({ ...c, fee_rates: rates }));
              void saveToCloud(next);
            }}
          />
        )}

        {showImport && (
          <div className="mb-4">
            <StockScreenshotImport config={stock} feeRates={stock.fee_rates} onApply={applyImportPlan} />
          </div>
        )}

        {showForm && (
          <div className="border border-border rounded-xl p-4 mb-4 space-y-3 bg-zinc-900/40">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-zinc-200">{form.id ? '編輯交易' : '手動新增一筆'}</h3>
              <button onClick={() => setShowForm(false)} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="col-span-2 relative">
                <label className="text-[10px] text-zinc-500">代號</label>
                <div className="flex gap-1">
                  <input value={form.symbol}
                    onChange={(e) => {
                      const symbolClean = e.target.value.toUpperCase();
                      setForm((f) => ({ ...f, symbol: symbolClean, kind: detectKind(symbolClean) }));
                    }}
                    placeholder="2330"
                    className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
                  <button type="button" onClick={() => setShowSymbolSearch((v) => !v)}
                    className="px-2 rounded-lg border border-border text-[10px] text-zinc-400 hover:text-zinc-200 shrink-0">搜尋</button>
                </div>
                {showSymbolSearch && (
                  <div className="absolute z-10 mt-1 w-72 bg-zinc-950 border border-border rounded-lg p-2 shadow-lg">
                    <SymbolSearch autoFocus onPick={(hit) => {
                      setForm((f) => ({ ...f, symbol: hit.code, name: hit.name, kind: detectKind(hit.code) }));
                      setShowSymbolSearch(false);
                    }} />
                  </div>
                )}
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-zinc-500">名稱</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="台積電" className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>

              <div>
                <label className="text-[10px] text-zinc-500">類別</label>
                <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as StockKind }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200">
                  <option value="stock">個股</option>
                  <option value="etf">ETF</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">方向</label>
                <select value={form.side} onChange={(e) => setForm((f) => ({ ...f, side: e.target.value as Side }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200">
                  <option value="long">現股（買進後賣出）</option>
                  <option value="short">融券（賣出後回補）</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">股數</label>
                <input type="number" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">買進均價</label>
                <input type="number" value={form.buy_price} onChange={(e) => setForm((f) => ({ ...f, buy_price: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>

              <div>
                <label className="text-[10px] text-zinc-500">賣出均價</label>
                <input type="number" value={form.sell_price} onChange={(e) => setForm((f) => ({ ...f, sell_price: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">買進日（選填）</label>
                <input type="date" value={form.buy_date} onChange={(e) => setForm((f) => ({ ...f, buy_date: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">賣出日（必填）</label>
                <input type="date" value={form.sell_date} onChange={(e) => setForm((f) => ({ ...f, sell_date: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>

              <div>
                <label className="text-[10px] text-zinc-500">手續費（選填，留空自動估）</label>
                <input type="number" value={form.fee} onChange={(e) => setForm((f) => ({ ...f, fee: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">證交稅（選填，留空自動估）</label>
                <input type="number" value={form.tax} onChange={(e) => setForm((f) => ({ ...f, tax: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-zinc-500">備註（選填）</label>
                <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200" />
              </div>
            </div>

            <button onClick={submitForm}
              className="px-4 py-2 bg-emerald-500/90 text-white text-xs font-semibold rounded-lg hover:bg-emerald-500">
              {form.id ? '儲存修改' : '新增這筆'}
            </button>
          </div>
        )}

        <p className="text-[11px] text-zinc-500">
          目前共 {stock.trades.length} 筆個股／ETF 已實現交易（明細見上方彙總表）。
          「真實同步」預設回溯兩年、可重複執行（已同步過的交易不會重複計入），淨損益與券商 App 一致；
          唯獨買進均價是用玉山回傳的成本反推、已內含買進手續費，跟截圖上單純顯示的買進均價可能有小數點差異，
          且同步進來的交易方向一律先標「多」，若原本是融券放空請自行改成「空」（純顯示用，不影響金額）。
        </p>
      </Panel>
    </div>
  );
};

/**
 * 每月淨損益長條圖，用專案既有的 lightweight-charts（其他頁面畫 K 線用的那套）
 * 的 histogram series，不必為了一張簡單長條圖再加新套件。比照 PriceChart.tsx
 * 的建立/resize/卸載模式，但只有一條 series，不需要它那套多圖同步的複雜度。
 */
const MonthlyPnlChart: React.FC<{ data: { month: string; net: number }[] }> = ({ data }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length === 0) return;

    /**
     * `autoSize:true` 讓套件自己接手 ResizeObserver 同步容器尺寸到畫布的內部繪圖
     * 緩衝區——曾經改用手動 `width: el.clientWidth` + 自己的 ResizeObserver 只
     * `applyOptions({width})`，結果畫布的 backing buffer 卡在 HTML canvas 預設值
     * 300×150（跟外層 CSS 顯示尺寸完全兜不上），造成滑鼠座標系統跟圖表內部的時間
     * 軸座標系統對不齊，crosshair 的 `time` 永遠解析不出來（`param.time` 恆為
     * undefined）——外觀看起來長條圖是正常的（CSS 拉伸掩蓋了問題），但滑鼠移到
     * 哪裡都讀不到對應時間點，這就是「淨損益卡住不跟著滑鼠變化」的根因。
     */
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: '#27272a' } },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: {
        borderColor: '#3f3f46',
        // 資料點都是月初，內建格式會印出完整日期，改成跟月份快選鈕同一種簡短格式
        tickMarkFormatter: (t: Time) => (typeof t === 'object' ? `${t.month}月` : String(t)),
      },
      crosshair: { mode: 0 },
    });

    const series = chart.addHistogramSeries({ priceFormat: { type: 'price', precision: 0, minMove: 1 } });
    const points: HistogramData[] = data.map((d) => {
      const [y, m] = d.month.split('-').map(Number);
      const time: BusinessDay = { year: y, month: m, day: 1 };
      return { time, value: d.net, color: d.net >= 0 ? '#ef4444' : '#22c55e' };
    });
    series.setData(points);
    chart.timeScale().fitContent();

    const setLegend = (found: { month: string; net: number } | undefined) => {
      if (legendRef.current) legendRef.current.textContent = found ? `${found.month}` + '　淨損益 ' + money(found.net) : '';
    };
    setLegend(data[data.length - 1]);
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) { setLegend(data[data.length - 1]); return; }
      const t = param.time as unknown as { year: number; month: number };
      setLegend(data.find((d) => d.month === `${t.year}-${String(t.month).padStart(2, '0')}`));
    });

    return () => chart.remove();
  }, [data]);

  if (data.length === 0) {
    return <div className="h-40 flex items-center justify-center text-xs text-zinc-600">尚無資料</div>;
  }
  return (
    <div className="relative w-full h-40">
      <div ref={legendRef} className="absolute top-0 left-1 z-10 text-[11px] font-mono text-zinc-400 select-none pointer-events-none" />
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};

/**
 * `rates` prop 只有在雲端載入完成/儲存後才會變——用 `key`（見呼叫端）在那時機
 * 整個重新掛載來重置編輯緩衝區，比在 effect 裡 setState 同步兩份狀態乾淨。
 */
const FeeRateForm: React.FC<{ rates: FeeRates; onSave: (r: FeeRates) => void }> = ({ rates, onSave }) => {
  const [local, setLocal] = useState(rates);
  const field = (label: string, key: keyof FeeRates, hint: string) => (
    <div>
      <label className="text-[10px] text-zinc-500" title={hint}>{label}</label>
      <input
        type="number"
        step="0.0001"
        value={local[key]}
        onChange={(e) => setLocal((l) => ({ ...l, [key]: Math.max(0, parseFloat(e.target.value) || 0) }))}
        className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200"
      />
    </div>
  );
  return (
    <div className="border border-border rounded-xl p-4 mb-4 bg-zinc-900/40 space-y-3">
      <p className="text-[11px] text-zinc-500">
        沒有券商實收手續費／證交稅資料的交易，會用這裡的費率推估。稅率是現行法規值（個股 0.3%、ETF 0.1%，僅收賣方），
        手續費折扣請依自己券商的實際折扣調整。
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {field('手續費費率', 'fee_rate', '牌告費率，預設 0.1425%')}
        {field('手續費折扣', 'fee_discount', '1＝不打折，0.6＝6 折')}
        {field('個股證交稅率', 'stock_tax_rate', '現行法規 0.3%，僅收賣方')}
        {field('ETF證交稅率', 'etf_tax_rate', '現行法規 0.1%，僅收賣方')}
      </div>
      <button onClick={() => onSave(local)}
        className="px-3 py-1.5 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary/90">
        儲存費率設定
      </button>
    </div>
  );
};

export default RealizedPnl;
