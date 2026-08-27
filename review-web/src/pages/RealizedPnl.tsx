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
import {
  ListOrdered, ScanLine, PlusCircle, Trash2, Pencil, X, Settings2,
  Cloud, CloudOff, Loader2, Filter, ExternalLink,
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
        <div className="flex flex-wrap items-center gap-2 mb-4">
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

          <select
            value={timeMode}
            onChange={(e) => { setTimeMode(e.target.value as typeof timeMode); setMonth(''); setDateStart(''); setDateEnd(''); }}
            className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300"
          >
            <option value="all">全部時間</option>
            <option value="month">單一月份</option>
            <option value="range">自訂區間</option>
          </select>

          {timeMode === 'month' && (
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300"
            />
          )}
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

        {/* ── 彙總卡 ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="淨已實現損益" value={money(totals.net)} valueCls={pnlCls(totals.net)} tone="primary"
            sub={`毛損益 ${money(totals.gross)} － 費用 ${money(totals.cost)}`} />
          <StatTile label="交易筆數" value={String(filteredRows.length)} tone="zinc"
            sub={filteredRows.length > 0 ? `勝率 ${pct(totals.wins / filteredRows.length, 0)}` : '尚無資料'} />
          <StatTile label="期貨小計" value={money(totals.byCategory.futures)} valueCls={pnlCls(totals.byCategory.futures)} tone="sky" />
          <StatTile label="個股＋ETF小計" value={money(totals.byCategory.stock + totals.byCategory.etf)}
            valueCls={pnlCls(totals.byCategory.stock + totals.byCategory.etf)} tone="sky"
            sub={`個股 ${money(totals.byCategory.stock)}・ETF ${money(totals.byCategory.etf)}`} />
        </div>

        {/* ── 明細表 ── */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs min-w-[720px]">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                <th className="text-left font-medium py-2 pr-3">類別</th>
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
              {filteredRows.length === 0 && (
                <tr><td colSpan={9} className="py-6 text-center text-zinc-600">沒有符合篩選條件的紀錄</td></tr>
              )}
              {filteredRows.map((r) => (
                <tr key={r.key} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 text-zinc-400">{CATEGORY_LABEL[r.category]}</td>
                  <td className="py-2 pr-3 text-zinc-300">{r.name}（{r.symbol}）</td>
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
        </p>
      </Panel>
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
