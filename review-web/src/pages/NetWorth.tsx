/**
 * NetWorth.tsx — 資產變化圖／淨資產總覽（2026-08-28 新增；2026-08-28 補交割款細分
 * ／持股明細／期貨明細／銀行截圖辨識）。
 *
 * 銀行帳戶（完全手動，沒有任何 API，可截圖辨識輔助）＋股市（再平衡計算機「真實
 * 同步」帶回來的券商現金＋整戶庫存市值，見 lib/api.ts 的 full_inventory）＋期貨
 * 權益（期貨損益總覽頁既有的權益數歷史最新一筆），統整成一個淨資產數字。
 *
 * 歷史無法回填：銀行餘額從沒被記錄過，股市/期貨的即時資料也只有「現在」這一份
 * 快照——所以「長期歷史變化」是從使用者第一次按「更新今天快照」那天開始累積，
 * 不是回溯重建的。快照一天一筆，同一天再存就覆蓋（見 netWorthStore.ts）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type Time } from 'lightweight-charts';
import {
  Wallet, Landmark, TrendingUp, Activity, Save, Trash2,
  Cloud, CloudOff, Loader2, Info, ImagePlus, ScanLine, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api, type FullInventoryPosition, type NetWorthBankOcrResp } from '../lib/api';
import { Panel, StatTile, Chip } from '../components/futures/ui';
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

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const pnlCls = (v: number) => (v >= 0 ? 'text-bull' : 'text-bear');

type NWCategory = 'bank' | 'stock' | 'futures';
const NW_LABEL: Record<NWCategory, string> = { bank: '銀行', stock: '股市', futures: '期貨' };
const NW_COLOR: Record<NWCategory, string> = { bank: '#facc15', stock: '#a78bfa', futures: '#38bdf8' };

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
  const [bankInput, setBankInput] = useState('');

  useEffect(() => subscribeNetWorth(() => setSnapshots(getNetWorthConfig().snapshots)), []);

  const didInit = useRef(false);
  const bankInitialized = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setCloud({ status: 'loading', msg: null });
    Promise.allSettled([
      api.getNetWorth(),
      api.getRebalanceHoldings(),
      api.getFuturesEquityHistory(),
      api.getFuturesPositions(),
    ])
      .then(([nw, rb, fut, futPos]) => {
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
    stock_pending_settlement: autoStock.pendingSettlement,
    stock_holdings_value: autoStock.holdings,
    futures_equity: autoFutures.equity,
  }), [bankInput, autoStock, autoFutures.equity]);

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
        desc="銀行帳戶＋股市（庫存市值＋在途交割）＋期貨權益，統整成淨資產。銀行沒有任何 API，數字要自己填（或截圖輔助辨識）；股市與期貨會自動帶入「再平衡計算機」真實同步與「期貨損益總覽」的最新資料。按「更新今天快照」才會存進歷史線圖——歷史從第一次使用這頁那天開始累積，之前的資料沒有留存。已入帳、可自由動用的券商現金**不算進股市這格**（見下方「更新今天快照」卡片裡單獨列的那行），避免看起來像跟銀行帳戶重複算——但仍然算進總資產，所以銀行＋股市＋期貨三格加起來會比總資產少，差額就是那筆已入帳現金。"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <StatTile label="銀行帳戶" value={money(composition.bank)} tone="amber" icon={<Landmark className="w-3.5 h-3.5" />} />
          <StatTile
            label="股市（庫存＋交割中）"
            value={money(composition.stock)}
            tone="primary"
            icon={<TrendingUp className="w-3.5 h-3.5" />}
            hint="庫存市值＋在途交割淨額，不含已入帳可動用現金（那筆錢單獨列在下方「更新今天快照」卡片，避免跟銀行帳戶看起來重複）"
          />
          <StatTile label="期貨權益" value={money(composition.futures)} tone="sky" icon={<Activity className="w-3.5 h-3.5" />} />
          <StatTile label="總資產" value={money(total)} tone="emerald" valueCls="text-emerald-300" hint="含已入帳的券商現金——銀行＋股市＋期貨三格加起來會比這個數字少" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 更新今天快照 */}
          <div className="lg:col-span-1 border border-border rounded-xl p-4 bg-zinc-900/40 space-y-3">
            <div className="text-[11px] text-zinc-500">更新今天（{todayDate()}）的快照</div>
            <div>
              <label className="text-[10px] text-zinc-500">銀行帳戶總額（手動輸入，可截圖輔助）</label>
              <input
                type="number"
                value={bankInput}
                onChange={(e) => setBankInput(e.target.value)}
                placeholder="0"
                className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-border text-xs text-zinc-200 font-mono"
              />
              <div className="mt-1.5">
                <BankOcrWidget onApply={(amount) => setBankInput(String(Math.round(amount)))} />
              </div>
            </div>
            <div className="text-[11px] text-zinc-500 space-y-1">
              <div className="flex justify-between" title="不算進上方「股市」那格，避免看起來跟銀行帳戶重複——但仍計入總資產">
                <span>已入帳可用現金（自動，不算進股市格）</span><span className="font-mono text-zinc-300">{money(settledStockCash(draft))}</span>
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

type Picked = { id: string; name: string; mime: string; data: string; url: string; kb: number };

/** 縮圖 + 轉 JPEG，比照 StockScreenshotImport.tsx 的 shrink()。回 base64 本體＋預覽 URL。 */
async function shrinkImage(file: File, maxDim = 1600, quality = 0.85): Promise<Omit<Picked, 'id'>> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`讀不到圖片：${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('這個瀏覽器不支援 canvas，無法縮圖');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name, mime: 'image/jpeg', data, url: dataUrl, kb: Math.round((data.length * 3) / 4 / 1024) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 銀行 App 餘額截圖辨識。比已實現損益的截圖匯入簡單很多——只有一個數字要抽出來，
 * 不需要「掃描→比對→套用」三段式的異動清單，辨識完直接把建議總額顯示出來，使用者
 * 按「套用」才會真的寫進銀行輸入框（仍然要按外層的「更新今天快照」才會存檔，維持
 * 「確認過才落地」的一致精神，只是這裡的確認動作只有一個數字，不必搞出一整份清單）。
 */
const BankOcrWidget: React.FC<{ onApply: (amount: number) => void }> = ({ onApply }) => {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [scan, setScan] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; msg: string | null; result: NetWorthBankOcrResp | null }>(
    { status: 'idle', msg: null, result: null },
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 4);
    if (list.length === 0) return;
    setScan({ status: 'idle', msg: null, result: null });
    const out: Picked[] = [];
    for (const f of list) {
      try {
        const s = await shrinkImage(f);
        out.push({ ...s, id: `${f.name}_${f.size}_${Math.random().toString(36).slice(2, 7)}` });
      } catch (e) {
        setScan({ status: 'error', msg: e instanceof Error ? e.message : '圖片讀取失敗', result: null });
      }
    }
    setPicked((p) => [...p, ...out].slice(0, 4));
  };

  const runScan = async () => {
    if (picked.length === 0) return;
    setScan({ status: 'loading', msg: null, result: null });
    try {
      const resp = await api.scanNetWorthBank(picked.map((p) => ({ mime: p.mime, data: p.data })));
      setScan({ status: 'done', msg: resp.warnings.length > 0 ? resp.warnings.join('；') : null, result: resp });
    } catch (e) {
      setScan({ status: 'error', msg: e instanceof Error ? e.message : '辨識失敗', result: null });
    }
  };

  const reset = () => {
    setPicked([]);
    setScan({ status: 'idle', msg: null, result: null });
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="border border-dashed border-border rounded-lg p-2.5 space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { void addFiles(e.target.files); }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-800 border border-border text-[10px] text-zinc-300 hover:text-zinc-100"
        >
          <ImagePlus className="w-3 h-3" /> 截圖辨識銀行餘額
        </button>
        {picked.length > 0 && (
          <button
            onClick={() => void runScan()}
            disabled={scan.status === 'loading'}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-cyan-500/90 text-white text-[10px] font-semibold hover:bg-cyan-500 disabled:opacity-40"
          >
            {scan.status === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanLine className="w-3 h-3" />}
            {scan.status === 'loading' ? '辨識中…' : `掃描（${picked.length}張）`}
          </button>
        )}
        {(picked.length > 0 || scan.result) && (
          <button onClick={reset} className="text-[10px] text-zinc-600 hover:text-zinc-300">清除</button>
        )}
      </div>

      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <img key={p.id} src={p.url} alt={p.name} className="w-10 h-16 object-cover object-top rounded border border-border" />
          ))}
        </div>
      )}

      {scan.status === 'error' && (
        <p className="text-[10px] text-rose-400 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {scan.msg}
        </p>
      )}

      {scan.result && (
        <div className="space-y-1.5">
          {scan.result.screens.map((s, i) => (
            <div key={i} className="text-[10px] text-zinc-500">
              {s.kind === 'balance'
                ? (
                  <>
                    {s.bank_name ?? `第 ${i + 1} 張`}：建議 {money(s.suggested)}
                    {s.accounts.length > 0 && `（${s.accounts.map((a) => `${a.label} ${money(a.balance)}`).join('、')}）`}
                  </>
                )
                : <span className="text-amber-400">第 {i + 1} 張認不出是餘額畫面，已略過</span>}
            </div>
          ))}
          <button
            onClick={() => onApply(scan.result!.total_suggested)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/90 text-white text-[10px] font-semibold hover:bg-emerald-500"
          >
            <CheckCircle2 className="w-3 h-3" /> 套用建議總額 {money(scan.result.total_suggested)}
          </button>
        </div>
      )}
    </div>
  );
};
