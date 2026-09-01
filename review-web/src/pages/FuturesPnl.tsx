import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, CalendarClock, Cloud, CloudOff, Loader2,
  Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Gauge,
  ClipboardCopy, Check, Target, Layers,
  ShieldCheck, Wallet, ListOrdered, CalendarSync, SlidersHorizontal, BookOpen,
  LineChart, Flame, Ruler, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight,
  ChevronDown, ChevronUp, Eraser, History, Compass, Filter,
} from 'lucide-react';
import { Panel, StatTile, RiskMeter, ThreatCard, LevelCard, Row, Chip, type Tone } from '../components/futures/ui';
import { ScreenshotImport } from '../components/futures/ScreenshotImport';
import type { AccountImportState, ProductLookup } from '../lib/futuresImport';
import { api } from '../lib/api';
import type { FuturesMonthQuote, FuturesEquityHistoryResp, FuturesMarginsResp, FuturesStockMarginsResp, FuturesStockContractsResp, TaiexResp } from '../lib/api';
import {
  CONTRACT_CODE, CONTRACT_NAME, UNDERLYING_CODE,
  SYMBOL_PRESETS, findPreset,
  tickValue, lastTradingDay, tradingDaysBetween,
  positionPnl, closedPnl, closedBreakdown, closeLots,
  summarizeAccount, summarizeAccountAll, rolloverAlerts, rolloverCost, stopLossRisk,
  indexAtPrice, stressTest, suggestLots, weightedEntry, targetPlan, trailingStopPlan,
  buildRiskReport, priceOf, referenceMonthOf,
  equityStats, summarizeCashFlows, flowDelta, holdingAsBatch,
  leverageLadder, entryPlan, rollCostEstimate, CALIBRATED_PLAN,
  type FuturesPosition, type ClosedTrade, type CashFlow, type FuturesSpec, type StressRow,
  type PriceInput, type EquityPoint, type ProductConfig, type ProductPriceSpec,
} from '../lib/futures';
import {
  getFuturesConfig, saveFuturesConfig, subscribeFutures,
  DEFAULT_PLANNER, type FuturesConfig, type PlannerConfig,
} from '../lib/futuresStore';

type FuturesTab = 'overview' | 'positions' | 'stress' | 'planner' | 'rollover' | 'settings' | 'logic';

/** 期交所行情的取得狀態。價格出現在哪一頁，這包東西就要跟到哪，否則數字會沒有出處。 */
type QuoteState = {
  status: 'idle' | 'loading' | 'done' | 'error';
  msg: string | null;                 // 每日行情檔的日期 'YYYY-MM-DD'
  months: FuturesMonthQuote[];
  live_source?: string | null;
  live_as_of?: string | null;
  intraday?: boolean;
  live_error?: string | null;
};
const FUTURES_TABS: { id: FuturesTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: '損益總覽', icon: Gauge },
  { id: 'positions', label: '部位 & 平倉紀錄', icon: ListOrdered },
  { id: 'stress', label: '壓力測試', icon: Flame },
  { id: 'planner', label: '建倉 & 出場試算', icon: Target },
  { id: 'rollover', label: '到期 & 轉倉', icon: CalendarSync },
  { id: 'settings', label: '契約規格 & 設定', icon: SlidersHorizontal },
  { id: 'logic', label: '整體邏輯', icon: BookOpen },
];
const DEFAULT_TAB: FuturesTab = 'overview';

// 台股慣例：賺錢紅、賠錢綠
const pnlCls = (v: number) => (v >= 0 ? 'text-bull' : 'text-bear');
const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const px = (v: number) => v.toFixed(2);
const todayStr = () => new Date().toLocaleDateString('sv-SE'); // 'YYYY-MM-DD'（本地時區）
const monthLabel = (m: string) => (/^\d{6}$/.test(m) ? `${m.slice(0, 4)}/${m.slice(4)}` : m || '—');
// 已實現損益篩選用：跟契約「月份」（YYYYMM，見 monthLabel）不同軸，這裡是平倉日曆月 'YYYY-MM'
const exitMonthOf = (dateStr: string) => (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr.slice(0, 7) : '');
const inExitDateRange = (dateStr: string, start: string, end: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
};

// 風險指標的顏色門檻（與 summarizeAccount 的 status 對齊）
const STATUS_META: Record<string, { cls: string; ring: string; tone: Tone; label: string; desc: string }> = {
  flat: { cls: 'text-zinc-400', ring: 'stroke-zinc-600', tone: 'zinc', label: '無部位', desc: '目前沒有未平倉部位' },
  ok: { cls: 'text-emerald-400', ring: 'stroke-emerald-500', tone: 'emerald', label: '安全', desc: '權益數高於所需原始保證金' },
  warn: { cls: 'text-amber-400', ring: 'stroke-amber-500', tone: 'amber', label: '低於原始保證金', desc: '還不會被追繳，但已無法再開新倉' },
  call: { cls: 'text-orange-400', ring: 'stroke-orange-500', tone: 'orange', label: '追繳區', desc: '權益數低於維持保證金，期貨商會發追繳通知' },
  danger: { cls: 'text-rose-500', ring: 'stroke-rose-500', tone: 'rose', label: '斷頭風險', desc: '風險指標低於 25%，盤中會被強制平倉' },
};

export function FuturesPnl() {
  const [config, setConfig] = useState<FuturesConfig>(() => getFuturesConfig());
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as FuturesTab | null;
  const activeTab: FuturesTab = useMemo(
    () => (rawTab && FUTURES_TABS.some((t) => t.id === rawTab) ? rawTab : DEFAULT_TAB),
    [rawTab],
  );
  const handleTabChange = (id: FuturesTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const [cloud, setCloud] = useState<{ status: 'idle' | 'loading' | 'saved' | 'error'; msg: string | null }>({
    status: 'idle', msg: null,
  });
  const [quote, setQuote] = useState<QuoteState>({ status: 'idle', msg: null, months: [] });
  const [taiex, setTaiex] = useState<{
    status: 'idle' | 'loading' | 'done' | 'error';
    data: TaiexResp | null;
    msg: string | null;
  }>({ status: 'idle', data: null, msg: null });
  // 台股休市日曆：最後交易日遇假日要順延，沒有它算出來的日期只是「規則上的第三個星期三」
  const [holidays, setHolidays] = useState<Set<string> | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.getMarketHolidays()
      .then((r) => { if (!cancelled) setHolidays(new Set(r.dates)); })
      .catch(() => { /* 抓不到就退回純第三個星期三，UI 會標示未經假日校正 */ });
    return () => { cancelled = true; };
  }, []);

  const [historyState, setHistoryState] = useState<{
    loading: boolean;
    error: string | null;
    data: FuturesEquityHistoryResp | null;
  }>({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setHistoryState({ loading: true, error: null, data: null });
    api.getFuturesEquityHistory()
      .then((res) => {
        if (!cancelled) setHistoryState({ loading: false, error: null, data: res });
      })
      .catch((err) => {
        if (!cancelled) setHistoryState({ loading: false, error: err instanceof Error ? err.message : '載入歷史資料失敗', data: null });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => subscribeFutures(() => setConfig(getFuturesConfig())), []);

  // 掛載：雲端為事實來源，載入後順手抓一次期交所行情
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    let cancelled = false;
    setCloud({ status: 'loading', msg: null });
    api.getFuturesPositions()
      .then((resp) => {
        if (cancelled) return;
        if (resp.exists && resp.futures) {
          saveFuturesConfig(resp.futures as unknown as FuturesConfig);
          setCloud({ status: 'saved', msg: '已從雲端載入' });
        } else {
          setCloud({ status: 'idle', msg: '雲端尚無資料，將以本機為準' });
        }
      })
      .catch((e) => {
        if (!cancelled) setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端載入失敗' });
      })
      .finally(() => {
        if (cancelled) return;
        void fetchQuote(false);
        void fetchTaiex();
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (updater: (c: FuturesConfig) => FuturesConfig) => {
    // 一律以 store 當下的值為基礎再改，避免多個非同步動作各拿舊 config 互相覆蓋
    const next = updater(getFuturesConfig());
    saveFuturesConfig(next);
    setConfig(getFuturesConfig());
    return next;
  };

  const saveToCloud = async (cfg?: FuturesConfig) => {
    const payload = cfg ?? getFuturesConfig();
    setCloud({ status: 'loading', msg: null });
    try {
      const resp = await api.saveFuturesPositions(payload);
      setCloud({ status: 'saved', msg: `已同步雲端 ${new Date(resp.saved_at).toLocaleTimeString('zh-TW', { hour12: false })}` });
    } catch (e) {
      setCloud({ status: 'error', msg: e instanceof Error ? e.message : '雲端同步失敗（已存本機）' });
    }
  };

  /**
   * 「真實同步」——把這頁能自動化的部分一次做完：抓期交所最新行情 → 更新現價 →
   * 存回雲端 → 從雲端回讀確認（另一台裝置改過的內容也會一起吃進來）。
   *
   * ⚠️ 與再平衡頁那顆「真實同步」不一樣，這裡**不會登入券商抓部位**：玉山的交易 API
   * 只涵蓋證券帳戶（庫存/餘額/交割都是股票的），期貨是獨立的期貨商帳戶，SDK 沒有
   * 任何期貨帳務方法，官方文件的期貨章節也只有行情不含帳務。因此**口數、進場價、
   * 保證金專戶餘額仍需手動維護**——按鈕旁的說明有寫清楚，別讓人以為按了就對帳完成。
   */
  const realSync = async () => {
    // 兩件事都先不存，最後一次寫回雲端——否則抓價存一次、抓指數再存一次，
    // 中間那次的 index_ref 還是舊的，另一台裝置剛好回讀就會拿到半套。
    await fetchQuote(false);
    await fetchTaiex();
    await saveToCloud();
    try {
      const resp = await api.getFuturesPositions();
      if (resp.exists && resp.futures) {
        saveFuturesConfig(resp.futures as unknown as FuturesConfig);
        setConfig(getFuturesConfig());
      }
    } catch {
      /* 回讀失敗不影響前面已完成的抓價與存檔，狀態列已顯示 */
    }
  };

  /**
   * 抓最新加權指數填進 `index_ref`。**盤中是即時的**：gateway 走 TWSE MIS
   * （看盤網頁自己在用的端點，約每 5 秒更新），收盤後 MIS 的成交價會變成 '-'，
   * 那時退回昨收並把 `intraday` 標成 false，狀態列會照實說是收盤價。
   *
   * 只動 `index_ref`（大盤點數換算的基準），不動任何期貨價格——標的價格一律
   * 以期交所行情為準，用 beta 反推指數只會多一層誤差。
   */
  const fetchTaiex = async () => {
    setTaiex((t) => ({ ...t, status: 'loading' }));
    try {
      const r = await api.getTaiex();
      setTaiex({ status: 'done', data: r, msg: null });
      if (r.index > 0) {
        patch((c) => ({
          ...c,
          products: { ...c.products, [c.active_product]: { ...c.products[c.active_product], index_ref: r.index } },
        }));
      }
    } catch (e) {
      setTaiex({ status: 'error', data: null, msg: e instanceof Error ? e.message : '抓取失敗' });
    }
  };

  /**
   * 抓期交所每日行情。**每個月份的價格都存下來**（`prices`）——不同到期月份是不同
   * 合約、不同價格，同時持有兩個月份時全部套同一個數字會讓損益與追繳價一起偏掉。
   * 另外挑一個「參考月份」填進 `price`，作為沒有行情的月份的退路與各處的顯示基準。
   */
  const fetchQuote = async (persist = true) => {
    setQuote((q) => ({ ...q, status: 'loading', msg: null }));
    try {
      const cur0 = getFuturesConfig();
      const code0 = cur0.active_product;
      const activeP0 = cur0.products[code0];
      const resp = await api.getFuturesQuote(activeP0.quote_contract || activeP0.code || CONTRACT_CODE);
      setQuote({
        status: 'done',
        msg: resp.date,
        months: resp.months,
        live_source: resp.live_source,
        live_as_of: resp.live_as_of,
        intraday: resp.intraday,
        live_error: resp.live_error,
      });

      // 優先使用即時價，沒有才退回結算價、最後成交價
      const prices: Record<string, number> = {};
      for (const m of resp.months) {
        const p = m.live ?? m.settlement ?? m.last ?? 0;
        if (p > 0) prices[m.month] = p;
      }
      if (Object.keys(prices).length === 0) return;

      const cur = getFuturesConfig();
      // 參考月份：有部位就用口數最多的持倉月份，沒有就用成交量最大的（＝主力月）
      const refMonth = referenceMonthOf(cur.positions.filter((p) => p.product === code0));
      const target = resp.months.find((m) => m.month === refMonth)
        ?? resp.months.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
      const price = target ? (prices[target.month] ?? 0) : 0;

      const next = patch((c) => {
        const p = c.products[code0];
        if (!p) return c;
        const nextP = {
          ...p,
          prices: { ...p.prices, ...prices },
          ...(price > 0 ? { price, price_month: target!.month } : {}),
          // live_source 只代表「MIS 這次請求有通」，不代表參考月份真的拿到即時價
          // （休市日、或只持有沒成交的遠月，MIS 會回 200 但每個月份都是空的）。
          // 這兩格描述的是「存下來的 price 是哪來的」，所以只能看參考月份自己。
          ...(target && target.live !== null && target.live !== undefined
            ? { price_as_of: target.live_time ?? resp.live_as_of ?? resp.date, price_source: 'live' as const }
            : { price_as_of: resp.date, price_source: 'daily' as const }),
        };
        return { ...c, products: { ...c.products, [code0]: nextP } };
      });
      if (persist) void saveToCloud(next);
    } catch (e) {
      setQuote((q) => ({ ...q, status: 'error', msg: e instanceof Error ? e.message : '抓取失敗' }));
    }
  };

  // 帳戶可能同時持有多個商品（例如 SRF ETF 期貨＋個股期貨）。`activeCode` 是「目前
  // 在部位新增表單／建倉試算頁預設操作哪個商品」的 UI 狀態；總覽/壓力測試/轉倉這些
  // 帳戶層級的分頁一律看全部商品加總（productsMap／specsMap），不受它影響。
  const products = config.products;
  const activeCode = config.products[config.active_product] ? config.active_product : Object.keys(products)[0];
  const activeProduct = products[activeCode];
  const spec = activeProduct.spec;
  const preset = useMemo(() => findPreset(activeCode), [activeCode]);
  const symbolName = activeProduct.name || (preset ? `${preset.name}（${preset.code}）` : `${CONTRACT_NAME}（${activeCode}）`);

  // 各月份分別報價；某月份沒抓到行情時退回使用者手填的參考價（都是目前選到商品自己的）
  const priceInput = useMemo<PriceInput>(
    () => ({ byMonth: activeProduct.prices, fallback: activeProduct.price }),
    [activeProduct.prices, activeProduct.price],
  );
  // 目前選到商品的部位／已平倉紀錄——建倉試算等「單商品」工具只看這個子集
  const activePositions = useMemo(
    () => config.positions.filter((p) => p.product === activeCode),
    [config.positions, activeCode],
  );

  const productsMap = useMemo<Record<string, ProductPriceSpec>>(() => {
    const m: Record<string, ProductPriceSpec> = {};
    for (const [code, p] of Object.entries(products)) {
      m[code] = { spec: p.spec, price: { byMonth: p.prices, fallback: p.price }, beta: p.index_linked ? 1 : p.beta, index_ref: p.index_ref };
    }
    return m;
  }, [products]);
  const specsMap = useMemo<Record<string, FuturesSpec>>(() => {
    const m: Record<string, FuturesSpec> = {};
    for (const [code, p] of Object.entries(products)) m[code] = p.spec;
    return m;
  }, [products]);

  const summary = useMemo(
    () => summarizeAccountAll(config.positions, productsMap, config.cash, config.closed),
    [config.positions, productsMap, config.cash, config.closed],
  );
  const alerts = useMemo(
    () => rolloverAlerts(config.positions, specsMap, todayStr(), holidays),
    [config.positions, specsMap, holidays],
  );
  const dueAlerts = alerts.filter((a) => a.due || a.expired);
  const statusMeta = STATUS_META[summary.status] ?? STATUS_META.flat;

  // 台指期本身就是大盤，beta 恆為 1；ETF/個股期貨才需要換算係數
  const beta = activeProduct.index_linked ? 1 : activeProduct.beta;
  const activePlanner = config.planner[activeCode] ?? DEFAULT_PLANNER;
  const stress = useMemo(
    () => stressTest(config.positions, productsMap, config.cash, {
      drops: activePlanner.stress_drops, stopLoss: config.stop_loss,
    }),
    [config.positions, productsMap, config.cash, activePlanner.stress_drops, config.stop_loss],
  );
  const plan = useMemo(
    () => targetPlan(activePositions, spec, config.cash, priceInput, activePlanner.gain_pct, activePlanner.reserve_multiple),
    [activePositions, spec, config.cash, priceInput, activePlanner.gain_pct, activePlanner.reserve_multiple],
  );
  const report = useMemo(
    () => buildRiskReport({
      symbol_name: symbolName, spec, summary, price: summary.reference_price, cash: config.cash,
      index: activeProduct.index_ref, beta, stress,
      plan: summary.total_lots > 0 ? plan : null,
      alerts,
      flows: config.cash_flows,
    }),
    [symbolName, spec, summary, config.cash, activeProduct.index_ref, beta, stress, plan, alerts, config.cash_flows],
  );

  return (
    <div className="space-y-6">
      {/*
        標題列。改版重點：狀態（安全／追繳）與操作（同步／存雲端）以前都是
        11px 的純文字連結，跟旁邊的說明字混在一起看不出可按；現在標題本身有
        重量，操作是真的按鈕，契約規格改用 chip 排開，一眼掃得完。
      */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-zinc-900 via-card to-zinc-900/60 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-9 h-9 rounded-xl bg-primary/15 border border-primary/30 grid place-items-center shrink-0">
                <Activity className="w-5 h-5 text-primary" />
              </span>
              <h1 className="text-2xl sm:text-3xl font-extrabold bg-gradient-to-r from-sky-300 via-cyan-200 to-emerald-300 bg-clip-text text-transparent">
                期貨風控與損益總覽
              </h1>
              <Chip tone={statusMeta.tone} title={statusMeta.desc}>
                <ShieldCheck className="w-3 h-3" />
                {statusMeta.label}
              </Chip>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              保證金水位、追繳／斷頭價位、暴跌壓力測試與建倉試算
            </p>
            {/*
              契約規格 chips：手機上這四顆會疊成三行，把資料整個推到螢幕外，
              而它們是「查一次就記得」的參考值（設定頁也有）——所以小螢幕只留商品名。
            */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Chip tone="primary">{symbolName}</Chip>
              <Chip tone="zinc" className="hidden sm:inline-flex">
                一口 {spec.contract_size.toLocaleString()} {preset?.unit_label ?? '股/口'}
                {(preset?.underlying || activeProduct.underlying) ? `（${preset?.underlying || activeProduct.underlying}）` : ''}
              </Chip>
              <Chip tone="zinc" className="hidden sm:inline-flex">跳一檔 {spec.tick_size} ＝ {money(tickValue(spec))}</Chip>
              <Chip tone="zinc" className="hidden sm:inline-flex">原始 / 維持保證金 {money(spec.initial_margin)} / {money(spec.maintenance_margin)}</Chip>
            </div>
          </div>
          {/* 手機排成等寬三格（原本會換行成 2+1，看起來像壞掉） */}
          <div className="grid grid-cols-3 gap-2 w-full sm:w-auto sm:flex sm:flex-wrap sm:items-center">
            <button
              onClick={() => void realSync()}
              disabled={quote.status === 'loading' || cloud.status === 'loading'}
              className="flex items-center justify-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg text-[11px] sm:text-xs font-semibold bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
              title="抓期交所最新行情更新各月份現價、抓 TWSE 最新加權指數（盤中即時），並與雲端對存回讀。注意：券商沒有期貨帳戶 API，口數/進場價/保證金專戶餘額仍需手動維護。"
            >
              {quote.status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              真實同步
            </button>
            <button
              onClick={() => void saveToCloud()}
              disabled={cloud.status === 'loading'}
              className="flex items-center justify-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg text-[11px] sm:text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
              title="只把目前設定存回雲端，不抓行情"
            >
              {cloud.status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
              存到雲端
            </button>
            <CopyReportButton text={report} />
          </div>
        </div>
      </div>

      {(cloud.msg || quote.msg || taiex.status !== 'idle') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] -mt-4">
          {cloud.msg && (
            <span className={`flex items-center gap-1 ${cloud.status === 'error' ? 'text-amber-400' : 'text-emerald-400'}`}>
              {cloud.status === 'error' ? <CloudOff className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />}
              {cloud.msg}
            </span>
          )}
          {quote.status === 'done' && (() => {
            // 這行只能印「期交所給的數字」。activeProduct.price 是下面那格後備價，使用者手打得進去，
            // 印它等於把使用者自己輸入的值標成期交所報價。
            const refMonthQuote = quote.months.find((m) => m.month === activeProduct.price_month);
            const shown = refMonthQuote ? (refMonthQuote.live ?? refMonthQuote.settlement ?? refMonthQuote.last) : null;
            const monthSuffix = activeProduct.price_month ? `（${monthLabel(activeProduct.price_month)} 月份）` : '';
            const px = shown === null || shown === undefined
              ? null
              : <strong className="text-zinc-300 font-mono">{shown.toFixed(2)}</strong>;

            // MIS 有嘗試但失敗 → live_error 有值；不支援的商品是 live_source / live_error 都 null。
            if (quote.live_error) {
              return (
                <span className="text-amber-400 font-semibold" title={quote.live_error}>
                  期交所報價 {px}（{quote.msg} 結算價，即時報價暫時失效）{monthSuffix}
                </span>
              );
            }
            if (refMonthQuote && refMonthQuote.live !== null) {
              const sessionName = refMonthQuote.live_session === 'night' ? '夜盤' : '日盤';
              return (
                <span className="text-zinc-500">
                  期交所報價 {px}
                  （{quote.intraday
                    ? `${sessionName}即時 ${refMonthQuote.live_time?.slice(11, 19) ?? ''}`
                    : `${refMonthQuote.live_time?.slice(0, 10) ?? quote.msg} ${sessionName}收盤`}）{monthSuffix}
                </span>
              );
            }
            return (
              <span className="text-zinc-500">
                期交所報價 {px}（{quote.msg} 結算價）{monthSuffix}
              </span>
            );
          })()}
          {quote.status === 'error' && <span className="text-amber-400 font-semibold">行情抓取失敗：{quote.msg}</span>}
          {/* 加權指數：即時與收盤要分得出來，否則盤中看到一個不動的數字會以為當掉了 */}
          {taiex.status === 'done' && taiex.data && (
            <span className={taiex.data.stale ? 'text-amber-400' : 'text-zinc-500'}>
              加權指數{' '}
              <strong className="text-zinc-300 font-mono tabular-nums">
                {Math.round(taiex.data.index).toLocaleString()}
              </strong>
              {taiex.data.change_pct !== null && (
                <span className={`ml-1 font-mono ${taiex.data.change_pct >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {taiex.data.change_pct >= 0 ? '+' : ''}{(taiex.data.change_pct * 100).toFixed(2)}%
                </span>
              )}
              {taiex.data.stale
                ? `（快取，${taiex.data.date}，來源暫時失效）`
                : taiex.data.intraday
                  ? `（盤中即時 ${taiex.data.time}）`
                  : `（${taiex.data.date} 收盤）`}
            </span>
          )}
          {taiex.status === 'error' && <span className="text-amber-400">加權指數抓取失敗：{taiex.msg}</span>}
        </div>
      )}

      {/*
        「真實同步」的涵蓋範圍。收成可展開：它是「看一次就記得」的參考說明，
        但在手機上攤開會佔掉六行、把實際數字推出第一屏。摘要那行仍然把最會被
        誤會的一點（不會抓券商餘額）直接寫在外面，不必展開也看得到。
      */}
      <details className="-mt-3 group">
        <summary className="text-[11px] text-zinc-500 flex items-start gap-1.5 cursor-pointer list-none marker:content-none hover:text-zinc-400">
          <RefreshCw className="w-3 h-3 mt-0.5 shrink-0 text-zinc-600" />
          <span>
            「真實同步」<strong className="text-zinc-400">不會抓券商的期貨帳戶餘額</strong>
            （券商沒有期貨帳戶 API）
            <span className="text-zinc-600 group-open:hidden">．展開看它實際做了什麼</span>
          </span>
        </summary>
        <p className="text-[11px] text-zinc-500 mt-1.5 pl-[18px]">
          <strong className="text-zinc-400">同步內容＝期交所各月份行情 ＋ TWSE 加權指數（盤中即時）＋ 與雲端對存回讀</strong>。
          口數／進場價／<strong className="text-zinc-400">保證金專戶餘額仍需手動維護</strong>——
          玉山交易 API 只涵蓋證券帳戶（庫存／餘額／交割都是股票的），期貨是獨立的期貨商帳戶，
          該 SDK 沒有任何期貨帳務方法，官方文件的期貨章節也只有行情不含帳務。詳見「整體邏輯」分頁。
        </p>
      </details>

      {/* 轉倉提醒橫幅：任何分頁都看得到，因為忘了轉倉的代價比看錯損益大 */}
      {dueAlerts.length > 0 && (
        <div className={`rounded-xl border p-4 ${
          dueAlerts.some((a) => a.expired || a.level === 'urgent')
            ? 'bg-rose-500/10 border-rose-500/40'
            : 'bg-amber-500/10 border-amber-500/40'
        }`}>
          <div className="flex items-start gap-3">
            <CalendarClock className={`w-5 h-5 shrink-0 mt-0.5 ${dueAlerts.some((a) => a.expired) ? 'text-rose-400' : 'text-amber-400'}`} />
            <div className="space-y-1">
              <div className="text-sm font-bold text-zinc-100 tracking-wide">轉倉提醒</div>
              {dueAlerts.map((a) => (
                <div key={a.month} className="text-xs text-zinc-300">
                  {a.expired ? (
                    <>
                      <strong className="text-rose-400">{monthLabel(a.month)} 已過最後交易日</strong>
                      （{a.last_trading_day}，{Math.abs(a.days_left ?? 0)} 天前）——
                      {a.lots} 口應該已被現金結算，請確認後把部位移到平倉紀錄。
                    </>
                  ) : (
                    <>
                      <strong className={a.level === 'urgent' ? 'text-rose-400' : 'text-amber-400'}>
                        {monthLabel(a.month)} 還剩 {a.trading_days_left ?? a.days_left} 個交易日到期
                      </strong>
                      （最後交易日 {a.last_trading_day}
                      {a.holiday_adjusted && <span className="text-zinc-400">，已因休市順延</span>}）——
                      持有 {a.lots} 口，要續抱就到「到期 &amp; 轉倉」按一鍵轉倉。
                    </>
                  )}
                </div>
              ))}
              <div className="text-[11px] text-zinc-500 pt-1">
                提醒門檻：到期前 {spec.rollover_days} 個交易日（可在「契約規格 &amp; 設定」分頁調整）
                {!holidays && <span className="text-amber-400">．目前抓不到休市日曆，日期未經假日校正</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/*
        分頁導覽。八個分頁在手機上橫向捲動很容易讓人以為只有前兩個，
        所以小螢幕改用下拉選單（一眼看得到全部），sm 以上才用原本的 tab 列。
      */}
      <div>
        <div className="sm:hidden">
          <select
            value={activeTab}
            onChange={(e) => handleTabChange(e.target.value as FuturesTab)}
            aria-label="切換分頁"
            className="w-full bg-primary text-white text-sm font-semibold rounded-xl px-3 py-2.5 border-0"
          >
            {FUTURES_TABS.map((t, i) => (
              <option key={t.id} value={t.id} className="bg-zinc-900 text-zinc-100 font-normal">
                {i + 1}. {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 overflow-x-auto p-1.5 rounded-xl border border-border bg-zinc-900/50 scrollbar-none">
          {FUTURES_TABS.map((t) => {
            const Icon = t.icon;
            const on = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                aria-current={on ? 'page' : undefined}
                className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition whitespace-nowrap shrink-0 ${
                  on
                    ? 'bg-primary/20 text-sky-200 border border-primary/40 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]'
                    : 'border border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${on ? 'text-primary' : 'text-zinc-500'}`} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'overview' && (
        <OverviewTab config={config} summary={summary} statusMeta={statusMeta} spec={spec} beta={beta} plan={plan} priceInput={priceInput} quote={quote} historyState={historyState} products={products} gainPct={activePlanner.gain_pct} activeCode={activeCode} />
      )}
      {activeTab === 'positions' && (
        <PositionsTab config={config} spec={spec} summary={summary} priceInput={priceInput} quote={quote} holidays={holidays} patch={patch} saveToCloud={saveToCloud} products={products} activeCode={activeCode} />
      )}
      {activeTab === 'stress' && (
        <StressTab summary={summary} stress={stress} beta={beta} patch={patch} saveToCloud={saveToCloud} products={products} activeCode={activeCode} />
      )}
      {activeTab === 'planner' && (
        <PlannerTab config={config} spec={spec} summary={summary} plan={plan} priceInput={priceInput} patch={patch} saveToCloud={saveToCloud} products={products} activeCode={activeCode} />
      )}
      {activeTab === 'rollover' && (
        <RolloverTab config={config} spec={spec} alerts={alerts} quoteMonths={quote.months} holidays={holidays} patch={patch} saveToCloud={saveToCloud} products={products} activeCode={activeCode} />
      )}
      {activeTab === 'settings' && (
        <SettingsTab config={config} preset={preset} patch={patch} saveToCloud={saveToCloud} products={products} activeCode={activeCode} />
      )}
      {activeTab === 'logic' && <LogicTab spec={spec} />}
    </div>
  );
}

/** 一鍵複製風控報告。navigator.clipboard 在非 HTTPS 下不存在，故留一條 textarea 後路。 */
const CopyReportButton: React.FC<{ text: string }> = ({ text }) => {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      /* 複製失敗就維持原樣，使用者仍可從「整體邏輯」下方的報告區手動選取 */
    }
  };
  return (
    <button
      onClick={() => void copy()}
      className="flex items-center justify-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg text-[11px] sm:text-xs font-semibold bg-zinc-800/70 border border-border text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition whitespace-nowrap"
      title="把目前的部位、保證金水位、危險價位與壓力測試結果複製成一段純文字"
    >
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
      {done ? '已複製' : '複製風控報告'}
    </button>
  );
};

// ── 損益總覽 ────────────────────────────────────────────────────────────────

type Summary = ReturnType<typeof summarizeAccount>;

/**
 * StatTile 的相容外殼。各分頁原本就用 `cls` 傳數值顏色（多半是損益的紅綠），
 * 保留這個簽名可以不用一次改二十幾個呼叫點；新寫的地方直接用 StatTile。
 */
const StatCard: React.FC<{
  label: string; value: string; sub?: React.ReactNode; cls?: string; hint?: string; tone?: Tone; icon?: React.ReactNode;
}> = ({ label, value, sub, cls, hint, tone, icon }) => (
  <StatTile label={label} value={value} sub={sub} valueCls={cls} hint={hint} tone={tone} icon={icon} />
);

/** 把價格翻成加權指數點數的小工具；沒填參考指數時回空字串（不顯示） */
const idxText = (price: number | null, cfgPrice: number, index: number, beta: number): string => {
  if (price === null) return '';
  const v = indexAtPrice(price, cfgPrice, index, beta);
  return v === null ? '' : `≈ ${Math.round(v).toLocaleString()} 點`;
};

const getStartDateForRange = (rangeType: '1m' | '3m' | '1y' | 'all', lastDateStr?: string): string | undefined => {
  if (rangeType === 'all') return undefined;
  const baseDate = lastDateStr ? new Date(lastDateStr) : new Date();
  if (isNaN(baseDate.getTime())) return undefined;

  const d = new Date(baseDate);
  if (rangeType === '1m') {
    d.setMonth(d.getMonth() - 1);
  } else if (rangeType === '3m') {
    d.setMonth(d.getMonth() - 3);
  } else if (rangeType === '1y') {
    d.setFullYear(d.getFullYear() - 1);
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const RangeSelector: React.FC<{
  active: '1m' | '3m' | '1y' | 'all';
  onChange: (v: '1m' | '3m' | '1y' | 'all') => void;
}> = ({ active, onChange }) => {
  const options: { id: '1m' | '3m' | '1y' | 'all'; label: string }[] = [
    { id: '1m', label: '近 1 個月' },
    { id: '3m', label: '近 3 個月' },
    { id: '1y', label: '近 1 年' },
    { id: 'all', label: '全部' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5 bg-zinc-900/50">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={`px-2.5 py-1 text-[10px] font-semibold rounded-md transition-colors ${
            active === opt.id
              ? 'bg-primary text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
};

/**
 * 快照列的風險指標。跟 equityStats 用同一套規則重算——只有一天資料時走的是另一條
 * 顯示路徑（還沒進 equityStats），忘了重算的話那一天會是舊公式算的數字。
 */
const riOfRow = (row: { equity: number; total_lots: number; risk_indicator: number | null }, initialMargin: number) => {
  const need = Math.max(0, initialMargin) * Math.max(0, row.total_lots);
  if (need > 0) return row.equity / need;
  return Math.max(0, initialMargin) > 0 ? null : row.risk_indicator;
};

const EquityCurveCard: React.FC<{
  historyState: {
    loading: boolean;
    error: string | null;
    data: FuturesEquityHistoryResp | null;
  };
  flows: CashFlow[];
  /** 目前設定的每口原始保證金：歷史列的風險指標用它重算，整條曲線才是同一個口徑 */
  initialMargin: number;
}> = ({ historyState, flows, initialMargin }) => {
  const [rangeType, setRangeType] = useState<'1m' | '3m' | '1y' | 'all'>('all');
  const [hoveredPoint, setHoveredPoint] = useState<EquityPoint | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const { loading, error, data } = historyState;

  if (loading) {
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500 mr-2" />
        <span className="text-xs text-zinc-400">載入歷史資料中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm text-center py-8">
        <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
        <p className="text-xs text-rose-400 font-semibold">載入歷史資料失敗</p>
        <p className="text-[11px] text-zinc-500 mt-1">{error}</p>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  if (!data?.exists || rows.length === 0) {
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm text-center py-8">
        <p className="text-xs text-zinc-400 font-semibold">還沒有歷史資料。</p>
        <p className="text-[11px] text-zinc-500 mt-1">快照由 VM 每日收盤後自動寫入，明天收盤後就會出現第一筆。</p>
      </div>
    );
  }

  if (rows.length === 1) {
    const singlePoint = rows[0];
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><LineChart className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">權益數走勢</h2></div>
        </div>
        <div className="border border-border/50 rounded-lg p-4 bg-zinc-900/30">
          <p className="text-xs text-zinc-400">日期：{singlePoint.date}</p>
          <p className="text-xs text-zinc-400 mt-1">
            權益數：<span className="font-mono text-zinc-100 font-semibold">{money(singlePoint.equity)}</span>
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            風險指標：<span className="font-mono text-zinc-100 font-semibold">{riOfRow(singlePoint, initialMargin) !== null ? pct(riOfRow(singlePoint, initialMargin) as number, 0) : '—'}</span>
          </p>
          <p className="text-[11px] text-amber-500 mt-3 font-semibold">累積中，需要至少兩天</p>
        </div>
        <p className="text-[11px] text-zinc-500">
          權益數會因入出金而跳動，這條線不是報酬率曲線。快照取自期交所每日行情（收盤／結算價），盤中不更新。
        </p>
      </div>
    );
  }

  const lastDateStr = rows[rows.length - 1]?.date;
  const startDate = getStartDateForRange(rangeType, lastDateStr);
  const stats = equityStats(rows, { from: startDate }, flows, initialMargin);
  const points = stats.points;

  if (points.length === 0) {
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><LineChart className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">權益數走勢</h2></div>
          <RangeSelector active={rangeType} onChange={setRangeType} />
        </div>
        <div className="text-center py-8">
          <p className="text-xs text-zinc-500">此期間尚無資料。</p>
        </div>
      </div>
    );
  }

  if (points.length === 1) {
    const singlePoint = points[0];
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><LineChart className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">權益數走勢</h2></div>
          <RangeSelector active={rangeType} onChange={setRangeType} />
        </div>
        <div className="border border-border/50 rounded-lg p-4 bg-zinc-900/30">
          <p className="text-xs text-zinc-400">日期：{singlePoint.date}</p>
          <p className="text-xs text-zinc-400 mt-1">
            權益數：<span className="font-mono text-zinc-100 font-semibold">{money(singlePoint.equity)}</span>
          </p>
          <p className="text-[11px] text-amber-500 mt-2 font-semibold">該期間累積中，需要至少兩天</p>
        </div>
      </div>
    );
  }

  /*
    期間內有入出金時，報酬率與回撤一律換成「已扣除入出金」的版本：權益數的變化裡
    混著自己匯進匯出的錢，直接拿來當報酬率會騙人——入金 20 萬看起來像大賺、出金
    20 萬看起來像大賠（下面那條回撤線尤其明顯）。沒有入出金時兩套數字完全相同。
    上面那條權益數曲線維持原始權益數：它回答的是「帳戶裡現在有多少」。
  */
  const adjusted = stats.has_flows;
  const ddOf = (p: EquityPoint) => (adjusted ? p.twr_drawdown : p.drawdown);

  const equities = points.map((p) => p.equity);
  let minEq = Math.min(...equities);
  let maxEq = Math.max(...equities);
  if (minEq === maxEq) {
    minEq -= 10000;
    maxEq += 10000;
  } else {
    const pad = (maxEq - minEq) * 0.1;
    minEq -= pad;
    maxEq += pad;
  }

  let minDrawdown = Math.min(...points.map(ddOf));
  if (minDrawdown >= 0) {
    minDrawdown = -0.1;
  }

  const bandWidth = (740 - 60) / (points.length - 1);

  const linePath = points
    .map((p, i) => {
      const x = 60 + i * bandWidth;
      const y = 170 - ((p.equity - minEq) / (maxEq - minEq)) * 150;
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  const areaPath = `${linePath} L ${60 + (points.length - 1) * bandWidth} 170 L 60 170 Z`;

  const ddLinePath = points
    .map((p, i) => {
      const x = 60 + i * bandWidth;
      const y = 190 + (ddOf(p) / minDrawdown) * 80;
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  const ddAreaPath = `${ddLinePath} L ${60 + (points.length - 1) * bandWidth} 190 L 60 190 Z`;

  const lastPoint = stats.last ?? {
    date: '', equity: 0, peak: 0, drawdown: 0, risk_indicator: null,
    net_flow: 0, twr_index: 1, twr_drawdown: 0,
  };

  const maxDrawdown = adjusted ? stats.max_drawdown_twr : stats.max_drawdown;
  const maxDrawdownDate = adjusted ? stats.max_drawdown_twr_date : stats.max_drawdown_date;

  const totalReturn = adjusted ? stats.twr_return : stats.total_return;
  const returnCls = totalReturn !== null ? pnlCls(totalReturn) : 'text-zinc-400';
  const returnText = totalReturn !== null ? `${totalReturn > 0 ? '+' : ''}${pct(totalReturn)}` : '—';
  // 圖上標出有入出金的那幾天：曲線在那裡的跳動不是行情造成的
  const flowDays = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.net_flow !== 0);

  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    top: '110px',
    pointerEvents: 'none',
    zIndex: 30,
    backgroundColor: '#18181b',
    border: '1px solid #27272a',
    borderRadius: '0.375rem',
    padding: '0.5rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
  };

  if (hoverX !== null) {
    if (hoverX < 400) {
      tooltipStyle.left = `calc(${(hoverX / 800) * 100}% + 12px)`;
      tooltipStyle.transform = 'translateY(-50%)';
    } else {
      tooltipStyle.left = `calc(${(hoverX / 800) * 100}% - 12px)`;
      tooltipStyle.transform = 'translate(-100%, -50%)';
    }
  }

  const lastX = 740;
  const lastY = 170 - ((lastPoint.equity - minEq) / (maxEq - minEq)) * 150;

  const maxDdIdx = points.findIndex((p) => p.date === maxDrawdownDate);
  const maxDdX = maxDdIdx !== -1 ? 60 + maxDdIdx * bandWidth : null;
  const maxDdY = maxDdIdx !== -1 ? 190 + (maxDrawdown / minDrawdown) * 80 : null;

  return (
    <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/50 pb-4">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <div>
            <div className="text-[10px] text-zinc-500 font-medium">最新權益數</div>
            <div className="text-base font-bold font-mono mt-0.5 text-zinc-100">{money(lastPoint.equity)}</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 font-medium">
              期間報酬{adjusted && <span className="text-cyan-500">（已扣入出金）</span>}
            </div>
            <div className={`text-base font-bold font-mono mt-0.5 ${returnCls}`}>{returnText}</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 font-medium">
              最大回撤{adjusted && <span className="text-cyan-500">（已扣入出金）</span>}
            </div>
            <div className="text-base font-bold font-mono mt-0.5 text-amber-500">
              {maxDrawdown !== 0 ? `${pct(maxDrawdown)}` : '0.0%'}
              {maxDrawdown !== 0 && (
                <span className="text-[9px] text-zinc-500 font-normal ml-1 block md:inline">
                  ({maxDrawdownDate})
                </span>
              )}
            </div>
          </div>
          {adjusted && (
            <div>
              <div className="text-[10px] text-zinc-500 font-medium">期間淨入出金</div>
              <div className="text-base font-bold font-mono mt-0.5 text-cyan-400">
                {stats.net_flow >= 0 ? '+' : '−'}{money(Math.abs(stats.net_flow)).replace('-', '')}
                <span className="text-[9px] text-zinc-500 font-normal ml-1 block md:inline">
                  真正賺賠 {money(stats.pnl_ex_flow)}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <RangeSelector active={rangeType} onChange={setRangeType} />
        </div>
      </div>

      <div className="relative">
        <svg viewBox="0 0 800 320" width="100%" className="overflow-visible select-none">
          <defs>
            <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.7" />
            </linearGradient>
          </defs>

          {/* Equity Chart Grid & Labels */}
          <line x1={60} y1={20} x2={740} y2={20} stroke="#27272a" strokeWidth={1} />
          <line x1={60} y1={95} x2={740} y2={95} stroke="#27272a" strokeWidth={1} strokeDasharray="2 2" />
          <line x1={60} y1={170} x2={740} y2={170} stroke="#27272a" strokeWidth={1} />

          <text x={50} y={24} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {money(maxEq)}
          </text>
          <text x={50} y={99} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {money((minEq + maxEq) / 2)}
          </text>
          <text x={50} y={174} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {money(minEq)}
          </text>

          {/* Drawdown Chart Grid & Labels */}
          <line x1={60} y1={190} x2={740} y2={190} stroke="#27272a" strokeWidth={1} />
          <line x1={60} y1={230} x2={740} y2={230} stroke="#27272a" strokeWidth={1} strokeDasharray="2 2" />
          <line x1={60} y1={270} x2={740} y2={270} stroke="#27272a" strokeWidth={1} />

          <text x={50} y={194} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            0%
          </text>
          <text x={50} y={234} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {pct(minDrawdown / 2)}
          </text>
          <text x={50} y={274} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {pct(minDrawdown)}
          </text>

          {/* Time axis labels */}
          <text x={60} y={295} textAnchor="start" fill="#71717a" className="text-[10px] font-mono">
            {points[0].date}
          </text>
          <text
            x={60 + Math.floor((points.length - 1) / 2) * bandWidth}
            y={295}
            textAnchor="middle"
            fill="#71717a"
            className="text-[10px] font-mono"
          >
            {points[Math.floor((points.length - 1) / 2)].date}
          </text>
          <text x={740} y={295} textAnchor="end" fill="#71717a" className="text-[10px] font-mono">
            {points[points.length - 1].date}
          </text>

          {/* Area and Line for Equity */}
          <path d={areaPath} fill="url(#equityGradient)" />
          <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth={2} />

          {/* Area and Line for Drawdown */}
          <path d={ddAreaPath} fill="url(#drawdownGradient)" />
          <path d={ddLinePath} fill="none" stroke="#f59e0b" strokeWidth={1.5} />

          {/* 入出金那幾天：曲線在這裡的落差是自己匯錢進出造成的，不是行情 */}
          {flowDays.map(({ p, i }) => {
            const x = 60 + i * bandWidth;
            return (
              <g key={`flow-${p.date}`}>
                <line x1={x} y1={20} x2={x} y2={170} stroke="#06b6d4" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
                <text x={x} y={16} textAnchor="middle" fill="#06b6d4" className="text-[9px] font-mono font-bold">
                  {p.net_flow > 0 ? '入' : '出'}
                </text>
              </g>
            );
          })}

          {/* Label Latest Point */}
          <circle cx={lastX} cy={lastY} r={4} fill="#3b82f6" stroke="#18181b" strokeWidth={1.5} />
          <text x={lastX - 8} y={lastY - 8} textAnchor="end" fill="#3b82f6" className="text-[10px] font-bold font-mono">
            {money(lastPoint.equity)}
          </text>

          {/* Label Max Drawdown Point */}
          {maxDrawdown < 0 && maxDdX !== null && maxDdY !== null && (
            <>
              <circle cx={maxDdX} cy={maxDdY} r={4} fill="#f43f5e" stroke="#18181b" strokeWidth={1.5} />
              <text x={maxDdX} y={maxDdY + 16} textAnchor="middle" fill="#f43f5e" className="text-[10px] font-bold font-mono">
                {pct(maxDrawdown)}
              </text>
            </>
          )}

          {/* Vertical Hover Line */}
          {hoverX !== null && (
            <line x1={hoverX} y1={20} x2={hoverX} y2={270} stroke="#71717a" strokeWidth={1} strokeDasharray="4 4" />
          )}

          {/* Hover hit-zones (vertical bands) */}
          {points.map((p, i) => {
            const x = 60 + i * bandWidth;
            return (
              <rect
                key={i}
                x={x - bandWidth / 2}
                y={20}
                width={bandWidth}
                height={260}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => {
                  setHoveredPoint(p);
                  setHoverX(x);
                }}
                onMouseLeave={() => {
                  setHoveredPoint(null);
                  setHoverX(null);
                }}
              />
            );
          })}
        </svg>

        {/* Hover Tooltip */}
        {hoveredPoint && hoverX !== null && (
          <div style={tooltipStyle}>
            <div className="text-[10px] text-zinc-400">{hoveredPoint.date}</div>
            <div className="mt-1">
              權益數: <span className="font-semibold text-zinc-100">{money(hoveredPoint.equity)}</span>
            </div>
            {hoveredPoint.net_flow !== 0 && (
              <div>
                {hoveredPoint.net_flow > 0 ? '入金' : '出金'}: <span className="font-semibold text-cyan-400">
                  {money(Math.abs(hoveredPoint.net_flow)).replace('-', '')}
                </span>
              </div>
            )}
            <div>
              回撤{adjusted ? '(已扣入出金)' : ''}: <span className={`font-semibold ${ddOf(hoveredPoint) === 0 ? 'text-zinc-300' : 'text-orange-400'}`}>
                {pct(ddOf(hoveredPoint))}
              </span>
            </div>
            <div>
              風險指標: <span className="font-semibold text-zinc-100">
                {hoveredPoint.risk_indicator !== null ? pct(hoveredPoint.risk_indicator, 0) : '—'}
              </span>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-500">
        {adjusted ? (
          <>
            上面那條線是<strong className="text-zinc-400">原始權益數</strong>（帳戶裡實際有多少），會因入出金而跳動；
            標了<span className="text-cyan-400">入／出</span>的日子就是你匯錢進出的那幾天。
            期間報酬與回撤已改用<strong className="text-zinc-400">扣掉入出金</strong>的算法（逐段報酬率連乘，與基金淨值同一個口徑），
            所以匯錢進出不會被算成賺賠。資料來源是「資金進出（入金／出金）」那本流水帳，漏記的話這兩個數字就會失真。
          </>
        ) : (
          <>權益數會因入出金而跳動，這條線<strong className="text-zinc-400">不是報酬率曲線</strong>——到「部位 &amp; 平倉紀錄」分頁記下入出金後，這裡的報酬與回撤會自動扣掉它們再算。</>
        )}
        {' '}快照取自期交所每日行情（收盤／結算價），盤中不更新。
      </p>
    </div>
  );
};

/**
 * 每個月份的現價「是哪來的」。
 *
 * 夜盤（15:00–翌日 05:00）跟日盤收盤價差個兩三塊是常態——2026-08-04 日盤收 100.95、
 * 同日夜盤 00:14 已經是 103.35。數字旁邊不標時段的話，看習慣日盤收盤價的人會直接
 * 認定是抓錯了（使用者當天就是這樣回報的）。所以價格出現在哪，這個標示就要跟到哪。
 */
function priceOrigin(month: string, quote: QuoteState, hasOwnPrice: boolean) {
  if (!hasOwnPrice) {
    return { label: '後備價', title: '沒有這個月份的行情，正在用後備價', cls: 'text-amber-400' };
  }
  const q = quote.months.find((x) => x.month === month);
  if (q && q.live !== null) {
    const night = q.live_session === 'night';
    const hhmm = q.live_time ? q.live_time.slice(11, 16) : '';
    return {
      label: `${night ? '夜盤' : '日盤'} ${hhmm}`.trim(),
      title: night
        ? `盤後（夜盤）交易時段的最新成交價${hhmm ? `（${hhmm} 成交）` : ''}。夜盤 15:00–翌日 05:00 照樣在跑，跟日盤收盤價差幾塊是常態，不是抓錯。`
        : `一般（日盤）交易時段的最新成交價${hhmm ? `（${hhmm} 成交）` : ''}。`,
      cls: night
        ? 'text-indigo-300 border border-indigo-400/40 bg-indigo-400/10 rounded px-1'
        : 'text-zinc-400',
    };
  }
  if (q && (q.settlement !== null || q.last !== null)) {
    return {
      label: '結算價',
      title: `${quote.msg || ''} 期交所每日結算價——這個月份目前沒有成交，所以沒有即時價`,
      cls: 'text-zinc-500',
    };
  }
  return null;
}

type RealizedSortMode = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
const REALIZED_SORT_OPTIONS: { value: RealizedSortMode; label: string }[] = [
  { value: 'date_desc', label: '日期新→舊' },
  { value: 'date_asc', label: '日期舊→新' },
  { value: 'amount_desc', label: '金額大→小' },
  { value: 'amount_asc', label: '金額小→大' },
];
/** 篩選/排序 chip 共用樣式，跟「已實現損益總覽」頁（RealizedPnl.tsx）同一套視覺語言 */
const filterChipCls = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition ${
    active
      ? 'bg-primary/15 text-primary border-primary/30'
      : 'text-zinc-400 border-border hover:text-zinc-200 hover:border-zinc-600'
  }`;

/**
 * 已實現損益明細。**預設收合**：這頁開場要回答的是「我現在安不安全」，已經落袋的
 * 損益是回顧用的，一攤開就把警戒卡推到摺線以下。收合時標題列仍然帶著合計與筆數，
 * 所以不展開也知道值不值得展開。
 *
 * 展開後比照「已實現損益總覽」頁（RealizedPnl.tsx）提供商品／月份／自訂區間篩選
 * 與排序——那頁彙整三種來源給全域視角，這裡是單一期貨帳戶自己的明細，篩選/排序
 * 邏輯故意獨立一份（不共用 state），選了哪個月份跟切到哪個分頁無關。
 *
 * 費用那欄會標示是券商實收（截圖匯入帶進來的）還是用設定值推估的——兩者可能差一截
 * （實收 40 元/口 vs 設定預設 30），看到「估」就知道這筆的淨額只是近似。
 */
const RealizedPanel: React.FC<{ closed: ClosedTrade[]; spec: FuturesSpec; products: Record<string, ProductConfig> }> = ({ closed, spec, products }) => {
  const [open, setOpen] = useState(false);
  const multiProduct = Object.keys(products).length > 1;
  const baseRows = useMemo(
    () => closed.map((t) => ({ t, b: closedBreakdown(t, products[t.product]?.spec ?? spec) })),
    [closed, spec, products],
  );
  // 收合時標題列看的是「所有平倉紀錄」的合計，不受下面篩選影響——篩選只在展開後才看得到、也才有意義
  const grandTotal = baseRows.reduce((s, r) => s + r.b.net, 0);
  const grandLots = baseRows.reduce((s, r) => s + Math.max(0, r.t.lots), 0);
  const grandWins = baseRows.filter((r) => r.b.net > 0).length;

  // ── 篩選：商品（多商品帳戶才顯示）／平倉日區間 ─────────────────────────────
  const [filterProduct, setFilterProduct] = useState('');
  const [timeMode, setTimeMode] = useState<'all' | 'month' | 'range'>('all');
  const [month, setMonth] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [sortMode, setSortMode] = useState<RealizedSortMode>('date_desc');

  const productOptions = useMemo(
    () => Object.entries(products)
      .map(([code, p]) => [code, p.name || code] as const)
      .sort((a, b) => a[1].localeCompare(b[1])),
    [products],
  );
  /** 月份快選：近 6 個月排成按鈕，更早的塞進下拉選單——跟總覽頁同一套設計 */
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    baseRows.forEach((r) => { const m = exitMonthOf(r.t.exit_date); if (m) set.add(m); });
    return [...set].sort().reverse();
  }, [baseRows]);
  const RECENT_MONTHS_SHOWN = 6;
  const recentMonths = monthOptions.slice(0, RECENT_MONTHS_SHOWN);
  const olderMonths = monthOptions.slice(RECENT_MONTHS_SHOWN);
  const monthChipLabel = (m: string) => {
    const [y, mm] = m.split('-');
    return Number(y) === new Date().getFullYear() ? `${Number(mm)}月` : `${y.slice(2)}/${mm}`;
  };

  const filteredRows = useMemo(() => baseRows
    .filter((r) => !filterProduct || r.t.product === filterProduct)
    .filter((r) => {
      if (timeMode === 'month') return !month || exitMonthOf(r.t.exit_date) === month;
      if (timeMode === 'range') return inExitDateRange(r.t.exit_date, dateStart, dateEnd);
      return true;
    }),
  [baseRows, filterProduct, timeMode, month, dateStart, dateEnd]);

  const sortedRows = useMemo(() => {
    const arr = [...filteredRows];
    switch (sortMode) {
      case 'date_asc': return arr.sort((a, b) => (a.t.exit_date || '').localeCompare(b.t.exit_date || ''));
      case 'amount_desc': return arr.sort((a, b) => b.b.net - a.b.net);
      case 'amount_asc': return arr.sort((a, b) => a.b.net - b.b.net);
      case 'date_desc':
      default: return arr.sort((a, b) => (b.t.exit_date || '').localeCompare(a.t.exit_date || ''));
    }
  }, [filteredRows, sortMode]);

  const total = filteredRows.reduce((s, r) => s + r.b.net, 0);
  const gross = filteredRows.reduce((s, r) => s + r.b.gross, 0);
  const cost = filteredRows.reduce((s, r) => s + r.b.fees + r.b.tax, 0);
  const lots = filteredRows.reduce((s, r) => s + Math.max(0, r.t.lots), 0);
  const wins = filteredRows.filter((r) => r.b.net > 0).length;
  const showProductCol = multiProduct && !filterProduct;

  return (
    <Panel
      title="已實現損益"
      icon={<ListOrdered className="w-4 h-4" />}
      tone="zinc"
      right={
        <>
          <Chip tone={grandTotal >= 0 ? 'rose' : 'emerald'} title="所有平倉紀錄的淨損益合計">
            {money(grandTotal)}
          </Chip>
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={baseRows.length === 0}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {open ? '收合明細' : `展開明細（${baseRows.length}）`}
          </button>
        </>
      }
      desc={baseRows.length === 0
        ? '還沒有平倉紀錄。到「部位 & 平倉紀錄」分頁平倉、或用券商截圖匯入之後，這裡會列出每一筆。'
        : <>已結算進保證金專戶現金餘額的損益，不會再隨行情變動。共 {baseRows.length} 筆 / {grandLots} 口，獲利 {grandWins} 筆。</>}
    >
      {baseRows.length > 0 && open && (
        <>
          {/* ── 篩選列：商品（多商品帳戶才顯示）／平倉日區間 ── */}
          <div className="space-y-2 mb-4">
            {multiProduct && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] text-zinc-500 mr-1">
                  <Filter className="w-3.5 h-3.5" /> 商品
                </span>
                <button onClick={() => setFilterProduct('')} className={filterChipCls(!filterProduct)}>全部商品</button>
                {productOptions.map(([code, name]) => (
                  <button key={code} onClick={() => setFilterProduct(code)} className={filterChipCls(filterProduct === code)}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-[11px] text-zinc-500 mr-1 ${multiProduct ? 'pl-[19px]' : 'flex items-center gap-1'}`}>
                {!multiProduct && <Filter className="w-3.5 h-3.5" />} 平倉日
              </span>
              <button
                onClick={() => { setTimeMode('all'); setMonth(''); setDateStart(''); setDateEnd(''); }}
                className={filterChipCls(timeMode === 'all')}
              >
                全部時間
              </button>
              {recentMonths.map((m) => (
                <button
                  key={m}
                  onClick={() => { setTimeMode('month'); setMonth(m); }}
                  className={filterChipCls(timeMode === 'month' && month === m)}
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
              <button onClick={() => setTimeMode('range')} className={filterChipCls(timeMode === 'range')}>自訂區間</button>
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

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="淨已實現損益" value={money(total)} valueCls={pnlCls(total)} tone="zinc"
              sub={`毛損益 ${money(gross)} － 費用 ${money(cost)}`} />
            <StatTile label="交易費用合計" value={money(cost)} tone="zinc"
              sub={lots > 0 ? `平均 ${money(cost / lots)} / 口（來回）` : ''}
              hint="手續費 + 期交稅。有券商實收金額就用實收的，否則用「契約規格 & 設定」的費率推估。" />
            <StatTile label="勝率" value={filteredRows.length > 0 ? pct(wins / filteredRows.length, 0) : '—'} tone="zinc"
              sub={`${wins} 勝 / ${filteredRows.length - wins} 敗`}
              hint="以每一筆平倉紀錄的淨損益是否為正計算，不是以口數加權。" />
            <StatTile label="平均每筆" value={filteredRows.length > 0 ? money(total / filteredRows.length) : '—'} valueCls={pnlCls(total)} tone="zinc"
              sub={lots > 0 ? `每口平均 ${money(total / lots)}` : ''} />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-500">明細（共 {sortedRows.length} 筆）</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {REALIZED_SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSortMode(opt.value)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition ${
                    sortMode === opt.value
                      ? 'bg-primary/15 text-primary border-primary/30'
                      : 'text-zinc-500 border-border hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  {showProductCol && <th className="text-left font-medium py-2 pr-3">商品</th>}
                  <th className="text-left font-medium py-2 pr-3">平倉日</th>
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-left font-medium py-2 pr-3">方向</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-right font-medium py-2 pr-3">進場</th>
                  <th className="text-right font-medium py-2 pr-3">出場</th>
                  <th className="text-right font-medium py-2 pr-3">毛損益</th>
                  <th className="text-right font-medium py-2 pr-3">費用</th>
                  <th className="text-right font-medium py-2">淨損益</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 && (
                  <tr><td colSpan={showProductCol ? 10 : 9} className="py-6 text-center text-zinc-600">沒有符合篩選條件的紀錄</td></tr>
                )}
                {sortedRows.map(({ t, b }) => (
                  <tr key={t.id} className="border-b border-border/50 last:border-0">
                    {showProductCol && <td className="py-2 pr-3 text-zinc-400">{products[t.product]?.name ?? t.product}</td>}
                    <td className="py-2 pr-3 font-mono text-zinc-400">{t.exit_date || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(t.month)}</td>
                    <td className={`py-2 pr-3 ${t.side === 'long' ? 'text-bull' : 'text-bear'}`}>{t.side === 'long' ? '多' : '空'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{t.lots}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.entry_price)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.exit_price)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${pnlCls(b.gross)}`}>{money(b.gross)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500"
                      title={b.actual_cost ? '券商實收金額' : '依「契約規格 & 設定」的費率推估'}>
                      {money(b.fees + b.tax)}{b.actual_cost ? '' : ' 估'}
                    </td>
                    <td className={`py-2 text-right font-mono font-semibold ${pnlCls(b.net)}`}>{money(b.net)}</td>
                  </tr>
                ))}
              </tbody>
              {sortedRows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="py-2 pr-3 text-zinc-400 font-medium" colSpan={showProductCol ? 4 : 3}>合計</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{lots}</td>
                    <td className="py-2 pr-3" colSpan={2} />
                    <td className={`py-2 pr-3 text-right font-mono ${pnlCls(gross)}`}>{money(gross)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{money(cost)}</td>
                    <td className={`py-2 text-right font-mono font-bold ${pnlCls(total)}`}>{money(total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="text-[10px] text-zinc-600 mt-2">
              要刪除或修改某一筆，到「部位 &amp; 平倉紀錄」分頁的平倉紀錄表（刪除會把當初結算的損益從現金餘額回沖）。
            </p>
          </div>
        </>
      )}
    </Panel>
  );
};

const OverviewTab: React.FC<{
  config: FuturesConfig;
  summary: Summary;
  statusMeta: { cls: string; ring: string; tone: Tone; label: string; desc: string };
  spec: FuturesSpec;
  beta: number;
  plan: ReturnType<typeof targetPlan>;
  priceInput: PriceInput;
  quote: QuoteState;
  historyState: {
    loading: boolean;
    error: string | null;
    data: FuturesEquityHistoryResp | null;
  };
  products: Record<string, ProductConfig>;
  gainPct: number;
  activeCode: string;
}> = ({ config, summary, statusMeta, spec, beta, plan, priceInput, quote, historyState, products, gainPct, activeCode }) => {
  const cashFlowTotals = useMemo(() => summarizeCashFlows(config.cash_flows), [config.cash_flows]);
  const ri = summary.risk_indicator;
  const riPctText = ri === null ? '—' : `${(ri * 100).toFixed(0)}%`;
  const refPrice = summary.reference_price;
  // 危險價位/目標價的大盤點位換算要用「參考商品」（口數最多、決定 summary 的那個）自己的
  // 加權指數，不是目前部位新增表單選到的那個商品——兩者多商品時可能不是同一個。
  const indexRef = (summary.reference_product && products[summary.reference_product]?.index_ref) || 0;
  const idx = (p: number | null) => idxText(p, refPrice, indexRef, beta);
  const hasLevels = summary.total_lots > 0 && summary.net_lots !== 0;

  /**
   * 警戒卡的四行。原本追繳／斷頭只是「危險價位」清單裡的兩列，跟現價、
   * 距離混在一起；拆成兩張獨立染色的卡之後，每一張自己回答同一組問題：
   * 觸發價、對應大盤點位、還能跌多少、大盤要掉幾點。
   */
  const threatRows = (price: number | null) => {
    const indexAt = price === null ? null : indexAtPrice(price, refPrice, indexRef, beta);
    const move = price !== null && refPrice > 0 ? (price - refPrice) / refPrice : null;
    const gap = indexAt === null ? null : indexAt - indexRef;
    return [
      { label: '觸發的標的價格', value: price !== null ? `${px(price)} 元` : '—', strong: true },
      {
        label: '對應加權指數',
        value: indexAt !== null ? `${Math.round(indexAt).toLocaleString()} 點` : '未填參考指數',
        hint: '在「契約規格 & 設定」填入目前的加權指數才會換算。',
      },
      {
        label: '最大容忍幅度',
        value: move !== null ? `${move > 0 ? '+' : ''}${(move * 100).toFixed(2)}%` : '—',
        hint: '相對目前價格。空單的警戒線在上方，所以會是正的漲幅。',
      },
      {
        label: '大盤折算點數',
        value: gap !== null ? `${gap >= 0 ? '+' : ''}${Math.round(gap).toLocaleString()} 點` : '—',
        hint: `以 beta ${beta.toFixed(2)} 換算，僅供對照。`,
      },
    ];
  };

  return (
    <div className="space-y-5">
      {/* 帳戶狀態：四塊數字 + 一條風險量表，開頁第一眼要回答的就是「我現在安不安全」 */}
      <Panel
        title="帳戶目前狀態"
        icon={<Wallet className="w-4 h-4" />}
        tone={statusMeta.tone}
        right={<Chip tone={statusMeta.tone} title={statusMeta.desc}>{statusMeta.label}</Chip>}
        desc={statusMeta.desc}
      >
        {/* 五塊：xl 以下排不下五欄，退成三欄（2+3）而不是硬擠 */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          <StatTile
            label="保證金權益數"
            value={money(summary.equity)}
            sub={`現金 ${money(config.cash)} ＋ 未實現 ${money(summary.unrealized)}`}
            valueCls={pnlCls(summary.equity)}
            tone="primary"
            icon={<Wallet className="w-3 h-3" />}
            hint="權益數＝保證金專戶現金餘額 ＋ 未實現損益。期貨每日結算，這個數字才是你真正的家當。"
          />
          <StatTile
            label="未實現損益"
            value={money(summary.unrealized)}
            sub={summary.required_initial > 0 ? `佔原始保證金 ${pct(summary.unrealized / summary.required_initial)}` : '無部位'}
            valueCls={pnlCls(summary.unrealized)}
            /* 色帶維持中性：數字已經用台股的漲紅跌綠表態，色帶再用 rose/emerald 會變成
               「紅棒配綠字」的反向暗示。風險語意留給風險指標那一塊。 */
            tone="zinc"
            icon={<LineChart className="w-3 h-3" />}
            hint="已扣掉來回手續費與期交稅的淨額。"
          />
          <StatTile
            label="已實現損益"
            value={money(summary.realized)}
            sub={config.closed.length > 0 ? `${config.closed.length} 筆平倉・已入帳` : '尚無平倉紀錄'}
            valueCls={pnlCls(summary.realized)}
            tone="zinc"
            icon={<ListOrdered className="w-3 h-3" />}
            hint="所有平倉紀錄的淨損益合計（已扣費用）。這筆錢已經結算進保證金專戶現金餘額，不會再隨行情變動。"
          />
          <StatTile
            label="風險指標"
            value={riPctText}
            sub={statusMeta.label}
            valueCls={statusMeta.cls}
            tone={statusMeta.tone}
            icon={<Gauge className="w-3 h-3" />}
            hint="權益數 ÷ 所需原始保證金——期交所定義，期貨商 App 顯示的就是這個數字。盤中低於 25% 會被強制平倉；低於 100% 只是不能再開新倉，追繳看的是另一條線（權益數低於維持保證金）。"
          />
          <StatTile
            label="名目曝險"
            value={money(summary.contract_value)}
            sub={summary.leverage !== null ? `實質槓桿 ${summary.leverage.toFixed(2)} 倍` : '無部位'}
            tone="sky"
            icon={<Ruler className="w-3 h-3" />}
            hint="契約總值＝價格 × 契約單位 × 口數。這才是你實際承受的市場曝險，不是保證金那點錢。"
          />
        </div>
        <div className="mt-3">
          <RiskMeter
            value={ri}
            tone={statusMeta.tone}
            liquidationRatio={spec.liquidation_ratio}
            marginCallRatio={summary.margin_call_ratio}
          />
        </div>
      </Panel>

      <RealizedPanel closed={config.closed} spec={spec} products={products} />

      <EquityCurveCard historyState={historyState} flows={config.cash_flows} initialMargin={spec.initial_margin} />

      {/* 兩張警戒卡：整張染色，是全頁唯一會被餘光抓到的區塊 */}
      {summary.total_lots === 0 ? (
        <Panel title="警戒價位" icon={<AlertTriangle className="w-4 h-4" />} tone="zinc">
          <p className="text-xs text-zinc-500">目前沒有未平倉部位。到「部位 &amp; 平倉紀錄」分頁新增後，這裡會算出追繳與斷頭價位。</p>
        </Panel>
      ) : summary.net_lots === 0 ? (
        <Panel title="警戒價位" icon={<AlertTriangle className="w-4 h-4" />} tone="zinc">
          <p className="text-xs text-zinc-500">
            多空完全對沖（多 {summary.long_lots} 口 / 空 {summary.short_lots} 口），價格已不影響權益數，因此沒有追繳價可言。
          </p>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ThreatCard
            tone="amber"
            title="黃牌 · 追繳點位"
            tag="權益數低於維持保證金"
            rows={threatRows(summary.margin_call_price)}
            footer={
              summary.margin_call_shift !== null && refPrice > 0
                ? `距追繳還有 ${pct(Math.abs(summary.margin_call_shift) / refPrice)}（${Math.abs(
                    Math.round(summary.margin_call_shift / spec.tick_size),
                  )} 檔）。到價會收到期貨商追繳通知，要補錢補到原始保證金水準。`
                : '到價會收到期貨商追繳通知，要補錢補到原始保證金水準。'
            }
          />
          <ThreatCard
            tone="rose"
            title="紅牌 · 斷頭點位"
            tag={`風險指標 ＜ ${pct(spec.liquidation_ratio, 0)}`}
            rows={threatRows(summary.liquidation_price)}
            footer="盤中觸及就會被期貨商代為沖銷，不會等你補錢。實際崩盤常因跳空而更早發生。"
          />
        </div>
      )}

      {/* 關鍵價格防線：斷頭 → 追繳 → 成本 → 目標，一眼看出自己站在哪 */}
      {hasLevels && (
        <Panel
          title="關鍵價格防線"
          icon={<Target className="w-4 h-4" />}
          tone="sky"
          right={<span className="text-[11px] text-zinc-600">斷頭價 → 追繳價 → 現價 → 目標價</span>}
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <LevelCard tone="rose" label="紅牌斷頭價" value={summary.liquidation_price} sub={idx(summary.liquidation_price)} base={refPrice} />
            <LevelCard tone="amber" label="黃牌追繳價" value={summary.margin_call_price} sub={idx(summary.margin_call_price)} base={refPrice} />
            <LevelCard
              tone="sky"
              current
              label={`目前價格${summary.months.length > 1 ? `（${monthLabel(summary.reference_month)}）` : ''}`}
              value={refPrice}
              sub={indexRef > 0 ? `${Math.round(indexRef).toLocaleString()} 點` : ''}
              base={refPrice}
            />
            <LevelCard tone="emerald" label={`目標價（+${(gainPct * 100).toFixed(0)}%）`} value={plan.target_price} sub={idx(plan.target_price)} base={refPrice} />
          </div>
          <p className="text-[11px] text-zinc-500 mt-3">
            以目前部位與權益數計算，含來回手續費與期交稅——加碼、平倉或入金都會改變這些價位。
            目標價的幅度可在「建倉 &amp; 出場試算」分頁調整；空單的追繳／斷頭價在現價之上，卡片會顯示為上漲幅度。
            {summary.months.length > 1 && (
              <> 你同時持有 {summary.months.map(monthLabel).join('、')}，各月份分別報價；追繳／斷頭價是
              <strong className="text-zinc-400">各月份一起移動</strong>
              {summary.margin_call_shift !== null && <> {summary.margin_call_shift >= 0 ? '+' : ''}{summary.margin_call_shift.toFixed(2)} 元</>}
              的意思，用 {monthLabel(summary.reference_month)} 的價格表示。</>
            )}
            {indexRef <= 0 && ' 在「契約規格 & 設定」填入目前的加權指數，這裡就會一併顯示對應點位。'}
          </p>
        </Panel>
      )}

      {/* 保證金水位：警戒價位是「會發生什麼」，這裡是「錢的組成」 */}
      <Panel
        title="保證金水位"
        icon={<Gauge className="w-4 h-4" />}
        tone={statusMeta.tone}
        right={<Chip tone={summary.excess >= 0 ? 'emerald' : 'rose'}>超額 {money(summary.excess)}</Chip>}
      >
        <dl className="space-y-2.5 text-xs">
          <Row label="權益數" value={money(summary.equity)} cls={`text-base font-bold ${pnlCls(summary.equity)}`} />
          <Row label={Object.keys(products).length > 1 ? '所需原始保證金（逐商品加總）' : `所需原始保證金（${summary.total_lots} 口 × ${money(spec.initial_margin)}）`} value={money(summary.required_initial)} />
          <Row label={Object.keys(products).length > 1 ? '所需維持保證金（逐商品加總）' : `所需維持保證金（${summary.total_lots} 口 × ${money(spec.maintenance_margin)}）`} value={money(summary.required_maintenance)} />
          <Row
            label="超額保證金（＝期貨商的「可動用保證金」）"
            value={money(summary.excess)}
            cls={summary.excess >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            hint="權益數 − 所需原始保證金。正的部分才是能再開倉或承受回檔的緩衝。期貨商 App 上叫「可動用保證金」，同一個東西。"
          />
          <Row
            label="風險指標（權益數 ÷ 所需原始保證金）"
            value={riPctText}
            cls={statusMeta.cls}
            hint="期交所定義，期貨商 App 顯示的就是這個。分母是原始保證金不是維持保證金——用維持保證金會算出大約 1.3 倍的數字，對不上期貨商。"
          />
          {/* 有記資金進出才顯示：沒有流水帳的話「淨投入」只會是一個假的 0 */}
          {cashFlowTotals.count > 0 && (
            <>
              <Row
                label={`淨投入資金（入 ${money(cashFlowTotals.deposit)} − 出 ${money(cashFlowTotals.withdraw)}）`}
                value={money(cashFlowTotals.net)}
                hint="自己匯進這個帳戶、還沒領回的錢。在「部位 & 平倉紀錄」分頁的資金進出流水帳維護。"
              />
              <Row
                label="相對淨投入的累積損益"
                value={money(summary.equity - cashFlowTotals.net)}
                cls={pnlCls(summary.equity - cashFlowTotals.net)}
                hint="權益數 − 淨投入。只有在「開戶以來每一筆入出金都記進來」時才成立；中途才開始記的話，請當成起記日之後的成績。"
              />
            </>
          )}
        </dl>
      </Panel>

      {/* 部位明細 */}
      <Panel
        title="未平倉部位"
        icon={<Layers className="w-4 h-4" />}
        tone="primary"
        right={summary.total_lots > 0
          ? <Chip tone="zinc">共 {summary.total_lots} 口（多 {summary.long_lots} / 空 {summary.short_lots}）</Chip>
          : undefined}
      >
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有部位。到「部位 &amp; 平倉紀錄」分頁新增。</p>
        ) : (
          <>
          {/*
            手機改成一部位一張卡。八欄硬塞進 390px 會把 `-$30,766` 截成 `-$30`——
            截掉的是損益的位數，這種「看起來像數字但其實錯了」比放不下更糟。
            每一筆用**自己商品**的規格/報價算，不是目前部位新增表單選到的那個
            （多商品帳戶時，兩者不一定相同）。
          */}
          <div className="sm:hidden space-y-2">
            {config.positions.map((p) => {
              const pp = products[p.product];
              const pInput: PriceInput = pp ? { byMonth: pp.prices, fallback: pp.price } : priceInput;
              const pSpec = pp?.spec ?? spec;
              const mp = priceOf(pInput, p.month);
              const r = positionPnl(p, mp, pSpec);
              return (
                <div key={p.id} className="rounded-xl border border-border bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                      p.side === 'long' ? 'text-bull border-bull/30 bg-bull/10' : 'text-bear border-bear/30 bg-bear/10'
                    }`}>
                      {p.side === 'long' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {p.side === 'long' ? '多' : '空'}
                    </span>
                    {Object.keys(products).length > 1 && (
                      <span className="text-[10px] text-zinc-500">{pp?.name ?? p.product}</span>
                    )}
                    <span className="font-mono text-xs text-zinc-300">{monthLabel(p.month)}</span>
                    <span className="text-xs text-zinc-500">{p.lots} 口</span>
                    <span className={`ml-auto font-mono font-bold text-base tabular-nums ${pnlCls(r.net_pnl)}`}>
                      {money(r.net_pnl)}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
                    <Row label="進場價" value={px(p.entry_price)} />
                    <Row
                      label="該月現價"
                      value={`${px(mp)}${pp?.prices[p.month] ? '' : '*'}`}
                      cls={pp?.prices[p.month] ? 'text-zinc-300' : 'text-amber-400'}
                    />
                    <Row label="損益平衡" value={px(r.break_even)} cls="text-zinc-500" />
                    <Row label="保證金報酬率" value={pct(r.return_on_margin)} cls={pnlCls(r.return_on_margin)} />
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="hidden sm:block overflow-x-auto -mx-1 px-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  {Object.keys(products).length > 1 && <th className="text-left font-medium py-2 pr-3">商品</th>}
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-left font-medium py-2 pr-3">方向</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-right font-medium py-2 pr-3">進場價</th>
                  <th className="text-right font-medium py-2 pr-3">該月現價</th>
                  <th className="text-right font-medium py-2 pr-3">損益平衡</th>
                  <th className="text-right font-medium py-2 pr-3">未實現損益</th>
                  <th className="text-right font-medium py-2">保證金報酬率</th>
                </tr>
              </thead>
              <tbody>
                {config.positions.map((p) => {
                  const pp = products[p.product];
                  const pInput: PriceInput = pp ? { byMonth: pp.prices, fallback: pp.price } : priceInput;
                  const pSpec = pp?.spec ?? spec;
                  const mp = priceOf(pInput, p.month);
                  const r = positionPnl(p, mp, pSpec);
                  return (
                    <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-zinc-800/40 transition-colors">
                      {Object.keys(products).length > 1 && (
                        <td className="py-2.5 pr-3 text-zinc-400">{pp?.name ?? p.product}</td>
                      )}
                      <td className="py-2.5 pr-3 font-mono text-zinc-300">{monthLabel(p.month)}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                          p.side === 'long' ? 'text-bull border-bull/30 bg-bull/10' : 'text-bear border-bear/30 bg-bear/10'
                        }`}>
                          {p.side === 'long' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {p.side === 'long' ? '多' : '空'}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-300">{p.lots}</td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-300">{px(p.entry_price)}</td>
                      {(() => {
                        // 現價旁邊要看得出是日盤還是夜盤——夜盤價跟日盤收盤差兩三塊是常態
                        // （quote 是「真實同步」抓的行情，目前只涵蓋部位新增表單選到的那個商品）
                        const origin = p.product === activeCode ? priceOrigin(p.month, quote, !!pp?.prices[p.month]) : null;
                        return (
                          <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${pp?.prices[p.month] ? 'text-zinc-300' : 'text-amber-400'}`}
                            title={origin ? origin.title : '該月份沒有行情，用後備價代替'}>
                            {px(mp)}
                            {origin && (
                              <span className={`ml-1.5 text-[10px] font-sans font-semibold ${origin.cls}`}>{origin.label}</span>
                            )}
                          </td>
                        );
                      })()}
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-500">{px(r.break_even)}</td>
                      <td className={`py-2.5 pr-3 text-right font-mono tabular-nums font-semibold ${pnlCls(r.net_pnl)}`}>{money(r.net_pnl)}</td>
                      <td className={`py-2.5 text-right font-mono tabular-nums ${pnlCls(r.return_on_margin)}`}>{pct(r.return_on_margin)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>

      {config.closed.length > 0 && (
        <div className="bg-card/70 border border-border rounded-2xl p-4 shadow-sm flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="text-zinc-500">已實現損益（{config.closed.length} 筆平倉）</span>
          <span className={`font-mono font-bold text-base tabular-nums ${pnlCls(summary.realized)}`}>{money(summary.realized)}</span>
          <span className="text-zinc-600 text-[11px]">
            期貨每日結算，已實現損益早就進出過保證金專戶了，所以不再加進權益數，這裡只作績效回顧。
          </span>
        </div>
      )}
    </div>
  );
};

// ── 部位 & 平倉紀錄 ─────────────────────────────────────────────────────────

const PositionsTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  priceInput: PriceInput;
  quote: QuoteState;
  holidays: Set<string> | undefined;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
  products: Record<string, ProductConfig>;
  activeCode: string;
}> = ({ config, spec, summary, priceInput, quote, holidays, patch, saveToCloud, products, activeCode }) => {
  // mode 把「新倉買進／新倉賣出／平倉」收成一個選項——券商的「倉別」就是這個概念，
  // 原本只有多單／空單，做完一筆平倉得先刪部位再手打一筆平倉紀錄，漏一步帳就歪了。
  // 新倉會記到「帳戶」那格選的商品；平倉列表則不分商品，選哪筆就平哪筆。
  const [form, setForm] = useState({
    mode: 'long' as 'long' | 'short' | 'close',
    month: '',
    lots: '',
    entry_price: '',
    entry_date: todayStr(),
    close_id: '',
  });
  const [closeForm, setCloseForm] = useState<{ id: string; lots: string; exit_price: string; exit_date: string } | null>(null);
  const activeProductCfg = products[activeCode];

  const monthOptions = useMemo(() => {
    const fromQuote = quote.months.map((m) => m.month);
    const fromPositions = config.positions.filter((p) => p.product === activeCode).map((p) => p.month);
    return [...new Set([...fromQuote, ...fromPositions])].sort();
  }, [quote.months, config.positions, activeCode]);

  const closeTarget = useMemo(
    () => config.positions.find((p) => p.id === form.close_id) ?? null,
    [config.positions, form.close_id],
  );
  const closeTargetSpec = closeTarget ? (products[closeTarget.product]?.spec ?? spec) : spec;

  // 截圖匯入是帳戶層級（可能同時匯到多個商品），切一份出來給它算，順便讓那支元件
  // 不必認識整包 config
  const importState = useMemo<AccountImportState>(() => {
    const product_prices: Record<string, Record<string, number>> = {};
    for (const [code, p] of Object.entries(products)) product_prices[code] = p.prices;
    return {
      positions: config.positions,
      closed: config.closed,
      product_prices,
      stop_loss: config.stop_loss,
      cash: config.cash,
      imported_refs: config.imported_refs,
    };
  }, [config.positions, config.closed, products, config.stop_loss, config.cash, config.imported_refs]);
  const importProducts = useMemo<Record<string, ProductLookup>>(() => {
    const m: Record<string, ProductLookup> = {};
    for (const [code, p] of Object.entries(products)) m[code] = { name: p.name, spec: p.spec };
    return m;
  }, [products]);

  const addPosition = () => {
    const lots = parseFloat(form.lots);
    const entry = parseFloat(form.entry_price);
    if (!/^\d{6}$/.test(form.month) || !(lots > 0) || !(entry > 0)) return;
    const next = patch((c) => ({
      ...c,
      positions: [...c.positions, {
        id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        product: activeCode,
        month: form.month,
        side: form.mode === 'short' ? 'short' : 'long',
        lots,
        entry_price: entry,
        entry_date: form.entry_date || todayStr(),
      }],
    }));
    setForm((f) => ({ ...f, lots: '', entry_price: '' }));
    void saveToCloud(next);
  };

  /** 表單上的「平倉」：選一筆部位、填口數與價格，走跟列內平倉同一條路 */
  const submitClose = () => {
    const target = config.positions.find((p) => p.id === form.close_id);
    const lots = parseFloat(form.lots);
    const price = parseFloat(form.entry_price);
    if (!target || !(lots > 0) || !(price > 0)) return;
    closePosition(target, lots, price, form.entry_date);
    setForm((f) => ({ ...f, lots: '', entry_price: '', close_id: '' }));
  };

  const removePosition = (id: string) => {
    const next = patch((c) => ({ ...c, positions: c.positions.filter((p) => p.id !== id) }));
    void saveToCloud(next);
  };

  /**
   * 平倉：把未平倉部位搬進平倉紀錄，並把損益結算進保證金專戶現金。
   *
   * 支援**部分平倉**（lots 少於這筆的口數時只平一部分，剩下的沿用同一個 id，
   * 掛在 id 上的停損價才不會因為減碼而不見）——真實出場本來就常常是分批的。
   *
   * 損益要用**這筆部位自己商品**的規格算，不是目前「帳戶」那格選到的商品——
   * 多商品帳戶時兩者不一定相同。
   */
  const closePosition = (pos: FuturesPosition, lots: number, exitPrice: number, exitDate: string) => {
    const res = closeLots(pos, lots, exitPrice, exitDate || todayStr());
    if (!res) return;
    const posSpec = products[pos.product]?.spec ?? spec;
    const next = patch((c) => ({
      ...c,
      positions: c.positions
        .map((p) => (p.id === pos.id ? res.remaining : p))
        .filter((p): p is FuturesPosition => p !== null),
      closed: [...c.closed, res.closed],
      // 期貨平倉當下損益就結算進專戶，故現金餘額同步加上這筆損益
      cash: c.cash + closedPnl(res.closed, posSpec),
      // 整筆平掉才把停損價一起清掉；部分平倉留著（部位還在）
      stop_loss: res.remaining
        ? c.stop_loss
        : Object.fromEntries(Object.entries(c.stop_loss).filter(([k]) => k !== pos.id)),
    }));
    setCloseForm(null);
    void saveToCloud(next);
  };

  const setStopLoss = (id: string, price: number) => {
    const next = patch((c) => ({
      ...c,
      stop_loss: price > 0 ? { ...c.stop_loss, [id]: price } : Object.fromEntries(Object.entries(c.stop_loss).filter(([k]) => k !== id)),
    }));
    void saveToCloud(next);
  };

  return (
    <div className="space-y-5">
      {/* 截圖匯入：擺在最前面，因為它是「今天做了什麼」最快的入口（手機尤其） */}
      <ScreenshotImport
        state={importState}
        products={importProducts}
        today={todayStr()}
        onApply={(plan) => {
          const next = patch((c) => {
            const nextProducts = { ...c.products };
            for (const [code, prices] of Object.entries(plan.next.product_prices)) {
              if (!nextProducts[code]) continue;
              nextProducts[code] = { ...nextProducts[code], prices };
            }
            return {
              ...c,
              products: nextProducts,
              positions: plan.next.positions,
              closed: plan.next.closed,
              stop_loss: plan.next.stop_loss,
              cash: plan.next.cash,
              imported_refs: plan.next.imported_refs,
            };
          });
          void saveToCloud(next);
        }}
      />

      {/* 帳戶輸入 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Wallet className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">帳戶</h2></div>
        <div className="grid grid-cols-1 gap-4">
          <Field
            label="保證金專戶現金餘額"
            hint="入金金額 ± 已實現損益（不含未實現）。期貨商軟體上通常叫「保證金餘額」或「前日餘額＋今日存提」。今天有入金／出金請用下面的「資金進出」記一筆，這格會自動加減——直接改這格的話，權益數曲線會把那筆錢當成賺賠。"
          >
            {/* 非受控＋key：平倉會改動 cash，key 變動讓輸入框重新掛載吃到新值，
                不必用 effect 回寫本地字串（那會造成串聯重繪，也會在打字中途被蓋掉） */}
            <input
              key={`cash-${config.cash}`}
              type="number"
              defaultValue={config.cash || ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) void saveToCloud(patch((c) => ({ ...c, cash: v })));
              }}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
              placeholder="例：60000"
            />
          </Field>
        </div>

        <CashReconcile config={config} spec={spec} summary={summary} patch={patch} saveToCloud={saveToCloud} />

        {/* 各月份現價：抓到行情的月份一覽，也可以手動覆寫某個月（只管「帳戶」這格選到的商品） */}
        {config.positions.some((p) => p.product === activeCode) && (
          <div className="pt-3 border-t border-border/50 space-y-2">
            <div className="text-[11px] text-zinc-500">
              {activeProductCfg.name} 持倉月份的現價（各月份分別計價）
            </div>
            <div className="flex flex-wrap gap-2">
              {[...new Set(config.positions.filter((p) => p.product === activeCode).map((p) => p.month))].sort().map((m) => {
                const origin = priceOrigin(m, quote, !!activeProductCfg.prices[m]);
                return (
                  <div key={m} className="flex items-center gap-1.5 bg-zinc-900/50 border border-border rounded-lg px-2.5 py-1.5">
                    <span className="text-[11px] font-mono text-zinc-400">{monthLabel(m)}</span>
                    <input
                      key={`mp-${activeCode}-${m}-${activeProductCfg.prices[m] ?? 0}`}
                      type="number"
                      step="0.05"
                      defaultValue={activeProductCfg.prices[m] ?? ''}
                      placeholder={px(activeProductCfg.price)}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        void saveToCloud(patch((c) => {
                          const p = c.products[activeCode];
                          const next = { ...p.prices };
                          const v = parseFloat(raw);
                          if (raw === '' || !Number.isFinite(v) || v <= 0) delete next[m];
                          else next[m] = v;
                          return { ...c, products: { ...c.products, [activeCode]: { ...p, prices: next } } };
                        }));
                      }}
                      className="w-20 bg-zinc-950 border border-border rounded px-2 py-0.5 text-xs font-mono text-zinc-100"
                    />
                    {origin && (
                      <span className={`text-[10px] font-semibold whitespace-nowrap ${origin.cls}`} title={origin.title}>
                        {origin.label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 後備價 */}
        {(() => {
          const usingBackupMonths = [...new Set(config.positions.filter((p) => p.product === activeCode).map((p) => p.month))].filter((m) => !activeProductCfg.prices[m]);
          return (
            <div className="pt-3 border-t border-border/50 space-y-2">
              <Field
                label={`${activeProductCfg.name} 後備價（只有抓不到行情的月份會用到）`}
                hint="按上方「真實同步」會自動填入期交所結算價；盤中想用即時價可手動改。有抓到行情的月份會各自用自己的價格，不吃這一格。"
              >
                <input
                  key={`price-${activeCode}-${activeProductCfg.price}`}
                  type="number"
                  step="0.05"
                  defaultValue={activeProductCfg.price || ''}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0) {
                      void saveToCloud(patch((c) => ({
                        ...c,
                        products: { ...c.products, [activeCode]: { ...c.products[activeCode], price: v } },
                      })));
                    }
                  }}
                  className="w-full sm:w-64 bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
                  placeholder="例：102.05"
                />
              </Field>
              <div className="text-[11px] mt-1">
                {usingBackupMonths.length === 0 ? (
                  <span className="text-zinc-500">目前所有持倉月份都有行情，這格沒有被使用</span>
                ) : (
                  <span className="text-amber-400">
                    {usingBackupMonths.map((m) => monthLabel(m)).join('、')} 正在用這格計價
                  </span>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      <CashFlowCard config={config} summary={summary} patch={patch} saveToCloud={saveToCloud} />

      {/* 記一筆交易：新倉買進／新倉賣出／平倉，對齊券商下單的「買賣別 × 倉別」 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-emerald-400/10 border border-emerald-400/30 grid place-items-center shrink-0"><Plus className="w-4 h-4 text-emerald-400" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">記一筆交易</h2></div>

        <div className="sm:max-w-xs">
          <Field label="動作" hint="就是券商下單畫面的「倉別」：新倉是開新部位，平倉是結清已經有的部位（可以只平一部分）。">
            <select
              value={form.mode}
              onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as 'long' | 'short' | 'close', lots: '', entry_price: '' }))}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100"
            >
              <option value="long">新倉買進（多單）</option>
              <option value="short">新倉賣出（空單）</option>
              <option value="close">平倉（結清已有部位）</option>
            </select>
          </Field>
        </div>

        {form.mode === 'close' ? (
          config.positions.length === 0 ? (
            <p className="text-xs text-zinc-500">目前沒有未平倉部位可以平。</p>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="col-span-2">
                  <Field label="要平的部位">
                    <select
                      value={form.close_id}
                      onChange={(e) => {
                        const id = e.target.value;
                        const t = config.positions.find((x) => x.id === id);
                        const tPP = t ? products[t.product] : undefined;
                        const tPriceInput: PriceInput = tPP ? { byMonth: tPP.prices, fallback: tPP.price } : priceInput;
                        // 選好部位就把口數帶成「全平」、價格帶成現價（用這筆部位自己商品的報價）——最常見的情況免手打
                        setForm((f) => ({
                          ...f,
                          close_id: id,
                          lots: t ? String(t.lots) : '',
                          entry_price: t ? String(priceOf(tPriceInput, t.month) || '') : '',
                        }));
                      }}
                      className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100"
                    >
                      <option value="">選擇…</option>
                      {config.positions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {Object.keys(products).length > 1 ? `${products[p.product]?.name ?? p.product}．` : ''}
                          {monthLabel(p.month)} {p.side === 'long' ? '多' : '空'} {p.lots} 口 @{px(p.entry_price)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="平倉口數" hint="可以只平一部分，剩下的留在原部位（停損價會跟著留著）。">
                  <input type="number" min="1" step="1" max={closeTarget?.lots} value={form.lots}
                    onChange={(e) => setForm((f) => ({ ...f, lots: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
                <Field label="平倉價">
                  <input type="number" step="0.05" value={form.entry_price}
                    onChange={(e) => setForm((f) => ({ ...f, entry_price: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
                <Field label="平倉日期">
                  <input type="date" value={form.entry_date}
                    onChange={(e) => setForm((f) => ({ ...f, entry_date: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
              </div>
              <button
                onClick={submitClose}
                disabled={!closeTarget || !(Number(form.lots) > 0) || !(Number(form.entry_price) > 0)}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" /> 確認平倉
              </button>
              {(() => {
                if (!closeTarget) return null;
                const n = Number(form.lots);
                const v = Number(form.entry_price);
                const res = closeLots(closeTarget, n, v, form.entry_date || todayStr());
                if (!res) {
                  return n > closeTarget.lots
                    ? <p className="text-[11px] text-amber-400">這筆只有 {closeTarget.lots} 口，平不了 {n} 口。</p>
                    : null;
                }
                const pnl = closedPnl(res.closed, closeTargetSpec);
                return (
                  <p className="text-[11px] text-zinc-500">
                    平掉 {n} 口 @{px(v)}：已實現損益約 <span className={`font-mono font-semibold ${pnlCls(pnl)}`}>{money(pnl)}</span>
                    （含來回手續費與期交稅），會結算進保證金專戶現金餘額。
                    {res.remaining && <>{'　'}這筆還會剩 {res.remaining.lots} 口。</>}
                  </p>
                );
              })()}
            </>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="到期月份">
                <select
                  value={form.month}
                  onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
                >
                  <option value="">選擇…</option>
                  {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              </Field>
              <Field label="口數">
                <input type="number" min="1" step="1" value={form.lots}
                  onChange={(e) => setForm((f) => ({ ...f, lots: e.target.value }))}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
              </Field>
              <Field label="進場價">
                <input type="number" step="0.05" value={form.entry_price}
                  onChange={(e) => setForm((f) => ({ ...f, entry_price: e.target.value }))}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
              </Field>
              <Field label="進場日期">
                <input type="date" value={form.entry_date}
                  onChange={(e) => setForm((f) => ({ ...f, entry_date: e.target.value }))}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
              </Field>
            </div>
            <button
              onClick={addPosition}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition"
            >
              <Plus className="w-3.5 h-3.5" /> 新增{form.mode === 'short' ? '空單' : '多單'}部位
            </button>
            {form.month && (
              <p className="text-[11px] text-zinc-500">
                {monthLabel(form.month)} 最後交易日 {lastTradingDay(form.month, holidays) ?? '—'}；
                {form.lots && Number(form.lots) > 0 && (
                  <> 這筆需要原始保證金 {money(activeProductCfg.spec.initial_margin * Number(form.lots))}。</>
                )}
              </p>
            )}
          </>
        )}
      </div>

      {/* 現有部位 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-3">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Layers className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">未平倉部位（{config.positions.length}）</h2></div>
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有部位。</p>
        ) : config.positions.map((p) => {
          // 每一筆用自己商品的規格/報價算，不是目前「帳戶」那格選到的那個
          const pp = products[p.product];
          const pPriceInput: PriceInput = pp ? { byMonth: pp.prices, fallback: pp.price } : priceInput;
          const pSpec = pp?.spec ?? spec;
          const mp = priceOf(pPriceInput, p.month);
          const r = positionPnl(p, mp, pSpec);
          const stop = config.stop_loss[p.id];
          const risk = stop ? stopLossRisk(p, stop, pSpec, summary.equity) : null;
          return (
            <div key={p.id} className="border border-border/70 rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {Object.keys(products).length > 1 && (
                  <span className="text-[10px] text-zinc-500">{pp?.name ?? p.product}</span>
                )}
                <span className="font-mono text-zinc-300">{monthLabel(p.month)}</span>
                <span className={p.side === 'long' ? 'text-bull' : 'text-bear'}>{p.side === 'long' ? '多' : '空'} {p.lots} 口</span>
                <span className="text-zinc-500">進場 {px(p.entry_price)}（{p.entry_date || '—'}）</span>
                <span className={`font-mono font-semibold ${pnlCls(r.net_pnl)}`}>{money(r.net_pnl)}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setCloseForm({ id: p.id, lots: String(p.lots), exit_price: String(mp || ''), exit_date: todayStr() })}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300"
                  >
                    平倉
                  </button>
                  <button onClick={() => removePosition(p.id)} className="text-zinc-500 hover:text-rose-400" title="刪除（不計入平倉損益）">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-zinc-500">停損價</span>
                <input
                  type="number"
                  step="0.05"
                  defaultValue={stop ?? ''}
                  onBlur={(e) => setStopLoss(p.id, parseFloat(e.target.value))}
                  className="w-24 bg-zinc-900 border border-border rounded px-2 py-1 font-mono text-zinc-100"
                  placeholder="未設"
                />
                {risk && (
                  <span className="text-zinc-500">
                    觸發最大損失 <span className={pnlCls(risk.loss)}>{money(risk.loss)}</span>
                    （{risk.ticks} 檔
                    {risk.pct_of_equity !== null && <>、佔權益數 {pct(Math.abs(risk.pct_of_equity))}</>}）
                  </span>
                )}
              </div>

              {closeForm?.id === p.id && (
                <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-border/50">
                  <div>
                    <div className="text-[10px] text-zinc-500 mb-1">口數（共 {p.lots}）</div>
                    <input type="number" min="1" step="1" max={p.lots} value={closeForm.lots}
                      onChange={(e) => setCloseForm({ ...closeForm, lots: e.target.value })}
                      className="w-16 bg-zinc-900 border border-border rounded px-2 py-1 text-xs font-mono text-zinc-100" />
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500 mb-1">平倉價</div>
                    <input type="number" step="0.05" value={closeForm.exit_price}
                      onChange={(e) => setCloseForm({ ...closeForm, exit_price: e.target.value })}
                      className="w-24 bg-zinc-900 border border-border rounded px-2 py-1 text-xs font-mono text-zinc-100" />
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500 mb-1">平倉日期</div>
                    <input type="date" value={closeForm.exit_date}
                      onChange={(e) => setCloseForm({ ...closeForm, exit_date: e.target.value })}
                      className="bg-zinc-900 border border-border rounded px-2 py-1 text-xs font-mono text-zinc-100" />
                  </div>
                  <button
                    onClick={() => {
                      const v = parseFloat(closeForm.exit_price);
                      const n = parseFloat(closeForm.lots);
                      if (Number.isFinite(v) && v > 0 && n > 0) closePosition(p, n, v, closeForm.exit_date);
                    }}
                    className="px-3 py-1.5 bg-primary text-white text-[11px] font-semibold rounded"
                  >
                    確認平倉
                  </button>
                  <button onClick={() => setCloseForm(null)} className="text-[11px] text-zinc-500 hover:text-zinc-300">取消</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 平倉紀錄 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm">
        <div className="flex items-center gap-2.5 mb-3"><span className="w-7 h-7 rounded-lg bg-zinc-400/10 border border-zinc-400/30 grid place-items-center shrink-0"><ListOrdered className="w-4 h-4 text-zinc-400" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">平倉紀錄（{config.closed.length}）</h2></div>
        {config.closed.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有平倉紀錄。平倉時會自動把損益結算進上方的保證金專戶現金餘額。</p>
        ) : (
          <>
          {/* 手機看不出這張表可以左右滑，補一句——否則會以為欄位就這幾個 */}
          <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  {Object.keys(products).length > 1 && <th className="text-left font-medium py-2 pr-3">商品</th>}
                  <th className="text-left font-medium py-2 pr-3">平倉日</th>
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-left font-medium py-2 pr-3">方向</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-right font-medium py-2 pr-3">進場</th>
                  <th className="text-right font-medium py-2 pr-3">出場</th>
                  <th className="text-right font-medium py-2 pr-3">損益</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {config.closed.map((t) => {
                  const tSpec = products[t.product]?.spec ?? spec;
                  return (
                  <tr key={t.id} className="border-b border-border/50 last:border-0">
                    {Object.keys(products).length > 1 && <td className="py-2 pr-3 text-zinc-400">{products[t.product]?.name ?? t.product}</td>}
                    <td className="py-2 pr-3 font-mono text-zinc-400">{t.exit_date || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(t.month)}</td>
                    <td className={`py-2 pr-3 ${t.side === 'long' ? 'text-bull' : 'text-bear'}`}>{t.side === 'long' ? '多' : '空'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{t.lots}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.entry_price)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.exit_price)}</td>
                    <td className={`py-2 pr-3 text-right font-mono font-semibold ${pnlCls(closedPnl(t, tSpec))}`}>{money(closedPnl(t, tSpec))}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => {
                          const next = patch((c) => ({
                            ...c,
                            closed: c.closed.filter((x) => x.id !== t.id),
                            cash: c.cash - closedPnl(t, tSpec), // 刪紀錄時把當初結算進去的損益扣回來
                          }));
                          void saveToCloud(next);
                        }}
                        className="text-zinc-600 hover:text-rose-400"
                        title="刪除這筆平倉紀錄（現金餘額會同步回沖）"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * 帳戶資金進出（入金／出金）流水帳。
 *
 * 為什麼不直接改上面那格現金餘額就好：入出金**不是損益**。直接改的話，權益數曲線
 * 會多出一段憑空的跳升／跳降並被當成賺賠——出金 20 萬會在圖上長出一段從來沒發生過
 * 的回撤。記成一筆一筆的流水帳後，現金餘額由這裡自動加減，權益曲線那邊也才能把
 * 外部資金扣掉再算真正的報酬率。
 *
 * 出金前會先試算「領走之後的權益數與風險指標」——期貨出金最常見的意外就是領完才
 * 發現風險指標掉進追繳區，那時候要再匯錢進來已經是隔天的事。
 */
const CashFlowCard: React.FC<{
  config: FuturesConfig;
  summary: Summary;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, summary, patch, saveToCloud }) => {
  const [form, setForm] = useState({ date: todayStr(), amount: '', note: '' });
  const flows = config.cash_flows;
  const totals = useMemo(() => summarizeCashFlows(flows), [flows]);
  // 新到舊排：最近的異動最常被回頭確認
  const sorted = useMemo(() => [...flows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), [flows]);

  const amt = Math.abs(parseFloat(form.amount));
  const valid = Number.isFinite(amt) && amt > 0;

  // 出金預覽：領走之後還剩多少、風險指標會掉到哪
  const equityAfterOut = summary.equity - (valid ? amt : 0);
  const riAfterOut = summary.required_initial > 0 ? equityAfterOut / summary.required_initial : null;
  // 顏色看的是「會不會被追繳」（權益數 vs 維持保證金），不是風險指標的 100%——
  // 風險指標 100% 只代表不能再開新倉，那是黃燈不是紅燈。
  const outTone = riAfterOut === null ? 'text-zinc-400'
    : equityAfterOut < summary.required_maintenance ? 'text-rose-400'
    : equityAfterOut < summary.required_initial ? 'text-amber-400'
    : 'text-emerald-400';

  const add = (type: CashFlow['type']) => {
    if (!valid) return;
    const flow: CashFlow = {
      id: `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      date: /^\d{4}-\d{2}-\d{2}$/.test(form.date) ? form.date : todayStr(),
      type,
      amount: amt,
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    };
    // 現金餘額跟著動：入金 +、出金 −（未實現損益不受影響，權益數自然跟著變）
    const next = patch((c) => ({
      ...c,
      cash_flows: [...c.cash_flows, flow],
      cash: c.cash + flowDelta(flow),
    }));
    setForm((f) => ({ ...f, amount: '', note: '' }));
    void saveToCloud(next);
  };

  const remove = (f: CashFlow) => {
    const next = patch((c) => ({
      ...c,
      cash_flows: c.cash_flows.filter((x) => x.id !== f.id),
      cash: c.cash - flowDelta(f), // 刪紀錄就把當初加減進去的錢還原
    }));
    void saveToCloud(next);
  };

  return (
    <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-cyan-400/10 border border-cyan-400/30 grid place-items-center shrink-0">
          <ArrowLeftRight className="w-4 h-4 text-cyan-400" />
        </span>
        <h2 className="text-sm font-bold text-zinc-100 tracking-wide">資金進出（入金／出金）</h2>
        {totals.count > 0 && (
          <span className="ml-auto text-[11px] text-zinc-500">
            淨投入 <span className="font-mono font-semibold text-zinc-300">{money(totals.net)}</span>
            <span className="text-zinc-600">（入 {money(totals.deposit)}／出 {money(totals.withdraw)}）</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="日期">
          <input type="date" value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
        </Field>
        <Field label="金額" hint="填正數就好，方向由下面的按鈕決定。">
          <input type="number" min="0" step="1000" value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            placeholder="例：100000"
            className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
        </Field>
        <div className="col-span-2">
          <Field label="備註（選填）">
            <input type="text" maxLength={100} value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="例：加碼保證金 / 獲利了結領回"
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100" />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => add('deposit')}
          disabled={!valid}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-500/90 text-white text-xs font-semibold rounded-lg hover:bg-emerald-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowDownCircle className="w-3.5 h-3.5" /> 入金（存進保證金專戶）
        </button>
        <button
          onClick={() => add('withdraw')}
          disabled={!valid}
          className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 border border-border text-zinc-200 text-xs font-semibold rounded-lg hover:bg-zinc-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowUpCircle className="w-3.5 h-3.5" /> 出金（領出）
        </button>
        {valid && (
          <span className="text-[11px] text-zinc-500">
            入金後現金 {money(config.cash + amt)}；
            出金後權益數 <span className={`font-mono ${outTone}`}>{money(equityAfterOut)}</span>
            {riAfterOut !== null && <>、風險指標 <span className={`font-mono ${outTone}`}>{pct(riAfterOut, 0)}</span></>}
          </span>
        )}
      </div>

      {valid && riAfterOut !== null && riAfterOut < 1 && (
        <p className="text-[11px] text-rose-400 font-semibold">
          ⚠ 這筆出金會讓權益數掉到維持保證金（{money(summary.required_maintenance)}）以下，風險指標剩 {pct(riAfterOut, 0)}，等於自己走進追繳區。要領這麼多請先減碼。
        </p>
      )}
      {valid && riAfterOut !== null && riAfterOut >= 1 && equityAfterOut < summary.required_initial && (
        <p className="text-[11px] text-amber-400">
          出金後權益數會低於所需原始保證金（{money(summary.required_initial)}），還不會被追繳，但不能再開新倉。
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="text-xs text-zinc-500">
          還沒有資金進出紀錄。在這裡新增，上面的「保證金專戶現金餘額」會自動加減，不用再手動改那一格；
          權益數走勢也會把入出金扣掉後才算報酬率與回撤。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                <th className="text-left font-medium py-2 pr-3">日期</th>
                <th className="text-left font-medium py-2 pr-3">類別</th>
                <th className="text-right font-medium py-2 pr-3">金額</th>
                <th className="text-left font-medium py-2 pr-3">備註</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <tr key={f.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-mono text-zinc-400">{f.date}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                      f.type === 'deposit'
                        ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
                        : 'text-zinc-300 border-zinc-500/30 bg-zinc-500/10'
                    }`}>
                      {f.type === 'deposit' ? <ArrowDownCircle className="w-3 h-3" /> : <ArrowUpCircle className="w-3 h-3" />}
                      {f.type === 'deposit' ? '入金' : '出金'}
                    </span>
                  </td>
                  <td className={`py-2 pr-3 text-right font-mono font-semibold tabular-nums ${f.type === 'deposit' ? 'text-emerald-400' : 'text-zinc-300'}`}>
                    {f.type === 'deposit' ? '+' : '−'}{money(f.amount).replace('-', '')}
                  </td>
                  <td className="py-2 pr-3 text-zinc-500">{f.note || '—'}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => remove(f)}
                      className="text-zinc-600 hover:text-rose-400"
                      title="刪除這筆（現金餘額會同步回沖）"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totals.count > 0 && (
        <p className="text-[11px] text-zinc-500 pt-1 border-t border-border/50">
          淨投入 {money(totals.net)}，目前權益數 {money(summary.equity)}
          {totals.net > 0 && (
            <>，累積損益 <span className={`font-mono font-semibold ${pnlCls(summary.equity - totals.net)}`}>
              {money(summary.equity - totals.net)}
            </span>（{pct((summary.equity - totals.net) / totals.net)}）</>
          )}
          。這個數字只有在「開戶以來每一筆入出金都記進來」時才成立，中途才開始記的話請當成起記日之後的淨投入。
        </p>
      )}
    </div>
  );
};

/**
 * 跟期貨商對帳。
 *
 * 兩件事：
 *
 * 1. **逐欄對照**——把期貨商 App「期貨資產總覽」那五格，跟本頁的對應值並排。
 *    對不上的時候要能一眼看出是哪一格，而不是只知道「總之不一樣」。
 *
 * 2. **反推現金餘額**——`cash` 全靠手動維護，久了一定會漂（手續費尾差、利息、
 *    忘了記的入出金）。填進期貨商的權益總值就能反推 cash 該是多少。
 *
 * ⚠️ 反推時用的是**毛**未平倉損益（`unrealized_gross`），不是本頁預設顯示的淨額。
 * 期貨商的權益總值裡沒有扣「出場那趟還沒發生的手續費與期交稅」，用淨額反推會把
 * 那一趟費用（14 口 × 30 元來回 ≈ 900 元）永久灌進 cash，而且每次對帳灌一次。
 */
const CashReconcile: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, spec, summary, patch, saveToCloud }) => {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const actual = parseFloat(raw);
  const valid = Number.isFinite(actual);
  const impliedCash = valid ? actual - summary.unrealized_gross : 0;
  const diff = valid ? impliedCash - config.cash : 0;

  // 期貨商口徑：權益總值用毛損益，可動用＝權益總值 − 原始保證金，風險指標分母是原始保證金
  const brokerAvailable = summary.equity_broker - summary.required_initial;
  const brokerRi = summary.required_initial > 0 ? summary.equity_broker / summary.required_initial : null;
  // 多商品時各自保證金不同，「口數 × 單一 spec」這個乘法標籤不成立，只在單商品時顯示算式
  const multiProduct = Object.keys(config.products).length > 1;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
        跟期貨商對帳…
      </button>
    );
  }

  return (
    <div className="bg-zinc-900/40 border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-200">跟期貨商對帳</h3>
        <button onClick={() => { setOpen(false); setRaw(''); }} className="text-[11px] text-zinc-500 hover:text-zinc-300">收起</button>
      </div>
      <p className="text-[11px] text-zinc-500">
        打開期貨商 App 的「期貨資產總覽」，把下表六格逐欄比對。
        {summary.total_lots > 0 && ' 全部對得上就代表口數、進場價、保證金設定與現金餘額都是對的。'}
      </p>
      {summary.total_lots > 0 && (
        <dl className="text-xs space-y-1.5 bg-zinc-900/50 border border-border rounded-lg p-3">
          <Row label="權益總值" value={money(summary.equity_broker)} cls="text-zinc-100"
            hint="現金餘額 ＋ 毛未平倉損益。期貨商不會先扣還沒發生的出場費用，所以這裡用毛額——跟本頁上方那個「保證金權益數」差一趟來回手續費與期交稅，兩個都對，只是口徑不同。" />
          <Row label="未平倉損益" value={money(summary.unrealized_gross)} cls={pnlCls(summary.unrealized_gross)}
            hint="純價差，不扣費用。本頁上方顯示的是扣掉來回費用的淨額。" />
          <Row label={multiProduct ? '原始保證金（逐商品加總）' : `原始保證金（${summary.total_lots} 口 × ${money(spec.initial_margin)}）`} value={money(summary.required_initial)} />
          <Row label={multiProduct ? '維持率保證金（逐商品加總）' : `維持率保證金（${summary.total_lots} 口 × ${money(spec.maintenance_margin)}）`} value={money(summary.required_maintenance)}
            hint="這兩格對不上，就是「契約規格與費用」裡的保證金填錯了——期貨商調整保證金時要回來改。" />
          <Row label="可動用保證金" value={money(brokerAvailable)} cls={brokerAvailable >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            hint="權益總值 − 原始保證金。" />
          <Row label="風險指標(%)" value={brokerRi === null ? '—' : pct(brokerRi, 1)} cls="text-zinc-100"
            hint="權益總值 ÷ 原始保證金。低於 25% 盤中代為沖銷。" />
        </dl>
      )}
      <p className="text-[11px] text-zinc-500">
        權益總值對不上的話，填進來反推本頁的現金餘額該是多少——手續費尾差、利息、忘了記的入出金都會在這裡現形。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="期貨商顯示的權益總值">
          <input
            type="number"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={String(Math.round(summary.equity_broker))}
            className="w-36 bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
          />
        </Field>
        {valid && (
          <>
            <dl className="text-xs space-y-1 min-w-[220px]">
              <Row label="本頁毛未平倉損益" value={money(summary.unrealized_gross)} cls={pnlCls(summary.unrealized_gross)} />
              <Row label="反推現金餘額應為" value={money(impliedCash)} cls="text-zinc-100" />
              <Row label="與目前設定的差額" value={money(diff)}
                cls={Math.abs(diff) < 1 ? 'text-emerald-400' : 'text-amber-400'} />
            </dl>
            {Math.abs(diff) < 1 ? (
              <span className="text-[11px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> 完全對得上</span>
            ) : (
              <button
                onClick={() => {
                  void saveToCloud(patch((c) => ({ ...c, cash: impliedCash })));
                  setOpen(false);
                  setRaw('');
                }}
                className="px-3 py-2 bg-primary text-white text-[11px] font-semibold rounded-lg hover:bg-primary/90 transition"
              >
                校正現金餘額為 {money(impliedCash)}
              </button>
            )}
          </>
        )}
      </div>
      {valid && Math.abs(diff) >= 1 && (
        <p className="text-[11px] text-zinc-500">
          差額若很大（超過幾百元），先確認是不是漏記了入出金或平倉——直接校正會把那筆歷史吞掉，
          之後就查不出來了。
        </p>
      )}
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <div className="text-[11px] text-zinc-500 mb-1" title={hint}>{label}</div>
    {children}
  </div>
);

// ── 到期 & 轉倉 ─────────────────────────────────────────────────────────────

const RolloverTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  alerts: ReturnType<typeof rolloverAlerts>;
  quoteMonths: FuturesMonthQuote[];
  holidays: Set<string> | undefined;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
  products: Record<string, ProductConfig>;
  activeCode: string;
}> = ({ config, spec, alerts, quoteMonths, holidays, patch, saveToCloud, products, activeCode }) => {
  // 一鍵轉倉／轉倉成本試算只管「帳戶」那格選到的商品——quoteMonths（真實同步抓的行情）
  // 本來就只涵蓋那個商品，近月候選也要跟著篩，否則月份代碼在不同商品間撞號時會誤轉錯商品的部位。
  const activeProductCfg = products[activeCode];
  const multiProduct = Object.keys(products).length > 1;
  const ownPositions = useMemo(() => config.positions.filter((p) => p.product === activeCode), [config.positions, activeCode]);
  const ownMonths = useMemo(() => [...new Set(ownPositions.map((p) => p.month))].sort(), [ownPositions]);
  // 預設把「最快到期的持倉月份」填進近月，省得每次自己選
  const dueMonth = alerts.find((a) => a.product === activeCode && (a.due || a.expired))?.month ?? ownMonths[0] ?? '';
  const [near, setNear] = useState(dueMonth);
  const [far, setFar] = useState('');
  const [lots, setLots] = useState('');

  const marketPrice = (m: string) => {
    const q = quoteMonths.find((x) => x.month === m);
    return q?.settlement ?? q?.last ?? activeProductCfg.prices[m] ?? 0;
  };
  const cost = useMemo(() => {
    const n = parseFloat(lots);
    if (!near || !far || !(n > 0)) return null;
    const np = marketPrice(near);
    const fp = marketPrice(far);
    if (!(np > 0) || !(fp > 0)) return null;
    return { ...rolloverCost(n, np, fp, spec), np, fp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, far, lots, quoteMonths, spec, activeProductCfg.prices]);

  // 一鍵轉倉可以處理的部位＝近月「這個商品」所有未平倉部位
  const nearPositions = useMemo(
    () => ownPositions.filter((p) => p.month === near && p.lots > 0),
    [ownPositions, near],
  );
  const nearLots = nearPositions.reduce((s, p) => s + p.lots, 0);
  const canRoll = Boolean(near && far && near !== far && nearPositions.length > 0
    && marketPrice(near) > 0 && marketPrice(far) > 0);

  /**
   * 一鍵轉倉＝把近月部位全部平掉、在遠月用同方向同口數重建。
   *
   * 手動做要「平倉」＋「新增部位」兩步，漏一步帳就歪了（而且轉倉常常在到期前
   * 最忙的那天做）。這裡一次做完並把平倉損益結算進保證金專戶現金，跟手動平倉
   * 走的是同一條路徑。進場價用遠月的市價——實際成交價之後可以再改。
   */
  const doRollover = () => {
    const np = marketPrice(near);
    const fp = marketPrice(far);
    if (!canRoll) return;
    if (!window.confirm(
      `把 ${monthLabel(near)} 的 ${nearLots} 口全部轉到 ${monthLabel(far)}？\n\n`
      + `平倉價 ${px(np)}（${monthLabel(near)}）→ 進場價 ${px(fp)}（${monthLabel(far)}）\n`
      + `會產生 ${nearPositions.length} 筆平倉紀錄，損益結算進保證金專戶現金。\n`
      + `實際成交價不同的話，之後可以在部位頁改。`,
    )) return;

    const stamp = Date.now();
    const today = todayStr();
    const next = patch((c) => {
      const rolling = c.positions.filter((p) => p.month === near && p.product === activeCode && p.lots > 0);
      const closedNew: ClosedTrade[] = rolling.map((p, i) => ({
        id: `c_${stamp}_${i}`,
        product: p.product,
        month: p.month, side: p.side, lots: p.lots,
        entry_price: p.entry_price, exit_price: np, exit_date: today,
        note: `轉倉至 ${monthLabel(far)}`,
      }));
      const opened: FuturesPosition[] = rolling.map((p, i) => ({
        id: `f_${stamp}_${i}`,
        product: p.product,
        month: far, side: p.side, lots: p.lots,
        entry_price: fp, entry_date: today,
        note: `由 ${monthLabel(near)} 轉倉`,
      }));
      const rolledIds = new Set(rolling.map((p) => p.id));
      return {
        ...c,
        positions: [...c.positions.filter((p) => !rolledIds.has(p.id)), ...opened],
        closed: [...c.closed, ...closedNew],
        cash: c.cash + closedNew.reduce((s, t) => s + closedPnl(t, spec), 0),
        // 停損價是掛在舊部位 id 上的，轉倉後那些 id 不存在了；normalizeFutures
        // 會自動清掉孤兒，這裡不用特別處理
      };
    });
    setNear(far);
    setFar('');
    void saveToCloud(next);
  };

  return (
    <div className="space-y-5">
      {/* 一鍵轉倉 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><RefreshCw className="w-4 h-4 text-primary" /></span>
          <h2 className="text-sm font-bold text-zinc-100 tracking-wide">一鍵轉倉</h2>
        </div>
        {ownPositions.length === 0 ? (
          <p className="text-xs text-zinc-500">{activeProductCfg.name} 目前沒有未平倉部位。</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label={`平掉的月份（近月・${activeProductCfg.name}）`}>
                <select value={near} onChange={(e) => setNear(e.target.value)}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
                  <option value="">選擇…</option>
                  {ownMonths.map((m) => (
                    <option key={m} value={m}>{monthLabel(m)}（{marketPrice(m) > 0 ? px(marketPrice(m)) : '無報價'}）</option>
                  ))}
                </select>
              </Field>
              <Field label="轉入的月份（遠月）">
                <select value={far} onChange={(e) => setFar(e.target.value)}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
                  <option value="">選擇…</option>
                  {quoteMonths.filter((m) => m.month !== near).map((m) => (
                    <option key={m.month} value={m.month}>{monthLabel(m.month)}（{px(marketPrice(m.month))}）</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <button
                  onClick={doRollover}
                  disabled={!canRoll}
                  className="w-full px-4 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 disabled:bg-zinc-800 disabled:text-zinc-600 transition"
                >
                  {nearPositions.length > 0 ? `轉倉 ${nearLots} 口` : '轉倉'}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500">
              會把近月所有部位平掉（產生平倉紀錄、損益結算進現金），並在遠月用<strong className="text-zinc-400">同方向同口數</strong>重建。
              進場價先用遠月市價，實際成交價不同的話到「部位 &amp; 平倉紀錄」改。
              {quoteMonths.length === 0 && <strong className="text-amber-400"> 還沒抓行情，先按頁面上方的「真實同步」。</strong>}
            </p>
          </>
        )}
      </div>

      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-3">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-amber-400/10 border border-amber-400/30 grid place-items-center shrink-0"><CalendarClock className="w-4 h-4 text-amber-400" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">持倉月份到期狀態</h2></div>
        {alerts.length === 0 ? (
          <p className="text-xs text-zinc-500">目前沒有未平倉部位。</p>
        ) : (
          <>
          {/* 手機看不出這張表可以左右滑，補一句——否則會以為欄位就這幾個 */}
          <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  {multiProduct && <th className="text-left font-medium py-2 pr-3">商品</th>}
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-left font-medium py-2 pr-3">最後交易日</th>
                  <th className="text-right font-medium py-2 pr-3">剩餘交易日</th>
                  <th className="text-right font-medium py-2 pr-3">日曆天</th>
                  <th className="text-left font-medium py-2">狀態</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={`${a.product}-${a.month}`} className="border-b border-border/50 last:border-0">
                    {multiProduct && <td className="py-2 pr-3 text-zinc-400">{products[a.product]?.name ?? a.product}</td>}
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(a.month)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.lots}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-400">
                      {a.last_trading_day ?? '—'}
                      {a.holiday_adjusted && <span className="text-amber-400 ml-1" title="第三個星期三休市，已順延至次一營業日">順延</span>}
                      {!a.calendar_known && <span className="text-zinc-600 ml-1" title="沒有這一年的休市日曆，日期未經假日校正">*</span>}
                    </td>
                    <td className={`py-2 pr-3 text-right font-mono ${
                      a.level === 'expired' || a.level === 'urgent' ? 'text-rose-400' : a.level === 'soon' ? 'text-amber-400' : 'text-zinc-300'
                    }`}>
                      {a.trading_days_left ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{a.days_left ?? '—'}</td>
                    <td className="py-2 text-[11px]">
                      {a.level === 'expired' ? <span className="text-rose-400">已到期</span>
                        : a.level === 'urgent' ? <span className="text-rose-400">剩兩個交易日內</span>
                        : a.level === 'soon' ? <span className="text-amber-400">該轉倉了</span>
                        : <span className="text-zinc-500">還早</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
        <p className="text-[11px] text-zinc-500">
          最後交易日＝到期月份的第三個星期三；該日休市時<strong className="text-zinc-400">順延至次一營業日</strong>（期交所明文規定）。
          休市日曆抓自證交所 OpenAPI，<strong className="text-zinc-400">只涵蓋當年度</strong>——標 <span className="font-mono">*</span> 的月份查不到日曆，是未經校正的第三個星期三。
          國內股票／ETF／指數期貨的<strong className="text-zinc-400">最後結算日就是最後交易日</strong>（結算價取到期日當天收盤前的平均價），
          沒有「次一營業日結算」那回事，那是國外指數期貨的規則。
        </p>
      </div>

      {/* 轉倉成本試算 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><CalendarSync className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">轉倉成本試算</h2></div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="平掉的月份（近月）">
            <select value={near} onChange={(e) => setNear(e.target.value)}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
              <option value="">選擇…</option>
              {quoteMonths.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}（{px(marketPrice(m.month))}）</option>)}
            </select>
          </Field>
          <Field label="建立的月份（遠月）">
            <select value={far} onChange={(e) => setFar(e.target.value)}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
              <option value="">選擇…</option>
              {quoteMonths.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}（{px(marketPrice(m.month))}）</option>)}
            </select>
          </Field>
          <Field label="口數">
            <input type="number" min="1" step="1" value={lots} onChange={(e) => setLots(e.target.value)}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
          </Field>
        </div>
        {quoteMonths.length === 0 && (
          <p className="text-[11px] text-amber-400">還沒有行情資料，先按頁面上方的「抓最新行情」。</p>
        )}
        {cost && (
          <dl className="space-y-2 text-xs pt-2 border-t border-border/50">
            <Row label={`月份價差（${px(cost.fp)} − ${px(cost.np)}）`} value={`${cost.spread >= 0 ? '+' : ''}${cost.spread.toFixed(2)}`}
              cls={cost.spread >= 0 ? 'text-rose-400' : 'text-emerald-400'} />
            <Row label="價差成本" value={money(cost.spread_cost)} cls={cost.spread_cost >= 0 ? 'text-rose-400' : 'text-emerald-400'}
              hint="正價差（遠月較貴）時轉倉要多付這段；逆價差反而是收入。" />
            <Row label="手續費（平近月＋建遠月）" value={money(cost.fees)} />
            <Row label="期交稅" value={money(cost.tax)} />
            <Row label="轉倉總成本" value={money(cost.total)} cls={cost.total >= 0 ? 'text-rose-400' : 'text-emerald-400'} />
          </dl>
        )}
      </div>

      {/* 各月份行情 */}
      {quoteMonths.length > 0 && (
        <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-2.5 mb-3"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><LineChart className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">{activeProductCfg.name} 各月份行情（期交所每日行情）</h2></div>
          {/* 手機看不出這張表可以左右滑，補一句——否則會以為欄位就這幾個 */}
          <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-right font-medium py-2 pr-3">結算價</th>
                  <th className="text-right font-medium py-2 pr-3">收盤</th>
                  <th className="text-right font-medium py-2 pr-3">漲跌</th>
                  <th className="text-right font-medium py-2 pr-3">成交量</th>
                  <th className="text-right font-medium py-2 pr-3">未平倉</th>
                  <th className="text-left font-medium py-2">最後交易日</th>
                </tr>
              </thead>
              <tbody>
                {quoteMonths.map((m) => (
                  <tr key={m.month} className={`border-b border-border/50 last:border-0 ${m.month === activeProductCfg.price_month ? 'bg-primary/5' : ''}`}>
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(m.month)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-100">{m.settlement !== null ? px(m.settlement) : '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-400">{m.last !== null ? px(m.last) : '—'}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${m.change === null ? 'text-zinc-500' : pnlCls(m.change)}`}>
                      {m.change !== null ? `${m.change >= 0 ? '+' : ''}${m.change.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-400">{m.volume?.toLocaleString() ?? '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-400">{m.open_interest?.toLocaleString() ?? '—'}</td>
                    <td className="py-2 font-mono text-zinc-500">
                      {(() => {
                        const d = lastTradingDay(m.month, holidays);
                        const left = d ? tradingDaysBetween(todayStr(), d, holidays) : null;
                        return (
                          <>
                            {d ?? '—'}
                            {left !== null && <span className="text-zinc-600">（{left} 個交易日）</span>}
                          </>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-zinc-500 mt-3">
            未平倉量最大的月份就是主力月，轉倉一般轉到那一個。結算價只有一般交易時段有，
            夜盤那筆沒有結算價，故此表以日盤資料為準。
          </p>
        </div>
      )}
    </div>
  );
};

// ── 共用輸入元件 ────────────────────────────────────────────────────────────

/**
 * 非受控數字輸入＋key：跟頁面其他地方同一套做法。
 * 受控輸入在「打字中途 → 寫回 store → 重繪」的路徑上會被 normalize 蓋掉游標，
 * 所以一律等 blur 才提交。
 */
const NumInput: React.FC<{
  value: number;
  step?: string;
  min?: string;
  onCommit: (v: number) => void;
  placeholder?: string;
  className?: string;
}> = ({ value, step = '1', min, onCommit, placeholder, className }) => (
  <input
    key={`n-${value}`}
    type="number"
    step={step}
    min={min}
    defaultValue={Number.isFinite(value) ? value : ''}
    placeholder={placeholder}
    onBlur={(e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) onCommit(v);
    }}
    className={className ?? 'w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100'}
  />
);

// ── 壓力測試 ────────────────────────────────────────────────────────────────

const STRESS_TONE: Record<string, { cls: string; tone: Tone; label: string }> = {
  flat: { cls: 'text-zinc-500', tone: 'zinc', label: '已全數出場' },
  ok: { cls: 'text-emerald-400', tone: 'emerald', label: '正常持倉' },
  warn: { cls: 'text-amber-400', tone: 'amber', label: '低於原始保證金' },
  call: { cls: 'text-orange-400', tone: 'orange', label: '黃牌追繳' },
  danger: { cls: 'text-rose-400 font-semibold', tone: 'rose', label: '紅牌斷頭' },
};

const STRESS_PRESETS: { label: string; drops: number[] }[] = [
  { label: '一般回檔', drops: [-0.05, -0.03, 0.02, 0.03, 0.05, 0.08, 0.1, 0.12] },
  { label: '預設（漲跌兩側）', drops: [...DEFAULT_PLANNER.stress_drops] },
  { label: '歷史級崩盤', drops: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
  { label: '軋空（只看上漲）', drops: [-0.03, -0.05, -0.1, -0.15, -0.2, -0.3] },
];

/** 大盤變動的顯示：正值＝跌（紅），負值＝漲（綠） */
const moveText = (d: number) => (d >= 0 ? `-${(d * 100).toFixed(0)}%` : `+${(-d * 100).toFixed(0)}%`);

const StressTab: React.FC<{
  summary: Summary;
  stress: StressRow[];
  beta: number;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
  products: Record<string, ProductConfig>;
  activeCode: string;
}> = ({ summary, stress, beta, patch, saveToCloud, products, activeCode }) => {
  const hasIndexRef = Object.values(products).some((p) => p.index_ref > 0);
  const setDrops = (drops: number[]) => {
    void saveToCloud(patch((c) => ({
      ...c,
      planner: { ...c.planner, [activeCode]: { ...c.planner[activeCode], stress_drops: drops } },
    })));
  };

  // 摘要只看下跌側（drop > 0）——上漲情境對淨多單本來就沒有風險可言
  const downside = useMemo(() => stress.filter((r) => r.drop > 0), [stress]);
  // 「撐得住幾 %」＝下跌側最後一個還沒進入追繳區的情境
  const survivable = useMemo(() => {
    let last: StressRow | null = null;
    for (const r of downside) {
      if (r.status === 'call' || r.status === 'danger') break;
      last = r;
    }
    return last;
  }, [downside]);
  const firstCall = downside.find((r) => r.status === 'call' || r.status === 'danger') ?? null;
  const firstDanger = downside.find((r) => r.status === 'danger') ?? null;
  const anyStops = stress.some((r) => r.stopped_lots > 0);

  if (summary.total_lots === 0) {
    return (
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm">
        <p className="text-xs text-zinc-500">目前沒有未平倉部位，沒有東西可以壓力測試。先到「部位 &amp; 平倉紀錄」新增，或到「建倉 &amp; 出場試算」規劃一個組合。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="撐得住的最大跌幅"
          value={survivable ? `-${(survivable.drop * 100).toFixed(0)}%` : '＜表列最小情境'}
          sub={survivable ? `權益數還有 ${money(survivable.equity)}` : '目前部位已在警戒區'}
          cls={survivable ? 'text-emerald-400' : 'text-rose-400'}
          tone={survivable ? 'emerald' : 'rose'}
          icon={<ShieldCheck className="w-3 h-3" />}
          hint="表列情境中，最後一個仍未觸發追繳的跌幅。"
        />
        <StatCard
          label="開始追繳（黃牌）"
          value={firstCall ? `-${(firstCall.drop * 100).toFixed(0)}%` : '表列情境內都不會'}
          sub={firstCall ? `價格 ${px(firstCall.price_after)}` : `追繳價 ${summary.margin_call_price !== null ? px(summary.margin_call_price) : '—'}`}
          cls={firstCall ? 'text-orange-400' : 'text-emerald-400'}
          tone={firstCall ? 'amber' : 'emerald'}
          icon={<AlertTriangle className="w-3 h-3" />}
        />
        <StatCard
          label="開始斷頭（紅牌）"
          value={firstDanger ? `-${(firstDanger.drop * 100).toFixed(0)}%` : '表列情境內都不會'}
          sub={firstDanger ? `價格 ${px(firstDanger.price_after)}` : `斷頭價 ${summary.liquidation_price !== null ? px(summary.liquidation_price) : '—'}`}
          cls={firstDanger ? 'text-rose-400' : 'text-emerald-400'}
          tone={firstDanger ? 'rose' : 'emerald'}
          icon={<Flame className="w-3 h-3" />}
        />
      </div>

      <Panel
        title="大盤暴跌壓力測試矩陣"
        icon={<Flame className="w-4 h-4" />}
        tone="amber"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-zinc-600 mr-1">試算不同修正幅度下的帳戶衝擊</span>
            {STRESS_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setDrops(p.drops)}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition"
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      >
        <p className="sm:hidden text-[10px] text-zinc-600 mb-1.5">← 左右滑動可看完整欄位 →</p>
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[780px] text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                <th className="text-left font-semibold py-2.5 pr-3">大盤修正</th>
                {hasIndexRef && <th className="text-right font-semibold py-2.5 pr-3">預估加權指數</th>}
                <th className="text-right font-semibold py-2.5 pr-3">預估標的價格</th>
                <th className="text-right font-semibold py-2.5 pr-3">未實現損益</th>
                <th className="text-right font-semibold py-2.5 pr-3">帳戶剩餘淨值</th>
                <th className="text-right font-semibold py-2.5 pr-3">超額保證金</th>
                <th className="text-right font-semibold py-2.5 pr-3">預估風險指標</th>
                {anyStops && <th className="text-right font-semibold py-2.5 pr-3">停損出場</th>}
                <th className="text-left font-semibold py-2.5">帳戶狀態評估</th>
              </tr>
            </thead>
            <tbody>
              {stress.map((r) => {
                const tone = STRESS_TONE[r.status] ?? STRESS_TONE.flat;
                return (
                  <tr
                    key={r.drop}
                    className={`border-b border-border/40 last:border-0 transition-colors hover:bg-zinc-800/40 ${
                      r.drop < 0 ? 'bg-emerald-500/[0.04]' : r.status === 'danger' ? 'bg-rose-500/[0.06]' : ''
                    }`}
                  >
                    <td className={`py-2.5 pr-3 font-mono font-bold tabular-nums ${r.drop >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {moveText(r.drop)}
                    </td>
                    {hasIndexRef && (
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-400">
                        {r.index_after !== null ? Math.round(r.index_after).toLocaleString() : '—'}
                      </td>
                    )}
                    <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-300">{px(r.price_after)}</td>
                    <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${pnlCls(r.unrealized)}`}>{money(r.unrealized)}</td>
                    <td className={`py-2.5 pr-3 text-right font-mono tabular-nums font-bold ${r.equity < 0 ? 'text-rose-500' : 'text-zinc-100'}`}>{money(r.equity)}</td>
                    <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${r.excess >= 0 ? 'text-zinc-400' : 'text-amber-400'}`}>{money(r.excess)}</td>
                    <td className={`py-2.5 pr-3 text-right font-mono tabular-nums font-semibold ${tone.cls}`}>
                      {r.risk_indicator !== null ? `${(r.risk_indicator * 100).toFixed(1)}%` : '—'}
                    </td>
                    {anyStops && (
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-[11px]">
                        {r.stopped_lots > 0
                          ? <span className="text-cyan-400">{r.stopped_lots} 口 <span className={pnlCls(r.stop_realized)}>{money(r.stop_realized)}</span></span>
                          : <span className="text-zinc-600">—</span>}
                      </td>
                    )}
                    <td className="py-2.5">
                      <Chip tone={tone.tone}>{tone.label}</Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-zinc-500 mt-4">
          每一列都是把各月份報價按比例換掉、重跑一次總覽頁那組算式，所以費用、期交稅、多空對沖的處理完全一致。
          標的變動 ＝ 大盤變動 × beta（目前 {beta.toFixed(2)}）。綠底列是<strong className="text-zinc-400">上漲</strong>情境（空單看的是那一側）。
          {anyStops
            ? <> 已設停損的部位<strong className="text-zinc-400">會在觸價時出場</strong>——損益實現進專戶、佔用的保證金一併釋放，剩下的部位才繼續承受行情。</>
            : <> 目前沒有部位設停損，所以表格假設你一路抱到斷頭；到「部位 &amp; 平倉紀錄」設停損價後這裡會改成模擬觸價出場。</>}
          <strong className="text-zinc-400"> 這仍是靜態測試</strong>：假設你不加碼、不減碼、不補錢，
          而且保證金維持現在的水準——實際崩盤時期交所通常會<strong className="text-zinc-400">調高</strong>保證金、
          停損也常因跳空而滑價，斷頭會比表上更早發生。
        </p>
      </Panel>
    </div>
  );
};

// ── 建倉 & 出場試算 ─────────────────────────────────────────────────────────

const PlannerTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  plan: ReturnType<typeof targetPlan>;
  priceInput: PriceInput;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
  products: Record<string, ProductConfig>;
  activeCode: string;
}> = ({ config, spec, summary, plan, priceInput, patch, saveToCloud, products, activeCode }) => {
  const activeProduct = products[activeCode];
  // 歷史校準（槓桿體檢／加碼減碼計畫）只針對 0050（SRF/NYF）——見下方大區塊的說明
  const isCalibratedUnderlying = activeCode === 'SRF' || activeCode === 'NYF';
  // 這個商品自己的未平倉部位——建倉試算是「規劃這個商品該怎麼加碼/出場」，
  // 不能把其他商品的部位也算進來
  const ownPositions = useMemo(
    () => config.positions.filter((pos) => pos.product === activeCode),
    [config.positions, activeCode],
  );
  const p = config.planner[activeCode] ?? DEFAULT_PLANNER;
  // 有部位時以參考月份的價格為基準，沒部位時用手填的參考價（建倉試算的情境）
  const refPrice = summary.total_lots > 0 && summary.reference_product === activeCode
    ? summary.reference_price
    : activeProduct.price;
  // 滑桿拖曳中要即時更新「建議口數／目標價」，但不能每動一格就打雲端，所以本地先 state、
  // 放開才存。store 被別處改掉時（雲端載入、還原預設值）用 React 官方的「render 期間
  // 校正 state」寫法同步回來——比 useEffect 少一次串聯重繪，也不會被 lint 擋。
  const [lev, setLev] = useState(p.target_leverage);
  const [gain, setGain] = useState(p.gain_pct);
  const [synced, setSynced] = useState({ lev: p.target_leverage, gain: p.gain_pct });
  if (synced.lev !== p.target_leverage || synced.gain !== p.gain_pct) {
    setSynced({ lev: p.target_leverage, gain: p.gain_pct });
    setLev(p.target_leverage);
    setGain(p.gain_pct);
  }

  const setPlanner = (u: (x: PlannerConfig) => PlannerConfig, persist = true) => {
    const next = patch((c) => ({
      ...c,
      planner: { ...c.planner, [activeCode]: u(c.planner[activeCode] ?? DEFAULT_PLANNER) },
    }));
    if (persist) void saveToCloud(next);
    return next;
  };

  const capital = p.capital > 0 ? p.capital : config.cash;
  const suggestion = useMemo(
    () => suggestLots(capital, refPrice, lev, spec),
    [capital, refPrice, lev, spec],
  );

  /*
    分批試算的第 1 筆＝真實持倉（唯讀，按「更新」才重抓），第 2、3 筆才是手打的加碼。
    刻意不自動同步：試算到一半被行情或平倉改掉數字，會讓算出來的東西無法解釋——
    要不要把新的持倉吃進來是使用者的決定，這裡只負責在漂掉時提醒。
  */
  const live = useMemo(() => holdingAsBatch(ownPositions), [ownPositions]);
  const b0 = p.batches[0] ?? { price: 0, lots: 0 };
  // 價格用 0.005 當容差：存進去的是完整精度，顯示只到小數點兩位，硬比會永遠說「不同步」
  const holdingDrift = b0.lots !== live.lots || Math.abs(b0.price - live.avg_price) > 0.005;

  /*
    按「更新」時，如果第 1 筆本來就等於現在的持倉，畫面上不會有任何變化——那看起來
    跟按鈕壞掉一模一樣（實際回報過的問題）。所以按下去一定要有回饋：真的有帶入新數字
    就說「已更新」，本來就是最新的就說「已是最新」，1.6 秒後復原。
  */
  const [pullMsg, setPullMsg] = useState<'updated' | 'same' | null>(null);
  const pullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashPull = (m: 'updated' | 'same') => {
    setPullMsg(m);
    if (pullTimer.current) clearTimeout(pullTimer.current);
    pullTimer.current = setTimeout(() => setPullMsg(null), 1600);
  };
  useEffect(() => () => { if (pullTimer.current) clearTimeout(pullTimer.current); }, []);

  const pullHolding = () => {
    if (!holdingDrift) { flashPull('same'); return; }
    setPlanner((x) => ({
      ...x,
      batches: x.batches.map((y, j) => (j === 0 ? { price: live.avg_price, lots: live.lots } : y)),
    }));
    flashPull('updated');
  };

  // 清空只動這張卡的試算欄位，實際部位不受影響（第 1 筆隨時可以按「更新」重抓回來）
  const clearBatch = (i: number) => setPlanner((x) => ({
    ...x, batches: x.batches.map((y, j) => (j === i ? { price: 0, lots: 0 } : y)),
  }));
  // 兩段式：第一下先變成「確定清空？」，3 秒內沒再按就自己縮回去。不用 confirm 彈窗。
  const [armClearAll, setArmClearAll] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const clearAll = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    if (!armClearAll) {
      setArmClearAll(true);
      armTimer.current = setTimeout(() => setArmClearAll(false), 3000);
      return;
    }
    setArmClearAll(false);
    setPlanner((x) => ({ ...x, batches: x.batches.map(() => ({ price: 0, lots: 0 })) }));
  };
  const allEmpty = p.batches.every((b) => !(b.price > 0) && !(b.lots > 0));

  // 分批進場：用假想部位跑一次總覽的算式，直接看到這個組合的風險長相
  const batch = useMemo(() => weightedEntry(p.batches, spec), [p.batches, spec]);
  const batchSim = useMemo(() => {
    if (!(batch.lots > 0) || !(batch.avg_price > 0)) return null;
    const virtual: FuturesPosition[] = [{
      id: '_batch', product: activeCode, month: '', side: 'long', lots: batch.lots,
      entry_price: batch.avg_price, entry_date: '',
    }];
    return summarizeAccount(virtual, refPrice > 0 ? refPrice : batch.avg_price, spec, capital);
  }, [batch, refPrice, spec, capital, activeCode]);

  const peak = p.trailing_peak > 0 ? p.trailing_peak : plan.target_price;
  const trailing = useMemo(
    () => trailingStopPlan(ownPositions, spec, priceInput, peak, p.trailing_dist),
    [ownPositions, spec, priceInput, peak, p.trailing_dist],
  );

  /*
    歷史校準區塊。三個純函式全部吃「本金 + 現價 + spec」，跟頁面其他地方共用同一組
    風控算式（leverageLadder 內部就是呼叫 summarizeAccount），所以這裡的追繳價／斷頭價
    跟總覽頁不會出現兩套數字。
  */
  const [baseLev, setBaseLev] = useState(p.plan_base_leverage);
  const [syncedBase, setSyncedBase] = useState(p.plan_base_leverage);
  if (syncedBase !== p.plan_base_leverage) {
    setSyncedBase(p.plan_base_leverage);
    setBaseLev(p.plan_base_leverage);
  }

  const ladder = useMemo(() => leverageLadder(capital, refPrice, spec), [capital, refPrice, spec]);
  const calPlan = useMemo(
    () => entryPlan(capital, refPrice, spec, { base_leverage: baseLev, peak_price: p.plan_peak }),
    [capital, refPrice, spec, baseLev, p.plan_peak],
  );
  // 加滿碼之後的斷頭價：借一格 ladder 來算，參數同一套
  const maxRow = useMemo(
    () => leverageLadder(capital, refPrice, spec, [calPlan.max_leverage])[0] ?? null,
    [capital, refPrice, spec, calPlan.max_leverage],
  );
  const roll = useMemo(
    () => rollCostEstimate(refPrice, spec, 12, 1, summary.contract_value),
    [refPrice, spec, summary.contract_value],
  );
  // 「你在這」的定位用實際部位的槓桿，沒部位就不標
  const liveLev = summary.total_lots > 0 ? summary.leverage : null;

  return (
    <div className="space-y-5">
      {/*
        歷史校準（槓桿體檢／加碼減碼計畫）是拿 0050 從 2000 年至今的歷史價格回測出來的
        （見 futures.ts 的 CALIBRATED_PLAN／HISTORICAL_CRASHES／LEVERAGE_CALIBRATION），
        物理上就是 0050／SRF・NYF 專屬——換成個股期貨要有同等的東西，得對那檔股票重跑
        一次同樣的歷史回測，不是這幾張卡片能力所及，所以其他商品只顯示下面的通用工具。
      */}
      {isCalibratedUnderlying && (
      <>
      {/* 歷史校準：槓桿體檢 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-amber-400/10 border border-amber-400/30 grid place-items-center shrink-0"><History className="w-4 h-4 text-amber-400" /></span>
            <h2 className="text-sm font-bold text-zinc-100 tracking-wide">槓桿體檢：這筆本金撐得住幾倍</h2>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
            右邊三欄是<strong className="text-zinc-400">回測結果</strong>（{UNDERLYING_CODE} 2000-01→2026-08，
            2009 年前用加權指數代理；400 條 × 20 年區塊自助抽樣，已扣月轉倉成本）。
            「歷史崩盤」欄位是照這個口數<strong className="text-zinc-400">不減碼硬撐</strong>會被代沖銷的那幾次——
            會減碼的話沒那麼慘，但那要你當下真的砍得下手。
          </p>
        </div>

        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-[11px] min-w-[720px]">
            <thead>
              <tr className="text-zinc-500 border-b border-border/60">
                <th className="text-left font-medium py-1.5 pr-2">槓桿</th>
                <th className="text-right font-medium py-1.5 px-2">口數</th>
                <th className="text-right font-medium py-1.5 px-2">風險指標</th>
                <th className="text-right font-medium py-1.5 px-2">追繳價</th>
                <th className="text-right font-medium py-1.5 px-2">斷頭價</th>
                <th className="text-right font-medium py-1.5 px-2" title="區塊自助抽樣 400 條 20 年路徑的中位數年化報酬">中位年化</th>
                <th className="text-right font-medium py-1.5 px-2" title="20 年下來本金實質歸零的路徑比例">歸零機率</th>
                <th className="text-left font-medium py-1.5 pl-2">歷史崩盤會斷頭</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {ladder.map((r) => {
                const here = liveLev !== null && Math.abs(liveLev - r.leverage) < 0.125;
                const dead = r.killed_by.length;
                return (
                  <tr key={r.leverage}
                    className={`border-b border-border/30 ${here ? 'bg-amber-500/10' : ''}`}>
                    <td className={`py-1.5 pr-2 font-bold ${dead === 0 ? 'text-emerald-400' : dead <= 2 ? 'text-amber-400' : 'text-rose-400'}`}>
                      {r.leverage}x{here && <span className="ml-1.5 text-[9px] font-sans font-semibold text-amber-300">你在這</span>}
                    </td>
                    <td className="text-right px-2 text-zinc-300">{r.lots}</td>
                    <td className="text-right px-2 text-zinc-400">{r.risk_indicator === null ? '—' : pct(r.risk_indicator, 0)}</td>
                    <td className="text-right px-2 text-orange-400/90">
                      {r.margin_call_price === null ? '—' : px(r.margin_call_price)}
                      <span className="text-zinc-600 ml-1">{r.margin_call_drop === null ? '' : pct(r.margin_call_drop, 0)}</span>
                    </td>
                    <td className="text-right px-2 text-rose-400/90">
                      {r.liquidation_price === null ? '—' : px(r.liquidation_price)}
                      <span className="text-zinc-600 ml-1">{r.liquidation_drop === null ? '' : pct(r.liquidation_drop, 0)}</span>
                    </td>
                    <td className={`text-right px-2 ${!r.stat ? 'text-zinc-600' : r.stat.median_cagr > 0.05 ? 'text-emerald-400' : r.stat.median_cagr > 0 ? 'text-zinc-300' : 'text-rose-400'}`}>
                      {r.stat ? pct(r.stat.median_cagr, 1) : '—'}
                    </td>
                    <td className={`text-right px-2 ${!r.stat ? 'text-zinc-600' : r.stat.ruin_prob > 0.05 ? 'text-rose-400 font-bold' : r.stat.ruin_prob > 0 ? 'text-amber-400' : 'text-zinc-500'}`}>
                      {r.stat ? pct(r.stat.ruin_prob, 0) : '—'}
                    </td>
                    <td className="pl-2 font-sans text-[10px] text-zinc-500">
                      {dead === 0
                        ? <span className="text-emerald-500/80">八次全撐得住</span>
                        : <span className="text-rose-400/90">{r.killed_by.map((c) => c.name).join('、')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={`rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed ${
          roll.verdict === 'bad' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            : roll.verdict === 'tight' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'}`}>
          <div className="flex items-start gap-1.5">
            <CalendarSync className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div>
              <strong>轉倉成本：{pct(roll.per_year_pct, 2)}／年</strong>
              （單邊 {pct(roll.per_side_pct, 3)} × 2 邊 × {roll.rolls_per_year} 次；含手續費、期交稅與 1 檔滑價）。
              打平「直接持有 {UNDERLYING_CODE}」的臨界值是 {pct(roll.breakeven_pct, 1)}／年。
              {roll.verdict === 'bad' && (
                <> 目前<strong>已經超過</strong>——照這個成本，加槓桿多賺的全被轉倉吃掉，回測裡怎麼調槓桿都贏不了直接抱 {UNDERLYING_CODE}。
                  最有效的一招是<strong>改用季月合約</strong>，一年 12 次轉倉降到 4 次，成本直接砍成三分之一。</>
              )}
              {roll.verdict !== 'bad' && <> 目前在安全區。</>}
            </div>
          </div>
        </div>
      </div>

      {/* 歷史校準：加碼／減碼計畫 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-emerald-400/10 border border-emerald-400/30 grid place-items-center shrink-0"><Compass className="w-4 h-4 text-emerald-400" /></span>
            <h2 className="text-sm font-bold text-zinc-100 tracking-wide">回測校準的加碼／減碼計畫</h2>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
            回測裡表現最穩的一組：底倉 {CALIBRATED_PLAN.base_leverage} 倍——<strong className="text-zinc-400">距高點每跌 {pct(CALIBRATED_PLAN.dip_step, 0)} 加 {CALIBRATED_PLAN.dip_add} 倍槓桿</strong>，最多三級；
            <strong className="text-zinc-400">從加碼成本起漲 {pct(CALIBRATED_PLAN.trim_step, 0)} 減碼三成</strong>，最多兩級。
            跌幅一律<strong className="text-zinc-400">從高點算，不是從你的成本算</strong>——從成本算會愈跌愈密集，在半山腰就把子彈打完。
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="text-zinc-400">底倉槓桿</span>
              <span className="font-mono">
                <span className="text-emerald-400 font-bold text-sm">{baseLev.toFixed(2)} 倍</span>
                <span className="text-zinc-500 ml-2">加滿 <span className="text-amber-400 font-bold">{calPlan.max_leverage.toFixed(2)}</span> 倍</span>
              </span>
            </div>
            <input
              type="range" min="0.5" max="3" step="0.05" value={baseLev}
              onChange={(e) => setBaseLev(parseFloat(e.target.value))}
              onMouseUp={() => setPlanner((x) => ({ ...x, plan_base_leverage: baseLev }))}
              onTouchEnd={() => setPlanner((x) => ({ ...x, plan_base_leverage: baseLev }))}
              onKeyUp={() => setPlanner((x) => ({ ...x, plan_base_leverage: baseLev }))}
              className="w-full h-2 bg-zinc-900 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
              <span>0.5x</span>
              <span className="text-emerald-500">1.2x 回測建議</span>
              <span>2x</span><span>3x</span>
            </div>
          </div>
          <Field label="基準高點" hint="加碼跌幅從這個價位往下算。空著或填 0 就用現價當高點（＝現在就在高點附近）。">
            <NumInput value={p.plan_peak} step="0.05" min="0" placeholder={`未填＝用現價 ${refPrice > 0 ? px(refPrice) : ''}`}
              onCommit={(v) => setPlanner((x) => ({ ...x, plan_peak: Math.max(0, v) }))} />
          </Field>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="底倉口數" value={`${calPlan.base_lots} 口`} sub={`名目 ${money(calPlan.base_notional)}`} cls="text-emerald-400" />
          <StatCard label="佔用原始保證金" value={money(calPlan.base_margin)}
            sub={capital > 0 ? `佔本金 ${pct(calPlan.base_margin / capital)}` : ''} />
          <StatCard label="預留加碼額度" value={money(calPlan.reserve_notional)}
            sub={`≈ ${calPlan.reserve_lots} 口・本金的 ${pct(calPlan.reserve_pct, 0)}`} cls="text-amber-400"
            hint="期貨的「閒置資金」不是現金，是槓桿的空間：底倉到上限之間的名目差額。錢本來就都在保證金專戶裡。" />
          <StatCard label="加滿後的斷頭價"
            value={maxRow?.liquidation_price != null ? px(maxRow.liquidation_price) : '—'}
            sub={maxRow?.liquidation_drop != null ? `距現價 ${pct(maxRow.liquidation_drop, 0)}` : ''}
            cls="text-rose-400" />
        </div>

        {calPlan.base_lots > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-border/50">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
                <ArrowDownCircle className="w-3.5 h-3.5 text-sky-400" /> 跌下去這樣加
              </div>
              {calPlan.steps.map((s) => (
                <div key={s.level} className="flex items-center gap-2 bg-zinc-900/40 border border-border rounded-lg px-3 py-2">
                  <span className="text-[10px] font-semibold text-zinc-500 w-11 shrink-0">第 {s.level} 階</span>
                  <span className="font-mono text-xs text-sky-300 w-16 shrink-0">{pct(s.drop, 0)}</span>
                  <span className="font-mono text-xs text-zinc-200 w-16 shrink-0">{px(s.price)}</span>
                  <span className="text-[11px] text-zinc-400 flex-1">
                    {s.add_lots > 0
                      ? <>加 <strong className="text-emerald-400">{s.add_lots}</strong> 口 → 共 {s.target_lots} 口</>
                      : s.capped
                        ? <span className="text-rose-400/80">押不起（屆時保證金只夠 {s.target_lots} 口）</span>
                        : <span className="text-zinc-500">不用加——跌到這裡時虧損已經把權益打薄，手上的口數本來就到 {s.target_leverage.toFixed(2)}x 了</span>}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono shrink-0 hidden sm:inline">
                    {s.target_leverage.toFixed(2)}x・權益 {money(s.equity_then)}
                  </span>
                </div>
              ))}
              <p className="text-[10px] text-zinc-600 leading-relaxed">
                每一階的口數是用<strong className="text-zinc-500">到價當下的權益數</strong>重算的。跌 20% 時帳上已經虧了一輪，
                同樣的槓桿對應的口數會變少——用現在的權益去排表，會排出一張到時候押不起的單。
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300">
                <ArrowUpCircle className="w-3.5 h-3.5 text-bull" /> 漲上去這樣減
              </div>
              {calPlan.trims.map((t) => (
                <div key={t.level} className="flex items-center gap-2 bg-zinc-900/40 border border-border rounded-lg px-3 py-2">
                  <span className="text-[10px] font-semibold text-zinc-500 w-11 shrink-0">第 {t.level} 階</span>
                  <span className="font-mono text-xs text-bull w-16 shrink-0">+{pct(t.gain, 0)}</span>
                  <span className="font-mono text-xs text-zinc-200 w-16 shrink-0">{px(t.price)}</span>
                  <span className="text-[11px] text-zinc-400 flex-1">
                    平 <strong className="text-bull">{t.close_lots}</strong> 口，剩 {t.remain_lots} 口
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">落袋 {money(t.locked)}</span>
                </div>
              ))}
              <p className="text-[10px] text-zinc-600 leading-relaxed">
                回測裡分批減碼<strong className="text-zinc-500">不會提高報酬</strong>（單一歷史路徑上還少賺），
                它買的是「不押身家在多頭會不會繼續」——20 年滾動中位報酬從 3.8% 升到 4.7%，倒楣路徑的結果也變好。
                想要更高報酬就別減碼，想睡得著就照表減。
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500 pt-2 border-t border-border/50">
            填入「帳戶可用本金」並取得現在價格，才排得出計畫。
          </p>
        )}

        {liveLev !== null && liveLev > calPlan.max_leverage * 1.1 && (
          <div className="text-[11px] text-rose-400 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              你目前的實際槓桿是 <strong>{liveLev.toFixed(2)} 倍</strong>，已經高過這個計畫「加滿碼」的
              {calPlan.max_leverage.toFixed(2)} 倍——也就是說行情還沒跌，子彈就已經打完了。
              真的跌下來時沒有加碼空間，只剩被追繳的選項。
            </span>
          </div>
        )}
      </div>
      </>
      )}
      {!isCalibratedUnderlying && (
        <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-2.5 mb-1.5">
            <span className="w-7 h-7 rounded-lg bg-amber-400/10 border border-amber-400/30 grid place-items-center shrink-0"><History className="w-4 h-4 text-amber-400" /></span>
            <h2 className="text-sm font-bold text-zinc-100 tracking-wide">槓桿體檢／加碼減碼計畫暫不適用</h2>
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            這組建議是拿 0050 從 2000 年至今的歷史價格回測出來的（小型／大型台灣50 ETF 期貨才適用），
            沒有 {activeProduct.name} 的同等歷史回測資料，暫不顯示——避免拿別檔標的的回測結論套在這裡誤導。
            下面「槓桿與口數規劃」「分批進場」「移動停損」這些通用試算工具不受影響，一樣可以用。
          </p>
        </div>
      )}

      {/* 槓桿 → 口數 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Layers className="w-4 h-4 text-primary" /></span>
          <h2 className="text-sm font-bold text-zinc-100 tracking-wide">槓桿與口數規劃</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="帳戶可用本金" hint="空著或填 0 就沿用「保證金專戶現金餘額」。這是槓桿的分母。">
            <NumInput value={p.capital} step="10000" min="0" placeholder={`未填＝沿用 ${money(config.cash)}`}
              onCommit={(v) => setPlanner((x) => ({ ...x, capital: Math.max(0, v) }))} />
          </Field>
          <Field label="現在價格（唯讀）" hint="到「部位 & 平倉紀錄」或按上方「真實同步」更新。有部位時用參考月份的價格。">
            <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-400">
              {refPrice > 0 ? px(refPrice) : '尚未取得'}
              {summary.total_lots > 0 && summary.months.length > 1 && (
                <span className="text-zinc-600 ml-2 text-xs">{monthLabel(summary.reference_month)}</span>
              )}
            </div>
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="text-zinc-400">目標槓桿（名目曝險 ÷ 本金）</span>
            <span className="font-mono">
              <span className="text-amber-400 font-bold text-sm">{lev.toFixed(1)} 倍</span>
              <span className="text-zinc-500 ml-2">建議 <span className="text-primary font-bold">{suggestion.lots}</span> 口</span>
            </span>
          </div>
          <input
            type="range" min="0.5" max="10" step="0.1" value={lev}
            onChange={(e) => setLev(parseFloat(e.target.value))}
            onMouseUp={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            onTouchEnd={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            onKeyUp={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            className="w-full h-2 bg-zinc-900 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
            <span>1x 無槓桿</span>
            <span className="text-emerald-500">1.2x 回測建議</span>
            <span className="text-amber-500">2x 上限</span>
            <span className="text-rose-500">3x 歸零率 30%</span>
            <span>10x</span>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="建議口數" value={`${suggestion.lots} 口`} sub={`本金押得起 ${suggestion.max_by_margin} 口`} cls="text-primary" />
          <StatCard label="名目曝險" value={money(suggestion.notional)} sub={`實際槓桿 ${suggestion.leverage.toFixed(2)} 倍`} />
          <StatCard label="佔用原始保證金" value={money(suggestion.margin_used)} sub={`佔本金 ${pct(suggestion.margin_usage)}`}
            cls={suggestion.margin_usage > 0.5 ? 'text-rose-400' : suggestion.margin_usage > 0.3 ? 'text-amber-400' : 'text-zinc-100'} />
          <StatCard label="可承受跌幅（估）" value={capital > 0 && suggestion.notional > 0
            ? pct(Math.max(0, (capital - suggestion.lots * spec.maintenance_margin) / suggestion.notional))
            : '—'}
            sub="跌到權益數＝維持保證金" cls="text-amber-400"
            hint="粗估值，未計入費用；精確的追繳價請看總覽頁。" />
        </div>

        {suggestion.capped && (
          <div className="text-[11px] text-amber-400 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {lev.toFixed(1)} 倍需要 {suggestion.by_leverage} 口，但本金只押得起 {suggestion.max_by_margin} 口的原始保證金，
              已自動下修。想真的做到這個槓桿要先入金。
            </span>
          </div>
        )}
        {suggestion.margin_usage > 0.5 && suggestion.lots > 0 && (
          <div className="text-[11px] text-rose-400 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>保證金已佔本金 {pct(suggestion.margin_usage)}，剩下的緩衝撐不了多少回檔——這個口數對這筆本金太重了。</span>
          </div>
        )}
      </div>

      {/* 分批進場 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Layers className="w-4 h-4 text-primary" /></span>
            <h2 className="text-sm font-bold text-zinc-100 tracking-wide">分批進場／加碼試算</h2>
            <button
              onClick={clearAll}
              disabled={allEmpty}
              className={`ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md border text-[10px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed ${
                armClearAll
                  ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                  : 'bg-zinc-800/60 border-border text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
              }`}
              title="把三筆試算欄位全部歸零。只清這張卡的輸入，不會動到實際部位；第 1 筆按「更新」就能重抓回來。"
            >
              <Eraser className="w-3 h-3" /> {armClearAll ? '再按一次確定清空' : '全部清空'}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            第 1 筆是<strong className="text-zinc-400">你目前的真實持倉</strong>（唯讀，部位有異動就按「更新」重抓），
            第 2、3 筆填想加碼的價格與口數，算出加起來的加權平均成本，並用這個組合跑一次風險模型。
            這裡只是試算，<strong className="text-zinc-400">不會動到實際部位</strong>。
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {p.batches.slice(0, 3).map((b, i) => (
            i === 0 ? (
              /* 第 1 筆＝現有持倉，唯讀。手打會跟真實部位漂掉而且不會有人記得回來改，
                 所以只給一顆「更新」按鈕從未平倉部位重新彙總。 */
              <div key={i} className="bg-zinc-900/40 border border-primary/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold text-zinc-300">
                    第 1 筆（目前持倉）
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={pullHolding}
                      className={`flex items-center gap-1 px-2 py-1 border text-[10px] font-semibold rounded-md transition ${
                        pullMsg
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                          : 'bg-primary/15 border-primary/40 text-primary hover:bg-primary/25'
                      }`}
                      title="從「部位 & 平倉紀錄」的未平倉部位重新彙總總口數與加權平均成本"
                    >
                      {pullMsg
                        ? <><Check className="w-3 h-3" /> {pullMsg === 'updated' ? '已更新' : '已是最新'}</>
                        : <><RefreshCw className="w-3 h-3" /> 更新</>}
                    </button>
                    <button
                      onClick={() => clearBatch(0)}
                      disabled={!(b.price > 0) && !(b.lots > 0)}
                      className="flex items-center gap-1 px-2 py-1 bg-zinc-800/60 border border-border text-zinc-400 text-[10px] font-semibold rounded-md hover:text-zinc-200 hover:border-zinc-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      title="把這一筆歸零（不會動到實際部位，按「更新」可重抓回來）"
                    >
                      <Eraser className="w-3 h-3" /> 清空
                    </button>
                  </div>
                </div>
                <Field label="進場價（加權平均成本・唯讀）">
                  <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-400">
                    {b.price > 0 ? px(b.price) : '—'}
                  </div>
                </Field>
                <Field label="口數（唯讀）">
                  <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-400">
                    {b.lots > 0 ? `${b.lots}` : '—'}
                  </div>
                </Field>
                {holdingDrift && (
                  <p className="text-[10px] text-amber-400 leading-relaxed">
                    {live.lots > 0
                      ? <>持倉已變動：目前是 {live.lots} 口 @ {px(live.avg_price)}，按「更新」帶入。</>
                      : <>目前沒有未平倉部位，按「更新」會清成 0。</>}
                  </p>
                )}
                {live.mixed && (
                  <p className="text-[10px] text-amber-400 leading-relaxed">
                    你同時有多單 {live.long_lots} 口與空單 {live.short_lots} 口，兩個方向的成本混在一起算沒有意義，
                    這格的平均成本僅供參考。
                  </p>
                )}
              </div>
            ) : (
            <div key={i} className="bg-zinc-900/40 border border-border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-zinc-300">
                  第 {i + 1} 筆（加碼）
                </div>
                <button
                  onClick={() => clearBatch(i)}
                  disabled={!(b.price > 0) && !(b.lots > 0)}
                  className="flex items-center gap-1 px-2 py-1 bg-zinc-800/60 border border-border text-zinc-400 text-[10px] font-semibold rounded-md hover:text-zinc-200 hover:border-zinc-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  title="把這一筆的價格與口數歸零"
                >
                  <Eraser className="w-3 h-3" /> 清空
                </button>
              </div>
              <Field label="進場價">
                <NumInput value={b.price} step="0.05" min="0"
                  onCommit={(v) => setPlanner((x) => ({
                    ...x, batches: x.batches.map((y, j) => (j === i ? { ...y, price: Math.max(0, v) } : y)),
                  }))} />
              </Field>
              <Field label="口數">
                <NumInput value={b.lots} step="1" min="0"
                  onCommit={(v) => setPlanner((x) => ({
                    ...x, batches: x.batches.map((y, j) => (j === i ? { ...y, lots: Math.max(0, v) } : y)),
                  }))} />
              </Field>
            </div>
            )
          ))}
        </div>

        {batch.lots > 0 ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-border/50">
            <StatCard label="總口數" value={`${batch.lots} 口`} />
            <StatCard label="加權平均成本" value={px(batch.avg_price)} sub={`名目 ${money(batch.notional)}`} cls="text-emerald-400" />
            <StatCard label="這個組合的槓桿"
              value={batchSim?.leverage !== null && batchSim?.leverage !== undefined ? `${batchSim.leverage.toFixed(2)} 倍` : '—'}
              sub={`本金 ${money(capital)}`} cls="text-amber-400" />
            <StatCard label="這個組合的追繳價"
              value={batchSim?.margin_call_price !== null && batchSim?.margin_call_price !== undefined ? px(batchSim.margin_call_price) : '—'}
              sub={batchSim?.liquidation_price !== null && batchSim?.liquidation_price !== undefined ? `斷頭 ${px(batchSim.liquidation_price)}` : ''}
              cls="text-orange-400" />
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500 pt-2 border-t border-border/50">填入至少一批的價格與口數就會出現試算結果。</p>
        )}
      </div>

      {/* 上漲目標與出場 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-emerald-400/10 border border-emerald-400/30 grid place-items-center shrink-0"><Target className="w-4 h-4 text-emerald-400" /></span>
          <h2 className="text-sm font-bold text-zinc-100 tracking-wide">上漲目標與出金規劃</h2>
        </div>

        {summary.total_lots === 0 ? (
          <p className="text-xs text-zinc-500">目前沒有未平倉部位，先新增部位才有東西可以規劃。</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="text-zinc-400">價格目標</span>
                <span className="font-mono text-emerald-400 font-bold text-sm">
                  {gain >= 0 ? '+' : ''}{(gain * 100).toFixed(0)}% → {px(refPrice * (1 + gain))}
                </span>
              </div>
              <input
                type="range" min="-30" max="100" step="1" value={Math.round(gain * 100)}
                onChange={(e) => setGain(parseFloat(e.target.value) / 100)}
                onMouseUp={() => setPlanner((x) => ({ ...x, gain_pct: gain }))}
                onTouchEnd={() => setPlanner((x) => ({ ...x, gain_pct: gain }))}
                onKeyUp={() => setPlanner((x) => ({ ...x, gain_pct: gain }))}
                className="w-full h-2 bg-zinc-900 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                <span>-30%</span><span>0</span><span>+20%</span><span>+50%</span><span>+100%</span>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard label="目標價" value={px(plan.target_price)} />
              <StatCard label="到價淨損益" value={money(plan.profit)} cls={pnlCls(plan.profit)}
                sub={plan.roi_on_margin !== null ? `對保證金 ${pct(plan.roi_on_margin)}` : ''} />
              <StatCard label="到價時權益數" value={money(plan.equity_after)} cls={pnlCls(plan.equity_after)}
                sub={plan.roi_on_equity !== null ? `權益成長 ${pct(plan.roi_on_equity)}` : ''} />
              <StatCard label="安全出金上限" value={money(plan.safe_withdraw)} cls="text-cyan-400"
                sub={`留 ${p.reserve_multiple.toFixed(1)} 倍原始保證金`}
                hint="領走這個數字之後，帳戶仍保有指定倍數的原始保證金當緩衝。" />
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-border/50">
              <Field label="出金要留幾倍原始保證金" hint="2.5 倍約可再承受 15% 回檔；設 1 倍等於沒有緩衝。">
                <NumInput value={p.reserve_multiple} step="0.5" min="1"
                  onCommit={(v) => setPlanner((x) => ({ ...x, reserve_multiple: Math.max(1, v) }))}
                  className="w-28 bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
              </Field>
            </div>

            {/* 移動停損 */}
            <div className="pt-4 border-t border-border/50 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-200">移動停損</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <Field label="參考最高價" hint="填部位走過的最高價；留 0 就用上面的目標價。">
                    <NumInput value={p.trailing_peak} step="0.05" min="0" placeholder={`未填＝目標價 ${px(plan.target_price)}`}
                      onCommit={(v) => setPlanner((x) => ({ ...x, trailing_peak: Math.max(0, v) }))} />
                  </Field>
                  <Field label="回檔多少就出場" hint="以價格單位計；SRF 一檔 0.05 元。">
                    <NumInput value={p.trailing_dist} step="0.05" min="0"
                      onCommit={(v) => setPlanner((x) => ({ ...x, trailing_dist: Math.max(0, v) }))} />
                  </Field>
                </div>
                <dl className="space-y-2 text-xs bg-zinc-900/40 border border-border rounded-lg p-4 self-start">
                  <Row label="參考最高價" value={px(trailing.peak_price)} cls="text-zinc-300" />
                  <Row label={`觸發停損價（${trailing.ticks} 檔）`} value={px(trailing.stop_price)} cls="text-rose-400" />
                  <Row label="觸發時鎖住的損益" value={money(trailing.locked_pnl)} cls={pnlCls(trailing.locked_pnl)}
                    hint="含來回手續費與期交稅，是這批部位從進場算起的總損益。" />
                  <Row label="從最高點回吐" value={money(trailing.give_back)} cls="text-amber-400" />
                </dl>
              </div>
              <p className="text-[11px] text-zinc-500">
                方向依淨部位判斷：淨多單時停損價在最高價<strong className="text-zinc-400">之下</strong>，
                淨空單時在最低價<strong className="text-zinc-400">之上</strong>。期貨商的觸價單通常是「市價觸發」，
                跳空時實際成交價可能比這裡差。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ── 契約規格 & 設定 ─────────────────────────────────────────────────────────

const SPEC_FIELDS: { key: keyof FuturesSpec; label: string; step: string; hint: string; suffix?: string }[] = [
  { key: 'contract_size', label: '契約單位（股/口）', step: '1', hint: 'SRF＝1,000 股；大型 NYF＝10,000 股。' },
  { key: 'tick_size', label: '最小升降單位', step: '0.01', hint: '0.05 元；乘上契約單位就是一跳的錢。' },
  { key: 'initial_margin', label: '原始保證金（元/口）', step: '100', hint: '開新倉所需。期交所會依風險調整，改動時記得同步更新。' },
  { key: 'maintenance_margin', label: '維持保證金（元/口）', step: '100', hint: '權益數低於這個水準就會被追繳。風險指標的分母。' },
  { key: 'fee_per_lot', label: '手續費（元/口，單邊）', step: '5', hint: '依你的期貨商而定，這裡填單邊，計算時自動抓來回兩趟。' },
  { key: 'tax_rate', label: '期交稅率', step: '0.00001', hint: '股價指數類期貨＝十萬分之二（0.00002），按成交金額課，買賣各一次。' },
  { key: 'rollover_days', label: '轉倉提醒提前天數', step: '1', hint: '預設 7＝到期前一週開始提醒。' },
  { key: 'liquidation_ratio', label: '強制平倉風險指標', step: '0.05', hint: '期交所規定 25%（0.25）。盤中低於此值期貨商會代為沖銷。' },
];

const NEW_PRODUCT_FORM_SEED = {
  code: '', name: '', underlying: '', quote_contract: '',
  contract_size: '2000', tick_size: '0.05',
  initial_margin: '', maintenance_margin: '', fee_per_lot: '', tax_rate: '0.00002',
  beta: '1', ref_price: '',
};

const SettingsTab: React.FC<{
  config: FuturesConfig;
  preset: ReturnType<typeof findPreset>;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
  products: Record<string, ProductConfig>;
  activeCode: string;
}> = ({ config, preset, patch, saveToCloud, products, activeCode }) => {
  const activeProductCfg = products[activeCode];
  const [addingCustom, setAddingCustom] = useState(false);
  const [newProduct, setNewProduct] = useState(NEW_PRODUCT_FORM_SEED);
  const [apiMargins, setApiMargins] = useState<FuturesMarginsResp | null>(null);
  const [stockMargins, setStockMargins] = useState<FuturesStockMarginsResp | null>(null);
  const [stockContracts, setStockContracts] = useState<FuturesStockContractsResp | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [productPickBusy, setProductPickBusy] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    message: string | null;
  }>({ status: 'idle', message: null });
  const [syncModal, setSyncModal] = useState<{
    isOpen: boolean;
    date: string;
    oldInitial: number;
    newInitial: number;
    oldMaintenance: number;
    newMaintenance: number;
    lots: number;
    oldMarginUsed: number;
    newMarginUsed: number;
    oldMarginCallPrice: number | null;
    newMarginCallPrice: number | null;
    pendingSpec: FuturesSpec;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getFuturesMargins()
      .then((res) => { if (!cancelled) setApiMargins(res); })
      .catch(() => { /* ignore */ });
    api.getFuturesStockMargins()
      .then((res) => { if (!cancelled) setStockMargins(res); })
      .catch(() => { /* ignore */ });
    api.getFuturesStockContracts()
      .then((res) => { if (!cancelled) setStockContracts(res); })
      .catch(() => { /* 抓不到契約單位就讓使用者照舊手動填 */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * 套用一組新算出來的保證金：跑 before/after 的 summarizeAccount 對比，開確認 modal——
   * 不管保證金是從哪個來源算出來的（指數類固定金額／個股期貨比例×現價），套用前
   * 都要看得到「這樣改對現有部位的影響」，同一套 UI，不分岔。
   */
  const openMarginConfirm = (date: string, initial: number, maintenance: number) => {
    const newSpec: FuturesSpec = { ...activeProductCfg.spec, initial_margin: initial, maintenance_margin: maintenance };
    const ownPositions = config.positions.filter((p) => p.product === activeCode);
    const ownClosed = config.closed.filter((t) => t.product === activeCode);
    const priceInput = { byMonth: activeProductCfg.prices, fallback: activeProductCfg.price };
    const oldSummary = summarizeAccount(ownPositions, priceInput, activeProductCfg.spec, config.cash, ownClosed);
    const newSummary = summarizeAccount(ownPositions, priceInput, newSpec, config.cash, ownClosed);
    setSyncModal({
      isOpen: true,
      date,
      oldInitial: activeProductCfg.spec.initial_margin,
      newInitial: initial,
      oldMaintenance: activeProductCfg.spec.maintenance_margin,
      newMaintenance: maintenance,
      lots: oldSummary.total_lots,
      oldMarginUsed: oldSummary.required_initial,
      newMarginUsed: newSummary.required_initial,
      oldMarginCallPrice: oldSummary.margin_call_price,
      newMarginCallPrice: newSummary.margin_call_price,
      pendingSpec: newSpec,
    });
  };

  const handleSyncMargins = async () => {
    setSyncState({ status: 'loading', message: null });
    const contractKey = (activeProductCfg.quote_contract || activeCode).toUpperCase();
    try {
      // 來源①：指數類（TX／MTX／TMF）OpenAPI，固定金額
      const resp = await api.getFuturesMargins();
      setApiMargins(resp);
      const marginInfo = resp.margins[contractKey];
      if (marginInfo) {
        if (activeProductCfg.spec.initial_margin === marginInfo.initial && activeProductCfg.spec.maintenance_margin === marginInfo.maintenance) {
          setSyncState({ status: 'success', message: `已是最新（期交所 ${resp.date} 現行值${resp.stale ? '，磁碟快取' : ''}）` });
        } else {
          openMarginConfirm(resp.date, marginInfo.initial, marginInfo.maintenance);
          setSyncState({ status: 'idle', message: null });
        }
        return;
      }

      // 來源②：個股/ETF期貨（沒有 OpenAPI，gateway 代抓 stockMargining 頁面解析）
      const stockResp = await api.getFuturesStockMargins();
      const etfInfo = stockResp.etfs[contractKey];
      if (etfInfo) {
        if (activeProductCfg.spec.initial_margin === etfInfo.initial && activeProductCfg.spec.maintenance_margin === etfInfo.maintenance) {
          setSyncState({ status: 'success', message: `已是最新（期交所 ${stockResp.etf_date || stockResp.fetched_at.slice(0, 10)} 現行值${stockResp.stale ? '，磁碟快取' : ''}）` });
        } else {
          openMarginConfirm(stockResp.etf_date || stockResp.fetched_at.slice(0, 10), etfInfo.initial, etfInfo.maintenance);
          setSyncState({ status: 'idle', message: null });
        }
        return;
      }

      const stockInfo = stockResp.stocks[contractKey];
      if (stockInfo) {
        // 個股期貨給的是比例，要乘上「目前這個商品在用的現價」才是金額，而且會隨標的
        // 價格每天變動——沒有現價就算不出來，不能自己編一個數字出來假裝同步成功。
        const ownPositions = config.positions.filter((p) => p.product === activeCode);
        const refMonth = referenceMonthOf(ownPositions);
        const price = priceOf({ byMonth: activeProductCfg.prices, fallback: activeProductCfg.price }, refMonth);
        if (!(price > 0)) {
          setSyncState({
            status: 'error',
            message: `這個商品的保證金是比例（原始 ${(stockInfo.initial_pct * 100).toFixed(2)}%／維持 ${(stockInfo.maintenance_pct * 100).toFixed(2)}%，${stockInfo.tier}），要乘上現價才是金額——先按「真實同步」抓到報價或手動填現價，再同步保證金。`,
          });
          return;
        }
        const unit = Math.max(1, activeProductCfg.spec.contract_size || 2000);
        const initial = Math.round(price * unit * stockInfo.initial_pct);
        const maintenance = Math.round(price * unit * stockInfo.maintenance_pct);
        if (activeProductCfg.spec.initial_margin === initial && activeProductCfg.spec.maintenance_margin === maintenance) {
          setSyncState({ status: 'success', message: `已是最新（依期交所 ${stockInfo.tier} 比例 × 現價 ${price} 算出，${stockResp.stock_date || '比例表'}${stockResp.stale ? '，磁碟快取' : ''}）` });
        } else {
          openMarginConfirm(
            `${stockResp.stock_date || stockResp.fetched_at.slice(0, 10)}（${stockInfo.tier}比例 ${(stockInfo.initial_pct * 100).toFixed(2)}% × 現價 ${price}，非固定金額，行情變動會跟著變）`,
            initial, maintenance,
          );
          setSyncState({ status: 'idle', message: null });
        }
        return;
      }

      setSyncState({ status: 'success', message: `這個商品期交所沒有提供保證金資料，請依期貨商通知手動維護` });
    } catch (e) {
      setSyncState({
        status: 'error',
        message: e instanceof Error ? e.message : '同步保證金失敗'
      });
    }
  };

  // 說明文字有四種狀態，其中「不一致」是最需要講話的那一種——你的追繳價正在用
  // 舊保證金算。原本這個狀態會掉到最後的預設文案，反而什麼都不提醒。
  const marginDescription: { text: string; warn: boolean } = (() => {
    const contractKey = (activeProductCfg.quote_contract || activeCode).toUpperCase();
    const stale = apiMargins?.stale ? '（期交所暫時抓不到，顯示的是磁碟快取）' : '';
    if (apiMargins) {
      const marginInfo = apiMargins.margins[contractKey];
      if (marginInfo) {
        const same = activeProductCfg.spec.initial_margin === marginInfo.initial
          && activeProductCfg.spec.maintenance_margin === marginInfo.maintenance;
        if (same) {
          return { text: `保證金＝期交所 ${apiMargins.date} 現行值（OpenAPI 自動同步）${stale}`, warn: false };
        }
        return {
          text: `⚠️ 目前設定（原始 ${money(activeProductCfg.spec.initial_margin)}／維持 ${money(activeProductCfg.spec.maintenance_margin)}）`
            + `與期交所 ${apiMargins.date} 現行值（原始 ${money(marginInfo.initial)}／維持 ${money(marginInfo.maintenance)}）不一致`
            + `${stale}，追繳價與斷頭價正在用舊值計算——請按下方「同步保證金」。`,
          warn: true,
        };
      }
    }
    // 指數類 OpenAPI 沒有這個代碼，退回個股/ETF期貨那份（gateway 代抓 stockMargining 頁面解析）
    if (stockMargins) {
      const sStale = stockMargins.stale ? '（期交所暫時抓不到，顯示的是磁碟快取）' : '';
      const etfInfo = stockMargins.etfs[contractKey];
      if (etfInfo) {
        const same = activeProductCfg.spec.initial_margin === etfInfo.initial && activeProductCfg.spec.maintenance_margin === etfInfo.maintenance;
        if (same) return { text: `保證金＝期交所 ${stockMargins.etf_date} 現行值（自動同步）${sStale}`, warn: false };
        return {
          text: `⚠️ 目前設定（原始 ${money(activeProductCfg.spec.initial_margin)}／維持 ${money(activeProductCfg.spec.maintenance_margin)}）`
            + `與期交所 ${stockMargins.etf_date} 現行值（原始 ${money(etfInfo.initial)}／維持 ${money(etfInfo.maintenance)}）不一致`
            + `${sStale}，追繳價與斷頭價正在用舊值計算——請按下方「同步保證金」。`,
          warn: true,
        };
      }
      const stockInfo = stockMargins.stocks[contractKey];
      if (stockInfo) {
        return {
          text: `保證金是比例、不是固定金額（${stockInfo.tier}：原始 ${(stockInfo.initial_pct * 100).toFixed(2)}%／維持 ${(stockInfo.maintenance_pct * 100).toFixed(2)}% × 現價，期交所 ${stockMargins.stock_date} 現行值${sStale}）——按下方「同步保證金」會用目前的現價換算成金額，行情變動後金額會跟著變，記得不時重新同步。`,
          warn: false,
        };
      }
    }
    return {
      text: '保證金會依市場風險調整，期貨商通知調整時回來這裡改，追繳價與斷頭價會跟著更新。'
        + '按下方「同步保證金」可直接抓期交所現行值（指數類與個股/ETF期貨皆支援）。',
      warn: false,
    };
  })();

  /**
   * 剛套用哪一格。改保證金最容易產生的懷疑是「我改了但好像沒有生效」——雲端狀態
   * 在頁首，手機上早就滑出畫面外了，所以回饋要出現在手指剛離開的那一格旁邊。
   */
  const [justSaved, setJustSaved] = useState<keyof FuturesSpec | null>(null);
  useEffect(() => {
    if (justSaved === null) return;
    const t = setTimeout(() => setJustSaved(null), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);

  // 非受控＋key：按「還原預設值」時 key 跟著變，輸入框重掛載吃到新值
  const commit = (key: keyof FuturesSpec, raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    if (v === activeProductCfg.spec[key]) return; // 沒改就不要假裝存了一次
    setJustSaved(key);
    void saveToCloud(patch((c) => ({
      ...c,
      products: { ...c.products, [activeCode]: { ...c.products[activeCode], spec: { ...c.products[activeCode].spec, [key]: v } } },
    })));
  };

  // 目前這組規格套用到這個商品現有部位會長什麼樣。放在輸入框正下方，改完馬上看得到差別。
  const ownPositions = useMemo(() => config.positions.filter((p) => p.product === activeCode), [config.positions, activeCode]);
  const ownClosed = useMemo(() => config.closed.filter((t) => t.product === activeCode), [config.closed, activeCode]);
  const specPreview = useMemo(
    () => summarizeAccount(
      ownPositions,
      { byMonth: activeProductCfg.prices, fallback: activeProductCfg.price },
      activeProductCfg.spec,
      config.cash,
      ownClosed,
    ),
    [ownPositions, activeProductCfg.prices, activeProductCfg.price, activeProductCfg.spec, config.cash, ownClosed],
  );

  /** 切換「帳戶」目前操作的商品——不影響任何部位資料，只是換一個編輯焦點 */
  const setActiveCode = (code: string) => {
    void saveToCloud(patch((c) => (c.products[code] ? { ...c, active_product: code } : c)));
  };

  /**
   * 把一個內建預設**加入**帳戶持有的商品清單（已經持有就只是切過去），不再是
   * 「整帳戶取代」——帳戶現在可以同時持有 SRF 期貨與個股期貨，不能因為切到別的
   * 商品就把既有商品的規格洗掉。
   */
  const addPreset = (code: string) => {
    const p = findPreset(code);
    if (!p) return;
    void saveToCloud(patch((c) => {
      if (c.products[code]) return { ...c, active_product: code };
      const product: ProductConfig = {
        code, name: p.name, quote_contract: p.code, underlying: p.underlying,
        spec: { ...p.spec }, beta: 1, index_ref: 0, index_linked: p.index_linked,
        price: 0, prices: {}, price_month: '', price_as_of: '', price_source: 'daily',
        is_custom: false,
      };
      return {
        ...c,
        products: { ...c.products, [code]: product },
        planner: { ...c.planner, [code]: c.planner[code] ?? { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] } },
        active_product: code,
      };
    }));
  };

  /** 新增個股期貨等自建商品——契約單位/跳動點/手續費仍手動輸入；保證金若「期交所行情代碼」對得上 stockMargins 表，UI 會提供「套用」按鈕自動代入，使用者仍可手動覆蓋 */
  const submitCustomProduct = () => {
    const code = newProduct.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const name = newProduct.name.trim();
    const initial = parseFloat(newProduct.initial_margin);
    const maintenance = parseFloat(newProduct.maintenance_margin);
    const size = parseFloat(newProduct.contract_size);
    if (!code || !name || !(size > 0) || !(initial > 0) || !(maintenance > 0)) return;
    if (products[code]) { window.alert(`商品代碼 ${code} 已經存在`); return; }
    const product: ProductConfig = {
      code, name,
      quote_contract: (newProduct.quote_contract.trim().toUpperCase() || code),
      underlying: newProduct.underlying.trim(),
      spec: {
        contract_size: size,
        tick_size: Math.max(0.0001, parseFloat(newProduct.tick_size) || 0.05),
        initial_margin: initial,
        maintenance_margin: maintenance,
        fee_per_lot: Math.max(0, parseFloat(newProduct.fee_per_lot) || 0),
        tax_rate: Math.max(0, parseFloat(newProduct.tax_rate) || 0),
        rollover_days: 7,
        liquidation_ratio: 0.25,
      },
      beta: Math.max(0.01, Math.min(5, parseFloat(newProduct.beta) || 1)),
      index_ref: 0, index_linked: false,
      price: 0, prices: {}, price_month: '', price_as_of: '', price_source: 'daily',
      is_custom: true,
    };
    void saveToCloud(patch((c) => ({
      ...c,
      products: { ...c.products, [code]: product },
      planner: { ...c.planner, [code]: { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] } },
      active_product: code,
    })));
    setNewProduct(NEW_PRODUCT_FORM_SEED);
    setAddingCustom(false);
  };

  /** 商品還有部位/平倉紀錄引用就不給刪，避免資料變成孤兒 */
  const removeProduct = (code: string) => {
    if (Object.keys(products).length <= 1) { window.alert('帳戶至少要保留一個商品'); return; }
    const inUse = config.positions.some((p) => p.product === code) || config.closed.some((t) => t.product === code);
    if (inUse) { window.alert('這個商品還有未平倉部位或平倉紀錄，先清空才能移除。'); return; }
    if (!window.confirm(`移除商品「${products[code]?.name ?? code}」？`)) return;
    void saveToCloud(patch((c) => {
      const nextProducts = { ...c.products };
      delete nextProducts[code];
      const nextPlanner = { ...c.planner };
      delete nextPlanner[code];
      const codes = Object.keys(nextProducts);
      return {
        ...c,
        products: nextProducts,
        planner: nextPlanner,
        active_product: c.active_product === code ? (codes[0] ?? code) : c.active_product,
      };
    }));
  };

  /** 新增商品表單填的「期交所行情代碼」若在剛抓回來的 stockMargins 表裡對得到號，就能直接抓現行值套用，不用使用者自己手算比例 */
  const newProductLookupCode = (newProduct.quote_contract.trim() || newProduct.code.trim()).toUpperCase();
  const newProductEtfMatch = stockMargins?.etfs[newProductLookupCode];
  const newProductStockMatch = !newProductEtfMatch ? stockMargins?.stocks[newProductLookupCode] : undefined;
  // 指數期貨（電子/金融/半導體30…）：quote_contract 直接填期交所商品全名也對得到號
  // （margins 現在同時用代碼與全名做 key，見 routes/futures.js），不必透過上面的搜尋清單。
  const newProductIndexMatch = (!newProductEtfMatch && !newProductStockMatch) ? apiMargins?.margins[newProductLookupCode] : undefined;
  const applyNewProductEtfMargin = () => {
    if (!newProductEtfMatch) return;
    setNewProduct((f) => ({ ...f, initial_margin: String(newProductEtfMatch.initial), maintenance_margin: String(newProductEtfMatch.maintenance) }));
  };
  const applyNewProductStockMargin = () => {
    if (!newProductStockMatch) return;
    const price = parseFloat(newProduct.ref_price);
    const size = parseFloat(newProduct.contract_size);
    if (!(price > 0) || !(size > 0)) return;
    setNewProduct((f) => ({
      ...f,
      initial_margin: String(Math.round(price * size * newProductStockMatch.initial_pct)),
      maintenance_margin: String(Math.round(price * size * newProductStockMatch.maintenance_pct)),
    }));
  };
  const applyNewProductIndexMargin = () => {
    if (!newProductIndexMatch) return;
    setNewProduct((f) => ({ ...f, initial_margin: String(newProductIndexMatch.initial), maintenance_margin: String(newProductIndexMatch.maintenance) }));
  };

  /**
   * 「搜尋標的」下拉的候選清單——直接從已經載入的 stockMargins／apiMargins 表建，不用另打一次 API。
   * name 欄位是「聯電期貨」這種帶「期貨」字尾的商品簡稱，顯示跟比對前先把字尾拿掉。
   * 指數期貨（電子/金融/半導體30…）沒有股票代號，用商品全名當 code——之後存進
   * quote_contract 的也是這個全名，「同步保證金」靠同一個名字回頭比對 indexMarging 資料。
   */
  const productSearchIndex = useMemo(() => {
    const list: { code: string; label: string; stockCode: string; kind: 'stock' | 'etf' | 'index' }[] = [];
    if (stockMargins) {
      for (const [code, m] of Object.entries(stockMargins.stocks)) {
        list.push({ code, label: m.name.replace(/期貨$/, '').trim() || m.name, stockCode: m.stock_code, kind: 'stock' });
      }
      for (const [code, m] of Object.entries(stockMargins.etfs)) {
        list.push({ code, label: m.name.replace(/期貨$/, '').trim() || m.name, stockCode: m.stock_code, kind: 'etf' });
      }
    }
    if (apiMargins) {
      for (const ic of apiMargins.index_contracts) {
        list.push({ code: ic.name, label: ic.name.replace(/期貨$/, '').trim() || ic.name, stockCode: '', kind: 'index' });
      }
    }
    return list;
  }, [stockMargins, apiMargins]);

  const productSearchResults = useMemo(() => {
    const q = productQuery.trim();
    if (!q) return [];
    const qUpper = q.toUpperCase();
    return productSearchIndex
      .filter((e) => e.label.includes(q) || e.stockCode.includes(q) || e.code.includes(qUpper))
      .slice(0, 8);
  }, [productQuery, productSearchIndex]);

  /**
   * 選一個搜尋結果＝一次帶入名稱／代碼／標的／契約單位，並且非同步抓最新價把保證金
   * 算好填上——跟人工流程用的是同一套資料（stockMargins／stockContracts），只是不用
   * 使用者自己找代碼、自己查現價、自己算比例。算完的欄位還是一般 input，有問題可以
   * 直接手動改，或改「期交所行情代碼」／「目前參考價」後再按一次「套用」重算。
   *
   * 指數期貨（kind='index'）保證金跟 ETF 期貨一樣是固定金額，不必等報價就能直接套用；
   * quote_contract 存的是期交所商品全名（不是英文代碼），沒有 MIS 即時報價可抓，也不會
   * 覆寫「商品代碼」欄位——那是帳戶內部代號，使用者自己取即可。
   */
  const pickProductSearchResult = (entry: { code: string; label: string; stockCode: string; kind: 'stock' | 'etf' | 'index' }) => {
    if (entry.kind === 'index') {
      const info = apiMargins?.margins[entry.code];
      setProductQuery('');
      setNewProduct((f) => ({
        ...f,
        name: /期(貨)?$/.test(entry.label) ? entry.label : `${entry.label}期`,
        quote_contract: entry.code,
        underlying: entry.label,
        ...(info ? { initial_margin: String(info.initial), maintenance_margin: String(info.maintenance) } : {}),
      }));
      return;
    }

    const rootCode = entry.code.replace(/F$/, '');
    const sizeFromList = entry.kind === 'stock' ? stockContracts?.contracts[rootCode]?.contract_size : undefined;
    const etfMatch = stockMargins?.etfs[entry.code];

    setProductQuery('');
    setNewProduct((f) => ({
      ...f,
      name: /期(貨)?$/.test(entry.label) ? entry.label : `${entry.label}期`,
      code: entry.code,
      quote_contract: entry.code,
      underlying: `${entry.stockCode} ${entry.label}`,
      contract_size: sizeFromList ? String(sizeFromList) : f.contract_size,
      ...(etfMatch ? { initial_margin: String(etfMatch.initial), maintenance_margin: String(etfMatch.maintenance) } : {}),
    }));

    if (etfMatch) return; // ETF 期貨保證金是固定金額，不用等報價就能套用

    setProductPickBusy(entry.code);
    api.getFuturesQuote(entry.code)
      .then((q) => {
        const nearest = q.months?.[0];
        const price = nearest?.live ?? nearest?.settlement ?? nearest?.last ?? null;
        if (!price) return;
        const size = sizeFromList || parseFloat(newProduct.contract_size) || 2000;
        const stockMatch = stockMargins?.stocks[entry.code];
        setNewProduct((f) => ({
          ...f,
          ref_price: String(price),
          ...(stockMatch ? {
            initial_margin: String(Math.round(price * size * stockMatch.initial_pct)),
            maintenance_margin: String(Math.round(price * size * stockMatch.maintenance_pct)),
          } : {}),
        }));
      })
      .catch(() => { /* 抓不到現價就留給使用者自己填「目前參考價」 */ })
      .finally(() => setProductPickBusy((cur) => (cur === entry.code ? null : cur)));
  };

  return (
    <div className="space-y-5">
      {/* 帳戶持有的商品 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><SlidersHorizontal className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">交易商品</h2></div>
          <p className="text-[11px] text-zinc-500 mt-1">
            帳戶可以同時持有多個商品（例如 0050 期貨＋個股期貨）。下面選一個商品當「目前操作」的對象——契約規格、報價、建倉試算都是逐商品分開存的；部位新增表單也用這個商品。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {Object.entries(products).map(([code, prod]) => (
            <div key={code} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 transition ${
              code === activeCode ? 'bg-primary/10 border-primary/50' : 'bg-zinc-900/40 border-border hover:border-zinc-500'
            }`}>
              <button onClick={() => setActiveCode(code)} className="text-left">
                <div className={`text-xs font-semibold ${code === activeCode ? 'text-primary' : 'text-zinc-200'}`}>{prod.name}</div>
                <div className="text-[10px] text-zinc-500 font-mono">{code}{prod.is_custom ? '．自建' : ''}</div>
              </button>
              {Object.keys(products).length > 1 && (
                <button onClick={() => removeProduct(code)} title="移除這個商品" className="text-zinc-600 hover:text-rose-400 ml-1">
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="pt-2 border-t border-border/50">
          <div className="text-[11px] text-zinc-500 mb-2">從常用清單加入</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {SYMBOL_PRESETS.map((p) => (
              <button
                key={p.code}
                onClick={() => addPreset(p.code)}
                className={`text-left rounded-xl border p-3 transition ${
                  products[p.code] ? 'bg-zinc-900/20 border-border/50' : 'bg-zinc-900/40 border-border hover:border-zinc-500'
                }`}
              >
                <div className="text-xs font-semibold text-zinc-200">
                  {p.name}{products[p.code] && <span className="text-[10px] text-emerald-400 ml-1.5">已持有</span>}
                </div>
                <div className="text-[10px] text-zinc-500 mt-1 font-mono">
                  {p.code}．一口 {p.spec.contract_size.toLocaleString()} {p.unit_label}
                </div>
                <div className="text-[10px] text-zinc-600 mt-0.5 font-mono">
                  原始 {money(p.spec.initial_margin)} / 維持 {money(p.spec.maintenance_margin)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2 border-t border-border/50">
          {!addingCustom ? (
            <button
              onClick={() => setAddingCustom(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-semibold rounded-lg hover:bg-emerald-500/25 transition"
            >
              <Plus className="w-3.5 h-3.5" /> 新增個股期貨（或其他自訂商品）
            </button>
          ) : (
            <div className="space-y-3 bg-zinc-900/40 border border-border rounded-xl p-4">
              <div className="text-[11px] text-zinc-400">
                契約單位／跳動點請照期交所公告或券商 App 手動填；保證金若填對「期交所行情代碼」，下面會自動抓期交所現行值可以直接套用，不用自己算。
              </div>

              <div className="relative">
                <Field label="搜尋標的" hint="輸入股名／代號／指數期貨名稱，例如「聯電」「2303」或「電子期貨」，選一個之後下面欄位（含保證金）會自動帶入，有問題再手動改">
                  <input
                    value={productQuery}
                    onChange={(e) => setProductQuery(e.target.value)}
                    placeholder="聯電 / 2303 / 電子期貨"
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100"
                  />
                </Field>
                {productQuery.trim() !== '' && (
                  <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-border bg-zinc-950/95 shadow-lg divide-y divide-border/60">
                    {productSearchResults.length === 0 ? (
                      <div className="p-3 text-center text-[11px] text-zinc-500">
                        {stockMargins && apiMargins ? '查無符合的期貨標的' : '期交所資料載入中…'}
                      </div>
                    ) : productSearchResults.map((entry) => (
                      <button
                        key={entry.code}
                        type="button"
                        onClick={() => pickProductSearchResult(entry)}
                        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-zinc-800/50 transition"
                      >
                        <span>
                          <span className="text-xs font-semibold text-zinc-200 mr-2">{entry.label}</span>
                          {entry.stockCode && <span className="text-[10px] text-zinc-500 font-mono">{entry.stockCode}</span>}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">
                          {entry.kind === 'index' ? '指數期貨' : `${entry.code}${entry.kind === 'etf' ? '．ETF' : ''}`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {productPickBusy && (
                  <div className="mt-1 text-[11px] text-zinc-500">抓最新價／計算保證金中…</div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="顯示名稱" hint="例：聯電期">
                  <input value={newProduct.name} onChange={(e) => setNewProduct((f) => ({ ...f, name: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100" placeholder="聯電期" />
                </Field>
                <Field label="商品代碼" hint="帳戶內部用的代碼，英數皆可，例：UMC">
                  <input value={newProduct.code} onChange={(e) => setNewProduct((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="UMC" />
                </Field>
                <Field label="期交所行情代碼" hint="抓每日行情用；不確定可以先留空，之後在下面「期交所行情代碼」補填">
                  <input value={newProduct.quote_contract} onChange={(e) => setNewProduct((f) => ({ ...f, quote_contract: e.target.value.toUpperCase() }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="同商品代碼" />
                </Field>
                <Field label="標的" hint="例：2303 聯電">
                  <input value={newProduct.underlying} onChange={(e) => setNewProduct((f) => ({ ...f, underlying: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100" placeholder="2303 聯電" />
                </Field>
                <Field label="契約單位（股/口）" hint="股票期貨通常是 2,000 股/口（低價股可能是 4,000）">
                  <input type="number" step="1" min="1" value={newProduct.contract_size} onChange={(e) => setNewProduct((f) => ({ ...f, contract_size: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
                <Field label="最小跳動點" hint="依標的股價級距，常見 0.01～0.05">
                  <input type="number" step="0.01" min="0.0001" value={newProduct.tick_size} onChange={(e) => setNewProduct((f) => ({ ...f, tick_size: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
                <Field label="原始保證金（元/口）" hint="照期交所公告或券商 App">
                  <input type="number" step="1000" min="0" value={newProduct.initial_margin} onChange={(e) => setNewProduct((f) => ({ ...f, initial_margin: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="必填" />
                </Field>
                <Field label="維持保證金（元/口）">
                  <input type="number" step="1000" min="0" value={newProduct.maintenance_margin} onChange={(e) => setNewProduct((f) => ({ ...f, maintenance_margin: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="必填" />
                </Field>
                <Field label="手續費（元/口，單邊）">
                  <input type="number" step="1" min="0" value={newProduct.fee_per_lot} onChange={(e) => setNewProduct((f) => ({ ...f, fee_per_lot: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="依券商實收" />
                </Field>
                <Field label="標的 beta" hint="這檔股票相對大盤的連動係數，不確定先留 1">
                  <input type="number" step="0.05" min="0.01" value={newProduct.beta} onChange={(e) => setNewProduct((f) => ({ ...f, beta: e.target.value }))}
                    className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" />
                </Field>
              </div>

              {newProductEtfMatch && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
                  <div className="text-[11px] text-emerald-300">
                    抓到期交所現行值（{newProductLookupCode}，{stockMargins?.etf_date}）：原始 {money(newProductEtfMatch.initial)} ／ 維持 {money(newProductEtfMatch.maintenance)}
                  </div>
                  <button type="button" onClick={applyNewProductEtfMargin} className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold rounded-lg hover:bg-emerald-500/30 transition">
                    套用到上面的保證金欄位
                  </button>
                </div>
              )}
              {newProductIndexMatch && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
                  <div className="text-[11px] text-emerald-300">
                    抓到期交所 indexMarging 現行值（{newProductLookupCode}，{apiMargins?.date}）：原始 {money(newProductIndexMatch.initial)} ／ 維持 {money(newProductIndexMatch.maintenance)}
                  </div>
                  <button type="button" onClick={applyNewProductIndexMargin} className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold rounded-lg hover:bg-emerald-500/30 transition">
                    套用到上面的保證金欄位
                  </button>
                </div>
              )}
              {newProductStockMatch && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
                  <div className="text-[11px] text-emerald-300">
                    抓到期交所現行比例（{newProductLookupCode}，{newProductStockMatch.tier}，{stockMargins?.stock_date}）：原始 {(newProductStockMatch.initial_pct * 100).toFixed(2)}% ／ 維持 {(newProductStockMatch.maintenance_pct * 100).toFixed(2)}%——個股期貨的保證金是比例，要乘上參考價才是金額。
                  </div>
                  <div className="flex items-end gap-2">
                    <Field label="目前參考價" hint="用來換算成金額；之後行情變動可以再到設定頁按「同步保證金」重算">
                      <input type="number" step="0.05" min="0" value={newProduct.ref_price} onChange={(e) => setNewProduct((f) => ({ ...f, ref_price: e.target.value }))}
                        className="w-28 bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100" placeholder="例：125" />
                    </Field>
                    <button type="button" onClick={applyNewProductStockMargin} disabled={!(parseFloat(newProduct.ref_price) > 0)}
                      className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold rounded-lg hover:bg-emerald-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed">
                      套用到上面的保證金欄位
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button onClick={submitCustomProduct} className="px-4 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition">
                  新增商品
                </button>
                <button onClick={() => { setAddingCustom(false); setNewProduct(NEW_PRODUCT_FORM_SEED); }} className="text-[11px] text-zinc-500 hover:text-zinc-300">
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-border/50">
          <div className="sm:col-span-3 text-[11px] text-zinc-500">以下設定套用到「{activeProductCfg.name}」：</div>
          <Field label="期交所行情代碼" hint="抓行情用的商品代碼，填錯會在抓行情時回報「今日行情沒有這個商品」。">
            <input
              key={`contract-${activeCode}-${activeProductCfg.quote_contract}`}
              defaultValue={activeProductCfg.quote_contract}
              onBlur={(e) => {
                const v = e.target.value.trim().toUpperCase();
                if (v && v !== activeProductCfg.quote_contract) {
                  void saveToCloud(patch((c) => ({ ...c, products: { ...c.products, [activeCode]: { ...c.products[activeCode], quote_contract: v } } })));
                }
              }}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
            />
          </Field>
          <Field label="目前加權指數" hint="按上方「真實同步」會自動抓 TWSE 最新指數填進來（盤中即時，只更新目前選到的商品），也可以手動覆寫。留 0 ＝不顯示大盤點數換算。">
            <NumInput key={`idx-${activeCode}`} value={activeProductCfg.index_ref} step="10" min="0" placeholder="例：40039"
              onCommit={(v) => void saveToCloud(patch((c) => ({ ...c, products: { ...c.products, [activeCode]: { ...c.products[activeCode], index_ref: Math.max(0, v) } } })))} />
          </Field>
          <Field
            label={`標的 beta${preset?.index_linked ? '（指數商品固定 1）' : ''}`}
            hint="標的相對大盤的連動係數。0050 對加權指數約 1.0～1.1；個股期貨可填該股票對大盤的 beta；台指期本身就是大盤，固定 1。"
          >
            {preset?.index_linked ? (
              <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-500">1.00</div>
            ) : (
              <NumInput key={`beta-${activeCode}`} value={activeProductCfg.beta} step="0.05" min="0.01"
                onCommit={(v) => void saveToCloud(patch((c) => ({ ...c, products: { ...c.products, [activeCode]: { ...c.products[activeCode], beta: Math.max(0.01, Math.min(5, v)) } } })))} />
            )}
          </Field>
        </div>
      </div>

      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Ruler className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">契約規格與費用</h2></div>
          <p className={`text-[11px] mt-1 ${marginDescription.warn ? 'text-amber-400 font-medium' : 'text-zinc-500'}`}>
            {marginDescription.text}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {SPEC_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                key={`${activeCode}-${f.key}-${activeProductCfg.spec[f.key]}`}
                type="number"
                step={f.step}
                defaultValue={activeProductCfg.spec[f.key]}
                onBlur={(e) => commit(f.key, e.target.value)}
                className={`w-full bg-zinc-900 border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 transition-colors ${
                  justSaved === f.key ? 'border-emerald-500' : 'border-border'
                }`}
              />
              <p className="text-[10px] text-zinc-600 mt-1">
                {justSaved === f.key
                  ? <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" />已套用，下方數字與各分頁已重算</span>
                  : f.hint}
              </p>
            </Field>
          ))}
        </div>
        {specPreview.total_lots > 0 && (
          <div className="rounded-xl border border-border bg-zinc-900/40 p-4">
            <div className="text-[11px] text-zinc-400 font-medium mb-2.5">
              套用到目前 {specPreview.total_lots} 口部位（改上面任何一格，這裡立刻跟著變）
            </div>
            <dl className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-xs">
              <Row label="所需原始保證金" value={money(specPreview.required_initial)} />
              <Row label="所需維持保證金" value={money(specPreview.required_maintenance)} />
              <Row label="權益數" value={money(specPreview.equity)} cls={pnlCls(specPreview.equity)} />
              <Row
                label="風險指標"
                value={specPreview.risk_indicator === null ? '—' : pct(specPreview.risk_indicator, 1)}
                cls={(STATUS_META[specPreview.status] ?? STATUS_META.flat).cls}
                hint="權益數 ÷ 所需原始保證金——期貨商 App 顯示的就是這個口徑。"
              />
              <Row label="追繳價" value={specPreview.margin_call_price === null ? '—' : px(specPreview.margin_call_price)} cls="text-amber-400" />
              <Row label="斷頭價" value={specPreview.liquidation_price === null ? '—' : px(specPreview.liquidation_price)} cls="text-rose-400" />
            </dl>
            <p className="text-[10px] text-zinc-600 mt-2.5">
              期貨商 App 的「原始保證金」「維持率保證金」兩格應該跟這裡完全一致；對不上就是上面的每口金額填錯。
              要逐欄核對整組數字，到「部位 &amp; 平倉紀錄」分頁按「跟期貨商對帳」。
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-border/50">
          {preset && (
            <button
              onClick={() => void saveToCloud(patch((c) => ({ ...c, products: { ...c.products, [activeCode]: { ...c.products[activeCode], spec: { ...preset.spec } } } })))}
              className="text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              還原成 {preset.code} 的公告預設值
            </button>
          )}
          <button
            onClick={handleSyncMargins}
            disabled={syncState.status === 'loading'}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            {syncState.status === 'loading' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            同步保證金
          </button>
          {syncState.message && (
            <span className={`text-[11px] ${syncState.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>
              {syncState.message}
            </span>
          )}
          <button
            onClick={() => void saveToCloud(patch((c) => ({
              ...c,
              planner: { ...c.planner, [activeCode]: { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] } },
            })))}
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            title="只清掉「這個商品」的試算頁參數，實際部位與平倉紀錄不受影響"
          >
            還原試算參數
          </button>
          <span className="text-[11px] text-zinc-600">
            目前一跳 ＝ {money(tickValue(activeProductCfg.spec))}
          </span>
        </div>
      </div>

      {syncModal && syncModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200 text-left">
            <div>
              <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-primary animate-spin" style={{ animationDuration: '3s' }} />
                確認同步保證金規格
              </h3>
              <p className="text-[11px] text-zinc-400 mt-1">
                期交所 {syncModal.date} 現行值已與目前設定不同，請確認變更後的影響：
              </p>
            </div>

            <div className="space-y-3 bg-zinc-950/50 border border-zinc-800/60 rounded-xl p-4 text-xs">
              <div className="flex justify-between items-center pb-2 border-b border-zinc-800/50">
                <span className="text-zinc-400">商品合約</span>
                <span className="font-semibold text-zinc-200">{activeProductCfg.name}</span>
              </div>

              <div className="space-y-1.5 pt-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400">原始保證金</span>
                  <span className="font-mono text-zinc-300">
                    {money(syncModal.oldInitial)} → <strong className="text-primary">{money(syncModal.newInitial)}</strong>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">維持保證金</span>
                  <span className="font-mono text-zinc-300">
                    {money(syncModal.oldMaintenance)} → <strong className="text-primary">{money(syncModal.newMaintenance)}</strong>
                  </span>
                </div>
              </div>

              {syncModal.lots > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-zinc-800/50">
                  <div className="flex justify-between">
                    <span className="text-zinc-400">目前部位</span>
                    <span className="text-zinc-300 font-semibold">{syncModal.lots} 口</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">總所需原始保證金</span>
                    <span className="font-mono text-zinc-300">
                      {money(syncModal.oldMarginUsed)} → <strong className="text-amber-400">{money(syncModal.newMarginUsed)}</strong>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">追繳價</span>
                    <span className="font-mono text-zinc-300">
                      {syncModal.oldMarginCallPrice !== null ? px(syncModal.oldMarginCallPrice) : '—'} →{' '}
                      <strong className="text-rose-400">
                        {syncModal.newMarginCallPrice !== null ? px(syncModal.newMarginCallPrice) : '—'}
                      </strong>
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="text-[11px] text-zinc-500 bg-zinc-950/30 rounded-lg p-2.5 leading-relaxed border border-zinc-800/40">
              ⚠️ <strong>警告：</strong> 變更保證金設定會立即重新計算目前的風險指標、追繳價與斷頭價。如果您的部位正處於追繳邊緣，調高保證金可能會導致風險指標瞬間降低。
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setSyncModal(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-2 rounded-lg text-xs font-semibold transition"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const d = syncModal.date;
                  void saveToCloud(patch((c) => ({ ...c, products: { ...c.products, [activeCode]: { ...c.products[activeCode], spec: syncModal.pendingSpec } } })));
                  setSyncModal(null);
                  setSyncState({ status: 'success', message: `已套用期交所 ${d} 現行值並存到雲端` });
                }}
                className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground py-2 rounded-lg text-xs font-semibold transition shadow-md shadow-primary/20"
              >
                確認套用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── 整體邏輯（說明頁）───────────────────────────────────────────────────────

const LogicTab: React.FC<{ spec: FuturesSpec }> = ({ spec }) => (
  <div className="space-y-5">
    <Section title="這頁在算什麼">
      <ul className="text-xs text-zinc-300 leading-relaxed space-y-2 list-disc list-inside">
        <li>
          <strong className="text-zinc-100">未實現損益</strong>＝（現價 − 進場價）× {spec.contract_size.toLocaleString()} × 口數 ×（多單 +1 / 空單 −1），
          再扣掉來回手續費與期交稅。空單方向相反。
        </li>
        <li>
          <strong className="text-zinc-100">權益數</strong>＝保證金專戶現金餘額 ＋ 未實現損益。
          期貨每日結算（逐日洗價），未實現損益每天真的在專戶進出，所以權益數才是你真正的餘額。
        </li>
        <li>
          <strong className="text-zinc-100">風險指標</strong>＝權益數 ÷ 未沖銷部位所需<strong className="text-zinc-100">原始</strong>保證金
          （期交所定義，期貨商 App 顯示的就是它）。盤中低於 {pct(spec.liquidation_ratio, 0)} 直接強制平倉；
          低於 100% 只是不能再開新倉。<strong className="text-zinc-100">追繳是另一條線</strong>：權益數低於
          <strong className="text-zinc-100">維持</strong>保證金才會收到追繳通知，要補到原始保證金水準。
        </li>
        <li>
          <strong className="text-zinc-100">損益平衡價</strong>含來回費用，所以多單的平衡價會略高於進場價——
          只回到進場價其實還虧一趟手續費。
        </li>
        <li>
          <strong className="text-zinc-100">追繳價／斷頭價</strong>是解「權益數 ＝ 門檻」的價格，
          期交稅隨價格變動的部分也解進去了，是精確值不是估算。多空並存到完全對沖時沒有這兩個價位（價格不再影響權益數）。
        </li>
      </ul>
    </Section>

    <Section title="期貨跟現股哪裡不一樣（這頁存在的理由）">
      <ul className="text-xs text-zinc-300 leading-relaxed space-y-2 list-disc list-inside">
        <li>
          <strong className="text-zinc-100">有槓桿</strong>：一口 {CONTRACT_CODE} 名目曝險是價格 × {spec.contract_size.toLocaleString()}，
          但只押 {money(spec.initial_margin)} 保證金。價格 −10%，權益數可能就 −100%。看「賺賠幾 %」要看保證金報酬率，不是價格漲跌幅。
        </li>
        <li>
          <strong className="text-zinc-100">會被強制平倉</strong>：現股套牢可以裝死，期貨不行。
          所以這頁把追繳價與斷頭價放在最顯眼的位置。
        </li>
        <li>
          <strong className="text-zinc-100">會到期</strong>：忘了轉倉就被現金結算掉，部位憑空消失。
          預設到期前 {spec.rollover_days} 天開始提醒，橫幅在每個分頁都看得到。
        </li>
        <li>
          <strong className="text-zinc-100">每日結算</strong>：平倉損益當天就進出專戶，
          所以「已實現損益」不再加進權益數（現金餘額已經含了），只作績效回顧。
        </li>
      </ul>
    </Section>

    <Section title="試算頁在算什麼（壓力測試／建倉試算）">
      <ul className="text-xs text-zinc-300 leading-relaxed space-y-2 list-disc list-inside">
        <li>
          <strong className="text-zinc-100">壓力測試</strong>不是另一套公式：它把「現在價格」換成修正後的價格，
          原封不動重跑總覽那組算式，所以兩頁的數字一定對得起來。標的跌幅 ＝ 大盤跌幅 × beta。
          這是<strong className="text-zinc-100">靜態</strong>測試——假設不加碼、不補錢，而且保證金不變；
          真崩盤時期交所會調高保證金，斷頭會比表上更早。
        </li>
        <li>
          <strong className="text-zinc-100">槓桿</strong>的定義是名目曝險 ÷ 本金，不是「保證金的幾倍」。
          建議口數同時受兩個限制：槓桿目標算出來的口數，以及本金押得起的原始保證金上限，取小的那個。
        </li>
        <li>
          <strong className="text-zinc-100">安全出金上限</strong>＝到價後的權益數 − 指定倍數的原始保證金。
          賺到的錢不能全領走，部位還在，領太多風險指標就掉回警戒區。
        </li>
        <li>
          <strong className="text-zinc-100">大盤點數換算</strong>只是把價格翻譯成看盤時有感的刻度，
          用的是固定 beta 的線性關係，不是迴歸結果——大跌時 0050 與加權指數的關係會偏離，別當精確預測。
        </li>
      </ul>
    </Section>

    <Section title="跟再平衡計算機的關係">
      <p className="text-xs text-zinc-300 leading-relaxed">
        再平衡頁管的是現股部位的 β（00631L ＋ 債券 ETF ＋ 現金）。這頁的 {CONTRACT_CODE} 多單本質上就是
        <strong className="text-zinc-100"> {UNDERLYING_CODE} 的曝險</strong>，β 約 1.0 但用保證金撐起來，
        所以在算「整體資產的市場曝險」時，應該把這頁的<strong className="text-zinc-100">名目曝險</strong>（不是保證金）
        加進再平衡頁的分子。兩頁目前是各自獨立的，尚未自動合併計算——要合併的話是之後的題目。
      </p>
    </Section>

    <Section title="資料來源與限制">
      <ul className="text-xs text-zinc-300 leading-relaxed space-y-2 list-disc list-inside">
        <li>
          <strong className="text-zinc-100">報價</strong>：串接期交所 MIS 即時行情與
          <span className="font-mono text-zinc-400"> DailyMarketReportFut</span> 每日行情。
          <strong className="text-zinc-100">日盤／夜盤 MIS 即時價優先</strong>，按「真實同步」可取得當下最新報價；
          若當下非交易時段、MIS 暫時失效或該合約月份沒有成交（如遠月合約），則<strong className="text-zinc-100">退回每日行情檔的結算價／收盤價</strong>
          （遠月合約沒有成交量時無即時價，顯示「結算價」為正常現象而非故障）。
        </li>
        <li>
          <strong className="text-zinc-100">部位</strong>：手動輸入。玉山證券的交易 API（esun_trade）只涵蓋
          <strong className="text-zinc-100">證券帳戶</strong>，庫存／餘額／交割都是股票的；期貨是獨立的期貨商帳戶，
          該 SDK 沒有任何期貨帳務方法，官方文件的「期貨」章節也只有<strong className="text-zinc-100">行情</strong>不含帳務。
          因此這頁的「真實同步」<strong className="text-zinc-100">只做行情＋雲端對存</strong>，
          不像再平衡頁那顆會登入券商抓庫存——口數、進場價、保證金專戶餘額都要自己維護。
          真要自動化，得等期貨商開放帳務 API，或改用有期貨 API 的期貨商（如永豐 Shioaji、富邦 Neo）。
        </li>
        <li>
          <strong className="text-zinc-100">加權指數</strong>：gateway 直接抓證交所，兩個源接力——
          <strong className="text-zinc-100">盤中走 MIS</strong>（<span className="font-mono text-zinc-400">mis.twse.com.tw</span>，
          看盤網頁自己在用的端點，約每 5 秒更新，所以按「真實同步」拿到的是<strong className="text-zinc-100">即時</strong>指數）；
          收盤後 MIS 的成交價會變成 <span className="font-mono text-zinc-400">'-'</span>，改退回證交所
          OpenAPI 的每日收盤指數，狀態列會照實標成「收盤」而不是「即時」。
          這條路刻意<strong className="text-zinc-100">不經 Python engine</strong>——期貨頁是本機 gateway
          （沒有 engine）少數還能用的頁面，掛上去會讓本機的「真實同步」直接壞掉。
        </li>
        <li>
          <strong className="text-zinc-100">最後交易日</strong>：按第三個星期三的規則推算，不含台股國定假日曆。
          撞到連假會順延，以期交所公告為準。
        </li>
        <li>
          <strong className="text-zinc-100">保證金</strong>：預設是期交所 2026-06-18 公告值，會隨市場風險調整。
          期貨商通知調整時到「契約規格 &amp; 設定」更新。
        </li>
      </ul>
    </Section>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-3">
    <h2 className="text-sm font-bold text-zinc-100 tracking-wide">{title}</h2>
    {children}
  </div>
);
