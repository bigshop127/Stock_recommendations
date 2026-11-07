// 個股攤平計算機（再平衡計算機的第四個分頁）。
//
// 持倉來源＝玉山證券「真實同步」存在雲端的整戶庫存（GET /api/rebalance/holdings 的
// full_inventory，跟資產變化圖同一份）；按「從玉山同步」會叫 VM 重抓一次（唯讀，不下單）。
// 持股／成本／現價都可以手動改（試算「如果成本是…」），改動只存在這個瀏覽器，
// 而且綁定那一次同步——下次同步有新資料，手改的數字自動作廢，不會拿舊數字蓋掉真實持倉。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CloudOff, Loader2, Plus, RefreshCw, RotateCcw, Trash2, Info } from 'lucide-react';
import { api, type FullInventory, type RebalanceHoldingsResp } from '../../lib/api';
import {
  DEFAULT_FEE_RATE_PCT, DROP_STEP, defaultTarget, dropSlider, estimateCost, holdingStats, kindOfCode, mergePositions,
  parseNum, parseSyncTime, planAverageDown, targetForDrop,
  type AssetKind, type AvgMode, type CalcEnv, type Holding, type PlanInput, type PlanResult,
} from '../../lib/averageDown';

// ───────────────────────── 型別與儲存 ─────────────────────────

interface PlanSettings {
  mode: AvgMode;
  buyPrice: string;
  target: string;
  budget: string;
  buyShares: string;
  /** 使用者手動改的類型（沒改就用代號判斷） */
  kind?: AssetKind;
}
/** 手動改過的真實持倉欄位；syncedAt 對不上現在的同步時間就作廢 */
interface Edit {
  syncedAt: string;
  shares?: string;
  cost?: string;
  price?: string;
}
interface ManualStock {
  id: string;
  code: string;
  name: string;
  kind: AssetKind;
  shares: string;
  cost: string;
  price: string;
}
interface Persisted {
  rate: string;
  unit: 1 | 1000;
  plans: Record<string, PlanSettings>;
  edits: Record<string, Edit>;
  manual: ManualStock[];
  active: string;
}

const STORAGE_KEY = 'review-avgdown-v1';
const EMPTY: Persisted = { rate: String(DEFAULT_FEE_RATE_PCT), unit: 1, plans: {}, edits: {}, manual: [], active: '' };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<Persisted>;
    return {
      rate: typeof d.rate === 'string' ? d.rate : EMPTY.rate,
      unit: d.unit === 1000 ? 1000 : 1,
      plans: d.plans && typeof d.plans === 'object' ? d.plans : {},
      edits: d.edits && typeof d.edits === 'object' ? d.edits : {},
      manual: Array.isArray(d.manual) ? d.manual : [],
      active: typeof d.active === 'string' ? d.active : '',
    };
  } catch {
    return EMPTY; // 私密視窗或存取被擋：照樣能用，只是不記住
  }
}

// ───────────────────────── 顯示小工具 ─────────────────────────

const nf0 = (n: number) => Math.round(n).toLocaleString('zh-TW');
const nf2 = (n: number) => n.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct1 = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(1)}%`;
const pct2 = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(2)}%`;
// 台股慣例：賺＝紅、賠＝綠
const pnlCls = (n: number) => (!Number.isFinite(n) || n === 0 ? 'text-zinc-300' : n > 0 ? 'text-bull' : 'text-bear');
const lotsText = (n: number) => (n >= 1000 ? `（${Number((n / 1000).toFixed(3))} 張）` : '');
const gapText = (g: number) => (g > 0 ? `+${(g * 100).toFixed(1)}%` : '已回本');
/** 刻度下的簡短金額：65.9萬、1,234萬、1.2億 */
const wan = (n: number) => {
  if (n >= 1e8) return `${Number((n / 1e8).toFixed(1))}億`;
  if (n >= 1e4) return `${n >= 1e6 ? Math.round(n / 1e4).toLocaleString('zh-TW') : Number((n / 1e4).toFixed(1))}萬`;
  return nf0(n);
};

const INPUT_CLS =
  'w-full h-10 px-3 bg-zinc-950 border border-zinc-800 rounded-lg text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-primary';
const LABEL_CLS = 'block text-[11px] text-zinc-500 mb-1';

function Seg<T extends string | number>({
  value, options, onChange, label,
}: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid grid-flow-col auto-cols-fr border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
      {options.map((o, i) => (
        <button
          key={String(o.v)}
          type="button"
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
          className={`h-10 text-xs font-medium transition-colors ${i > 0 ? 'border-l border-zinc-800' : ''} ${
            o.v === value ? 'bg-primary/20 text-primary font-semibold' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── 列（一檔持股的有效數字） ─────────────────────────

interface Row {
  key: string;
  code: string;
  name: string;
  source: 'real' | 'manual';
  kind: AssetKind;
  shares: string;
  cost: string;
  price: string;
  holding: Holding;
  costEstimated: boolean;
  edited: boolean;
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `m_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

type SyncState = { status: 'idle' | 'triggering' | 'waiting' | 'done' | 'timeout' | 'error'; msg: string | null };

export function AverageDownCalculator({ onRealSynced }: { onRealSynced?: (resp: RebalanceHoldingsResp) => void }) {
  const [st, setSt] = useState<Persisted>(loadPersisted);
  const [inv, setInv] = useState<FullInventory | null>(null);
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState('');
  const [sync, setSync] = useState<SyncState>({ status: 'idle', msg: null });
  const [armed, setArmed] = useState<string | null>(null); // 兩段式確認（刪除）
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 記住設定（私密視窗寫不進去也不影響使用）
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch { /* 忽略 */ }
  }, [st]);

  const applyResp = useCallback((resp: RebalanceHoldingsResp) => {
    setInv(resp.full_inventory ?? null);
  }, []);

  // 載入雲端持倉（元件已卸載就丟掉回來的結果；初始狀態就是 loading，所以載入時不用再 setState）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const loadHoldings = useCallback(() => {
    api.getRebalanceHoldings()
      .then((resp) => { if (alive.current) { applyResp(resp); setLoad('ok'); } })
      .catch((e: unknown) => { if (alive.current) { setLoadErr(e instanceof Error ? e.message : '讀取失敗'); setLoad('error'); } });
  }, [applyResp]);
  useEffect(() => { loadHoldings(); }, [loadHoldings]);

  // 真實同步：流程同再平衡頁的「真實同步」（觸發 VM → 輪詢狀態與 saved_at）
  const runSync = async () => {
    setSync({ status: 'triggering', msg: null });
    let baseline: string | null;
    try {
      baseline = (await api.getRebalanceHoldings()).saved_at;
      await api.triggerRealSync();
    } catch (e) {
      setSync({ status: 'error', msg: e instanceof Error ? e.message : '觸發失敗' });
      return;
    }
    setSync({ status: 'waiting', msg: null });
    for (let i = 0; i < 60; i++) { // 3 秒一次、約 3 分鐘（容器在 qemu 下啟動較慢）
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const s = await api.getRealSyncStatus();
        if (s.state === 'error') { setSync({ status: 'error', msg: s.message || '同步失敗' }); return; }
        const resp = await api.getRebalanceHoldings();
        if (resp.exists && resp.saved_at && resp.saved_at !== baseline) {
          applyResp(resp);
          onRealSynced?.(resp);
          setSync({ status: 'done', msg: resp.saved_at });
          return;
        }
      } catch { /* 單次輪詢失敗不中斷 */ }
    }
    setSync({ status: 'timeout', msg: '逾時未收到更新。同步跑在 VM 上，請看 VM 的 data/sync_holdings_status.json。' });
  };

  const feeRate = useMemo(() => {
    const r = parseNum(st.rate);
    return (Number.isFinite(r) && r >= 0 ? r : DEFAULT_FEE_RATE_PCT) / 100;
  }, [st.rate]);
  const env: CalcEnv = useMemo(() => ({ feeRate, unit: st.unit }), [feeRate, st.unit]);
  const syncedAt = inv?.synced_at ?? '';

  // 真實＋手動 → 列
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const p of mergePositions(inv?.positions ?? [])) {
      const key = p.code;
      const e = st.edits[key];
      const live = e && e.syncedAt === syncedAt ? e : undefined;
      const costEstimated = !(typeof p.cost === 'number' && p.cost > 0);
      const realCost = costEstimated ? estimateCost(p.shares, p.avg_cost, feeRate) : (p.cost as number);
      const shares = live?.shares ?? String(p.shares);
      const cost = live?.cost ?? String(realCost);
      const price = live?.price ?? (p.market_price > 0 ? String(p.market_price) : '');
      const kind = st.plans[key]?.kind ?? kindOfCode(p.code);
      out.push({
        key, code: p.code, name: p.name || '', source: 'real', kind, shares, cost, price,
        holding: { shares: parseNum(shares), cost: parseNum(cost), price: parseNum(price), kind },
        costEstimated: costEstimated && live?.cost === undefined,
        edited: !!live && (live.shares !== undefined || live.cost !== undefined || live.price !== undefined),
      });
    }
    for (const m of st.manual) {
      out.push({
        key: `m:${m.id}`, code: m.code, name: m.name, source: 'manual', kind: m.kind,
        shares: m.shares, cost: m.cost, price: m.price,
        holding: { shares: parseNum(m.shares), cost: parseNum(m.cost), price: parseNum(m.price), kind: m.kind },
        costEstimated: false, edited: false,
      });
    }
    return out;
  }, [inv, st.edits, st.plans, st.manual, syncedAt, feeRate]);

  const active = rows.find((r) => r.key === st.active) ?? rows[0];

  const planOf = useCallback((r: Row): PlanSettings => {
    const saved = st.plans[r.key];
    if (saved) return saved;
    return { mode: 'target', buyPrice: '', target: defaultTarget(r.holding, env), budget: '100000', buyShares: '100' };
  }, [st.plans, env]);

  const resultOf = useCallback((r: Row): PlanResult => {
    const p = planOf(r);
    const input: PlanInput = {
      mode: p.mode, buyPrice: parseNum(p.buyPrice), target: parseNum(p.target),
      budget: parseNum(p.budget), buyShares: parseNum(p.buyShares),
    };
    return planAverageDown(r.holding, env, input);
  }, [planOf, env]);

  // ── 改值 ──
  const setPlan = (r: Row, patch: Partial<PlanSettings>) =>
    setSt((s) => ({ ...s, plans: { ...s.plans, [r.key]: { ...planOf(r), ...patch } } }));
  const setField = (r: Row, field: 'shares' | 'cost' | 'price', value: string) => {
    if (r.source === 'manual') {
      const id = r.key.slice(2);
      setSt((s) => ({ ...s, manual: s.manual.map((m) => (m.id === id ? { ...m, [field]: value } : m)) }));
    } else {
      setSt((s) => ({ ...s, edits: { ...s.edits, [r.key]: { ...(s.edits[r.key]?.syncedAt === syncedAt ? s.edits[r.key] : {}), syncedAt, [field]: value } } }));
    }
  };
  const setManualMeta = (r: Row, patch: Partial<Pick<ManualStock, 'code' | 'name' | 'kind'>>) => {
    const id = r.key.slice(2);
    setSt((s) => ({ ...s, manual: s.manual.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  };
  const resetEdit = (r: Row) => setSt((s) => {
    const edits = { ...s.edits };
    delete edits[r.key];
    return { ...s, edits };
  });
  const select = (key: string) => setSt((s) => ({ ...s, active: key }));
  const addManual = () => {
    const m: ManualStock = { id: newId(), code: '', name: '', kind: 'stock', shares: '', cost: '', price: '' };
    setSt((s) => ({ ...s, manual: [...s.manual, m], active: `m:${m.id}` }));
    setTimeout(() => nameRef.current?.focus(), 0);
  };
  const removeManual = (r: Row) => {
    const id = r.key.slice(2);
    setSt((s) => {
      const plans = { ...s.plans };
      delete plans[r.key];
      return { ...s, manual: s.manual.filter((m) => m.id !== id), plans, active: '' };
    });
  };
  const arm = (id: string, fn: () => void) => {
    if (armed === id) { setArmed(null); fn(); return; }
    setArmed(id);
    setTimeout(() => setArmed((cur) => (cur === id ? null : cur)), 3000);
  };

  // ── 畫面用的衍生值 ──
  const syncTime = parseSyncTime(syncedAt);
  const syncTimeText = syncTime
    ? syncTime.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '';
  const syncing = sync.status === 'triggering' || sync.status === 'waiting';
  const ap = active ? planOf(active) : null;
  const aStats = active ? holdingStats(active.holding, env) : null;
  const aResult = active ? resultOf(active) : null;
  const aSlider = active && ap && ap.mode === 'target' && aStats
    ? dropSlider(active.holding, env, parseNum(ap.buyPrice), parseNum(ap.target))
    : null;
  const setDrop = (pct: number) => {
    if (active && aStats) setPlan(active, { target: targetForDrop(aStats.avg, pct) });
  };

  const summary = useMemo(() => {
    let total = 0;
    const lines = rows.map((r) => {
      const res = resultOf(r);
      if (res.kind === 'ok') total += res.total;
      return { r, res };
    });
    return { lines, total };
  }, [rows, resultOf]);

  return (
    <div className="space-y-6">
      {/* 資料來源與共用設定 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-200">個股攤平計算機</h2>
            <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
              持倉取自玉山證券真實帳戶（唯讀，不會下單）。持股、成本、現價都可以改來試算，改動只存在這個瀏覽器。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={syncing}
            className="shrink-0 h-9 px-3 rounded-lg border border-primary/40 bg-primary/10 text-primary text-xs font-semibold flex items-center gap-1.5 hover:bg-primary/20 disabled:opacity-50 transition-colors"
            title="叫 VM 重新抓一次玉山庫存（約 20–60 秒）"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            從玉山同步
          </button>
        </div>

        <div className="text-[11px] space-y-1" aria-live="polite">
          {load === 'loading' && <div className="text-zinc-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />讀取雲端持倉…</div>}
          {load === 'error' && (
            <div className="text-amber-400 flex items-center gap-1.5 flex-wrap">
              <CloudOff className="w-3.5 h-3.5" />讀不到雲端持倉：{loadErr}
              <button type="button" onClick={() => { setLoad('loading'); loadHoldings(); }} className="underline underline-offset-2">重試</button>
            </div>
          )}
          {load === 'ok' && inv && syncTimeText && (
            <div className="text-zinc-400">
              真實持倉 <span className="text-zinc-200">{inv.positions.length}</span> 檔，同步於 <span className="font-mono text-zinc-200">{syncTimeText}</span>
              <span className="text-zinc-500 ml-3">現價是同步當下的價格，下單前記得再同步或自己改現價</span>
            </div>
          )}
          {load === 'ok' && !inv && (
            <div className="text-amber-400">還沒有真實持倉資料——按右上「從玉山同步」，或用下方「＋ 新增」手動輸入。</div>
          )}
          {syncing && <div className="text-primary flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />{sync.status === 'triggering' ? '觸發中…' : 'VM 正在向玉山抓庫存…'}</div>}
          {sync.status === 'done' && <div className="text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" />已更新真實持倉</div>}
          {(sync.status === 'error' || sync.status === 'timeout') && (
            <div className="text-amber-400 flex items-center gap-1.5"><CloudOff className="w-3.5 h-3.5 shrink-0" />同步失敗：{sync.msg}</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="avg-rate" className={LABEL_CLS}>手續費率（%，填折扣後的）</label>
            <input id="avg-rate" type="text" inputMode="decimal" autoComplete="off" value={st.rate}
              onChange={(e) => setSt((s) => ({ ...s, rate: e.target.value }))} className={INPUT_CLS} />
          </div>
          <div>
            <span className={LABEL_CLS}>買進單位</span>
            <Seg label="買進單位" value={st.unit} onChange={(v) => setSt((s) => ({ ...s, unit: v }))}
              options={[{ v: 1 as const, label: '零股' }, { v: 1000 as const, label: '整張' }]} />
          </div>
        </div>
      </div>

      {/* 個股選擇 */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="選擇個股">
        {rows.map((r) => {
          const s = holdingStats(r.holding, env);
          const sel = active?.key === r.key;
          return (
            <button key={r.key} type="button" onClick={() => select(r.key)} aria-pressed={sel}
              className={`flex flex-col items-start px-3 py-1.5 rounded-lg border text-left transition-colors ${
                sel ? 'border-primary bg-primary/10' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-600'
              }`}>
              <span className="text-xs font-medium text-zinc-100">{r.name || r.code || '未命名'}</span>
              {s && Number.isFinite(s.pct)
                ? <span className={`text-[11px] font-mono ${pnlCls(s.pct)}`}>{pct1(s.pct)}</span>
                : <span className="text-[11px] font-mono text-zinc-600">—</span>}
            </button>
          );
        })}
        <button type="button" onClick={addManual}
          className="px-3 py-1.5 rounded-lg border border-dashed border-primary/50 text-primary text-xs font-semibold flex items-center gap-1 hover:bg-primary/10 transition-colors">
          <Plus className="w-3.5 h-3.5" />新增
        </button>
      </div>

      {/* 單檔計算 */}
      {active && ap ? (
        <div ref={panelRef} className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-5">
          <div className="flex items-center justify-between gap-2 flex-wrap border-b border-border/60 pb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-zinc-100 font-mono">{active.code || '—'}</span>
              <span className="text-xs text-zinc-400 truncate">{active.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${active.source === 'real' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>
                {active.source === 'real' ? '真實持倉' : '手動輸入'}
              </span>
            </div>
            {active.edited && (
              <button type="button" onClick={() => resetEdit(active)}
                className="text-[11px] text-primary hover:text-primary/80 flex items-center gap-1">
                <RotateCcw className="w-3 h-3" />還原真實數字
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {active.source === 'manual' && (
              <>
                <div>
                  <label htmlFor="avg-name" className={LABEL_CLS}>個股名稱</label>
                  <input id="avg-name" ref={nameRef} type="text" autoComplete="off" value={active.name}
                    onChange={(e) => setManualMeta(active, { name: e.target.value })} className={INPUT_CLS.replace('font-mono', 'font-sans')} />
                </div>
                <div>
                  <label htmlFor="avg-code" className={LABEL_CLS}>代號（用來判斷股票或 ETF）</label>
                  <input id="avg-code" type="text" autoComplete="off" value={active.code}
                    onChange={(e) => setManualMeta(active, { code: e.target.value, kind: kindOfCode(e.target.value) })} className={INPUT_CLS} />
                </div>
              </>
            )}
            <div>
              <span className={LABEL_CLS}>類型（影響賣出證交稅）</span>
              <Seg label="類型" value={active.kind}
                onChange={(v) => (active.source === 'manual' ? setManualMeta(active, { kind: v }) : setPlan(active, { kind: v }))}
                options={[{ v: 'stock' as const, label: '股票 0.3%' }, { v: 'etf' as const, label: 'ETF 0.1%' }]} />
            </div>
            <div>
              <label htmlFor="avg-shares" className={LABEL_CLS}>持有股數</label>
              <input id="avg-shares" type="text" inputMode="numeric" autoComplete="off" value={active.shares}
                onChange={(e) => setField(active, 'shares', e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="avg-cost" className={LABEL_CLS}>持有總成本（元，含手續費）</label>
              <input id="avg-cost" type="text" inputMode="decimal" autoComplete="off" value={active.cost}
                onChange={(e) => setField(active, 'cost', e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="avg-price" className={LABEL_CLS}>現價</label>
              <input id="avg-price" type="text" inputMode="decimal" autoComplete="off" value={active.price}
                onChange={(e) => setField(active, 'price', e.target.value)} className={INPUT_CLS} />
            </div>
          </div>
          {active.costEstimated && (
            <p className="text-[11px] text-amber-400/90 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              這檔的成本是用「股數×均價＋買進手續費」估的（上次同步還沒帶含費成本），可能差幾元。按右上「從玉山同步」就會換成券商的精確成本。
            </p>
          )}

          {/* 目前狀況 */}
          <div className="grid grid-cols-3 gap-2 p-3 bg-zinc-950/60 border border-zinc-800 rounded-lg">
            {aStats ? (
              <>
                <div className="min-w-0"><div className="text-[11px] text-zinc-500">目前均價</div><div className="text-sm font-mono font-semibold text-zinc-100">{nf2(aStats.avg)}</div></div>
                <div className="min-w-0"><div className="text-[11px] text-zinc-500">損益平衡價</div><div className="text-sm font-mono font-semibold text-zinc-100">{nf2(aStats.breakEven)}</div></div>
                <div className="min-w-0">
                  <div className="text-[11px] text-zinc-500">預估報酬率</div>
                  <div className={`text-sm font-mono font-semibold ${pnlCls(aStats.pct)}`}>{Number.isFinite(aStats.pct) ? pct2(aStats.pct) : '—'}</div>
                </div>
              </>
            ) : (
              <div className="col-span-3 text-xs text-zinc-500">填入持股數與總成本後，這裡會顯示均價與損益。</div>
            )}
          </div>

          <div className="border-t border-border/60 pt-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-200">怎麼攤平</h3>
            <Seg label="攤平方式" value={ap.mode} onChange={(v) => setPlan(active, { mode: v })}
              options={[{ v: 'target' as const, label: '目標均價' }, { v: 'budget' as const, label: '手上預算' }, { v: 'shares' as const, label: '指定股數' }]} />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="avg-buyprice" className={LABEL_CLS}>買進價格（留空＝現價）</label>
                <input id="avg-buyprice" type="text" inputMode="decimal" autoComplete="off" value={ap.buyPrice}
                  onChange={(e) => setPlan(active, { buyPrice: e.target.value })} className={INPUT_CLS} />
              </div>
              {ap.mode === 'target' && (
                <div>
                  <label htmlFor="avg-target" className={LABEL_CLS}>想攤到的均價</label>
                  <input id="avg-target" type="text" inputMode="decimal" autoComplete="off" value={ap.target}
                    onChange={(e) => setPlan(active, { target: e.target.value })} className={INPUT_CLS} />
                </div>
              )}
              {ap.mode === 'budget' && (
                <div>
                  <label htmlFor="avg-budget" className={LABEL_CLS}>預算上限（元，含手續費）</label>
                  <input id="avg-budget" type="text" inputMode="numeric" autoComplete="off" value={ap.budget}
                    onChange={(e) => setPlan(active, { budget: e.target.value })} className={INPUT_CLS} />
                </div>
              )}
              {ap.mode === 'shares' && (
                <div>
                  <label htmlFor="avg-buyshares" className={LABEL_CLS}>要買幾股</label>
                  <input id="avg-buyshares" type="text" inputMode="numeric" autoComplete="off" value={ap.buyShares}
                    onChange={(e) => setPlan(active, { buyShares: e.target.value })} className={INPUT_CLS} />
                </div>
              )}
            </div>

            {aSlider && aStats && (
              <div className="space-y-2 pt-1" data-testid="avg-drop-slider">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                  <span className="text-zinc-400">
                    均價下降
                    <span className="font-mono font-semibold text-primary text-sm ml-2">
                      {aSlider.pct > 0 ? `${Number(aSlider.pct.toFixed(1))}%` : '—'}
                    </span>
                  </span>
                  <span className="font-mono text-zinc-300">
                    {aResult && aResult.kind === 'ok'
                      ? <>需準備 <span className="font-semibold text-primary text-sm">NT$ {nf0(aResult.total)}</span></>
                      : <span className="text-zinc-500">拉動滑軌選擇要攤到多低</span>}
                  </span>
                </div>
                <input
                  id="avg-drop"
                  type="range"
                  min={0}
                  max={aSlider.max}
                  step={DROP_STEP}
                  value={aSlider.pct}
                  onChange={(e) => setDrop(parseFloat(e.target.value))}
                  aria-label="均價下降百分比"
                  aria-valuetext={aResult && aResult.kind === 'ok'
                    ? `均價下降 ${Number(aSlider.pct.toFixed(1))}%，需準備 ${nf0(aResult.total)} 元`
                    : '尚未選擇'}
                  className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary"
                />
                {/* 刻度：點一下跳過去；每個刻度下面是拉到那裡要準備的錢 */}
                <div className="relative h-10 mx-2 text-[11px] font-mono">
                  {aSlider.marks.map((m) => {
                    const frac = m.pct / aSlider.max;
                    return (
                      <button
                        key={m.pct}
                        type="button"
                        onClick={() => setDrop(m.pct)}
                        className="absolute top-0 -translate-x-1/2 px-1 py-0.5 text-center whitespace-nowrap text-zinc-400 hover:text-primary transition-colors"
                        style={{ left: `${frac * 100}%` }}
                        title={m.total === null ? undefined : `均價下降 ${m.pct}%：需準備約 NT$ ${nf0(m.total)}`}
                      >
                        <span className="block">{m.pct}%</span>
                        <span className="block text-[10px] text-zinc-500">{m.total === null ? '—' : m.total === 0 ? '0' : wan(m.total)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 結果 */}
          <div aria-live="polite">
            {aResult && aResult.kind !== 'ok' && (
              <div className={`p-3 rounded-lg text-xs leading-relaxed border ${
                aResult.kind === 'skip' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              }`}>{aResult.msg}</div>
            )}
            {aResult && aResult.kind === 'ok' && (
              <div className="space-y-3">
                <div className="p-4 bg-zinc-950/60 border border-zinc-800 rounded-lg">
                  <div className="text-[11px] text-zinc-500">需要準備（含手續費）</div>
                  <div className="text-3xl font-mono font-semibold text-zinc-50 tracking-tight break-all">
                    <span className="text-sm font-normal text-zinc-500 mr-1.5">NT$</span>{nf0(aResult.total)}
                  </div>
                  <div className="text-xs text-zinc-400 mt-1">
                    買進 {nf0(aResult.n)} 股{lotsText(aResult.n)}，價格 {nf2(aResult.p)}，手續費 {nf0(aResult.fee)} 元
                  </div>
                  {aResult.note && <div className="text-[11px] text-amber-400 mt-1">{aResult.note}</div>}
                </div>
                {aResult.raisesAvg && (
                  <div className="p-3 rounded-lg text-xs border bg-amber-500/10 border-amber-500/30 text-amber-300">
                    買進價 {nf2(aResult.p)} 不低於目前均價 {nf2(aResult.A0)}，買進後均價不會下降。
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-zinc-500">
                        <th className="text-left font-medium py-1.5 pr-2"></th>
                        <th className="text-right font-medium py-1.5 px-2">攤平前</th>
                        <th className="text-right font-medium py-1.5 pl-2">攤平後</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-zinc-200">
                      <tr className="border-t border-zinc-800"><th scope="row" className="text-left font-sans font-normal text-zinc-400 py-2 pr-2">持有股數</th><td className="text-right py-2 px-2">{nf0(aResult.S0)}</td><td className="text-right py-2 pl-2">{nf0(aResult.nS)}</td></tr>
                      <tr className="border-t border-zinc-800">
                        <th scope="row" className="text-left font-sans font-normal text-zinc-400 py-2 pr-2">均價</th>
                        <td className="text-right py-2 px-2">{nf2(aResult.A0)}</td>
                        <td className="text-right py-2 pl-2">
                          {nf2(aResult.nA)}
                          <div className={`text-[11px] ${pnlCls(aResult.nA / aResult.A0 - 1)}`}>{pct1(aResult.nA / aResult.A0 - 1)}</div>
                        </td>
                      </tr>
                      <tr className="border-t border-zinc-800"><th scope="row" className="text-left font-sans font-normal text-zinc-400 py-2 pr-2">損益平衡價</th><td className="text-right py-2 px-2">{nf2(aResult.be0)}</td><td className="text-right py-2 pl-2">{nf2(aResult.be1)}</td></tr>
                      <tr className="border-t border-zinc-800"><th scope="row" className="text-left font-sans font-normal text-zinc-400 py-2 pr-2">現價到回本</th><td className="text-right py-2 px-2">{gapText(aResult.gap0)}</td><td className="text-right py-2 pl-2">{gapText(aResult.gap1)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {active.source === 'manual' && (
            <div className="flex justify-end">
              <button type="button" onClick={() => arm(active.key, () => removeManual(active))}
                className={`h-8 px-3 rounded-lg border text-xs flex items-center gap-1.5 transition-colors ${
                  armed === active.key ? 'border-bull text-bull' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}>
                <Trash2 className="w-3.5 h-3.5" />{armed === active.key ? '再按一次確認刪除' : '刪除這檔'}
              </button>
            </div>
          )}
        </div>
      ) : (
        load !== 'loading' && (
          <div className="bg-card border border-border rounded-xl p-6 text-center text-xs text-zinc-500">
            還沒有任何持股。按「從玉山同步」帶入真實持倉，或「＋ 新增」手動輸入一檔。
          </div>
        )
      )}

      {/* 全部個股一覽 */}
      {rows.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">全部個股一覽</h2>
            <p className="text-[11px] text-zinc-500 mt-1">每一檔的攤平設定分開記住，點名稱可切換；合計是每檔都照各自設定攤平時總共要準備的錢。</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-medium py-1.5 pr-2">個股</th>
                  <th className="text-right font-medium py-1.5 px-2">買進</th>
                  <th className="text-right font-medium py-1.5 px-2">需準備（元）</th>
                  <th className="text-right font-medium py-1.5 pl-2">新均價</th>
                </tr>
              </thead>
              <tbody className="font-mono text-zinc-200">
                {summary.lines.map(({ r, res }) => (
                  <tr key={r.key} className={`border-t border-zinc-800 ${active?.key === r.key ? 'bg-primary/10' : ''}`}>
                    <th scope="row" className="text-left font-sans font-normal py-2 pr-2 whitespace-nowrap">
                      <button type="button" className="underline decoration-zinc-700 underline-offset-4 hover:text-primary text-zinc-200"
                        onClick={() => { select(r.key); panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                        {r.name || r.code || '未命名'}
                      </button>
                    </th>
                    {res.kind === 'ok' ? (
                      <>
                        <td className="text-right py-2 px-2 whitespace-nowrap">{nf0(res.n)}<span className="text-[10px] text-zinc-500 ml-0.5">股</span></td>
                        <td className="text-right py-2 px-2 whitespace-nowrap">{nf0(res.total)}</td>
                        <td className="text-right py-2 pl-2 whitespace-nowrap">
                          {nf2(res.nA)}
                          <div className={`text-[11px] ${pnlCls(res.nA / res.A0 - 1)}`}>{pct1(res.nA / res.A0 - 1)}</div>
                        </td>
                      </>
                    ) : (
                      <td colSpan={3} className="text-left font-sans text-zinc-500 py-2 px-2">{res.kind === 'skip' ? '不需攤平' : '待設定'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-700 font-semibold text-zinc-100">
                  <th scope="row" className="text-left py-2 pr-2">合計需準備</th>
                  <td></td>
                  <td className="text-right font-mono py-2 px-2">{nf0(summary.total)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        手續費整股最低 20 元、零股最低 1 元，無條件捨去；賣出證交稅股票 0.3%、ETF 0.1%。損益平衡價已含賣出時的手續費與證交稅（與玉山庫存的損益平衡價一致）。
        試算僅供參考，實際金額以券商成交為準。
      </p>
    </div>
  );
}
