/**
 * NetWorth.tsx — 資產變化圖／淨資產總覽（2026-08-28 新增）。
 *
 * 銀行帳戶（完全手動，沒有任何 API）＋股市（再平衡計算機「真實同步」帶回來的
 * 券商現金＋整戶庫存市值，見 lib/api.ts 的 full_inventory）＋期貨權益（期貨損益
 * 總覽頁既有的權益數歷史最新一筆），統整成一個淨資產數字。
 *
 * 歷史無法回填：銀行餘額從沒被記錄過，股市/期貨的即時資料也只有「現在」這一份
 * 快照——所以「長期歷史變化」是從使用者第一次按「更新今天快照」那天開始累積，
 * 不是回溯重建的。快照一天一筆，同一天再存就覆蓋（見 netWorthStore.ts）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type Time } from 'lightweight-charts';
import {
  Wallet, Landmark, TrendingUp, Activity, Save, Trash2,
  Cloud, CloudOff, Loader2, Info,
} from 'lucide-react';
import { api } from '../lib/api';
import { Panel, StatTile, Chip } from '../components/futures/ui';
import {
  snapshotTotal, snapshotComposition, todayDate, type NetWorthSnapshot,
} from '../lib/netWorth';
import {
  getNetWorthConfig, saveNetWorthConfig, subscribeNetWorth,
} from '../lib/netWorthStore';

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;

type NWCategory = 'bank' | 'stock' | 'futures';
const NW_LABEL: Record<NWCategory, string> = { bank: '銀行', stock: '股市', futures: '期貨' };
const NW_COLOR: Record<NWCategory, string> = { bank: '#facc15', stock: '#a78bfa', futures: '#38bdf8' };

export const NetWorth: React.FC = () => {
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[]>(() => getNetWorthConfig().snapshots);
  const [cloud, setCloud] = useState<{ status: 'idle' | 'loading' | 'saved' | 'error'; msg: string | null }>({ status: 'idle', msg: null });
  const [autoStock, setAutoStock] = useState<{ cash: number; holdings: number; syncedAt: string | null }>({ cash: 0, holdings: 0, syncedAt: null });
  const [autoFutures, setAutoFutures] = useState<{ equity: number; updatedAt: string | null }>({ equity: 0, updatedAt: null });
  const [bankInput, setBankInput] = useState('');

  useEffect(() => subscribeNetWorth(() => setSnapshots(getNetWorthConfig().snapshots)), []);

  const didInit = useRef(false);
  const bankInitialized = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setCloud({ status: 'loading', msg: null });
    Promise.allSettled([api.getNetWorth(), api.getRebalanceHoldings(), api.getFuturesEquityHistory()])
      .then(([nw, rb, fut]) => {
        if (nw.status === 'fulfilled' && nw.value.exists) {
          saveNetWorthConfig({ snapshots: nw.value.snapshots });
          if (!bankInitialized.current && nw.value.snapshots.length > 0) {
            bankInitialized.current = true;
            setBankInput(String(nw.value.snapshots[nw.value.snapshots.length - 1].bank));
          }
        }
        if (rb.status === 'fulfilled' && rb.value.exists && rb.value.holdings) {
          const h = rb.value.holdings;
          // 舊資料（部署此功能前同步過的）沒有 full_inventory，退回只算三檔追蹤標的
          // 當估計值，好過直接當 0。
          const fallback = h.shares * h.price + h.bonds.reduce((s, b) => s + b.shares * b.price, 0);
          setAutoStock({
            cash: h.cash,
            holdings: rb.value.full_inventory?.total_value ?? fallback,
            syncedAt: rb.value.full_inventory?.synced_at ?? rb.value.saved_at ?? null,
          });
        }
        if (fut.status === 'fulfilled' && fut.value.exists && fut.value.rows.length > 0) {
          const last = fut.value.rows[fut.value.rows.length - 1];
          setAutoFutures({ equity: last.equity, updatedAt: fut.value.updated_at });
        }
        setCloud({ status: 'saved', msg: '已從雲端載入' });
      })
      .catch((e) => setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端載入失敗' }));
  }, []);

  // 「現在」草稿：銀行輸入框 + 自動帶入的股市/期貨，按下「更新今天快照」才真的存檔
  const draft: NetWorthSnapshot = useMemo(() => ({
    id: 'draft',
    date: todayDate(),
    bank: Math.max(0, parseFloat(bankInput) || 0),
    stock_cash: autoStock.cash,
    stock_holdings_value: autoStock.holdings,
    futures_equity: autoFutures.equity,
  }), [bankInput, autoStock, autoFutures]);

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
    const cats: NWCategory[] = ['bank', 'stock', 'futures'];
    const abs = cats.map((c) => Math.abs(composition[c]));
    const sum = abs.reduce((s, v) => s + v, 0);
    if (sum <= 0) return [];
    let cursor = 0;
    return cats
      .map((c, i) => {
        const pct = abs[i] / sum;
        const seg = { category: c, pct, value: composition[c], offset: cursor };
        cursor += pct;
        return seg;
      })
      .filter((s) => s.pct > 0);
  }, [composition]);

  const historyData = useMemo(
    () => snapshots.map((s) => ({ date: s.date, total: snapshotTotal(s) })),
    [snapshots],
  );

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
        desc="銀行帳戶＋股市（券商現金＋庫存市值）＋期貨權益，統整成淨資產。銀行沒有任何 API，數字要自己填；股市與期貨會自動帶入「再平衡計算機」真實同步與「期貨損益總覽」的最新資料。按「更新今天快照」才會存進歷史線圖——歷史從第一次使用這頁那天開始累積，之前的資料沒有留存。"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <StatTile label="銀行帳戶" value={money(composition.bank)} tone="amber" icon={<Landmark className="w-3.5 h-3.5" />} />
          <StatTile label="股市（現金＋庫存）" value={money(composition.stock)} tone="primary" icon={<TrendingUp className="w-3.5 h-3.5" />} />
          <StatTile label="期貨權益" value={money(composition.futures)} tone="sky" icon={<Activity className="w-3.5 h-3.5" />} />
          <StatTile label="總資產" value={money(total)} tone="emerald" valueCls="text-emerald-300" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 更新今天快照 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40 space-y-3">
            <div className="text-[11px] text-zinc-500">更新今天（{todayDate()}）的快照</div>
            <div>
              <label className="text-[10px] text-zinc-500">銀行帳戶總額（手動輸入）</label>
              <input
                type="number"
                value={bankInput}
                onChange={(e) => setBankInput(e.target.value)}
                placeholder="0"
                className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200 font-mono"
              />
            </div>
            <div className="text-[11px] text-zinc-500 space-y-1">
              <div className="flex justify-between"><span>股市現金（自動）</span><span className="font-mono text-zinc-300">{money(autoStock.cash)}</span></div>
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
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40">
            <div className="text-[11px] text-zinc-500 mb-3">目前組成</div>
            {donutData.length > 0 ? (
              <div className="flex items-center gap-4">
                <svg viewBox="0 0 36 36" className="w-24 h-24 -rotate-90 shrink-0">
                  <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#27272a" strokeWidth="4" />
                  {donutData.map((seg) => (
                    <circle
                      key={seg.category}
                      cx="18" cy="18" r="15.9155" fill="none"
                      stroke={NW_COLOR[seg.category]}
                      strokeWidth="4"
                      strokeDasharray={`${seg.pct * 100} ${100 - seg.pct * 100}`}
                      strokeDashoffset={-seg.offset * 100}
                    />
                  ))}
                </svg>
                <ul className="space-y-1.5 text-[11px] flex-1 min-w-0">
                  {donutData.map((seg) => (
                    <li key={seg.category} className="flex items-center gap-1.5" title={money(seg.value)}>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: NW_COLOR[seg.category] }} />
                      <span className="text-zinc-400 truncate">{NW_LABEL[seg.category]}</span>
                      <span className="ml-auto font-mono font-semibold text-zinc-300">{Math.round(seg.pct * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="h-20 flex items-center justify-center text-xs text-zinc-600">尚無資料</div>
            )}
          </div>

          {/* 長期歷史變化 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40">
            <div className="text-[11px] text-zinc-500 mb-1">淨資產長期變化</div>
            <NetWorthHistoryChart data={historyData} />
          </div>
        </div>

        {/* 快照列表 */}
        {snapshots.length > 0 && (
          <div className="mt-4 border border-border rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-900/60 text-zinc-500">
                  <th className="text-left px-3 py-2 font-medium">日期</th>
                  <th className="text-right px-3 py-2 font-medium">銀行</th>
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
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">{money(s.bank)}</td>
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
