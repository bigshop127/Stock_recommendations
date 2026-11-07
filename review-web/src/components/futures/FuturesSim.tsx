/**
 * 壓力測試分頁的「模擬建倉」：還沒下單前，先看「我如果買（賣）N 口大台」會怎樣。
 *
 * 期貨沒有權利金——只付保證金：原始保證金夠才開得了倉、權益數掉到維持保證金以下被追繳、
 * 風險指標低於 25% 被強制平倉。這裡把同一套帳戶算式（見 lib/futuresSim.ts）對不同口數各跑一次，
 * 再給一張「口數 × 漲跌幅」的損益矩陣當預測。純試算，不存雲端、不動真實部位。
 */
import { useEffect, useMemo, useState } from 'react';
import { Calculator, Info } from 'lucide-react';
import { Panel, StatTile, Chip, type Tone } from './ui';
import { api } from '../../lib/api';
import type { FuturesMarginInfo } from '../../lib/api';
import {
  SYMBOL_PRESETS, findPreset,
  type AccountSummary, type FuturesPosition, type FuturesSpec, type ProductConfig, type ProductPriceSpec, type Side,
} from '../../lib/futures';
import { lotsToShow, maxAffordableLots, simGrid, simulateLots, type SimInput } from '../../lib/futuresSim';
import { parseNum } from '../../lib/averageDown';

// ───────────────────────── 小工具 ─────────────────────────

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('zh-TW')}`;
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('zh-TW')}`;
const pctText = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const movePct = (m: number) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.abs(m * 100).toFixed(Math.abs(m * 100) % 1 === 0 ? 0 : 1)}%`;
// 台股慣例：賺紅、賠綠
const pnlCls = (v: number) => (v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-zinc-300');
const priceText = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('zh-TW') : v.toFixed(2));

const STATUS: Record<AccountSummary['status'], { tone: Tone; label: string }> = {
  flat: { tone: 'zinc', label: '—' },
  ok: { tone: 'emerald', label: '安全' },
  warn: { tone: 'amber', label: '低於原始保證金' },
  call: { tone: 'orange', label: '追繳' },
  danger: { tone: 'rose', label: '斷頭' },
};

const MOVE_PRESETS: { id: string; label: string; moves: number[] }[] = [
  { id: 'daily', label: '日常 ±1~3%', moves: [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03] },
  { id: 'swing', label: '波段 ±5~10%', moves: [-0.1, -0.07, -0.05, 0.05, 0.07, 0.1] },
  { id: 'crash', label: '崩盤／軋空 ±15~30%', moves: [-0.3, -0.2, -0.15, 0.15, 0.2, 0.3] },
];
type Metric = 'pnl' | 'equity' | 'risk';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'pnl', label: '這筆損益' },
  { id: 'equity', label: '帳戶權益' },
  { id: 'risk', label: '風險指標' },
];

const INPUT_CLS =
  'w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-primary';
const LABEL_CLS = 'block text-[11px] text-zinc-500 mb-1';

// ───────────────────────── 記住上次的選擇 ─────────────────────────

interface Persisted { code: string; side: Side; lots: number; stack: boolean; preset: string; metric: Metric }
const STORAGE_KEY = 'review-futures-sim-v1';
const DEFAULTS: Persisted = { code: 'TX', side: 'long', lots: 1, stack: true, preset: 'swing', metric: 'pnl' };
function loadPersisted(): Persisted {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Persisted> | null;
    if (!d || typeof d !== 'object') return DEFAULTS;
    return {
      code: typeof d.code === 'string' && d.code ? d.code : DEFAULTS.code,
      side: d.side === 'short' ? 'short' : 'long',
      lots: typeof d.lots === 'number' && d.lots >= 1 ? Math.floor(d.lots) : 1,
      stack: d.stack !== false,
      preset: MOVE_PRESETS.some((p) => p.id === d.preset) ? (d.preset as string) : DEFAULTS.preset,
      metric: METRICS.some((m) => m.id === d.metric) ? (d.metric as Metric) : 'pnl',
    };
  } catch {
    return DEFAULTS;
  }
}

// ───────────────────────── 元件 ─────────────────────────

interface QuoteInfo { code: string; price: number | null; label: string }
interface MarginsInfo { margins: Record<string, FuturesMarginInfo>; date: string }

export function SimPanel({ positions, products, productsMap, cash }: {
  positions: FuturesPosition[];
  products: Record<string, ProductConfig>;
  productsMap: Record<string, ProductPriceSpec>;
  cash: number;
}) {
  const [st, setSt] = useState<Persisted>(loadPersisted);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch { /* 私密視窗：不記住也能用 */ }
  }, [st]);
  const patchSt = (p: Partial<Persisted>) => setSt((s) => ({ ...s, ...p }));

  // null ＝ 跟著預設值走；使用者動過才有字串
  const [entryText, setEntryText] = useState<string | null>(null);
  const [cashText, setCashText] = useState<string | null>(null);
  const [initText, setInitText] = useState<string | null>(null);
  const [maintText, setMaintText] = useState<string | null>(null);
  const [targetText, setTargetText] = useState('');

  const [quote, setQuote] = useState<QuoteInfo | null>(null);
  const [marginsInfo, setMarginsInfo] = useState<MarginsInfo | null>(null);

  // 商品選單：內建 5 個預設 ＋ 帳戶裡自建的商品
  const options = useMemo(() => {
    const list: { code: string; label: string }[] = SYMBOL_PRESETS.map((p) => ({ code: p.code, label: `${p.name}（${p.code}）` }));
    for (const [code, p] of Object.entries(products)) {
      if (p.archived || list.some((o) => o.code === code)) continue;
      list.push({ code, label: p.name || code });
    }
    return list;
  }, [products]);
  const code = options.some((o) => o.code === st.code) ? st.code : options[0].code;
  const preset = findPreset(code);
  const cfgProduct = products[code];

  // 行情：換商品就重抓（結果帶著 code，對不上就視為載入中）
  useEffect(() => {
    let alive = true;
    api.getFuturesQuote(cfgProduct?.quote_contract || code)
      .then((resp) => {
        if (!alive) return;
        const main = resp.months.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
        const price = main ? (main.live ?? main.settlement ?? main.last ?? null) : null;
        const how = main?.live != null ? '即時' : main?.settlement != null ? '結算價' : '最後成交';
        setQuote({ code, price: price && price > 0 ? price : null, label: main ? `${main.month} 主力月・${how}` : '' });
      })
      .catch(() => { if (alive) setQuote({ code, price: null, label: '' }); });
    return () => { alive = false; };
  }, [code, cfgProduct?.quote_contract]);

  // 最新保證金（指數類 TX／MTX／TMF）：只抓一次
  useEffect(() => {
    let alive = true;
    api.getFuturesMargins()
      .then((r) => { if (alive) setMarginsInfo({ margins: r.margins ?? {}, date: r.date }); })
      .catch(() => { /* 抓不到就用內建預設值 */ });
    return () => { alive = false; };
  }, []);

  const quoteHere = quote && quote.code === code ? quote : null;
  const quoteLoading = !quoteHere;

  // 規格：帳戶自己維護的商品優先；沒有就用內建預設，指數類再套期交所最新公告的保證金
  const baseSpec: FuturesSpec | null = cfgProduct?.spec ?? preset?.spec ?? null;
  const apiMargin = !cfgProduct ? marginsInfo?.margins[code] : undefined;
  const defInit = apiMargin?.initial ?? baseSpec?.initial_margin ?? 0;
  const defMaint = apiMargin?.maintenance ?? baseSpec?.maintenance_margin ?? 0;

  const defEntry = quoteHere?.price ?? (cfgProduct && cfgProduct.price > 0 ? cfgProduct.price : NaN);
  const entry = entryText === null ? defEntry : parseNum(entryText);
  const cashVal = cashText === null ? cash : parseNum(cashText);
  const initVal = initText === null ? defInit : parseNum(initText);
  const maintVal = maintText === null ? defMaint : parseNum(maintText);
  const beta = cfgProduct ? (cfgProduct.index_linked ? 1 : cfgProduct.beta) : 1;
  const hasReal = positions.some((p) => p.lots > 0);
  const stackOn = hasReal && st.stack;

  const inp: SimInput | null = useMemo(() => {
    if (!baseSpec || !(entry > 0) || !Number.isFinite(cashVal) || !(initVal > 0) || !(maintVal > 0)) return null;
    return {
      spec: { ...baseSpec, initial_margin: initVal, maintenance_margin: maintVal },
      side: st.side, entry, cash: cashVal, beta,
      base: stackOn ? { positions, products: productsMap } : undefined,
    };
  }, [baseSpec, entry, cashVal, initVal, maintVal, st.side, beta, stackOn, positions, productsMap]);

  const maxAfford = useMemo(() => (inp ? maxAffordableLots(inp) : 0), [inp]);
  const sliderMax = Math.max(10, Math.min(100, maxAfford + 3));
  const lots = Math.min(Math.max(1, st.lots), sliderMax);

  const lotsList = useMemo(() => lotsToShow(lots, maxAfford), [lots, maxAfford]);
  const rows = useMemo(() => (inp ? lotsList.map((n) => simulateLots(inp, n)) : []), [inp, lotsList]);
  const cur = inp ? simulateLots(inp, lots) : null;

  // 預測矩陣
  const target = parseNum(targetText);
  const customMove = inp && target > 0 && Math.abs(target / inp.entry - 1) > 1e-9 ? target / inp.entry - 1 : null;
  const presetMoves = (MOVE_PRESETS.find((p) => p.id === st.preset) ?? MOVE_PRESETS[1]).moves;
  const moves = useMemo(() => (customMove === null ? presetMoves : [customMove, ...presetMoves]), [customMove, presetMoves]);
  const grid = useMemo(() => (inp ? simGrid(inp, lotsList, moves) : []), [inp, lotsList, moves]);

  const unitLabel = preset?.unit_label === '元/點' ? '點' : '元';
  const productLabel = options.find((o) => o.code === code)?.label ?? code;
  const marginNote = apiMargin ? `期交所 ${marginsInfo?.date ?? ''} 公告` : cfgProduct ? '帳戶設定' : '內建預設（可能不是最新）';

  const setCode = (c: string) => {
    patchSt({ code: c });
    setEntryText(null); setInitText(null); setMaintText(null); setTargetText('');
  };

  return (
    <Panel
      title="模擬建倉：我如果買（賣）N 口"
      icon={<Calculator className="w-4 h-4" />}
      tone="sky"
      desc="還沒下單前先試算：不同口數要多少保證金、帳戶撐不撐得住、價格漲跌多少會賺賠多少。純試算，不存雲端、不動真實部位。"
    >
      <div className="space-y-5" data-testid="futures-sim">
        {/* ── 輸入 ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="col-span-2">
            <label htmlFor="sim-product" className={LABEL_CLS}>商品</label>
            <select id="sim-product" value={code} onChange={(e) => setCode(e.target.value)} className={INPUT_CLS.replace('font-mono', '')}>
              {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <span className={LABEL_CLS}>方向</span>
            <div role="group" aria-label="方向" className="grid grid-cols-2 border border-border rounded-lg overflow-hidden text-xs font-semibold h-[38px]">
              {(['long', 'short'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={st.side === s} onClick={() => patchSt({ side: s })}
                  className={`transition ${st.side === s ? (s === 'long' ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear') : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}>
                  {s === 'long' ? '買進（多）' : '賣出（空）'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="sim-entry" className={LABEL_CLS}>進場價（{unitLabel}）</label>
            <input id="sim-entry" type="text" inputMode="decimal" autoComplete="off"
              value={entryText ?? (Number.isFinite(defEntry) ? String(defEntry) : '')}
              placeholder={quoteLoading ? '抓行情中…' : '輸入進場價'}
              onChange={(e) => setEntryText(e.target.value)} className={INPUT_CLS} />
            <p className="text-[10px] text-zinc-600 mt-1 truncate">
              {entryText !== null
                ? <button type="button" className="text-primary hover:underline" onClick={() => setEntryText(null)}>改回行情價</button>
                : quoteHere?.price ? `行情 ${quoteHere.label}` : quoteLoading ? '' : '抓不到行情，請手動輸入'}
            </p>
          </div>
          <div>
            <label htmlFor="sim-cash" className={LABEL_CLS}>保證金專戶現金（元）</label>
            <input id="sim-cash" type="text" inputMode="numeric" autoComplete="off"
              value={cashText ?? (cash ? String(Math.round(cash)) : '')}
              placeholder="你要放進去的資金"
              onChange={(e) => setCashText(e.target.value)} className={INPUT_CLS} />
            <p className="text-[10px] text-zinc-600 mt-1 truncate">
              {cashText !== null
                ? <button type="button" className="text-primary hover:underline" onClick={() => setCashText(null)}>改回帳戶現金</button>
                : cash ? '帳戶目前現金' : '帳戶現金是 0，請輸入'}
            </p>
          </div>
          <div>
            <label htmlFor="sim-init" className={LABEL_CLS}>原始保證金（元/口）</label>
            <input id="sim-init" type="text" inputMode="numeric" autoComplete="off"
              value={initText ?? String(defInit || '')} onChange={(e) => setInitText(e.target.value)} className={INPUT_CLS} />
          </div>
          <div>
            <label htmlFor="sim-maint" className={LABEL_CLS}>維持保證金（元/口）</label>
            <input id="sim-maint" type="text" inputMode="numeric" autoComplete="off"
              value={maintText ?? String(defMaint || '')} onChange={(e) => setMaintText(e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="col-span-2">
            <label htmlFor="sim-target" className={LABEL_CLS}>我預測會到（{unitLabel}，選填）</label>
            <input id="sim-target" type="text" inputMode="decimal" autoComplete="off" value={targetText}
              placeholder={Number.isFinite(entry) && entry > 0 ? `例如 ${priceText(entry * 1.05)}` : ''}
              onChange={(e) => setTargetText(e.target.value)} className={INPUT_CLS} />
          </div>
        </div>
        <p className="text-[11px] text-zinc-500 -mt-2">
          {productLabel}：一口 {baseSpec ? baseSpec.contract_size.toLocaleString() : '—'} {preset?.unit_label ?? '股/口'}，
          保證金來源＝{marginNote}。
          {hasReal && (
            <label className="ml-3 inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={st.stack} onChange={(e) => patchSt({ stack: e.target.checked })} className="accent-primary" />
              疊加我目前的真實部位一起算
            </label>
          )}
        </p>

        {!inp ? (
          <div className="p-3 rounded-lg text-xs border bg-amber-500/10 border-amber-500/30 text-amber-300">
            {quoteLoading ? '正在抓行情…' : '填好進場價、保證金專戶現金和保證金後就會開始試算。'}
          </div>
        ) : (
          <>
            {/* ── 口數滑軌 ── */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                <span className="text-zinc-400">
                  口數
                  <span className="font-mono font-semibold text-primary text-sm ml-2">{lots} 口</span>
                </span>
                <span className="font-mono text-zinc-300">
                  需準備原始保證金 <span className="font-semibold text-primary text-sm">{money(lots * initVal)}</span>
                </span>
              </div>
              <input
                id="sim-lots" type="range" min={1} max={sliderMax} step={1} value={lots}
                onChange={(e) => patchSt({ lots: parseInt(e.target.value, 10) })}
                aria-label="口數"
                aria-valuetext={`${lots} 口，原始保證金 ${Math.round(lots * initVal)} 元`}
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-[10px] text-zinc-500 font-mono px-0.5">
                <span>1 口</span>
                <span>{maxAfford > 0 ? `資金最多開 ${maxAfford} 口` : '資金連 1 口都不夠'}</span>
                <span>{sliderMax} 口</span>
              </div>
            </div>

            {/* ── 選定口數的重點 ── */}
            {cur && (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <StatTile label="進場後風險指標"
                  value={cur.risk !== null ? pctText(cur.risk, 0) : '—'}
                  tone={STATUS[cur.status].tone}
                  sub={<><Chip tone={STATUS[cur.status].tone}>{STATUS[cur.status].label}</Chip><span className="ml-1.5">權益 {money(cur.equity)}</span></>}
                  hint="風險指標＝權益數 ÷ 所需原始保證金。低於 25% 會被強制平倉；權益低於維持保證金會被追繳。" />
                <StatTile label="超額保證金（還能動用）"
                  value={money(cur.excess)}
                  tone={cur.excess >= 0 ? 'emerald' : 'amber'}
                  valueCls={cur.excess >= 0 ? 'text-zinc-100' : 'text-amber-400'}
                  sub={cur.excess >= 0 ? `名目 ${money(cur.notional)}，槓桿 ${cur.leverage ? cur.leverage.toFixed(1) : '—'} 倍` : '資金不夠開這個口數'} />
                <StatTile label="追繳價（黃牌）"
                  value={cur.call_price !== null ? priceText(cur.call_price) : cur.status === 'call' || cur.status === 'danger' ? '進場就追繳' : '—'}
                  tone="orange" valueCls="text-orange-400"
                  sub={cur.call_move !== null ? `離進場價 ${movePct(cur.call_move)}（維持保證金 ${money(cur.maintenance)}）` : undefined} />
                <StatTile label="斷頭價（紅牌）"
                  value={cur.liq_price !== null ? priceText(cur.liq_price) : cur.status === 'danger' ? '進場就斷頭' : '—'}
                  tone="rose" valueCls="text-rose-400"
                  sub={cur.liq_move !== null ? `離進場價 ${movePct(cur.liq_move)}（風險指標 25%）` : undefined} />
                <StatTile label={`每動 1% 損益（${lots} 口）`}
                  value={money(cur.notional * 0.01)}
                  tone="sky"
                  sub={`每動 1 ${unitLabel} ＝ ${money((baseSpec?.contract_size ?? 0) * lots)}`} />
                <StatTile label="來回手續費＋期交稅"
                  value={money(cur.costs)}
                  tone="zinc"
                  sub="已含在下面所有損益與權益裡" />
              </div>
            )}

            {/* ── 口數比較 ── */}
            <div>
              <h3 className="text-xs font-semibold text-zinc-200 mb-2">不同口數比較（進場當下）</h3>
              <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full min-w-[720px] text-xs" data-testid="sim-lots-table">
                  <thead>
                    <tr className="text-zinc-500 border-b border-border">
                      <th className="text-left font-semibold py-2 pr-3">口數</th>
                      <th className="text-right font-semibold py-2 pr-3">原始保證金</th>
                      <th className="text-right font-semibold py-2 pr-3">名目價值</th>
                      <th className="text-right font-semibold py-2 pr-3">超額保證金</th>
                      <th className="text-right font-semibold py-2 pr-3">風險指標</th>
                      <th className="text-right font-semibold py-2 pr-3">追繳價</th>
                      <th className="text-right font-semibold py-2 pr-3">斷頭價</th>
                      <th className="text-left font-semibold py-2">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      if (!r) return null;
                      const sel = r.lots === lots;
                      const s = STATUS[r.status];
                      return (
                        <tr key={r.lots} onClick={() => patchSt({ lots: Math.min(r.lots, sliderMax) })}
                          className={`border-b border-border/40 last:border-0 cursor-pointer transition-colors hover:bg-zinc-800/40 ${sel ? 'bg-primary/10' : ''} ${!r.affordable ? 'opacity-70' : ''}`}
                          data-lots={lotsList[i]}>
                          <td className={`py-2 pr-3 font-mono font-bold tabular-nums ${sel ? 'text-primary' : 'text-zinc-200'}`}>{r.lots} 口</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-200">{money(r.sim_initial)}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-400">{money(r.notional)}</td>
                          <td className={`py-2 pr-3 text-right font-mono tabular-nums ${r.excess >= 0 ? 'text-zinc-300' : 'text-amber-400'}`}>{money(r.excess)}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-300">{r.risk !== null ? pctText(r.risk, 0) : '—'}</td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-orange-400">
                            {r.call_price !== null ? <>{priceText(r.call_price)}<span className="text-zinc-600 ml-1">{movePct(r.call_move ?? 0)}</span></> : r.status === 'call' || r.status === 'danger' ? <span className="text-zinc-600">已觸發</span> : '—'}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono tabular-nums text-rose-400">
                            {r.liq_price !== null ? <>{priceText(r.liq_price)}<span className="text-zinc-600 ml-1">{movePct(r.liq_move ?? 0)}</span></> : r.status === 'danger' ? <span className="text-zinc-600">已觸發</span> : '—'}
                          </td>
                          <td className="py-2">
                            {r.affordable ? <Chip tone={s.tone}>{s.label}</Chip> : <Chip tone="amber">資金不足</Chip>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── 預測矩陣 ── */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <h3 className="text-xs font-semibold text-zinc-200">價格漲跌預測：口數 × 漲跌幅</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {MOVE_PRESETS.map((p) => (
                    <button key={p.id} type="button" aria-pressed={st.preset === p.id} onClick={() => patchSt({ preset: p.id })}
                      className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${st.preset === p.id ? 'border-primary text-primary bg-primary/10' : 'border-border text-zinc-400 hover:text-zinc-100 hover:border-zinc-500'}`}>
                      {p.label}
                    </button>
                  ))}
                  <span className="w-px h-4 bg-border mx-1" aria-hidden />
                  {METRICS.map((m) => (
                    <button key={m.id} type="button" aria-pressed={st.metric === m.id} onClick={() => patchSt({ metric: m.id })}
                      className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${st.metric === m.id ? 'border-primary text-primary bg-primary/10' : 'border-border text-zinc-400 hover:text-zinc-100 hover:border-zinc-500'}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full min-w-[640px] text-xs" data-testid="sim-grid">
                  <thead>
                    <tr className="text-zinc-500 border-b border-border">
                      <th className="text-left font-semibold py-2 pr-3 align-bottom">口數</th>
                      {moves.map((m, j) => (
                        <th key={m} className={`text-right font-semibold py-2 px-2 ${customMove !== null && j === 0 ? 'text-primary' : ''}`}>
                          <div className="font-mono">{customMove !== null && j === 0 ? '預測 ' : ''}{movePct(m)}</div>
                          <div className="font-mono font-normal text-[10px] text-zinc-600">{priceText(Math.max(0, inp.entry * (1 + m)))}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lotsList.map((n, i) => {
                      const sel = n === lots;
                      return (
                        <tr key={n} className={`border-b border-border/40 last:border-0 ${sel ? 'bg-primary/10' : ''} ${rows[i] && !rows[i]!.affordable ? 'opacity-60' : ''}`}>
                          <td className={`py-2 pr-3 font-mono font-bold tabular-nums ${sel ? 'text-primary' : 'text-zinc-200'}`}>{n} 口</td>
                          {(grid[i] ?? []).map((c) => {
                            const danger = c.status === 'danger';
                            const call = c.status === 'call';
                            const text = st.metric === 'pnl' ? signed(c.pnl) : st.metric === 'equity' ? money(c.equity) : (c.risk !== null ? pctText(c.risk, 0) : '—');
                            const cls = st.metric === 'pnl' ? pnlCls(c.pnl) : st.metric === 'equity' ? (c.equity < 0 ? 'text-rose-500' : 'text-zinc-200') : (danger ? 'text-rose-400' : call ? 'text-orange-400' : 'text-zinc-200');
                            return (
                              <td key={c.move} data-status={c.status}
                                className={`py-2 px-2 text-right font-mono tabular-nums ${danger ? 'bg-rose-500/15' : call ? 'bg-orange-500/10' : ''}`}>
                                <div className={cls}>{text}</div>
                                {(danger || call) && <div className={`text-[9px] ${danger ? 'text-rose-400' : 'text-orange-400'}`}>{danger ? '斷頭' : '追繳'}</div>}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-zinc-500 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                期貨沒有權利金，只付保證金：原始保證金夠才開得了倉；權益數（現金＋未實現損益）低於維持保證金會被追繳，風險指標（權益 ÷ 原始保證金）低於 25% 會被強制平倉。
                損益都含來回手續費與期交稅。矩陣的「這筆損益」只看你假想的這一筆，「帳戶權益／風險指標」{stackOn ? '連你現有的真實部位一起算（真實部位照各自的 beta 跟著大盤動）' : '只算這一筆'}。
                這是靜態試算：實際大跌時期交所通常會調高保證金、停損也可能滑價，斷頭會比表上更早發生。
              </span>
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
