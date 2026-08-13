import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, CalendarClock, Cloud, CloudOff, Loader2,
  Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Gauge,
  ClipboardCopy, Check, Target, Layers,
  ShieldCheck, Wallet, ListOrdered, CalendarSync, SlidersHorizontal, BookOpen,
  LineChart, Flame, Ruler, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight,
} from 'lucide-react';
import { Panel, StatTile, RiskMeter, ThreatCard, LevelCard, Row, Chip, type Tone } from '../components/futures/ui';
import { api } from '../lib/api';
import type { FuturesMonthQuote, FuturesEquityHistoryResp, FuturesMarginsResp, TaiexResp } from '../lib/api';
import {
  CONTRACT_CODE, CONTRACT_NAME, UNDERLYING_CODE,
  DEFAULT_SPEC, SYMBOL_PRESETS, findPreset,
  tickValue, lastTradingDay, tradingDaysBetween,
  positionPnl, closedPnl, summarizeAccount, rolloverAlerts, rolloverCost, stopLossRisk,
  indexAtPrice, stressTest, suggestLots, weightedEntry, targetPlan, trailingStopPlan,
  buildRiskReport, priceOf, referenceMonthOf,
  equityStats, summarizeCashFlows, flowDelta,
  type FuturesPosition, type ClosedTrade, type CashFlow, type Side, type FuturesSpec, type StressRow,
  type PriceInput, type EquityPoint,
} from '../lib/futures';
import {
  getFuturesConfig, saveFuturesConfig, subscribeFutures,
  DEFAULT_PLANNER, type FuturesConfig,
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
      if (r.index > 0) patch((c) => ({ ...c, index_ref: r.index }));
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
      const resp = await api.getFuturesQuote(getFuturesConfig().contract || CONTRACT_CODE);
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
      const refMonth = referenceMonthOf(cur.positions);
      const target = resp.months.find((m) => m.month === refMonth)
        ?? resp.months.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
      const price = target ? (prices[target.month] ?? 0) : 0;

      const next = patch((c) => ({
        ...c,
        prices: { ...c.prices, ...prices },
        ...(price > 0 ? { price, price_month: target!.month } : {}),
        // live_source 只代表「MIS 這次請求有通」，不代表參考月份真的拿到即時價
        // （休市日、或只持有沒成交的遠月，MIS 會回 200 但每個月份都是空的）。
        // 這兩格描述的是「存下來的 price 是哪來的」，所以只能看參考月份自己。
        ...(target && target.live !== null && target.live !== undefined
          ? { price_as_of: target.live_time ?? resp.live_as_of ?? resp.date, price_source: 'live' as const }
          : { price_as_of: resp.date, price_source: 'daily' as const }),
      }));
      if (persist) void saveToCloud(next);
    } catch (e) {
      setQuote((q) => ({ ...q, status: 'error', msg: e instanceof Error ? e.message : '抓取失敗' }));
    }
  };

  const spec = config.spec;
  const preset = useMemo(() => findPreset(config.contract), [config.contract]);
  const symbolName = preset ? `${preset.name}（${preset.code}）` : `${CONTRACT_NAME}（${config.contract}）`;

  // 各月份分別報價；某月份沒抓到行情時退回使用者手填的參考價
  const priceInput = useMemo<PriceInput>(
    () => ({ byMonth: config.prices, fallback: config.price }),
    [config.prices, config.price],
  );

  const summary = useMemo(
    () => summarizeAccount(config.positions, priceInput, spec, config.cash, config.closed),
    [config.positions, priceInput, spec, config.cash, config.closed],
  );
  const alerts = useMemo(
    () => rolloverAlerts(config.positions, spec, todayStr(), holidays),
    [config.positions, spec, holidays],
  );
  const dueAlerts = alerts.filter((a) => a.due || a.expired);
  const statusMeta = STATUS_META[summary.status] ?? STATUS_META.flat;

  // 台指期本身就是大盤，beta 恆為 1；ETF 期貨才需要換算係數
  const beta = preset?.index_linked ? 1 : config.beta;
  const stress = useMemo(
    () => stressTest(config.positions, spec, config.cash, priceInput, {
      drops: config.planner.stress_drops, index: config.index_ref, beta, stopLoss: config.stop_loss,
    }),
    [config.positions, spec, config.cash, priceInput, config.planner.stress_drops, config.index_ref, beta, config.stop_loss],
  );
  const plan = useMemo(
    () => targetPlan(config.positions, spec, config.cash, priceInput, config.planner.gain_pct, config.planner.reserve_multiple),
    [config.positions, spec, config.cash, priceInput, config.planner.gain_pct, config.planner.reserve_multiple],
  );
  const report = useMemo(
    () => buildRiskReport({
      symbol_name: symbolName, spec, summary, price: summary.reference_price, cash: config.cash,
      index: config.index_ref, beta, stress,
      plan: summary.total_lots > 0 ? plan : null,
      alerts,
      flows: config.cash_flows,
    }),
    [symbolName, spec, summary, config.cash, config.index_ref, beta, stress, plan, alerts, config.cash_flows],
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
                {preset ? `（${preset.underlying}）` : ` ${UNDERLYING_CODE}`}
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
            // 這行只能印「期交所給的數字」。config.price 是下面那格後備價，使用者手打得進去，
            // 印它等於把使用者自己輸入的值標成期交所報價。
            const refMonthQuote = quote.months.find((m) => m.month === config.price_month);
            const shown = refMonthQuote ? (refMonthQuote.live ?? refMonthQuote.settlement ?? refMonthQuote.last) : null;
            const monthSuffix = config.price_month ? `（${monthLabel(config.price_month)} 月份）` : '';
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
        <OverviewTab config={config} summary={summary} statusMeta={statusMeta} spec={spec} beta={beta} plan={plan} priceInput={priceInput} quote={quote} historyState={historyState} />
      )}
      {activeTab === 'positions' && (
        <PositionsTab config={config} spec={spec} summary={summary} priceInput={priceInput} quote={quote} holidays={holidays} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'stress' && (
        <StressTab config={config} summary={summary} stress={stress} beta={beta} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'planner' && (
        <PlannerTab config={config} spec={spec} summary={summary} plan={plan} priceInput={priceInput} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'rollover' && (
        <RolloverTab config={config} spec={spec} summary={summary} alerts={alerts} quoteMonths={quote.months} holidays={holidays} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'settings' && (
        <SettingsTab config={config} preset={preset} patch={patch} saveToCloud={saveToCloud} />
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

const EquityCurveCard: React.FC<{
  historyState: {
    loading: boolean;
    error: string | null;
    data: FuturesEquityHistoryResp | null;
  };
  flows: CashFlow[];
}> = ({ historyState, flows }) => {
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
            風險指標：<span className="font-mono text-zinc-100 font-semibold">{singlePoint.risk_indicator !== null ? pct(singlePoint.risk_indicator, 0) : '—'}</span>
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
  const stats = equityStats(rows, { from: startDate }, flows);
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
}> = ({ config, summary, statusMeta, spec, beta, plan, priceInput, quote, historyState }) => {
  const cashFlowTotals = useMemo(() => summarizeCashFlows(config.cash_flows), [config.cash_flows]);
  const ri = summary.risk_indicator;
  const riPctText = ri === null ? '—' : `${(ri * 100).toFixed(0)}%`;
  const refPrice = summary.reference_price;
  const idx = (p: number | null) => idxText(p, refPrice, config.index_ref, beta);
  const hasLevels = summary.total_lots > 0 && summary.net_lots !== 0;

  /**
   * 警戒卡的四行。原本追繳／斷頭只是「危險價位」清單裡的兩列，跟現價、
   * 距離混在一起；拆成兩張獨立染色的卡之後，每一張自己回答同一組問題：
   * 觸發價、對應大盤點位、還能跌多少、大盤要掉幾點。
   */
  const threatRows = (price: number | null) => {
    const indexAt = price === null ? null : indexAtPrice(price, refPrice, config.index_ref, beta);
    const move = price !== null && refPrice > 0 ? (price - refPrice) / refPrice : null;
    const gap = indexAt === null ? null : indexAt - config.index_ref;
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
            label="風險指標"
            value={riPctText}
            sub={statusMeta.label}
            valueCls={statusMeta.cls}
            tone={statusMeta.tone}
            icon={<Gauge className="w-3 h-3" />}
            hint="權益數 ÷ 所需維持保證金。低於 100% 會收到追繳通知，盤中低於 25% 會被強制平倉。"
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
          <RiskMeter value={ri} tone={statusMeta.tone} liquidationRatio={spec.liquidation_ratio} />
        </div>
      </Panel>

      <EquityCurveCard historyState={historyState} flows={config.cash_flows} />

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
              sub={config.index_ref > 0 ? `${Math.round(config.index_ref).toLocaleString()} 點` : ''}
              base={refPrice}
            />
            <LevelCard tone="emerald" label={`目標價（+${(config.planner.gain_pct * 100).toFixed(0)}%）`} value={plan.target_price} sub={idx(plan.target_price)} base={refPrice} />
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
            {config.index_ref <= 0 && ' 在「契約規格 & 設定」填入目前的加權指數，這裡就會一併顯示對應點位。'}
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
          <Row label={`所需原始保證金（${summary.total_lots} 口 × ${money(spec.initial_margin)}）`} value={money(summary.required_initial)} />
          <Row label={`所需維持保證金（${summary.total_lots} 口 × ${money(spec.maintenance_margin)}）`} value={money(summary.required_maintenance)} />
          <Row
            label="超額保證金"
            value={money(summary.excess)}
            cls={summary.excess >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            hint="權益數 − 所需原始保證金。正的部分才是能再開倉或承受回檔的緩衝。"
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
          */}
          <div className="sm:hidden space-y-2">
            {config.positions.map((p) => {
              const mp = priceOf(priceInput, p.month);
              const r = positionPnl(p, mp, spec);
              return (
                <div key={p.id} className="rounded-xl border border-border bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                      p.side === 'long' ? 'text-bull border-bull/30 bg-bull/10' : 'text-bear border-bear/30 bg-bear/10'
                    }`}>
                      {p.side === 'long' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {p.side === 'long' ? '多' : '空'}
                    </span>
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
                      value={`${px(mp)}${config.prices[p.month] ? '' : '*'}`}
                      cls={config.prices[p.month] ? 'text-zinc-300' : 'text-amber-400'}
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
                  const mp = priceOf(priceInput, p.month);
                  const r = positionPnl(p, mp, spec);
                  return (
                    <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-zinc-800/40 transition-colors">
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
                        const origin = priceOrigin(p.month, quote, !!config.prices[p.month]);
                        return (
                          <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${config.prices[p.month] ? 'text-zinc-300' : 'text-amber-400'}`}
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
}> = ({ config, spec, summary, priceInput, quote, holidays, patch, saveToCloud }) => {
  const [form, setForm] = useState({ month: '', side: 'long' as Side, lots: '', entry_price: '', entry_date: todayStr() });
  const [closeForm, setCloseForm] = useState<{ id: string; exit_price: string; exit_date: string } | null>(null);

  const monthOptions = useMemo(() => {
    const fromQuote = quote.months.map((m) => m.month);
    const fromPositions = config.positions.map((p) => p.month);
    return [...new Set([...fromQuote, ...fromPositions])].sort();
  }, [quote.months, config.positions]);

  const addPosition = () => {
    const lots = parseFloat(form.lots);
    const entry = parseFloat(form.entry_price);
    if (!/^\d{6}$/.test(form.month) || !(lots > 0) || !(entry > 0)) return;
    const next = patch((c) => ({
      ...c,
      positions: [...c.positions, {
        id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        month: form.month,
        side: form.side,
        lots,
        entry_price: entry,
        entry_date: form.entry_date || todayStr(),
      }],
    }));
    setForm((f) => ({ ...f, lots: '', entry_price: '' }));
    void saveToCloud(next);
  };

  const removePosition = (id: string) => {
    const next = patch((c) => ({ ...c, positions: c.positions.filter((p) => p.id !== id) }));
    void saveToCloud(next);
  };

  // 平倉：把未平倉部位搬進平倉紀錄，並把損益結算進保證金專戶現金
  const closePosition = (pos: FuturesPosition, exitPrice: number, exitDate: string) => {
    const closed: ClosedTrade = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      month: pos.month,
      side: pos.side,
      lots: pos.lots,
      entry_price: pos.entry_price,
      exit_price: exitPrice,
      exit_date: exitDate || todayStr(),
    };
    const next = patch((c) => ({
      ...c,
      positions: c.positions.filter((p) => p.id !== pos.id),
      closed: [...c.closed, closed],
      // 期貨平倉當下損益就結算進專戶，故現金餘額同步加上這筆損益
      cash: c.cash + closedPnl(closed, spec),
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

        <CashReconcile config={config} summary={summary} patch={patch} saveToCloud={saveToCloud} />

        {/* 各月份現價：抓到行情的月份一覽，也可以手動覆寫某個月 */}
        {config.positions.length > 0 && (
          <div className="pt-3 border-t border-border/50 space-y-2">
            <div className="text-[11px] text-zinc-500">持倉月份的現價（各月份分別計價）</div>
            <div className="flex flex-wrap gap-2">
              {[...new Set(config.positions.map((p) => p.month))].sort().map((m) => {
                const origin = priceOrigin(m, quote, !!config.prices[m]);
                return (
                  <div key={m} className="flex items-center gap-1.5 bg-zinc-900/50 border border-border rounded-lg px-2.5 py-1.5">
                    <span className="text-[11px] font-mono text-zinc-400">{monthLabel(m)}</span>
                    <input
                      key={`mp-${m}-${config.prices[m] ?? 0}`}
                      type="number"
                      step="0.05"
                      defaultValue={config.prices[m] ?? ''}
                      placeholder={px(config.price)}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        void saveToCloud(patch((c) => {
                          const next = { ...c.prices };
                          const v = parseFloat(raw);
                          if (raw === '' || !Number.isFinite(v) || v <= 0) delete next[m];
                          else next[m] = v;
                          return { ...c, prices: next };
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
          const usingBackupMonths = [...new Set(config.positions.map((p) => p.month))].filter((m) => !config.prices[m]);
          return (
            <div className="pt-3 border-t border-border/50 space-y-2">
              <Field
                label="後備價（只有抓不到行情的月份會用到）"
                hint="按上方「真實同步」會自動填入期交所結算價；盤中想用即時價可手動改。有抓到行情的月份會各自用自己的價格，不吃這一格。"
              >
                <input
                  key={`price-${config.price}`}
                  type="number"
                  step="0.05"
                  defaultValue={config.price || ''}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0) void saveToCloud(patch((c) => ({ ...c, price: v })));
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

      {/* 新增部位 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-emerald-400/10 border border-emerald-400/30 grid place-items-center shrink-0"><Plus className="w-4 h-4 text-emerald-400" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">新增部位</h2></div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
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
          <Field label="方向">
            <select
              value={form.side}
              onChange={(e) => setForm((f) => ({ ...f, side: e.target.value as Side }))}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100"
            >
              <option value="long">多單</option>
              <option value="short">空單</option>
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
          <Plus className="w-3.5 h-3.5" /> 新增部位
        </button>
        {form.month && (
          <p className="text-[11px] text-zinc-500">
            {monthLabel(form.month)} 最後交易日 {lastTradingDay(form.month, holidays) ?? '—'}；
            {form.lots && Number(form.lots) > 0 && (
              <> 這筆需要原始保證金 {money(spec.initial_margin * Number(form.lots))}。</>
            )}
          </p>
        )}
      </div>

      {/* 現有部位 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-3">
        <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Layers className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">未平倉部位（{config.positions.length}）</h2></div>
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有部位。</p>
        ) : config.positions.map((p) => {
          const mp = priceOf(priceInput, p.month);
          const r = positionPnl(p, mp, spec);
          const stop = config.stop_loss[p.id];
          const risk = stop ? stopLossRisk(p, stop, spec, summary.equity) : null;
          return (
            <div key={p.id} className="border border-border/70 rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="font-mono text-zinc-300">{monthLabel(p.month)}</span>
                <span className={p.side === 'long' ? 'text-bull' : 'text-bear'}>{p.side === 'long' ? '多' : '空'} {p.lots} 口</span>
                <span className="text-zinc-500">進場 {px(p.entry_price)}（{p.entry_date || '—'}）</span>
                <span className={`font-mono font-semibold ${pnlCls(r.net_pnl)}`}>{money(r.net_pnl)}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setCloseForm({ id: p.id, exit_price: String(mp || ''), exit_date: todayStr() })}
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
                      if (Number.isFinite(v) && v > 0) closePosition(p, v, closeForm.exit_date);
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
                {config.closed.map((t) => (
                  <tr key={t.id} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 font-mono text-zinc-400">{t.exit_date || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(t.month)}</td>
                    <td className={`py-2 pr-3 ${t.side === 'long' ? 'text-bull' : 'text-bear'}`}>{t.side === 'long' ? '多' : '空'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{t.lots}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.entry_price)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(t.exit_price)}</td>
                    <td className={`py-2 pr-3 text-right font-mono font-semibold ${pnlCls(closedPnl(t, spec))}`}>{money(closedPnl(t, spec))}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => {
                          const next = patch((c) => ({
                            ...c,
                            closed: c.closed.filter((x) => x.id !== t.id),
                            cash: c.cash - closedPnl(t, spec), // 刪紀錄時把當初結算進去的損益扣回來
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
                ))}
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
  const riAfterOut = summary.required_maintenance > 0 ? equityAfterOut / summary.required_maintenance : null;
  const outTone = riAfterOut === null ? 'text-zinc-400'
    : riAfterOut < 1 ? 'text-rose-400'
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
          ⚠ 這筆出金會讓風險指標掉到 {pct(riAfterOut, 0)}（低於 100%），等於自己走進追繳區。要領這麼多請先減碼。
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
 * 保證金專戶餘額對帳。
 *
 * `cash` 全靠手動維護，久了一定會跟期貨商對不起來（手續費尾差、利息、忘了記的入出金）。
 * 期貨商 App 上看得到「權益數」，這裡讓你把它填進來反推 cash 應該是多少：
 *   cash = 期貨商權益數 − 本頁算出來的未實現損益
 * 差額就是漂掉的量，按一下就校正。
 */
const CashReconcile: React.FC<{
  config: FuturesConfig;
  summary: Summary;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, summary, patch, saveToCloud }) => {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const actual = parseFloat(raw);
  const valid = Number.isFinite(actual);
  const impliedCash = valid ? actual - summary.unrealized : 0;
  const diff = valid ? impliedCash - config.cash : 0;

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
        打開期貨商 App 看「權益數」（不是「保證金餘額」），填進來反推本頁的現金餘額該是多少。
        手續費尾差、利息、忘了記的入出金都會在這裡現形。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="期貨商顯示的權益數">
          <input
            type="number"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={String(Math.round(summary.equity))}
            className="w-36 bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
          />
        </Field>
        {valid && (
          <>
            <dl className="text-xs space-y-1 min-w-[220px]">
              <Row label="本頁未實現損益" value={money(summary.unrealized)} cls={pnlCls(summary.unrealized)} />
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
  summary: Summary;
  alerts: ReturnType<typeof rolloverAlerts>;
  quoteMonths: FuturesMonthQuote[];
  holidays: Set<string> | undefined;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, spec, summary, alerts, quoteMonths, holidays, patch, saveToCloud }) => {
  // 預設把「最快到期的持倉月份」填進近月，省得每次自己選
  const dueMonth = alerts.find((a) => a.due || a.expired)?.month ?? alerts[0]?.month ?? '';
  const [near, setNear] = useState(dueMonth);
  const [far, setFar] = useState('');
  const [lots, setLots] = useState('');

  const marketPrice = (m: string) => {
    const q = quoteMonths.find((x) => x.month === m);
    return q?.settlement ?? q?.last ?? config.prices[m] ?? 0;
  };
  const cost = useMemo(() => {
    const n = parseFloat(lots);
    if (!near || !far || !(n > 0)) return null;
    const np = marketPrice(near);
    const fp = marketPrice(far);
    if (!(np > 0) || !(fp > 0)) return null;
    return { ...rolloverCost(n, np, fp, spec), np, fp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, far, lots, quoteMonths, spec, config.prices]);

  // 一鍵轉倉可以處理的部位＝近月所有未平倉部位
  const nearPositions = useMemo(
    () => config.positions.filter((p) => p.month === near && p.lots > 0),
    [config.positions, near],
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
      const rolling = c.positions.filter((p) => p.month === near && p.lots > 0);
      const closedNew: ClosedTrade[] = rolling.map((p, i) => ({
        id: `c_${stamp}_${i}`,
        month: p.month, side: p.side, lots: p.lots,
        entry_price: p.entry_price, exit_price: np, exit_date: today,
        note: `轉倉至 ${monthLabel(far)}`,
      }));
      const opened: FuturesPosition[] = rolling.map((p, i) => ({
        id: `f_${stamp}_${i}`,
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
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">目前沒有未平倉部位。</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="平掉的月份（近月）">
                <select value={near} onChange={(e) => setNear(e.target.value)}
                  className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
                  <option value="">選擇…</option>
                  {summary.months.map((m) => (
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
                  <tr key={a.month} className="border-b border-border/50 last:border-0">
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
          <div className="flex items-center gap-2.5 mb-3"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><LineChart className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">{CONTRACT_CODE} 各月份行情（期交所每日行情）</h2></div>
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
                  <tr key={m.month} className={`border-b border-border/50 last:border-0 ${m.month === config.price_month ? 'bg-primary/5' : ''}`}>
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
  config: FuturesConfig;
  summary: Summary;
  stress: StressRow[];
  beta: number;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, summary, stress, beta, patch, saveToCloud }) => {
  const setDrops = (drops: number[]) => {
    void saveToCloud(patch((c) => ({ ...c, planner: { ...c.planner, stress_drops: drops } })));
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
                {config.index_ref > 0 && <th className="text-right font-semibold py-2.5 pr-3">預估加權指數</th>}
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
                    {config.index_ref > 0 && (
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
}> = ({ config, spec, summary, plan, priceInput, patch, saveToCloud }) => {
  const p = config.planner;
  // 有部位時以參考月份的價格為基準，沒部位時用手填的參考價（建倉試算的情境）
  const refPrice = summary.total_lots > 0 ? summary.reference_price : config.price;
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

  const setPlanner = (u: (x: FuturesConfig['planner']) => FuturesConfig['planner'], persist = true) => {
    const next = patch((c) => ({ ...c, planner: u(c.planner) }));
    if (persist) void saveToCloud(next);
    return next;
  };

  const capital = p.capital > 0 ? p.capital : config.cash;
  const suggestion = useMemo(
    () => suggestLots(capital, refPrice, lev, spec),
    [capital, refPrice, lev, spec],
  );

  // 分批進場：用假想部位跑一次總覽的算式，直接看到這個組合的風險長相
  const batch = useMemo(() => weightedEntry(p.batches, spec), [p.batches, spec]);
  const batchSim = useMemo(() => {
    if (!(batch.lots > 0) || !(batch.avg_price > 0)) return null;
    const virtual: FuturesPosition[] = [{
      id: '_batch', month: '', side: 'long', lots: batch.lots,
      entry_price: batch.avg_price, entry_date: '',
    }];
    return summarizeAccount(virtual, refPrice > 0 ? refPrice : batch.avg_price, spec, capital);
  }, [batch, refPrice, spec, capital]);

  const peak = p.trailing_peak > 0 ? p.trailing_peak : plan.target_price;
  const trailing = useMemo(
    () => trailingStopPlan(config.positions, spec, priceInput, peak, p.trailing_dist),
    [config.positions, spec, priceInput, peak, p.trailing_dist],
  );

  return (
    <div className="space-y-5">
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
            type="range" min="1" max="10" step="0.1" value={lev}
            onChange={(e) => setLev(parseFloat(e.target.value))}
            onMouseUp={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            onTouchEnd={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            onKeyUp={() => setPlanner((x) => ({ ...x, target_leverage: lev }))}
            className="w-full h-2 bg-zinc-900 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
            <span>1x 無槓桿</span><span>3x 平衡</span><span>5x 高槓桿</span><span>10x 極限</span>
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
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><Layers className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">分批進場／加碼試算</h2></div>
          <p className="text-[11px] text-zinc-500 mt-1">
            填入各批的價格與口數，算出加權平均成本，並用這個組合跑一次風險模型。這裡只是試算，不會動到實際部位。
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {p.batches.slice(0, 3).map((b, i) => (
            <div key={i} className="bg-zinc-900/40 border border-border rounded-lg p-3 space-y-2">
              <div className="text-[11px] font-semibold text-zinc-300">
                第 {i + 1} 筆{i === 0 ? '（建倉）' : '（加碼）'}
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

const SettingsTab: React.FC<{
  config: FuturesConfig;
  preset: ReturnType<typeof findPreset>;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, preset, patch, saveToCloud }) => {
  const [apiMargins, setApiMargins] = useState<FuturesMarginsResp | null>(null);
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
    return () => { cancelled = true; };
  }, []);

  const handleSyncMargins = async () => {
    setSyncState({ status: 'loading', message: null });
    try {
      const resp = await api.getFuturesMargins();
      setApiMargins(resp);
      const contractKey = config.contract;
      const marginInfo = resp.margins[contractKey];
      if (!marginInfo) {
        setSyncState({
          status: 'success',
          message: `這個商品期交所沒有提供 API，保證金請依期貨商通知手動維護`
        });
        return;
      }

      const isIdentical =
        config.spec.initial_margin === marginInfo.initial &&
        config.spec.maintenance_margin === marginInfo.maintenance;

      if (isIdentical) {
        setSyncState({
          status: 'success',
          message: `已是最新（期交所 ${resp.date} 現行值${resp.stale ? '，磁碟快取' : ''}）`
        });
        return;
      }

      const newSpec: FuturesSpec = {
        ...config.spec,
        initial_margin: marginInfo.initial,
        maintenance_margin: marginInfo.maintenance,
      };

      const priceInput = { byMonth: config.prices, fallback: config.price };
      const oldSummary = summarizeAccount(config.positions, priceInput, config.spec, config.cash, config.closed);
      const newSummary = summarizeAccount(config.positions, priceInput, newSpec, config.cash, config.closed);

      // 口數與所需保證金直接取彙總的結果，不要自己再 reduce 一次——
      // summarizeAccount 會把負數/壞掉的 lots 夾成 0，手算的版本不會。
      setSyncModal({
        isOpen: true,
        date: resp.date,
        oldInitial: config.spec.initial_margin,
        newInitial: marginInfo.initial,
        oldMaintenance: config.spec.maintenance_margin,
        newMaintenance: marginInfo.maintenance,
        lots: oldSummary.total_lots,
        oldMarginUsed: oldSummary.required_initial,
        newMarginUsed: newSummary.required_initial,
        oldMarginCallPrice: oldSummary.margin_call_price,
        newMarginCallPrice: newSummary.margin_call_price,
        pendingSpec: newSpec,
      });
      setSyncState({ status: 'idle', message: null });
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
    const stale = apiMargins?.stale ? '（期交所暫時抓不到，顯示的是磁碟快取）' : '';
    if (apiMargins) {
      const marginInfo = apiMargins.margins[config.contract];
      if (marginInfo) {
        const same = config.spec.initial_margin === marginInfo.initial
          && config.spec.maintenance_margin === marginInfo.maintenance;
        if (same) {
          return { text: `保證金＝期交所 ${apiMargins.date} 現行值（OpenAPI 自動同步）${stale}`, warn: false };
        }
        return {
          text: `⚠️ 目前設定（原始 ${money(config.spec.initial_margin)}／維持 ${money(config.spec.maintenance_margin)}）`
            + `與期交所 ${apiMargins.date} 現行值（原始 ${money(marginInfo.initial)}／維持 ${money(marginInfo.maintenance)}）不一致`
            + `${stale}，追繳價與斷頭價正在用舊值計算——請按下方「同步保證金」。`,
          warn: true,
        };
      }
      return { text: '這個商品期交所沒有提供 OpenAPI，保證金請依期貨商通知手動維護。', warn: false };
    }
    return {
      text: '保證金會依市場風險調整，期貨商通知調整時回來這裡改，追繳價與斷頭價會跟著更新。'
        + '指數類商品（TX／MTX／TMF）可以按下方「同步保證金」直接抓期交所現行值。',
      warn: false,
    };
  })();

  // 非受控＋key：按「還原預設值」時 key 跟著變，輸入框重掛載吃到新值
  const commit = (key: keyof FuturesSpec, raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    void saveToCloud(patch((c) => ({ ...c, spec: { ...c.spec, [key]: v } })));
  };

  /**
   * 換商品＝連契約規格一起換。既有部位不動（口數與進場價還在），但它們的意義會變，
   * 所以有部位時先確認一次——不然從 SRF 切到台指期，同樣「10 口 102 元」會變成
   * 完全不同的東西。
   */
  const switchSymbol = (code: string) => {
    const p = findPreset(code);
    if (!p) return;
    if (config.positions.length > 0 &&
        !window.confirm(`目前有 ${config.positions.length} 筆未平倉部位。換成「${p.name}」會一併換掉契約單位與保證金，既有部位的損益會用新規格重算。確定要換嗎？`)) {
      return;
    }
    void saveToCloud(patch((c) => ({
      ...c,
      contract: p.code,
      spec: { ...p.spec },
      beta: p.index_linked ? 1 : c.beta,
    })));
  };

  return (
    <div className="space-y-5">
      {/* 商品切換 */}
      <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0"><SlidersHorizontal className="w-4 h-4 text-primary" /></span><h2 className="text-sm font-bold text-zinc-100 tracking-wide">交易商品</h2></div>
          <p className="text-[11px] text-zinc-500 mt-1">
            切換會一併帶入該商品的契約單位與保證金預設值。代碼同時是期交所行情 API 的商品代碼，抓行情用的就是它。
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {SYMBOL_PRESETS.map((p) => (
            <button
              key={p.code}
              onClick={() => switchSymbol(p.code)}
              className={`text-left rounded-xl border p-3 transition ${
                config.contract === p.code
                  ? 'bg-primary/10 border-primary/50'
                  : 'bg-zinc-900/40 border-border hover:border-zinc-500'
              }`}
            >
              <div className={`text-xs font-semibold ${config.contract === p.code ? 'text-primary' : 'text-zinc-200'}`}>
                {p.name}
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-border/50">
          <Field label="期交所行情代碼" hint="上面沒有的商品可以自己填，例如台股期貨 TX。填錯會在抓行情時回報「今日行情沒有這個商品」。">
            <input
              key={`contract-${config.contract}`}
              defaultValue={config.contract}
              onBlur={(e) => {
                const v = e.target.value.trim().toUpperCase();
                if (v && v !== config.contract) void saveToCloud(patch((c) => ({ ...c, contract: v })));
              }}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
            />
          </Field>
          <Field label="目前加權指數" hint="按上方「真實同步」會自動抓 TWSE 最新指數填進來（盤中即時），也可以手動覆寫。留 0 ＝不顯示大盤點數換算。">
            <NumInput value={config.index_ref} step="10" min="0" placeholder="例：40039"
              onCommit={(v) => void saveToCloud(patch((c) => ({ ...c, index_ref: Math.max(0, v) })))} />
          </Field>
          <Field
            label={`標的 beta${preset?.index_linked ? '（指數商品固定 1）' : ''}`}
            hint="標的相對大盤的連動係數。0050 對加權指數約 1.0～1.1；台指期本身就是大盤，固定 1。"
          >
            {preset?.index_linked ? (
              <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-500">1.00</div>
            ) : (
              <NumInput value={config.beta} step="0.05" min="0.01"
                onCommit={(v) => void saveToCloud(patch((c) => ({ ...c, beta: Math.max(0.01, Math.min(5, v)) })))} />
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
                key={`${f.key}-${config.spec[f.key]}`}
                type="number"
                step={f.step}
                defaultValue={config.spec[f.key]}
                onBlur={(e) => commit(f.key, e.target.value)}
                className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
              />
              <p className="text-[10px] text-zinc-600 mt-1">{f.hint}</p>
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-border/50">
          <button
            onClick={() => void saveToCloud(patch((c) => ({ ...c, spec: { ...(preset?.spec ?? DEFAULT_SPEC) } })))}
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
          >
            還原成 {preset?.code ?? CONTRACT_CODE} 的公告預設值
          </button>
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
              planner: { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] },
            })))}
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            title="只清掉試算頁的參數，實際部位與平倉紀錄不受影響"
          >
            還原試算參數
          </button>
          <span className="text-[11px] text-zinc-600">
            目前一跳 ＝ {money(tickValue(config.spec))}
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
                <span className="font-semibold text-zinc-200">{config.contract}</span>
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
                  void saveToCloud(patch((c) => ({ ...c, spec: syncModal.pendingSpec })));
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
          <strong className="text-zinc-100">風險指標</strong>＝權益數 ÷ 未沖銷部位所需維持保證金。
          低於 100% 期貨商發追繳通知（要補到原始保證金）；盤中低於 {pct(spec.liquidation_ratio, 0)} 直接強制平倉。
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
