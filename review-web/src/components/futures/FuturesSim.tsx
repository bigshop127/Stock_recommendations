/**
 * 壓力測試分頁的「模擬建倉」：還沒下單前，先看「我如果買（賣）N 口大台」會怎樣。
 *
 * 期貨沒有權利金——只付保證金：原始保證金夠才開得了倉、權益數掉到維持保證金以下被追繳、
 * 風險指標低於 25% 被強制平倉。這裡把同一套帳戶算式（見 lib/futuresSim.ts）對不同口數各跑一次。
 *
 * 版面（opt55）：兩條滑軌（口數、價格漲跌幅）直接給結果卡，不再一次列一堆數字；
 * 結果分兩種口徑並排——「只算新加入的 N 口」與「新 N 口＋現有真實部位」。
 * 想看全部口數／全部情境的人，展開底下的完整對照表（同樣可切口徑）。純試算，不存雲端、不動真實部位。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, ChevronDown, Info } from 'lucide-react';
import { Panel, Chip, Row, FontScaleSlider, ScaledBox, type Tone } from './ui';
import { useFontScale } from '../../lib/useFontScale';
import { api } from '../../lib/api';
import type { FuturesMarginInfo } from '../../lib/api';
import {
  SYMBOL_PRESETS, findPreset, listedMonths, marginPerLot,
  type AccountSummary, type FuturesPosition, type FuturesSpec, type ProductConfig, type ProductPriceSpec, type Side,
} from '../../lib/futures';
import { lotsToShow, maxAffordableLots, simGrid, simulateLots, type SimCell, type SimInput, type SimRow } from '../../lib/futuresSim';
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
const METRIC_IDS: Metric[] = ['pnl', 'equity', 'risk'];
/** 口徑：只算新加入的口數 / 新口數＋現有真實部位 */
type Scope = 'new' | 'all';
const MOVE_MIN = -50;
const MOVE_MAX = 50;

const INPUT_CLS =
  'w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-primary';
const LABEL_CLS = 'block text-[11px] text-zinc-500 mb-1';

// ───────────────────────── 記住上次的選擇 ─────────────────────────

interface Persisted {
  code: string; side: Side; lots: number; preset: string; metric: Metric;
  /** 價格漲跌幅（−0.1＝跌 10%） */
  move: number;
  /** 完整對照表是否展開、表格口徑 */
  tableOpen: boolean; scope: Scope;
  /** 假想部位的到期月份 'YYYYMM'；空字串＝最近月（不加收） */
  month: string;
}
const STORAGE_KEY = 'review-futures-sim-v1';
const DEFAULTS: Persisted = { code: 'TX', side: 'long', lots: 1, preset: 'swing', metric: 'pnl', move: -0.1, tableOpen: false, scope: 'new', month: '' };
function loadPersisted(): Persisted {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Persisted> | null;
    if (!d || typeof d !== 'object') return DEFAULTS;
    return {
      code: typeof d.code === 'string' && d.code ? d.code : DEFAULTS.code,
      side: d.side === 'short' ? 'short' : 'long',
      lots: typeof d.lots === 'number' && d.lots >= 1 ? Math.floor(d.lots) : 1,
      preset: MOVE_PRESETS.some((p) => p.id === d.preset) ? (d.preset as string) : DEFAULTS.preset,
      metric: METRIC_IDS.includes(d.metric as Metric) ? (d.metric as Metric) : 'pnl',
      move: typeof d.move === 'number' && Number.isFinite(d.move) && d.move > -1 ? d.move : DEFAULTS.move,
      tableOpen: d.tableOpen === true,
      scope: d.scope === 'all' ? 'all' : 'new',
      month: typeof d.month === 'string' && /^\d{6}$/.test(d.month) ? d.month : '',
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
  const [fontScale, setFontScale] = useFontScale('sim');

  // 兩種口徑：只算新加入的口數（帳戶只有這一筆）／新口數＋現有真實部位
  // 假想部位的到期月份：只列目前掛牌的 6 檔；存的月份已過期就回到最近月
  const monthList = useMemo(() => listedMonths(), []);
  const simMonth = monthList.includes(st.month) ? st.month : monthList[0] ?? '';
  const inpNew: SimInput | null = useMemo(() => {
    if (!baseSpec || !(entry > 0) || !Number.isFinite(cashVal) || !(initVal > 0) || !(maintVal > 0)) return null;
    return {
      spec: { ...baseSpec, initial_margin: initVal, maintenance_margin: maintVal },
      side: st.side, entry, cash: cashVal, beta, month: simMonth,
    };
  }, [baseSpec, entry, cashVal, initVal, maintVal, st.side, beta, simMonth]);
  const monthMargin = baseSpec ? marginPerLot({ ...baseSpec, initial_margin: initVal, maintenance_margin: maintVal }, simMonth) : null;
  const inpAll: SimInput | null = useMemo(
    () => (inpNew && hasReal ? { ...inpNew, base: { positions, products: productsMap } } : null),
    [inpNew, hasReal, positions, productsMap],
  );
  // 資金夠不夠開，要看有沒有被現有部位佔掉保證金，所以有真實部位就用「新＋舊」那個口徑
  const inpMain = inpAll ?? inpNew;
  const inp = inpNew;

  const maxAfford = useMemo(() => (inpMain ? maxAffordableLots(inpMain) : 0), [inpMain]);
  const sliderMax = Math.max(10, Math.min(100, maxAfford + 3));
  const lots = Math.min(Math.max(1, st.lots), sliderMax);
  const move = st.move;

  // 結果卡：選定口數 ×（進場當下／漲跌後）
  const cardNew = useMemo(() => (inpNew ? {
    row: simulateLots(inpNew, lots), cell: simGrid(inpNew, [lots], [move])[0]?.[0] ?? null,
  } : null), [inpNew, lots, move]);
  const cardAll = useMemo(() => (inpAll ? {
    row: simulateLots(inpAll, lots), cell: simGrid(inpAll, [lots], [move])[0]?.[0] ?? null,
  } : null), [inpAll, lots, move]);

  // 完整對照表（展開才算）
  const tableAll = st.scope === 'all' && inpAll !== null;
  const tableInp = tableAll ? inpAll : inpNew;
  const lotsList = useMemo(() => lotsToShow(lots, maxAfford), [lots, maxAfford]);
  const rows = useMemo(
    () => (st.tableOpen && tableInp ? lotsList.map((n) => simulateLots(tableInp, n)) : []),
    [st.tableOpen, tableInp, lotsList],
  );
  const target = parseNum(targetText);
  const customMove = inp && target > 0 && Math.abs(target / inp.entry - 1) > 1e-9 ? target / inp.entry - 1 : null;
  const presetMoves = (MOVE_PRESETS.find((p) => p.id === st.preset) ?? MOVE_PRESETS[1]).moves;
  const moves = useMemo(() => (customMove === null ? presetMoves : [customMove, ...presetMoves]), [customMove, presetMoves]);
  const grid = useMemo(
    () => (st.tableOpen && tableInp ? simGrid(tableInp, lotsList, moves) : []),
    [st.tableOpen, tableInp, lotsList, moves],
  );

  const unitLabel = preset?.unit_label === '元/點' ? '點' : '元';
  const productLabel = options.find((o) => o.code === code)?.label ?? code;
  const marginNote = apiMargin ? `期交所 ${marginsInfo?.date ?? ''} 公告` : cfgProduct ? '帳戶設定' : '內建預設（可能不是最新）';

  const setCode = (c: string) => {
    patchSt({ code: c });
    setEntryText(null); setInitText(null); setMaintText(null); setTargetText('');
  };
  // 打「我預測會到」的價格就直接帶到漲跌幅滑軌；拖滑軌就清掉預測價（兩邊才不會互相矛盾）
  const onTargetChange = (text: string) => {
    setTargetText(text);
    const t = parseNum(text);
    if (inp && t > 0) patchSt({ move: Math.max(-0.99, t / inp.entry - 1) });
  };
  const onMoveSlide = (pct: number) => { setTargetText(''); patchSt({ move: pct / 100 }); };
  const movePrice = Math.max(0, entry * (1 + move));

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
            <label htmlFor="sim-month" className={LABEL_CLS}>到期月份</label>
            <select id="sim-month" value={simMonth} onChange={(e) => patchSt({ month: e.target.value })} className={INPUT_CLS.replace('font-mono', '')}>
              {monthList.map((m, i) => {
                const mm = baseSpec ? marginPerLot(baseSpec, m) : null;
                return <option key={m} value={m}>{m}{i === 0 ? '（近月）' : ''}{mm?.far ? `・遠月 +${Math.round(mm.surcharge * 100)}%` : ''}</option>;
              })}
            </select>
            <p className="text-[10px] text-zinc-600 mt-1 truncate">
              {monthMargin?.far ? `遠月每口原始 ${money(monthMargin.initial)}` : '近三檔不加收'}
            </p>
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
            <label htmlFor="sim-init" className={LABEL_CLS}>近月原始保證金（元/口）</label>
            <input id="sim-init" type="text" inputMode="numeric" autoComplete="off"
              value={initText ?? String(defInit || '')} onChange={(e) => setInitText(e.target.value)} className={INPUT_CLS} />
          </div>
          <div>
            <label htmlFor="sim-maint" className={LABEL_CLS}>近月維持保證金（元/口）</label>
            <input id="sim-maint" type="text" inputMode="numeric" autoComplete="off"
              value={maintText ?? String(defMaint || '')} onChange={(e) => setMaintText(e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="col-span-2">
            <label htmlFor="sim-target" className={LABEL_CLS}>我預測會到（{unitLabel}，選填）</label>
            <input id="sim-target" type="text" inputMode="decimal" autoComplete="off" value={targetText}
              placeholder={Number.isFinite(entry) && entry > 0 ? `例如 ${priceText(entry * 1.05)}` : ''}
              onChange={(e) => onTargetChange(e.target.value)} className={INPUT_CLS} />
          </div>
        </div>
        <p className="text-[11px] text-zinc-500 -mt-2">
          {productLabel}：一口 {baseSpec ? baseSpec.contract_size.toLocaleString() : '—'} {preset?.unit_label ?? '股/口'}，
          保證金來源＝{marginNote}。
        </p>

        {!inp ? (
          <div className="p-3 rounded-lg text-xs border bg-amber-500/10 border-amber-500/30 text-amber-300">
            {quoteLoading ? '正在抓行情…' : '填好進場價、保證金專戶現金和保證金後就會開始試算。'}
          </div>
        ) : (
          <>
            {/* ── 兩條滑軌：口數、價格漲跌幅 ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
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

              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                  <span className="text-zinc-400">價格漲跌幅</span>
                  <span className="font-mono font-bold text-sm text-sky-300" data-testid="sim-move-headline">
                    {movePct(move)} → {priceText(movePrice)} {unitLabel}
                  </span>
                </div>
                <input
                  id="sim-move" type="range" min={MOVE_MIN} max={MOVE_MAX} step={1}
                  value={Math.min(MOVE_MAX, Math.max(MOVE_MIN, Math.round(move * 100)))}
                  onChange={(e) => onMoveSlide(parseInt(e.target.value, 10))}
                  aria-label="價格漲跌幅"
                  aria-valuetext={`${movePct(move)}，價格 ${priceText(movePrice)}`}
                  className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-sky-400"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 font-mono px-0.5">
                  <span>{MOVE_MIN}%</span><span>-25%</span><span>0</span><span>+25%</span><span>+{MOVE_MAX}%</span>
                </div>
              </div>
            </div>

            {/* ── 結果（字體可調）── */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/50">
              <h3 className="text-xs font-semibold text-zinc-200 pt-2">
                {lots} 口、價格{movePct(move)}（{priceText(movePrice)}）的結果
              </h3>
              <div className="pt-2"><FontScaleSlider value={fontScale} onChange={setFontScale} /></div>
            </div>

            <ScaledBox scale={fontScale}>
              <div className={`grid grid-cols-1 ${cardAll ? 'lg:grid-cols-2' : ''} gap-4`} data-testid="sim-cards">
                {cardNew && (
                  <ResultCard
                    testId="sim-card-new"
                    title={`只算新加入的 ${lots} 口`}
                    note="假設帳戶只有這一筆（現金同上）"
                    tone="sky"
                    row={cardNew.row} cell={cardNew.cell}
                    pnlLabel={`這 ${lots} 口的損益`} pnl={cardNew.cell?.pnl ?? 0}
                    marginLabel="這筆原始保證金" margin={cardNew.row?.sim_initial ?? 0}
                    extra={[
                      { label: '每動 1% 損益', value: money((cardNew.row?.notional ?? 0) * 0.01), sub: `每 1 ${unitLabel} ＝ ${money((baseSpec?.contract_size ?? 0) * lots)}` },
                      { label: '來回手續費＋期交稅', value: money(cardNew.row?.costs ?? 0), sub: '已含在損益裡' },
                    ]}
                  />
                )}
                {cardAll && (
                  <ResultCard
                    testId="sim-card-all"
                    title={`新 ${lots} 口 ＋ 現有部位一起算`}
                    note="現有真實部位照各自的 beta 跟著大盤動"
                    tone="primary"
                    row={cardAll.row} cell={cardAll.cell}
                    pnlLabel="帳戶合計損益" pnl={cardAll.cell?.account_pnl ?? 0}
                    pnlSub={cardAll.cell ? (
                      <>
                        新 {lots} 口 <span className={pnlCls(cardAll.cell.pnl)}>{signed(cardAll.cell.pnl)}</span>
                        <span className="mx-2">＋</span>現有部位 <span className={pnlCls(cardAll.cell.account_pnl - cardAll.cell.pnl)}>{signed(cardAll.cell.account_pnl - cardAll.cell.pnl)}</span>
                      </>
                    ) : null}
                    marginLabel="合計原始保證金" margin={cardAll.row?.initial ?? 0}
                    extra={[
                      { label: '其中新加入的佔用', value: money(cardAll.row?.sim_initial ?? 0), sub: `${lots} 口` },
                    ]}
                  />
                )}
              </div>
            </ScaledBox>

            {/* ── 完整對照表（預設收起）── */}
            <div className="border border-border rounded-xl">
              <button type="button" aria-expanded={st.tableOpen} onClick={() => patchSt({ tableOpen: !st.tableOpen })}
                className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-semibold text-zinc-300 hover:text-zinc-100 transition"
                data-testid="sim-table-toggle">
                <span>完整對照表：不同口數比較 ＋ 口數 × 漲跌幅矩陣</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${st.tableOpen ? 'rotate-180' : ''}`} />
              </button>
              {st.tableOpen && (
                <div className="px-4 pb-4 space-y-5 border-t border-border/60 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {hasReal ? (
                      <div role="group" aria-label="表格口徑" className="inline-flex rounded-lg border border-border overflow-hidden text-[11px] font-semibold">
                        {([['new', '只算新加入口數'], ['all', '新口數＋現有部位']] as const).map(([k, label]) => (
                          <button key={k} type="button" aria-pressed={st.scope === k} onClick={() => patchSt({ scope: k })}
                            className={`px-2.5 py-1 transition ${st.scope === k ? 'bg-primary/20 text-primary' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : <span className="text-[11px] text-zinc-500">目前沒有真實部位，只算新加入口數</span>}
                    <div className="ml-auto"><FontScaleSlider value={fontScale} onChange={setFontScale} /></div>
                  </div>
                  <ScaledBox scale={fontScale}>
                    <LotsTable rows={rows} lotsList={lotsList} lots={lots} all={tableAll}
                      onPick={(n) => patchSt({ lots: Math.min(n, sliderMax) })} />
                  </ScaledBox>
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
                        {METRIC_IDS.map((m) => (
                          <button key={m} type="button" aria-pressed={st.metric === m} onClick={() => patchSt({ metric: m })}
                            className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${st.metric === m ? 'border-primary text-primary bg-primary/10' : 'border-border text-zinc-400 hover:text-zinc-100 hover:border-zinc-500'}`}>
                            {metricLabel(m, tableAll)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ScaledBox scale={fontScale}>
                      <GridTable grid={grid} rows={rows} lotsList={lotsList} lots={lots} moves={moves} entry={inp.entry}
                        customMove={customMove} metric={st.metric} all={tableAll} />
                    </ScaledBox>
                  </div>
                </div>
              )}
            </div>

            <p className="text-[11px] text-zinc-500 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                期貨沒有權利金，只付保證金：原始保證金夠才開得了倉；權益數（現金＋未實現損益）低於維持保證金會被追繳，風險指標（權益 ÷ 原始保證金）低於 25% 會被強制平倉。
                損益都含來回手續費與期交稅。<strong className="text-zinc-400">「只算新加入」</strong>＝帳戶裡只有你假想的這一筆；
                <strong className="text-zinc-400">「新＋現有」</strong>{hasReal ? '＝連你現有的真實部位一起算（真實部位照各自的 beta 跟著大盤動）' : '要有真實部位才會出現'}。
                這是靜態試算：實際大跌時期交所通常會調高保證金、停損也可能滑價，斷頭會比表上更早發生。
              </span>
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

// ───────────────────────── 子元件 ─────────────────────────

const metricLabel = (m: Metric, all: boolean) => (m === 'pnl' ? (all ? '合計損益' : '這筆損益') : m === 'equity' ? '帳戶權益' : '風險指標');

const TONE_BOX: Partial<Record<Tone, string>> = {
  sky: 'border-sky-500/30 bg-sky-500/[0.04]',
  primary: 'border-primary/30 bg-primary/[0.04]',
};

/** 一種口徑的結果卡：漲跌後的損益／權益／風險指標，加上進場當下的保證金與追繳斷頭價 */
function ResultCard({ testId, title, note, tone, row, cell, pnlLabel, pnl, pnlSub, marginLabel, margin, extra }: {
  testId: string; title: string; note: string; tone: Tone;
  row: SimRow | null; cell: SimCell | null;
  pnlLabel: string; pnl: number; pnlSub?: React.ReactNode;
  marginLabel: string; margin: number;
  extra: { label: string; value: string; sub?: string }[];
}) {
  const afterStatus = cell ? STATUS[cell.status] : STATUS.flat;
  const nowStatus = row ? STATUS[row.status] : STATUS.flat;
  return (
    <div data-testid={testId} className={`rounded-xl border p-4 space-y-3 ${TONE_BOX[tone] ?? ''}`}>
      <div>
        <h4 className="text-sm font-bold text-zinc-100">{title}</h4>
        <p className="text-[11px] text-zinc-500">{note}</p>
      </div>

      <div>
        <div className="text-[11px] text-zinc-500">{pnlLabel}</div>
        <div className={`text-2xl font-bold font-mono tabular-nums leading-tight ${pnlCls(pnl)}`} data-testid={`${testId}-pnl`}>{signed(pnl)}</div>
        {pnlSub && <div className="text-[11px] text-zinc-500 mt-0.5 font-mono">{pnlSub}</div>}
      </div>

      <dl className="space-y-1.5 text-xs">
        <Row label="漲跌後帳戶權益" value={cell ? money(cell.equity) : '—'} cls={cell && cell.equity < 0 ? 'text-rose-500' : 'text-zinc-100'} />
        <div className="flex items-center justify-between gap-3">
          <dt className="text-zinc-500">漲跌後風險指標</dt>
          <dd className="flex items-center gap-1.5 font-mono tabular-nums text-zinc-100">
            {cell && cell.risk !== null ? pctText(cell.risk, 0) : '—'}
            <Chip tone={afterStatus.tone}>{afterStatus.label}</Chip>
          </dd>
        </div>
      </dl>

      <div className="pt-2 border-t border-border/50">
        <div className="text-[10px] text-zinc-600 mb-1.5">進場當下</div>
        <dl className="space-y-1.5 text-xs">
          <Row label={marginLabel} value={money(margin)} />
          <Row label="超額保證金（還能動用）" value={row ? money(row.excess) : '—'} cls={row && row.excess < 0 ? 'text-amber-400' : 'text-zinc-300'} />
          <div className="flex items-center justify-between gap-3">
            <dt className="text-zinc-500">風險指標</dt>
            <dd className="flex items-center gap-1.5 font-mono tabular-nums text-zinc-300">
              {row && row.risk !== null ? pctText(row.risk, 0) : '—'}
              {row && !row.affordable ? <Chip tone="amber">資金不足</Chip> : <Chip tone={nowStatus.tone}>{nowStatus.label}</Chip>}
            </dd>
          </div>
          <Row label="追繳價（黃牌）"
            value={row?.call_price != null ? priceText(row.call_price) : row && (row.status === 'call' || row.status === 'danger') ? '進場就追繳' : '—'}
            sub={row?.call_move != null ? movePct(row.call_move) : undefined} cls="text-orange-400" />
          <Row label="斷頭價（紅牌）"
            value={row?.liq_price != null ? priceText(row.liq_price) : row && row.status === 'danger' ? '進場就斷頭' : '—'}
            sub={row?.liq_move != null ? movePct(row.liq_move) : undefined} cls="text-rose-400" />
          {extra.map((e) => <Row key={e.label} label={e.label} value={e.value} sub={e.sub} />)}
        </dl>
      </div>
    </div>
  );
}

function LotsTable({ rows, lotsList, lots, all, onPick }: {
  rows: (SimRow | null)[]; lotsList: number[]; lots: number; all: boolean; onPick: (n: number) => void;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-200 mb-2">不同口數比較（進場當下）</h3>
      <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[720px] text-xs" data-testid="sim-lots-table">
          <thead>
            <tr className="text-zinc-500 border-b border-border">
              <th className="text-left font-semibold py-2 pr-3">口數</th>
              <th className="text-right font-semibold py-2 pr-3">{all ? '合計原始保證金' : '原始保證金'}</th>
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
                <tr key={r.lots} onClick={() => onPick(r.lots)}
                  className={`border-b border-border/40 last:border-0 cursor-pointer transition-colors hover:bg-zinc-800/40 ${sel ? 'bg-primary/10' : ''} ${!r.affordable ? 'opacity-70' : ''}`}
                  data-lots={lotsList[i]}>
                  <td className={`py-2 pr-3 font-mono font-bold tabular-nums ${sel ? 'text-primary' : 'text-zinc-200'}`}>{r.lots} 口</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-200">{money(all ? r.initial : r.sim_initial)}</td>
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
  );
}

function GridTable({ grid, rows, lotsList, lots, moves, entry, customMove, metric, all }: {
  grid: SimCell[][]; rows: (SimRow | null)[]; lotsList: number[]; lots: number; moves: number[]; entry: number;
  customMove: number | null; metric: Metric; all: boolean;
}) {
  return (
    <>
      <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[640px] text-xs" data-testid="sim-grid">
          <thead>
            <tr className="text-zinc-500 border-b border-border">
              <th className="text-left font-semibold py-2 pr-3 align-bottom">口數</th>
              {moves.map((m, j) => (
                <th key={m} className={`text-right font-semibold py-2 px-2 ${customMove !== null && j === 0 ? 'text-primary' : ''}`}>
                  <div className="font-mono">{customMove !== null && j === 0 ? '預測 ' : ''}{movePct(m)}</div>
                  <div className="font-mono font-normal text-[10px] text-zinc-600">{priceText(Math.max(0, entry * (1 + m)))}</div>
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
                    const pnl = all ? c.account_pnl : c.pnl;
                    const text = metric === 'pnl' ? signed(pnl) : metric === 'equity' ? money(c.equity) : (c.risk !== null ? pctText(c.risk, 0) : '—');
                    const cls = metric === 'pnl' ? pnlCls(pnl) : metric === 'equity' ? (c.equity < 0 ? 'text-rose-500' : 'text-zinc-200') : (danger ? 'text-rose-400' : call ? 'text-orange-400' : 'text-zinc-200');
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
    </>
  );
}
