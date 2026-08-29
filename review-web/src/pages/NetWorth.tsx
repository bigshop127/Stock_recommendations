/**
 * NetWorth.tsx — 資產變化圖／淨資產總覽（2026-08-28 新增；2026-08-28 補交割款細分
 * ／持股明細／期貨明細；2026-08-29 移除銀行帳戶手動輸入——那格填的其實就是券商
 * 現金的重複人工估算，既然券商現金已經自動同步，這格沒有存在必要）。
 *
 * 股市（再平衡計算機「真實同步」帶回來的券商現金＋整戶庫存市值，見 lib/api.ts 的
 * full_inventory）＋期貨權益（期貨損益總覽頁既有的權益數歷史最新一筆），統整成
 * 一個淨資產數字，全部自動同步、沒有任何手動輸入欄位。
 *
 * 歷史無法回填：股市/期貨的即時資料只有「現在」這一份快照——所以「長期歷史變化」
 * 是從使用者第一次按「更新今天快照」那天開始累積，不是回溯重建的。快照一天一筆，
 * 同一天再存就覆蓋（見 netWorthStore.ts）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type Time, type BusinessDay, type HistogramData } from 'lightweight-charts';
import {
  Wallet, TrendingUp, Activity, Save, Trash2,
  Cloud, CloudOff, Loader2, Info, AlertTriangle, Filter,
  CreditCard, RefreshCw, Plus, Pencil, X,
} from 'lucide-react';
import { api, type FullInventoryPosition, type MonthlyBill } from '../lib/api';
import { Panel, StatTile, Chip, TONE, type Tone } from '../components/futures/ui';
import {
  snapshotTotal, snapshotComposition, settledStockCash, todayDate, type NetWorthSnapshot,
} from '../lib/netWorth';
import {
  getNetWorthConfig, saveNetWorthConfig, subscribeNetWorth,
} from '../lib/netWorthStore';
import {
  positionPnl, priceOf,
  type FuturesPosition, type ProductPriceSpec, type ProductConfig,
} from '../lib/futures';
import type { FuturesConfig } from '../lib/futuresStore';
import { monthOf } from '../lib/stockRealized';

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const pnlCls = (v: number) => (v >= 0 ? 'text-bull' : 'text-bear');

type NWCategory = 'cash' | 'stock' | 'futures';
const NW_LABEL: Record<NWCategory, string> = { cash: '券商現金', stock: '股市庫存', futures: '期貨' };
const NW_COLOR: Record<NWCategory, string> = { cash: '#fb923c', stock: '#a78bfa', futures: '#38bdf8' };

interface AutoStock {
  cash: number;
  pendingSettlement: number;
  holdings: number;
  positions: FullInventoryPosition[];
  syncedAt: string | null;
}
interface AutoFutures {
  equity: number;
  updatedAt: string | null;
  positions: FuturesPosition[];
  products: Record<string, ProductConfig>;
}

export const NetWorth: React.FC = () => {
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[]>(() => getNetWorthConfig().snapshots);
  const [cloud, setCloud] = useState<{ status: 'idle' | 'loading' | 'saved' | 'error'; msg: string | null }>({ status: 'idle', msg: null });
  const [autoStock, setAutoStock] = useState<AutoStock>({ cash: 0, pendingSettlement: 0, holdings: 0, positions: [], syncedAt: null });
  const [autoFutures, setAutoFutures] = useState<AutoFutures>({ equity: 0, updatedAt: null, positions: [], products: {} });
  const [bills, setBills] = useState<MonthlyBill[]>([]);
  const [billsUpdatedAt, setBillsUpdatedAt] = useState<string | null>(null);
  const [billSync, setBillSync] = useState<{ status: 'idle' | 'triggering' | 'waiting' | 'done' | 'error' | 'timeout'; msg: string | null }>({ status: 'idle', msg: null });

  useEffect(() => subscribeNetWorth(() => setSnapshots(getNetWorthConfig().snapshots)), []);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setCloud({ status: 'loading', msg: null });
    Promise.allSettled([
      api.getNetWorth(),
      api.getRebalanceHoldings(),
      api.getFuturesEquityHistory(),
      api.getFuturesPositions(),
      api.getMonthlyBills(),
    ])
      .then(([nw, rb, fut, futPos, mb]) => {
        if (nw.status === 'fulfilled' && nw.value.exists) {
          saveNetWorthConfig({ snapshots: nw.value.snapshots });
        }
        if (rb.status === 'fulfilled' && rb.value.exists && rb.value.holdings) {
          const h = rb.value.holdings;
          // 舊資料（部署此功能前同步過的）沒有 full_inventory，退回只算三檔追蹤標的
          // 當估計值，好過直接當 0。
          const fallback = h.shares * h.price + h.bonds.reduce((s, b) => s + b.shares * b.price, 0);
          setAutoStock({
            cash: h.cash,
            pendingSettlement: rb.value.settlement?.net ?? 0,
            holdings: rb.value.full_inventory?.total_value ?? fallback,
            positions: rb.value.full_inventory?.positions ?? [],
            syncedAt: rb.value.full_inventory?.synced_at ?? rb.value.saved_at ?? null,
          });
        }
        if (fut.status === 'fulfilled' && fut.value.exists && fut.value.rows.length > 0) {
          const last = fut.value.rows[fut.value.rows.length - 1];
          setAutoFutures((prev) => ({ ...prev, equity: last.equity, updatedAt: fut.value.updated_at }));
        }
        if (futPos.status === 'fulfilled' && futPos.value.exists && futPos.value.futures) {
          const cfg = futPos.value.futures as unknown as FuturesConfig;
          setAutoFutures((prev) => ({ ...prev, positions: cfg.positions ?? [], products: cfg.products ?? {} }));
        }
        if (mb.status === 'fulfilled' && mb.value.exists) {
          setBills(mb.value.bills);
          setBillsUpdatedAt(mb.value.updated_at);
        }
        setCloud({ status: 'saved', msg: '已從雲端載入' });
      })
      .catch((e) => setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端載入失敗' }));
  }, []);

  // 「現在」草稿：全部自動帶入的股市/期貨，按下「更新今天快照」才真的存檔
  const draft: NetWorthSnapshot = useMemo(() => ({
    id: 'draft',
    date: todayDate(),
    stock_cash: autoStock.cash,
    stock_pending_settlement: autoStock.pendingSettlement,
    stock_holdings_value: autoStock.holdings,
    futures_equity: autoFutures.equity,
  }), [autoStock, autoFutures.equity]);

  const composition = snapshotComposition(draft);
  const total = snapshotTotal(draft);

  const persist = (next: NetWorthSnapshot[]) => {
    setSnapshots(next);
    saveNetWorthConfig({ snapshots: next });
    setCloud({ status: 'loading', msg: null });
    api.saveNetWorth(next)
      .then(() => setCloud({ status: 'saved', msg: '已儲存' }))
      .catch((e) => setCloud({ status: 'error', msg: e instanceof Error ? e.message : '儲存失敗' }));
  };

  const handleSaveSnapshot = () => {
    const today = todayDate();
    const next = [...snapshots.filter((s) => s.date !== today), { ...draft, id: `nw_${today}` }]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    persist(next);
  };

  const handleDelete = (id: string) => persist(snapshots.filter((s) => s.id !== id));

  const cloudIcon = cloud.status === 'loading'
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
    : cloud.status === 'error'
      ? <CloudOff className="w-3.5 h-3.5" />
      : <Cloud className="w-3.5 h-3.5" />;

  const donutData = useMemo(() => {
    const cats: NWCategory[] = ['cash', 'stock', 'futures'];
    const abs = cats.map((c) => Math.abs(composition[c]));
    const sum = abs.reduce((s, v) => s + v, 0);
    if (sum <= 0) return [];
    let cursor = 0;
    return cats
      .map((c, i) => {
        const pct2 = abs[i] / sum;
        const seg = { category: c, pct: pct2, value: composition[c], offset: cursor };
        cursor += pct2;
        return seg;
      })
      .filter((s) => s.pct > 0);
  }, [composition]);

  const historyData = useMemo(
    () => snapshots.map((s) => ({ date: s.date, total: snapshotTotal(s) })),
    [snapshots],
  );

  // 個股/ETF 持股明細：市值/成本已經由同步腳本算好，這裡只算未實現損益與報酬率
  const stockRows = useMemo(
    () => autoStock.positions
      .map((p) => {
        const cost = p.avg_cost * p.shares;
        const unrealized = p.value - cost;
        return { ...p, cost, unrealized, returnPct: cost > 0 ? unrealized / cost : null };
      })
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    [autoStock.positions],
  );

  // 期貨未平倉明細：重用 lib/futures.ts 的 positionPnl（跟期貨損益總覽頁同一套算式）
  const futuresRows = useMemo(() => {
    const productsMap: Record<string, ProductPriceSpec> = {};
    for (const [code, p] of Object.entries(autoFutures.products)) {
      productsMap[code] = {
        spec: p.spec,
        price: { byMonth: p.prices, fallback: p.price },
        beta: p.index_linked ? 1 : p.beta,
        index_ref: p.index_ref,
      };
    }
    return autoFutures.positions.map((pos) => {
      const pp = productsMap[pos.product];
      const price = pp ? priceOf(pp.price, pos.month) : 0;
      const pnl = pp ? positionPnl(pos, price, pp.spec) : null;
      const name = autoFutures.products[pos.product]?.name ?? pos.product;
      return { pos, price, pnl, name };
    });
  }, [autoFutures.positions, autoFutures.products]);

  // 月份篩選（比照已實現損益總覽的月份快選）：''＝全部月份，否則是 'YYYY-MM'
  const [billMonth, setBillMonth] = useState('');
  const billMonthOptions = useMemo(() => {
    const set = new Set<string>();
    bills.forEach((b) => { const m = monthOf(b.statement_date ?? ''); if (m) set.add(m); });
    return [...set].sort().reverse(); // 新到舊
  }, [bills]);
  const BILL_RECENT_MONTHS_SHOWN = 6;
  const billRecentMonths = billMonthOptions.slice(0, BILL_RECENT_MONTHS_SHOWN);
  const billOlderMonths = billMonthOptions.slice(BILL_RECENT_MONTHS_SHOWN);
  const billMonthChipLabel = (m: string) => {
    const [y, mm] = m.split('-');
    return Number(y) === new Date().getFullYear() ? `${Number(mm)}月` : `${y.slice(2)}/${mm}`;
  };

  const filteredBills = useMemo(
    () => (billMonth ? bills.filter((b) => monthOf(b.statement_date ?? '') === billMonth) : bills),
    [bills, billMonth],
  );

  // 銀行／卡片＋幣別各自固定一個色調，統計磚跟下面明細表的色點才能對得上；
  // 未來新增銀行/卡片沒對到表也不會壞，就落回原本的橘色
  const BILL_BANK_TONES: Record<string, Tone> = {
    '台新|TWD': 'sky',
    '玉山|TWD': 'emerald',
    '玉山|JPY': 'amber',
  };
  const billBankTone = (bank: string, currency: string): Tone => BILL_BANK_TONES[`${bank}|${currency}`] ?? 'orange';

  // 依銀行＋幣別分組小計（篩選範圍內），幣別不同不能直接相加，分開列
  const billBreakdown = useMemo(() => {
    const map = new Map<string, { bank: string; currency: string; total: number; count: number }>();
    for (const b of filteredBills) {
      const key = `${b.bank}|${b.currency}`;
      const g = map.get(key) ?? { bank: b.bank, currency: b.currency, total: 0, count: 0 };
      g.total += b.amount_due;
      g.count += 1;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.bank.localeCompare(b.bank) || a.currency.localeCompare(b.currency));
  }, [filteredBills]);
  const billTwdTotal = useMemo(
    () => filteredBills.filter((b) => b.currency === 'TWD').reduce((s, b) => s + b.amount_due, 0),
    [filteredBills],
  );

  // 每月支出趨勢：故意用全部 bills（不隨月份篩選變動），這樣圖表隨時看得到完整歷史；
  // 只加總 TWD（JPY 等外幣幣別不同不能直接相加），依 statement_date 年月分組
  const monthlyTwdTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of bills) {
      if (b.currency !== 'TWD' || !b.statement_date) continue;
      const month = b.statement_date.slice(0, 7);
      map.set(month, (map.get(month) ?? 0) + b.amount_due);
    }
    return [...map.entries()].map(([month, total]) => ({ month, total })).sort((a, b) => a.month.localeCompare(b.month));
  }, [bills]);

  // 立即檢查帳單：跟「再平衡計算機」的真實同步同一套非同步觸發＋輪詢寫法
  const checkBillsNow = async () => {
    setBillSync({ status: 'triggering', msg: null });
    try {
      await api.triggerMonthlyBillsSync();
    } catch (e) {
      setBillSync({ status: 'error', msg: e instanceof Error ? e.message : '觸發失敗' });
      return;
    }
    setBillSync({ status: 'waiting', msg: null });
    const maxAttempts = 40; // 3 秒一次，約 2 分鐘逾時
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const st = await api.getMonthlyBillsSyncStatus();
        if (st.state === 'ok') {
          const resp = await api.getMonthlyBills();
          if (resp.exists) { setBills(resp.bills); setBillsUpdatedAt(resp.updated_at); }
          setBillSync({ status: 'done', msg: null });
          return;
        }
        if (st.state === 'error') {
          setBillSync({ status: 'error', msg: st.message || '檢查失敗' });
          return;
        }
      } catch {
        // 單次輪詢失敗不中斷，繼續重試到逾時
      }
    }
    setBillSync({ status: 'timeout', msg: '逾時未收到結果，稍後重新整理頁面看看。' });
  };

  const [billForm, setBillForm] = useState<{ open: boolean; editingId: string | null; draft: Partial<MonthlyBill> }>({
    open: false, editingId: null, draft: {},
  });
  const openBillForm = (b?: MonthlyBill) => setBillForm({
    open: true,
    editingId: b?.id ?? null,
    draft: b ? { ...b } : { bank: '', currency: 'TWD', source: 'manual' },
  });
  const closeBillForm = () => setBillForm({ open: false, editingId: null, draft: {} });
  const saveBillForm = async () => {
    const d = billForm.draft;
    if (!d.bank || !d.amount_due) return;
    try {
      const resp = await api.saveMonthlyBill({ ...d, id: billForm.editingId ?? undefined });
      setBills((prev) => {
        const idx = prev.findIndex((b) => b.id === resp.bill.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = resp.bill; return next; }
        return [...prev, resp.bill];
      });
      closeBillForm();
    } catch (e) {
      alert(e instanceof Error ? e.message : '儲存失敗');
    }
  };
  const deleteBill = async (id: string) => {
    try {
      await api.deleteMonthlyBill(id);
      setBills((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : '刪除失敗');
    }
  };

  return (
    <div className="space-y-5 pb-10">
      <Panel
        title="資產變化圖"
        icon={<Wallet className="w-4 h-4" />}
        tone="zinc"
        right={
          <Chip tone={cloud.status === 'error' ? 'rose' : 'sky'} title={cloud.msg ?? ''}>
            {cloudIcon} {cloud.status === 'loading' ? '同步中…' : cloud.status === 'error' ? '同步失敗' : '雲端已同步'}
          </Chip>
        }
        desc="券商現金＋股市庫存＋期貨權益，統整成淨資產——三格加總就是總資產，全部自動帶入「再平衡計算機」真實同步與「期貨損益總覽」的最新資料，沒有任何手動輸入。按「更新今天快照」才會存進歷史線圖——歷史從第一次使用這頁那天開始累積，之前的資料沒有留存。"
      >
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <StatTile
            label="券商現金"
            value={money(composition.cash)}
            tone="orange"
            icon={<Wallet className="w-3.5 h-3.5" />}
            hint="證券交易帳戶裡已入帳、不用等交割就能動用的現金餘額——來自「再平衡計算機」真實同步"
          />
          <StatTile
            label="股市庫存"
            value={money(composition.stock)}
            tone="primary"
            icon={<TrendingUp className="w-3.5 h-3.5" />}
            hint="庫存市值＋在途交割淨額，不含已入帳可動用現金（見左邊「券商現金」那格）"
          />
          <StatTile label="期貨權益" value={money(composition.futures)} tone="sky" icon={<Activity className="w-3.5 h-3.5" />} />
          <StatTile label="總資產" value={money(total)} tone="emerald" valueCls="text-emerald-300" hint="券商現金＋股市庫存＋期貨三格加總" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 更新今天快照 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40 space-y-3">
            <div className="text-[11px] text-zinc-500">今天（{todayDate()}）的自動快照</div>
            <div className="text-[11px] text-zinc-500 space-y-1">
              <div className="flex justify-between" title="即上方「券商現金」那格的來源">
                <span>已入帳可用現金（自動）</span><span className="font-mono text-zinc-300">{money(settledStockCash(draft))}</span>
              </div>
              <div className="flex justify-between">
                <span>尚未交割淨額（自動）</span>
                <span className="font-mono text-zinc-300">
                  {autoStock.pendingSettlement === 0
                    ? money(0)
                    : `${autoStock.pendingSettlement > 0 ? '應收' : '應付'} ${money(Math.abs(autoStock.pendingSettlement))}`}
                </span>
              </div>
              <div className="flex justify-between"><span>股市庫存市值（自動）</span><span className="font-mono text-zinc-300">{money(autoStock.holdings)}</span></div>
              <div className="flex justify-between"><span>期貨權益（自動）</span><span className="font-mono text-zinc-300">{money(autoFutures.equity)}</span></div>
              <div className="text-[10px] text-zinc-600 pt-1 flex items-start gap-1">
                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                <span>
                  股市／期貨自動資料截至{autoStock.syncedAt ? new Date(autoStock.syncedAt).toLocaleString('zh-TW') : '尚未同步'}
                  ，要更新請到「再平衡計算機」按「真實同步」。
                </span>
              </div>
            </div>
            <button
              onClick={handleSaveSnapshot}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary/90"
            >
              <Save className="w-3.5 h-3.5" /> 更新今天快照（總資產 {money(total)}）
            </button>
          </div>

          {/* 組成圓餅圖 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40 h-full flex flex-col">
            <div className="text-[11px] text-zinc-500 mb-3">目前組成</div>
            {donutData.length > 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-5">
                <div className="relative w-36 h-36 sm:w-44 sm:h-44 shrink-0">
                  <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#27272a" strokeWidth="3.5" />
                    {donutData.map((seg) => (
                      <circle
                        key={seg.category}
                        cx="18" cy="18" r="15.9155" fill="none"
                        stroke={NW_COLOR[seg.category]}
                        strokeWidth="3.5"
                        strokeLinecap="butt"
                        strokeDasharray={`${seg.pct * 100} ${100 - seg.pct * 100}`}
                        strokeDashoffset={-seg.offset * 100}
                      />
                    ))}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-[10px] text-zinc-500">總資產</span>
                    <span className="text-sm sm:text-base font-bold font-mono text-emerald-300">{money(total)}</span>
                  </div>
                </div>
                <ul className="space-y-2 text-xs w-full max-w-[220px]">
                  {donutData.map((seg) => (
                    <li key={seg.category} className="flex items-center gap-2" title={money(seg.value)}>
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: NW_COLOR[seg.category] }} />
                      <span className="text-zinc-400 truncate">{NW_LABEL[seg.category]}</span>
                      <span className="ml-auto font-mono text-zinc-500">{money(seg.value)}</span>
                      <span className="font-mono font-semibold text-zinc-300 w-10 text-right">{Math.round(seg.pct * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">尚無資料</div>
            )}
          </div>

          {/* 長期歷史變化 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40">
            <div className="text-[11px] text-zinc-500 mb-1">淨資產長期變化</div>
            <NetWorthHistoryChart data={historyData} />
          </div>
        </div>

        {/* 個股/ETF 持股明細 */}
        {stockRows.length > 0 && (
          <div className="mt-4 border border-border rounded-xl overflow-hidden">
            <div className="px-3 py-2 text-[11px] text-zinc-500 bg-zinc-900/60 border-b border-border">
              個股／ETF 持股明細（真實同步整戶庫存）
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left px-3 py-2 font-medium">標的</th>
                    <th className="text-right px-3 py-2 font-medium">股數</th>
                    <th className="text-right px-3 py-2 font-medium">目前價格</th>
                    <th className="text-right px-3 py-2 font-medium">平均成本</th>
                    <th className="text-right px-3 py-2 font-medium">市值</th>
                    <th className="text-right px-3 py-2 font-medium">未實現損益</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map((r) => (
                    <tr key={r.code} className="border-t border-border/60">
                      <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
                        {r.name ? `${r.name}（${r.code}）` : r.code}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">{r.shares.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">{r.market_price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-400">{r.avg_cost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">{money(r.value)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${pnlCls(r.unrealized)}`}>
                        {money(r.unrealized)}
                        {r.returnPct !== null && <span className="ml-1 text-[10px] font-normal">（{pct(r.returnPct)}）</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 期貨未平倉明細 */}
        {futuresRows.length > 0 && (
          <div className="mt-4 border border-border rounded-xl overflow-hidden">
            <div className="px-3 py-2 text-[11px] text-zinc-500 bg-zinc-900/60 border-b border-border">
              期貨未平倉明細（沿用「期貨損益總覽」的部位）
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left px-3 py-2 font-medium">商品</th>
                    <th className="text-left px-3 py-2 font-medium">月份</th>
                    <th className="text-left px-3 py-2 font-medium">方向</th>
                    <th className="text-right px-3 py-2 font-medium">口數</th>
                    <th className="text-right px-3 py-2 font-medium">進場價</th>
                    <th className="text-right px-3 py-2 font-medium">目前價</th>
                    <th className="text-right px-3 py-2 font-medium">未實現損益</th>
                  </tr>
                </thead>
                <tbody>
                  {futuresRows.map((r) => (
                    <tr key={r.pos.id} className="border-t border-border/60">
                      <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{r.name}</td>
                      <td className="px-3 py-2 text-zinc-400 font-mono">{r.pos.month}</td>
                      <td className="px-3 py-2 text-zinc-400">{r.pos.side === 'long' ? '多' : '空'}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">{r.pos.lots}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-400">{r.pos.entry_price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">{r.price.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${r.pnl ? pnlCls(r.pnl.net_pnl) : 'text-zinc-500'}`}>
                        {r.pnl ? money(r.pnl.net_pnl) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 快照列表 */}
        {snapshots.length > 0 && (
          <div className="mt-4 border border-border rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-900/60 text-zinc-500">
                  <th className="text-left px-3 py-2 font-medium">日期</th>
                  <th className="text-right px-3 py-2 font-medium">股市</th>
                  <th className="text-right px-3 py-2 font-medium">期貨</th>
                  <th className="text-right px-3 py-2 font-medium">總資產</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr key={s.id} className="border-t border-border/60">
                    <td className="px-3 py-2 text-zinc-300 font-mono whitespace-nowrap">{s.date}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">{money(s.stock_cash + s.stock_holdings_value)}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">{money(s.futures_equity)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-zinc-100">{money(snapshotTotal(s))}</td>
                    <td className="px-2 py-2 text-right">
                      <button onClick={() => handleDelete(s.id)} className="text-zinc-600 hover:text-rose-400" title="刪除這筆快照">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* 每月信用卡帳單 */}
      <Panel
        title="每月信用卡帳單"
        icon={<CreditCard className="w-4 h-4" />}
        tone="orange"
        right={
          <button
            onClick={() => void checkBillsNow()}
            disabled={billSync.status === 'triggering' || billSync.status === 'waiting'}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold bg-orange-500/15 text-orange-300 border-orange-500/30 hover:bg-orange-500/25 disabled:opacity-50"
          >
            {billSync.status === 'triggering' || billSync.status === 'waiting'
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            {billSync.status === 'waiting' ? '檢查中…' : '立即檢查帳單'}
          </button>
        }
        desc={`自動去信箱抓台新／玉山信用卡電子帳單，解密 PDF、擷取應繳金額與繳款截止日──每天排程跑一次，也可以按右上角「立即檢查帳單」手動觸發。${billsUpdatedAt ? `上次更新：${new Date(billsUpdatedAt).toLocaleString('zh-TW')}` : '尚未抓過'}`}
      >
        {billSync.status === 'error' && (
          <p className="text-[11px] text-rose-400 flex items-start gap-1 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {billSync.msg}
          </p>
        )}
        {billSync.status === 'timeout' && (
          <p className="text-[11px] text-amber-400 flex items-start gap-1 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {billSync.msg}
          </p>
        )}

        {/* 月份篩選：全部月份 或 單一月份，比照已實現損益總覽的月份快選 */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="flex items-center gap-1 text-[11px] text-zinc-500 mr-1">
            <Filter className="w-3.5 h-3.5" /> 月份
          </span>
          <button
            onClick={() => setBillMonth('')}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
              billMonth === ''
                ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
                : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
            }`}
          >
            全部月份
          </button>
          {billRecentMonths.map((m) => (
            <button
              key={m}
              onClick={() => setBillMonth(m)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
                billMonth === m
                  ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
                  : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
              }`}
            >
              {billMonthChipLabel(m)}
            </button>
          ))}
          {billOlderMonths.length > 0 && (
            <select
              value={billOlderMonths.includes(billMonth) ? billMonth : ''}
              onChange={(e) => { if (e.target.value) setBillMonth(e.target.value); }}
              className="px-2.5 py-1.5 rounded-lg text-[11px] bg-zinc-900 border border-border text-zinc-300"
            >
              <option value="">更早月份…</option>
              {billOlderMonths.map((m) => (
                <option key={m} value={m}>{m.replace('-', '/')}</option>
              ))}
            </select>
          )}
        </div>

        {/* 篩選範圍內的小計：TWD 總支出＋依銀行/幣別分開列（幣別不同不能直接相加）；
            筆數不再佔一整塊磚，改成右上角一行小字；卡片數量會隨銀行增加，
            改成左右可拉的滑軌而不是繼續往下擠成好幾排 */}
        {filteredBills.length > 0 ? (
          <div className="mb-4">
            <div className="flex justify-end mb-1.5">
              <span className="text-[11px] text-zinc-500">共 {filteredBills.length} 筆帳單</span>
            </div>
            <div className="flex items-stretch gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
              <div className="shrink-0 w-[200px] snap-start">
                <StatTile
                  label="TWD 支出小計"
                  value={money(billTwdTotal)}
                  tone="primary"
                  tintBg
                  icon={<CreditCard className="w-3.5 h-3.5" />}
                  sub={<span className="text-zinc-500">{billMonth ? billMonthChipLabel(billMonth) : '全部月份合計'}</span>}
                />
              </div>
              {billBreakdown.map((g) => (
                <div key={`${g.bank}|${g.currency}`} className="shrink-0 w-[200px] snap-start">
                  <StatTile
                    label={`${g.bank}（${g.currency}）`}
                    value={`${g.currency === 'TWD' ? '' : g.currency + ' '}${money(g.total)}`}
                    tone={billBankTone(g.bank, g.currency)}
                    tintBg
                    icon={<CreditCard className="w-3.5 h-3.5" />}
                    sub={`${g.count} 筆`}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="h-16 flex items-center justify-center text-xs text-zinc-600 mb-4">
            {bills.length === 0 ? '尚無帳單資料，按「立即檢查帳單」試試看' : '這個月沒有帳單資料'}
          </div>
        )}

        {/* 每月支出長條圖：故意不隨上面的月份篩選變動，隨時看得到完整歷史趨勢 */}
        <div className="border border-border rounded-xl p-4 bg-zinc-900/40 mb-4">
          <div className="text-[11px] text-zinc-500 mb-1">每月支出（TWD，兩張卡合計）</div>
          <MonthlyBillsChart data={monthlyTwdTotals} selectedMonth={billMonth || null} />
        </div>

        {/* 帳單明細（可手動新增/編輯/刪除） */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-3 py-2 flex items-center justify-between bg-zinc-900/60 border-b border-border">
            <span className="text-[11px] text-zinc-500">帳單明細</span>
            <button
              onClick={() => openBillForm()}
              className="inline-flex items-center gap-1 text-[11px] text-orange-300 hover:text-orange-200"
            >
              <Plus className="w-3.5 h-3.5" /> 手動新增
            </button>
          </div>

          {billForm.open && (
            <div className="p-3 border-b border-border bg-zinc-950/40 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <input placeholder="銀行（例：台新）" value={billForm.draft.bank ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, bank: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200" />
              <input placeholder="卡片名稱" value={billForm.draft.card_name ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, card_name: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200" />
              <input placeholder="卡號末四碼" value={billForm.draft.card_last4 ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, card_last4: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200" />
              <input placeholder="幣別（TWD）" value={billForm.draft.currency ?? 'TWD'} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, currency: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200" />
              <input type="number" placeholder="本期應繳金額" value={billForm.draft.amount_due ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, amount_due: Number(e.target.value) } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200 font-mono" />
              <input type="number" placeholder="最低應繳金額" value={billForm.draft.minimum_due ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, minimum_due: Number(e.target.value) } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200 font-mono" />
              <input type="date" placeholder="帳單結帳日" value={billForm.draft.statement_date ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, statement_date: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200 font-mono" />
              <input type="date" placeholder="繳款截止日" value={billForm.draft.due_date ?? ''} onChange={(e) => setBillForm((f) => ({ ...f, draft: { ...f.draft, due_date: e.target.value } }))} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-zinc-200 font-mono" />
              <div className="col-span-2 sm:col-span-4 flex items-center gap-2">
                <button onClick={() => void saveBillForm()} className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-500/90 text-white text-[11px] font-semibold rounded-lg hover:bg-orange-500">
                  <Save className="w-3.5 h-3.5" /> {billForm.editingId ? '更新' : '新增'}
                </button>
                <button onClick={closeBillForm} className="inline-flex items-center gap-1 px-3 py-1.5 bg-zinc-800 text-zinc-300 text-[11px] font-semibold rounded-lg hover:bg-zinc-700">
                  <X className="w-3.5 h-3.5" /> 取消
                </button>
              </div>
            </div>
          )}

          {filteredBills.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left px-3 py-2 font-medium">帳單結帳日</th>
                    <th className="text-left px-3 py-2 font-medium">銀行／卡片</th>
                    <th className="text-right px-3 py-2 font-medium">應繳金額</th>
                    <th className="text-right px-3 py-2 font-medium">最低應繳</th>
                    <th className="text-left px-3 py-2 font-medium">繳款截止日</th>
                    <th className="text-left px-3 py-2 font-medium">來源</th>
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody>
                  {[...filteredBills].sort((a, b) => (b.statement_date ?? '').localeCompare(a.statement_date ?? '')).map((b) => (
                    <tr key={b.id} className="border-t border-border/60">
                      <td className="px-3 py-2 text-zinc-300 font-mono whitespace-nowrap">{b.statement_date ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-zinc-300">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE[billBankTone(b.bank, b.currency)].bar}`} aria-hidden />
                          {b.bank}{b.card_name ? `｜${b.card_name}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-100 font-semibold">{b.currency === 'TWD' ? '' : `${b.currency} `}{money(b.amount_due)}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-400">{money(b.minimum_due)}</td>
                      <td className="px-3 py-2 text-zinc-300 font-mono whitespace-nowrap">{b.due_date ?? '未知'}</td>
                      <td className="px-3 py-2 text-zinc-500">{b.source === 'auto' ? '自動' : '手動'}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={() => openBillForm(b)} className="text-zinc-600 hover:text-orange-400 mr-1.5" title="編輯"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => void deleteBill(b.id)} className="text-zinc-600 hover:text-rose-400" title="刪除"><Trash2 className="w-3.5 h-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-12 flex items-center justify-center text-xs text-zinc-600">
              {bills.length === 0 ? '尚無帳單明細' : '這個月沒有帳單明細'}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
};

/** BusinessDay 物件或字串一律轉回 'YYYY-MM-DD'，用來把 chart 事件的 time 對回資料列 */
function timeToDateStr(t: Time): string {
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t !== null && 'year' in t) {
    const bd = t as { year: number; month: number; day: number };
    return `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`;
  }
  return '';
}

/**
 * 淨資產歷史線圖。跟「每月淨損益」長條圖同一套互動設計（見 RealizedPnl.tsx 的
 * MonthlyPnlChart）：關掉 series 內建、會釘住不動的 lastValue/priceLine 標籤，
 * 改成點擊哪個日期就顯示那天的淨資產，並用 setCrosshairPosition 把十字線釘在
 * 被點的那個點上當作視覺回饋。
 */
const NetWorthHistoryChart: React.FC<{ data: { date: string; total: number }[] }> = ({ data }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length === 0) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: '#27272a' } },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: { borderColor: '#3f3f46' },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addAreaSeries({
      lineColor: '#38bdf8',
      topColor: 'rgba(56,189,248,0.28)',
      bottomColor: 'rgba(56,189,248,0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const points = data.map((d) => ({ time: d.date as Time, value: d.total }));
    series.setData(points);
    chart.timeScale().fitContent();

    const setLegend = (found: { date: string; total: number } | undefined) => {
      if (legendRef.current) legendRef.current.textContent = found ? `${found.date}` + '　淨資產 ' + money(found.total) : '';
    };
    const selectPoint = (found: { date: string; total: number } | undefined) => {
      setLegend(found);
      if (found) chart.setCrosshairPosition(found.total, found.date as Time, series);
      else chart.clearCrosshairPosition();
    };
    selectPoint(data[data.length - 1]);

    chart.subscribeClick((param) => {
      if (!param.time) return;
      const found = data.find((d) => d.date === timeToDateStr(param.time as Time));
      if (found) selectPoint(found);
    });

    return () => chart.remove();
  }, [data]);

  if (data.length === 0) {
    return <div className="h-40 flex items-center justify-center text-xs text-zinc-600">尚無資料，按左側「更新今天快照」開始累積</div>;
  }
  return (
    <div className="relative w-full h-40">
      <div ref={legendRef} className="absolute top-0 left-1 z-10 text-[11px] font-mono text-zinc-400 select-none pointer-events-none" />
      <div ref={containerRef} className="w-full h-full cursor-pointer" />
    </div>
  );
};

/**
 * 每月信用卡支出長條圖。改寫自 RealizedPnl.tsx 的 MonthlyPnlChart（同一套點擊選月份、
 * autoSize:true 互動設計——見該元件註解：手動 width/ResizeObserver 會讓 canvas backing
 * buffer 卡在預設 300×150，一定要用 autoSize，這裡不重複贅述）。
 */
const MonthlyBillsChart: React.FC<{ data: { month: string; total: number }[]; selectedMonth?: string | null }> = ({ data, selectedMonth }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length === 0) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: '#27272a' } },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: {
        borderColor: '#3f3f46',
        tickMarkFormatter: (t: Time) => (typeof t === 'object' ? `${(t as BusinessDay).month}月` : String(t)),
      },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addHistogramSeries({
      color: '#fb923c',
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const points: HistogramData[] = data.map((d) => {
      const [y, m] = d.month.split('-').map(Number);
      return { time: { year: y, month: m, day: 1 } as BusinessDay, value: d.total };
    });
    series.setData(points);
    chart.timeScale().fitContent();

    const setLegend = (found: { month: string; total: number } | undefined) => {
      if (legendRef.current) legendRef.current.textContent = found ? `${found.month}` + '　支出 ' + money(found.total) : '';
    };
    const selectMonth = (found: { month: string; total: number } | undefined) => {
      setLegend(found);
      if (found) {
        const [y, m] = found.month.split('-').map(Number);
        chart.setCrosshairPosition(found.total, { year: y, month: m, day: 1 } as BusinessDay, series);
      } else {
        chart.clearCrosshairPosition();
      }
    };
    // 有外層月份篩選就跟著它選那根柱子，沒有（全部月份）就預設選最新一個月
    selectMonth(data.find((d) => d.month === selectedMonth) ?? data[data.length - 1]);

    chart.subscribeClick((param) => {
      if (!param.time) return;
      const t = param.time as unknown as { year: number; month: number };
      const found = data.find((d) => d.month === `${t.year}-${String(t.month).padStart(2, '0')}`);
      if (found) selectMonth(found);
    });

    return () => chart.remove();
  }, [data, selectedMonth]);

  if (data.length === 0) {
    return <div className="h-32 flex items-center justify-center text-xs text-zinc-600">尚無資料，按上方「立即檢查帳單」開始累積</div>;
  }
  return (
    <div className="relative w-full h-32">
      <div ref={legendRef} className="absolute top-0 left-1 z-10 text-[11px] font-mono text-zinc-400 select-none pointer-events-none" />
      <div ref={containerRef} className="w-full h-full cursor-pointer" />
    </div>
  );
};
