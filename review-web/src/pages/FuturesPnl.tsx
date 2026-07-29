import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, CalendarClock, Cloud, CloudOff, Loader2,
  Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Gauge,
  ClipboardCopy, Check, Zap, Target, PiggyBank, Layers,
} from 'lucide-react';
import { api } from '../lib/api';
import type { FuturesMonthQuote } from '../lib/api';
import {
  CONTRACT_CODE, CONTRACT_NAME, UNDERLYING_CODE,
  DEFAULT_SPEC, SYMBOL_PRESETS, findPreset,
  tickValue, lastTradingDay, daysBetween,
  positionPnl, closedPnl, summarizeAccount, rolloverAlerts, rolloverCost, stopLossRisk,
  indexAtPrice, stressTest, suggestLots, weightedEntry, targetPlan, trailingStopPlan,
  compareSpotVsFutures, buildRiskReport,
  type FuturesPosition, type ClosedTrade, type Side, type FuturesSpec, type StressRow,
} from '../lib/futures';
import {
  getFuturesConfig, saveFuturesConfig, subscribeFutures,
  DEFAULT_PLANNER, DEFAULT_SPOT, type FuturesConfig,
} from '../lib/futuresStore';

type FuturesTab = 'overview' | 'positions' | 'stress' | 'planner' | 'rollover' | 'spot' | 'settings' | 'logic';
const FUTURES_TABS: { id: FuturesTab; label: string }[] = [
  { id: 'overview', label: '損益總覽' },
  { id: 'positions', label: '部位 & 平倉紀錄' },
  { id: 'stress', label: '壓力測試' },
  { id: 'planner', label: '建倉 & 出場試算' },
  { id: 'rollover', label: '到期 & 轉倉' },
  { id: 'spot', label: '存股比較' },
  { id: 'settings', label: '契約規格 & 設定' },
  { id: 'logic', label: '整體邏輯' },
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
const STATUS_META: Record<string, { cls: string; ring: string; label: string; desc: string }> = {
  flat: { cls: 'text-zinc-400', ring: 'stroke-zinc-600', label: '無部位', desc: '目前沒有未平倉部位' },
  ok: { cls: 'text-emerald-400', ring: 'stroke-emerald-500', label: '安全', desc: '權益數高於所需原始保證金' },
  warn: { cls: 'text-amber-400', ring: 'stroke-amber-500', label: '低於原始保證金', desc: '還不會被追繳，但已無法再開新倉' },
  call: { cls: 'text-orange-400', ring: 'stroke-orange-500', label: '追繳區', desc: '權益數低於維持保證金，期貨商會發追繳通知' },
  danger: { cls: 'text-rose-500', ring: 'stroke-rose-500', label: '斷頭風險', desc: '風險指標低於 25%，盤中會被強制平倉' },
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
  const [quote, setQuote] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; msg: string | null; months: FuturesMonthQuote[] }>({
    status: 'idle', msg: null, months: [],
  });

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
      .finally(() => { if (!cancelled) void fetchQuote(false); });
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
    await fetchQuote(true);
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

  // 抓期交所每日行情：填現價（優先結算價，沒有就用最後成交價），並記下報價日
  const fetchQuote = async (persist = true) => {
    setQuote((q) => ({ ...q, status: 'loading', msg: null }));
    try {
      const resp = await api.getFuturesQuote(getFuturesConfig().contract || CONTRACT_CODE);
      setQuote({ status: 'done', msg: resp.date, months: resp.months });
      const cur = getFuturesConfig();
      // 有部位就用「最近月的持倉月份」報價，沒有就用成交量最大的那個月（＝主力月）
      const held = cur.positions.find((p) => p.lots > 0)?.month;
      const target = resp.months.find((m) => m.month === held)
        ?? resp.months.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
      if (target) {
        const price = target.settlement ?? target.last ?? 0;
        if (price > 0) {
          const next = patch((c) => ({ ...c, price, price_month: target.month, price_as_of: resp.date }));
          if (persist) void saveToCloud(next);
        }
      }
    } catch (e) {
      setQuote((q) => ({ ...q, status: 'error', msg: e instanceof Error ? e.message : '抓取失敗' }));
    }
  };

  const spec = config.spec;
  const preset = useMemo(() => findPreset(config.contract), [config.contract]);
  const symbolName = preset ? `${preset.name}（${preset.code}）` : `${CONTRACT_NAME}（${config.contract}）`;

  const summary = useMemo(
    () => summarizeAccount(config.positions, config.price, spec, config.cash, config.closed),
    [config.positions, config.price, spec, config.cash, config.closed],
  );
  const alerts = useMemo(
    () => rolloverAlerts(config.positions, spec, todayStr()),
    [config.positions, spec],
  );
  const dueAlerts = alerts.filter((a) => a.due || a.expired);
  const statusMeta = STATUS_META[summary.status] ?? STATUS_META.flat;

  // 台指期本身就是大盤，beta 恆為 1；ETF 期貨才需要換算係數
  const beta = preset?.index_linked ? 1 : config.beta;
  const stress = useMemo(
    () => stressTest(config.positions, spec, config.cash, config.price, {
      drops: config.planner.stress_drops, index: config.index_ref, beta,
    }),
    [config.positions, spec, config.cash, config.price, config.planner.stress_drops, config.index_ref, beta],
  );
  const plan = useMemo(
    () => targetPlan(config.positions, spec, config.cash, config.price, config.planner.gain_pct, config.planner.reserve_multiple),
    [config.positions, spec, config.cash, config.price, config.planner.gain_pct, config.planner.reserve_multiple],
  );
  const report = useMemo(
    () => buildRiskReport({
      symbol_name: symbolName, spec, summary, price: config.price, cash: config.cash,
      index: config.index_ref, beta, stress,
      plan: summary.total_lots > 0 ? plan : null,
      alerts,
    }),
    [symbolName, spec, summary, config.price, config.cash, config.index_ref, beta, stress, plan, alerts],
  );

  return (
    <div className="space-y-6">
      {/* 標題列 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            期貨損益總覽
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            {symbolName} — 一口 {spec.contract_size.toLocaleString()} {preset?.unit_label ?? '股/口'}
            {preset ? `（${preset.underlying}）` : ` ${UNDERLYING_CODE}`}，
            跳一檔 {spec.tick_size} ＝ {money(tickValue(spec))}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CopyReportButton text={report} />
          <button
            onClick={() => void realSync()}
            disabled={quote.status === 'loading' || cloud.status === 'loading'}
            className="text-[11px] text-cyan-400 hover:text-cyan-300 disabled:text-zinc-600 flex items-center gap-1 transition-colors"
            title="抓期交所最新行情更新現價，並與雲端對存回讀。注意：券商沒有期貨帳戶 API，口數/進場價/保證金餘額仍需手動維護。"
          >
            {quote.status === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            真實同步
          </button>
          <button
            onClick={() => void saveToCloud()}
            disabled={cloud.status === 'loading'}
            className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:text-zinc-600 flex items-center gap-1 transition-colors"
            title="只把目前設定存回雲端，不抓行情"
          >
            {cloud.status === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cloud className="w-3 h-3" />}
            存到雲端
          </button>
        </div>
      </div>

      {(cloud.msg || quote.msg) && (
        <div className="flex flex-wrap items-center gap-4 text-[11px] -mt-3">
          {cloud.msg && (
            <span className={`flex items-center gap-1 ${cloud.status === 'error' ? 'text-amber-400' : 'text-emerald-400'}`}>
              {cloud.status === 'error' ? <CloudOff className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />}
              {cloud.msg}
            </span>
          )}
          {quote.status === 'done' && (
            <span className="text-zinc-500">
              期交所行情 {quote.msg}
              {config.price_month ? `（${monthLabel(config.price_month)} 月份）` : ''}
            </span>
          )}
          {quote.status === 'error' && <span className="text-amber-400">行情抓取失敗：{quote.msg}</span>}
        </div>
      )}

      {/* 「真實同步」的涵蓋範圍——講在最前面，免得誤以為按了就等於跟券商對帳完成 */}
      <div className="text-[11px] text-zinc-500 -mt-3 flex items-start gap-1.5">
        <RefreshCw className="w-3 h-3 mt-0.5 shrink-0 text-zinc-600" />
        <span>
          <strong className="text-zinc-400">「真實同步」＝抓期交所最新行情更新現價＋與雲端對存回讀</strong>。
          口數／進場價／保證金專戶餘額<strong className="text-zinc-400">仍需手動維護</strong>——券商沒有期貨帳戶 API
          （玉山交易 API 只涵蓋證券帳戶，期貨是獨立的期貨商帳戶），詳見「整體邏輯」分頁。
        </span>
      </div>

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
              <div className="text-sm font-semibold text-zinc-100">轉倉提醒</div>
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
                        {monthLabel(a.month)} 還有 {a.days_left} 天到期
                      </strong>
                      （最後交易日 {a.last_trading_day}）——持有 {a.lots} 口，要續抱就得轉倉到次月。
                    </>
                  )}
                </div>
              ))}
              <div className="text-[11px] text-zinc-500 pt-1">
                提醒門檻：到期前 {spec.rollover_days} 天（可在「契約規格 &amp; 設定」分頁調整）
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 分頁導覽 */}
      <div className="border-b border-border/80">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {FUTURES_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => handleTabChange(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition whitespace-nowrap shrink-0 ${
                activeTab === t.id ? 'bg-primary text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <OverviewTab config={config} summary={summary} statusMeta={statusMeta} spec={spec} beta={beta} plan={plan} />
      )}
      {activeTab === 'positions' && (
        <PositionsTab config={config} spec={spec} summary={summary} quoteMonths={quote.months} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'stress' && (
        <StressTab config={config} summary={summary} stress={stress} beta={beta} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'planner' && (
        <PlannerTab config={config} spec={spec} summary={summary} plan={plan} patch={patch} saveToCloud={saveToCloud} />
      )}
      {activeTab === 'rollover' && (
        <RolloverTab config={config} spec={spec} alerts={alerts} quoteMonths={quote.months} />
      )}
      {activeTab === 'spot' && (
        <SpotCompareTab config={config} spec={spec} summary={summary} patch={patch} saveToCloud={saveToCloud} />
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
      className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
      title="把目前的部位、保證金水位、危險價位與壓力測試結果複製成一段純文字"
    >
      {done ? <Check className="w-3 h-3 text-emerald-400" /> : <ClipboardCopy className="w-3 h-3" />}
      {done ? '已複製' : '複製風控報告'}
    </button>
  );
};

// ── 損益總覽 ────────────────────────────────────────────────────────────────

type Summary = ReturnType<typeof summarizeAccount>;

const StatCard: React.FC<{ label: string; value: string; sub?: string; cls?: string; hint?: string }> = ({
  label, value, sub, cls, hint,
}) => (
  <div className="bg-card border border-border rounded-xl p-4 shadow-sm" title={hint}>
    <div className="text-[11px] text-zinc-500 font-medium">{label}</div>
    <div className={`text-xl font-bold font-mono mt-1 ${cls ?? 'text-zinc-100'}`}>{value}</div>
    {sub && <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>}
  </div>
);

/** 把價格翻成加權指數點數的小工具；沒填參考指數時回空字串（不顯示） */
const idxText = (price: number | null, cfgPrice: number, index: number, beta: number): string => {
  if (price === null) return '';
  const v = indexAtPrice(price, cfgPrice, index, beta);
  return v === null ? '' : `≈ ${Math.round(v).toLocaleString()} 點`;
};

const OverviewTab: React.FC<{
  config: FuturesConfig;
  summary: Summary;
  statusMeta: { cls: string; ring: string; label: string; desc: string };
  spec: FuturesSpec;
  beta: number;
  plan: ReturnType<typeof targetPlan>;
}> = ({ config, summary, statusMeta, spec, beta, plan }) => {
  const ri = summary.risk_indicator;
  // 風險指標的視覺化：0%～300% 對應半圓，25%（斷頭）與 100%（追繳）標成刻度
  const riPctText = ri === null ? '—' : `${(ri * 100).toFixed(0)}%`;
  const idx = (p: number | null) => idxText(p, config.price, config.index_ref, beta);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="保證金權益數"
          value={money(summary.equity)}
          sub={`現金 ${money(config.cash)} ＋ 未實現 ${money(summary.unrealized)}`}
          cls={pnlCls(summary.equity)}
          hint="權益數＝保證金專戶現金餘額 ＋ 未實現損益。期貨每日結算，這個數字才是你真正的家當。"
        />
        <StatCard
          label="未實現損益"
          value={money(summary.unrealized)}
          sub={summary.required_initial > 0 ? `佔原始保證金 ${pct(summary.unrealized / summary.required_initial)}` : '無部位'}
          cls={pnlCls(summary.unrealized)}
          hint="已扣掉來回手續費與期交稅的淨額。"
        />
        <StatCard
          label="風險指標"
          value={riPctText}
          sub={statusMeta.label}
          cls={statusMeta.cls}
          hint="權益數 ÷ 所需維持保證金。低於 100% 會收到追繳通知，盤中低於 25% 會被強制平倉。"
        />
        <StatCard
          label="名目曝險"
          value={money(summary.contract_value)}
          sub={summary.leverage !== null ? `槓桿 ${summary.leverage.toFixed(1)} 倍` : '無部位'}
          hint="契約總值＝價格 × 契約單位 × 口數。這才是你實際承受的市場曝險，不是保證金那點錢。"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 保證金水位 */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-zinc-100">保證金水位</h2>
            <span className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border ${statusMeta.cls} border-current/30`}>
              {statusMeta.label}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500">{statusMeta.desc}</p>
          <dl className="space-y-2 text-xs">
            <Row label="權益數" value={money(summary.equity)} cls={pnlCls(summary.equity)} />
            <Row label={`所需原始保證金（${summary.total_lots} 口 × ${money(spec.initial_margin)}）`} value={money(summary.required_initial)} />
            <Row label={`所需維持保證金（${summary.total_lots} 口 × ${money(spec.maintenance_margin)}）`} value={money(summary.required_maintenance)} />
            <Row
              label="超額保證金"
              value={money(summary.excess)}
              cls={summary.excess >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              hint="權益數 − 所需原始保證金。正的部分才是能再開倉或承受回檔的緩衝。"
            />
          </dl>
        </div>

        {/* 危險價位 */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-zinc-100">危險價位</h2>
          </div>
          {summary.total_lots === 0 ? (
            <p className="text-xs text-zinc-500">目前沒有未平倉部位。</p>
          ) : summary.net_lots === 0 ? (
            <p className="text-xs text-zinc-500">
              多空完全對沖（多 {summary.long_lots} 口 / 空 {summary.short_lots} 口），價格已不影響權益數，因此沒有追繳價可言。
            </p>
          ) : (
            <>
              <dl className="space-y-2 text-xs">
                <Row label="現在價格" value={px(config.price)} cls="text-zinc-100" sub={config.index_ref > 0 ? `${Math.round(config.index_ref).toLocaleString()} 點` : ''} />
                <Row
                  label="追繳價（權益數＝維持保證金）"
                  value={summary.margin_call_price !== null ? px(summary.margin_call_price) : '—'}
                  cls="text-orange-400"
                  sub={idx(summary.margin_call_price)}
                  hint="跌（空單為漲）到這個價位就會收到期貨商的追繳通知，要補錢補到原始保證金水準。"
                />
                <Row
                  label={`斷頭價（風險指標 ${pct(spec.liquidation_ratio, 0)}）`}
                  value={summary.liquidation_price !== null ? px(summary.liquidation_price) : '—'}
                  cls="text-rose-400"
                  sub={idx(summary.liquidation_price)}
                  hint="盤中觸及這個價位，期貨商會直接代為沖銷，不會等你補錢。"
                />
                {summary.margin_call_price !== null && config.price > 0 && (
                  <Row
                    label="距追繳還有"
                    value={`${pct(Math.abs(summary.margin_call_price - config.price) / config.price)}（${Math.abs(
                      Math.round((summary.margin_call_price - config.price) / spec.tick_size),
                    )} 檔）`}
                    cls="text-zinc-300"
                  />
                )}
              </dl>
              <p className="text-[11px] text-zinc-500 pt-1">
                以目前部位與權益數計算，含來回手續費與期交稅。加碼、平倉或入金都會改變這兩個價位。
                {config.index_ref > 0
                  ? `大盤點數以 beta ${beta.toFixed(2)} 換算，僅供對照。`
                  : '在「契約規格 & 設定」填入目前的加權指數，這裡就會一併顯示對應點位。'}
              </p>
            </>
          )}
        </div>
      </div>

      {/* 關鍵價格防線：斷頭 → 追繳 → 成本 → 目標，一眼看出自己站在哪 */}
      {summary.total_lots > 0 && summary.net_lots !== 0 && (
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-100">關鍵價格防線</h2>
            <span className="text-[11px] text-zinc-600">斷頭價 → 追繳價 → 現價 → 目標價</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <LevelCard tone="rose" label="斷頭價" value={summary.liquidation_price} sub={idx(summary.liquidation_price)} base={config.price} />
            <LevelCard tone="amber" label="追繳價" value={summary.margin_call_price} sub={idx(summary.margin_call_price)} base={config.price} />
            <LevelCard tone="sky" label="現在價格" value={config.price} sub={config.index_ref > 0 ? `${Math.round(config.index_ref).toLocaleString()} 點` : ''} base={config.price} />
            <LevelCard tone="emerald" label={`目標價（+${(config.planner.gain_pct * 100).toFixed(0)}%）`} value={plan.target_price} sub={idx(plan.target_price)} base={config.price} />
          </div>
          <p className="text-[11px] text-zinc-500">
            目標價的幅度可在「建倉 &amp; 出場試算」分頁調整。空單的追繳／斷頭價在現價之上，卡片會顯示為上漲幅度。
          </p>
        </div>
      )}

      {/* 部位明細 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-100 mb-3">未平倉部位</h2>
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有部位。到「部位 &amp; 平倉紀錄」分頁新增。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-left font-medium py-2 pr-3">方向</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-right font-medium py-2 pr-3">進場價</th>
                  <th className="text-right font-medium py-2 pr-3">損益平衡</th>
                  <th className="text-right font-medium py-2 pr-3">未實現損益</th>
                  <th className="text-right font-medium py-2">保證金報酬率</th>
                </tr>
              </thead>
              <tbody>
                {config.positions.map((p) => {
                  const r = positionPnl(p, config.price, spec);
                  return (
                    <tr key={p.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(p.month)}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex items-center gap-1 ${p.side === 'long' ? 'text-bull' : 'text-bear'}`}>
                          {p.side === 'long' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {p.side === 'long' ? '多' : '空'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{p.lots}</td>
                      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{px(p.entry_price)}</td>
                      <td className="py-2 pr-3 text-right font-mono text-zinc-500">{px(r.break_even)}</td>
                      <td className={`py-2 pr-3 text-right font-mono font-semibold ${pnlCls(r.net_pnl)}`}>{money(r.net_pnl)}</td>
                      <td className={`py-2 text-right font-mono ${pnlCls(r.return_on_margin)}`}>{pct(r.return_on_margin)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {config.closed.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 shadow-sm flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="text-zinc-500">已實現損益（{config.closed.length} 筆平倉）</span>
          <span className={`font-mono font-semibold ${pnlCls(summary.realized)}`}>{money(summary.realized)}</span>
          <span className="text-zinc-600 text-[11px]">
            期貨每日結算，已實現損益早就進出過保證金專戶了，所以不再加進權益數，這裡只作績效回顧。
          </span>
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; cls?: string; hint?: string; sub?: string }> = ({
  label, value, cls, hint, sub,
}) => (
  <div className="flex items-baseline justify-between gap-3" title={hint}>
    <dt className="text-zinc-500">{label}</dt>
    <dd className={`font-mono font-medium ${cls ?? 'text-zinc-300'}`}>
      {value}
      {sub ? <span className="text-zinc-600 font-normal ml-1.5">{sub}</span> : null}
    </dd>
  </div>
);

const LEVEL_TONES = {
  rose: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  sky: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
} as const;

const LevelCard: React.FC<{
  tone: keyof typeof LEVEL_TONES;
  label: string;
  value: number | null;
  sub?: string;
  base: number;
}> = ({ tone, label, value, sub, base }) => {
  const delta = value !== null && base > 0 ? (value - base) / base : null;
  return (
    <div className={`rounded-xl border p-3 ${LEVEL_TONES[tone]}`}>
      <div className="text-[10px] opacity-80">{label}</div>
      <div className="text-lg font-bold font-mono mt-0.5">{value !== null ? px(value) : '—'}</div>
      <div className="text-[10px] opacity-70 mt-0.5 h-3.5">
        {delta !== null && Math.abs(delta) > 1e-9 ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(2)}%` : ''}
        {sub ? <span className="ml-1.5">{sub}</span> : null}
      </div>
    </div>
  );
};

// ── 部位 & 平倉紀錄 ─────────────────────────────────────────────────────────

const PositionsTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  quoteMonths: FuturesMonthQuote[];
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, spec, summary, quoteMonths, patch, saveToCloud }) => {
  const [form, setForm] = useState({ month: '', side: 'long' as Side, lots: '', entry_price: '', entry_date: todayStr() });
  const [closeForm, setCloseForm] = useState<{ id: string; exit_price: string; exit_date: string } | null>(null);

  const monthOptions = useMemo(() => {
    const fromQuote = quoteMonths.map((m) => m.month);
    const fromPositions = config.positions.map((p) => p.month);
    return [...new Set([...fromQuote, ...fromPositions])].sort();
  }, [quoteMonths, config.positions]);

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
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">帳戶</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="保證金專戶現金餘額"
            hint="入金金額 ± 已實現損益（不含未實現）。期貨商軟體上通常叫「保證金餘額」或「前日餘額＋今日存提」。"
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
          <Field label="現在價格" hint="按上方「抓最新行情」會自動填入期交所結算價；盤中想用即時價可手動改。">
            <input
              key={`price-${config.price}`}
              type="number"
              step="0.05"
              defaultValue={config.price || ''}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v >= 0) void saveToCloud(patch((c) => ({ ...c, price: v })));
              }}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100"
              placeholder="例：102.05"
            />
          </Field>
        </div>
      </div>

      {/* 新增部位 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">新增部位</h2>
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
            {monthLabel(form.month)} 最後交易日 {lastTradingDay(form.month) ?? '—'}；
            {form.lots && Number(form.lots) > 0 && (
              <> 這筆需要原始保證金 {money(spec.initial_margin * Number(form.lots))}。</>
            )}
          </p>
        )}
      </div>

      {/* 現有部位 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-zinc-100">未平倉部位（{config.positions.length}）</h2>
        {config.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有部位。</p>
        ) : config.positions.map((p) => {
          const r = positionPnl(p, config.price, spec);
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
                    onClick={() => setCloseForm({ id: p.id, exit_price: String(config.price || ''), exit_date: todayStr() })}
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
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-100 mb-3">平倉紀錄（{config.closed.length}）</h2>
        {config.closed.length === 0 ? (
          <p className="text-xs text-zinc-500">還沒有平倉紀錄。平倉時會自動把損益結算進上方的保證金專戶現金餘額。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
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
        )}
      </div>
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
}> = ({ config, spec, alerts, quoteMonths }) => {
  const [near, setNear] = useState('');
  const [far, setFar] = useState('');
  const [lots, setLots] = useState('');

  const priceOf = (m: string) => {
    const q = quoteMonths.find((x) => x.month === m);
    return q?.settlement ?? q?.last ?? 0;
  };
  const cost = useMemo(() => {
    const n = parseFloat(lots);
    if (!near || !far || !(n > 0)) return null;
    const np = priceOf(near);
    const fp = priceOf(far);
    if (!(np > 0) || !(fp > 0)) return null;
    return { ...rolloverCost(n, np, fp, spec), np, fp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, far, lots, quoteMonths, spec]);

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-zinc-100">持倉月份到期狀態</h2>
        {alerts.length === 0 ? (
          <p className="text-xs text-zinc-500">目前沒有未平倉部位。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-border">
                  <th className="text-left font-medium py-2 pr-3">月份</th>
                  <th className="text-right font-medium py-2 pr-3">口數</th>
                  <th className="text-left font-medium py-2 pr-3">最後交易日</th>
                  <th className="text-left font-medium py-2 pr-3">最後結算日</th>
                  <th className="text-right font-medium py-2 pr-3">剩餘天數</th>
                  <th className="text-left font-medium py-2">狀態</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.month} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 font-mono text-zinc-300">{monthLabel(a.month)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.lots}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-400">{a.last_trading_day ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-zinc-500">{a.final_settlement_day ?? '—'}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${
                      a.level === 'expired' || a.level === 'urgent' ? 'text-rose-400' : a.level === 'soon' ? 'text-amber-400' : 'text-zinc-300'
                    }`}>
                      {a.days_left ?? '—'}
                    </td>
                    <td className="py-2 text-[11px]">
                      {a.level === 'expired' ? <span className="text-rose-400">已到期</span>
                        : a.level === 'urgent' ? <span className="text-rose-400">今明兩天要處理</span>
                        : a.level === 'soon' ? <span className="text-amber-400">該轉倉了</span>
                        : <span className="text-zinc-500">還早</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          最後交易日＝到期月份的第三個星期三（期交所規則），次一營業日為最後結算日。
          遇國定假日會順延，本頁不含台股假日曆，撞到連假時請以期交所公告為準。
        </p>
      </div>

      {/* 轉倉成本試算 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">轉倉成本試算</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="平掉的月份（近月）">
            <select value={near} onChange={(e) => setNear(e.target.value)}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
              <option value="">選擇…</option>
              {quoteMonths.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}（{px(priceOf(m.month))}）</option>)}
            </select>
          </Field>
          <Field label="建立的月份（遠月）">
            <select value={far} onChange={(e) => setFar(e.target.value)}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100">
              <option value="">選擇…</option>
              {quoteMonths.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}（{px(priceOf(m.month))}）</option>)}
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
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-100 mb-3">{CONTRACT_CODE} 各月份行情（期交所每日行情）</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
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
                      {lastTradingDay(m.month) ?? '—'}
                      {(() => {
                        const d = lastTradingDay(m.month);
                        const left = d ? daysBetween(todayStr(), d) : null;
                        return left !== null ? <span className="text-zinc-600">（{left} 天）</span> : null;
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

const STRESS_TONE: Record<string, { cls: string; label: string }> = {
  flat: { cls: 'text-zinc-500', label: '無部位' },
  ok: { cls: 'text-emerald-400', label: '✅ 正常持倉' },
  warn: { cls: 'text-amber-400', label: '⚠️ 低於原始保證金' },
  call: { cls: 'text-orange-400', label: '🟨 黃牌追繳' },
  danger: { cls: 'text-rose-400 font-semibold', label: '🟥 紅牌斷頭' },
};

const STRESS_PRESETS: { label: string; drops: number[] }[] = [
  { label: '一般回檔', drops: [0.02, 0.03, 0.05, 0.08, 0.1, 0.12] },
  { label: '預設（回檔→崩盤）', drops: [...DEFAULT_PLANNER.stress_drops] },
  { label: '歷史級崩盤', drops: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
];

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

  // 「撐得住幾 %」＝最後一個還沒進入追繳區的情境；全掛就是 0
  const survivable = useMemo(() => {
    let last: StressRow | null = null;
    for (const r of stress) {
      if (r.status === 'call' || r.status === 'danger') break;
      last = r;
    }
    return last;
  }, [stress]);
  const firstCall = stress.find((r) => r.status === 'call' || r.status === 'danger') ?? null;
  const firstDanger = stress.find((r) => r.status === 'danger') ?? null;

  if (summary.total_lots === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
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
          hint="表列情境中，最後一個仍未觸發追繳的跌幅。"
        />
        <StatCard
          label="開始追繳"
          value={firstCall ? `-${(firstCall.drop * 100).toFixed(0)}%` : '表列情境內都不會'}
          sub={firstCall ? `價格 ${px(firstCall.price_after)}` : `追繳價 ${summary.margin_call_price !== null ? px(summary.margin_call_price) : '—'}`}
          cls={firstCall ? 'text-orange-400' : 'text-emerald-400'}
        />
        <StatCard
          label="開始斷頭"
          value={firstDanger ? `-${(firstDanger.drop * 100).toFixed(0)}%` : '表列情境內都不會'}
          sub={firstDanger ? `價格 ${px(firstDanger.price_after)}` : `斷頭價 ${summary.liquidation_price !== null ? px(summary.liquidation_price) : '—'}`}
          cls={firstDanger ? 'text-rose-400' : 'text-emerald-400'}
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-zinc-100">大盤下跌壓力測試</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                <th className="text-left font-medium py-2 pr-3">大盤修正</th>
                {config.index_ref > 0 && <th className="text-right font-medium py-2 pr-3">加權指數</th>}
                <th className="text-right font-medium py-2 pr-3">標的價格</th>
                <th className="text-right font-medium py-2 pr-3">未實現損益</th>
                <th className="text-right font-medium py-2 pr-3">權益數</th>
                <th className="text-right font-medium py-2 pr-3">超額保證金</th>
                <th className="text-right font-medium py-2 pr-3">風險指標</th>
                <th className="text-left font-medium py-2">狀態</th>
              </tr>
            </thead>
            <tbody>
              {stress.map((r) => {
                const tone = STRESS_TONE[r.status] ?? STRESS_TONE.flat;
                return (
                  <tr key={r.drop} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 font-mono text-rose-400 font-semibold">-{(r.drop * 100).toFixed(0)}%</td>
                    {config.index_ref > 0 && (
                      <td className="py-2 pr-3 text-right font-mono text-zinc-400">
                        {r.index_after !== null ? Math.round(r.index_after).toLocaleString() : '—'}
                      </td>
                    )}
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">{px(r.price_after)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${pnlCls(r.unrealized)}`}>{money(r.unrealized)}</td>
                    <td className={`py-2 pr-3 text-right font-mono font-semibold ${r.equity < 0 ? 'text-rose-500' : 'text-zinc-200'}`}>{money(r.equity)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${r.excess >= 0 ? 'text-zinc-400' : 'text-amber-400'}`}>{money(r.excess)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${tone.cls}`}>
                      {r.risk_indicator !== null ? `${(r.risk_indicator * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className={`py-2 text-[11px] ${tone.cls}`}>{tone.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-zinc-500">
          每一列都是把「現在價格」換成修正後的價格、重跑一次總覽頁那組算式，所以費用、期交稅、多空對沖的處理完全一致。
          標的跌幅 ＝ 大盤跌幅 × beta（目前 {beta.toFixed(2)}）。
          <strong className="text-zinc-400"> 這是靜態測試</strong>：假設你不加碼、不減碼、不補錢，
          而且保證金維持現在的水準——實際崩盤時期交所通常會<strong className="text-zinc-400">調高</strong>保證金，
          斷頭會比表上更早發生。
        </p>
      </div>
    </div>
  );
};

// ── 建倉 & 出場試算 ─────────────────────────────────────────────────────────

const PlannerTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  plan: ReturnType<typeof targetPlan>;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, spec, summary, plan, patch, saveToCloud }) => {
  const p = config.planner;
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
    () => suggestLots(capital, config.price, lev, spec),
    [capital, config.price, lev, spec],
  );

  // 分批進場：用假想部位跑一次總覽的算式，直接看到這個組合的風險長相
  const batch = useMemo(() => weightedEntry(p.batches, spec), [p.batches, spec]);
  const batchSim = useMemo(() => {
    if (!(batch.lots > 0) || !(batch.avg_price > 0)) return null;
    const virtual: FuturesPosition[] = [{
      id: '_batch', month: '', side: 'long', lots: batch.lots,
      entry_price: batch.avg_price, entry_date: '',
    }];
    return summarizeAccount(virtual, config.price > 0 ? config.price : batch.avg_price, spec, capital);
  }, [batch, config.price, spec, capital]);

  const peak = p.trailing_peak > 0 ? p.trailing_peak : plan.target_price;
  const trailing = useMemo(
    () => trailingStopPlan(config.positions, spec, peak, p.trailing_dist),
    [config.positions, spec, peak, p.trailing_dist],
  );

  return (
    <div className="space-y-5">
      {/* 槓桿 → 口數 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-zinc-100">槓桿與口數規劃</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="帳戶可用本金" hint="空著或填 0 就沿用「保證金專戶現金餘額」。這是槓桿的分母。">
            <NumInput value={p.capital} step="10000" min="0" placeholder={`未填＝沿用 ${money(config.cash)}`}
              onCommit={(v) => setPlanner((x) => ({ ...x, capital: Math.max(0, v) }))} />
          </Field>
          <Field label="現在價格（唯讀）" hint="到「部位 & 平倉紀錄」或按上方「真實同步」更新。">
            <div className="w-full bg-zinc-900/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-zinc-400">
              {config.price > 0 ? px(config.price) : '尚未取得'}
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
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">分批進場／加碼試算</h2>
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
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-zinc-100">上漲目標與出金規劃</h2>
        </div>

        {summary.total_lots === 0 ? (
          <p className="text-xs text-zinc-500">目前沒有未平倉部位，先新增部位才有東西可以規劃。</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="text-zinc-400">價格目標</span>
                <span className="font-mono text-emerald-400 font-bold text-sm">
                  {gain >= 0 ? '+' : ''}{(gain * 100).toFixed(0)}% → {px(config.price * (1 + gain))}
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

// ── 存股比較（期貨 vs 現貨）─────────────────────────────────────────────────

const TAX_BRACKETS = [
  { v: 0.05, label: '5%（小資族，股利可退稅）' },
  { v: 0.12, label: '12%（一般上班族）' },
  { v: 0.2, label: '20%（中產）' },
  { v: 0.3, label: '30%（高所得）' },
  { v: 0.4, label: '40%（頂級所得）' },
];

const SpotCompareTab: React.FC<{
  config: FuturesConfig;
  spec: FuturesSpec;
  summary: Summary;
  patch: (u: (c: FuturesConfig) => FuturesConfig) => FuturesConfig;
  saveToCloud: (cfg?: FuturesConfig) => Promise<void>;
}> = ({ config, spec, summary, patch, saveToCloud }) => {
  const s = config.spot;
  const setSpot = (u: (x: FuturesConfig['spot']) => FuturesConfig['spot']) => {
    void saveToCloud(patch((c) => ({ ...c, spot: u(c.spot) })));
  };

  // 比較基準：有部位就用實際曝險，沒有就用建倉試算的建議口數
  const fallback = useMemo(
    () => suggestLots(config.planner.capital > 0 ? config.planner.capital : config.cash, config.price, config.planner.target_leverage, spec),
    [config.planner.capital, config.cash, config.price, config.planner.target_leverage, spec],
  );
  const lots = summary.total_lots > 0 ? summary.total_lots : fallback.lots;
  const notional = summary.total_lots > 0 ? summary.contract_value : fallback.notional;
  const usingActual = summary.total_lots > 0;

  const r = useMemo(
    () => compareSpotVsFutures({
      notional, lots,
      dividend_yield: s.dividend_yield,
      income_tax_rate: s.income_tax_rate,
      idle_rate: s.idle_rate,
      rollovers_per_year: s.rollovers_per_year,
      spread_per_rollover: s.spread_per_rollover,
      broker_discount: s.broker_discount,
    }, spec),
    [notional, lots, s, spec],
  );

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <PiggyBank className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-zinc-100">用期貨存股，一年省多少？</h2>
        </div>
        <p className="text-[11px] text-zinc-500">
          比較基準：{usingActual ? '目前實際部位' : '建倉試算的建議口數'} —— {lots} 口、名目曝險 {money(notional)}。
          {!usingActual && ' 有實際部位後會自動改用實際數字。'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="標的現金殖利率" hint="0050 近年約 3%～4%。這裡只用來算「因為領股利多繳的稅」。">
            <NumInput value={+(s.dividend_yield * 100).toFixed(2)} step="0.1" min="0"
              onCommit={(v) => setSpot((x) => ({ ...x, dividend_yield: Math.max(0, v) / 100 }))} />
          </Field>
          <Field label="個人綜所稅邊際稅率">
            <select
              value={s.income_tax_rate}
              onChange={(e) => setSpot((x) => ({ ...x, income_tax_rate: parseFloat(e.target.value) }))}
              className="w-full bg-zinc-900 border border-border rounded-lg px-3 py-2 text-sm text-zinc-100"
            >
              {TAX_BRACKETS.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
            </select>
          </Field>
          <Field label="閒置資金年化報酬（%）" hint="定存或貨幣型基金。用期貨只押保證金，省下的錢可以生息。">
            <NumInput value={+(s.idle_rate * 100).toFixed(2)} step="0.1" min="0"
              onCommit={(v) => setSpot((x) => ({ ...x, idle_rate: Math.max(0, v) / 100 }))} />
          </Field>
          <Field label="一年轉倉次數" hint="月結算商品續抱一整年約 11～12 次。">
            <NumInput value={s.rollovers_per_year} step="1" min="0"
              onCommit={(v) => setSpot((x) => ({ ...x, rollovers_per_year: Math.max(0, v) }))} />
          </Field>
          <Field label="每次轉倉的月份價差" hint="遠月比近月貴多少（元／點）。正價差是轉倉的隱形成本，可在「到期 & 轉倉」查實際數字。">
            <NumInput value={s.spread_per_rollover} step="0.05" min="0"
              onCommit={(v) => setSpot((x) => ({ ...x, spread_per_rollover: Math.max(0, v) }))} />
          </Field>
          <Field label="現股手續費折數" hint="0.6＝六折。電子下單常見 2～6 折。">
            <NumInput value={s.broker_discount} step="0.05" min="0.01"
              onCommit={(v) => setSpot((x) => ({ ...x, broker_discount: Math.max(0.01, Math.min(1, v)) }))} />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-2">
          <h3 className="text-sm font-semibold text-zinc-100 border-b border-border pb-2">買現貨持有一年</h3>
          <dl className="space-y-2 text-xs pt-1">
            <Row label="手續費（買＋賣）" value={money(r.spot.trading_fee)} />
            <Row label="證交稅（賣出 0.1%）" value={money(r.spot.transaction_tax)} />
            <Row label={`現金股利（${pct(s.dividend_yield, 2)}）`} value={money(r.spot.dividend)} cls="text-zinc-500" hint="不計為收入——期貨價格已內含除息貼水，兩邊都拿得到，故只比較稅負差異。" />
            <Row label="股利所得稅（扣 8.5% 可抵減）" value={money(r.spot.dividend_tax)} cls="text-rose-400" />
            <Row label="二代健保補充保費 2.11%" value={money(r.spot.nhi_premium)} cls="text-rose-400"
              hint="單筆股利達 2 萬元才課，這裡以全年股利當單筆估算，實際依配息次數可能較低。" />
          </dl>
          <div className="flex justify-between text-xs font-semibold pt-2 border-t border-border">
            <span className="text-zinc-300">一年總成本</span>
            <span className="font-mono text-rose-400">{money(r.spot.total_cost)}</span>
          </div>
        </div>

        <div className="bg-card border border-primary/30 rounded-xl p-5 shadow-sm space-y-2">
          <h3 className="text-sm font-semibold text-primary border-b border-border pb-2">買期貨持有一年</h3>
          <dl className="space-y-2 text-xs pt-1">
            <Row label={`轉倉手續費（${s.rollovers_per_year} 次來回）`} value={money(r.futures.rollover_fee)} cls="text-rose-400" />
            <Row label="轉倉期交稅" value={money(r.futures.rollover_tax)} cls="text-rose-400" />
            <Row label="月份價差成本" value={money(r.futures.spread_cost)} cls="text-rose-400" />
            <Row label="股利所得稅 / 二代健保" value="$0（免）" cls="text-emerald-400" />
            <Row label={`閒置資金 ${money(r.futures.idle_cash)} 的利息`} value={money(r.futures.interest)} cls="text-emerald-400"
              hint="＝名目曝險 − 原始保證金。前提是你本來就有這筆錢；拿小本金開高槓桿的話這段利息不存在。" />
          </dl>
          <div className="flex justify-between text-xs font-semibold pt-2 border-t border-border">
            <span className="text-zinc-300">一年淨成本</span>
            <span className={`font-mono ${r.futures.total_cost > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{money(r.futures.total_cost)}</span>
          </div>
        </div>
      </div>

      <div className={`rounded-xl border p-4 text-center text-sm font-semibold ${
        r.advantage >= 0 ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300' : 'bg-rose-500/10 border-rose-500/40 text-rose-300'
      }`}>
        {r.advantage >= 0
          ? `用期貨替代現貨，這個規模下一年約省 ${money(r.advantage)}`
          : `這個規模下期貨反而多花 ${money(-r.advantage)}——轉倉成本吃掉了稅負優勢`}
      </div>

      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-2">
        <h3 className="text-sm font-semibold text-zinc-100">這個比較沒有算進去的事</h3>
        <ul className="text-[11px] text-zinc-400 leading-relaxed space-y-1.5 list-disc list-inside">
          <li><strong className="text-zinc-300">兩邊都不計股利收入</strong>：期貨價格已內含除息貼水，期貨持有人靠價差拿到等值股利且免稅，所以現貨這邊只算「多繳的稅」，不重複計算股利本身。</li>
          <li><strong className="text-zinc-300">閒置資金利息是有條件的</strong>：只有在你本來就準備好全額現金、只是改押保證金時才成立。拿 50 萬去開 300 萬曝險，那 250 萬不存在，這段利息是幻覺。</li>
          <li><strong className="text-zinc-300">期貨會斷頭，現貨不會</strong>：現股套牢可以放十年，期貨跌到維持保證金以下就得補錢，補不出來就被平倉在最低點。這個風險沒有金額，但它是最貴的一項。</li>
          <li><strong className="text-zinc-300">價差會變</strong>：正價差在多頭時會擴大，實際轉倉成本可能高於這裡的固定假設；逆價差時反而是收入。</li>
          <li><strong className="text-zinc-300">流動性</strong>：{CONTRACT_CODE} 的成交量遠小於台指期，遠月份可能掛不到好價位，滑價沒有計入。</li>
        </ul>
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
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">交易商品</h2>
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
          <Field label="目前加權指數" hint="填今天的收盤指數，追繳價與壓力測試就會一併換算成大盤點數。留 0 ＝不顯示點數。">
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

      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">契約規格與費用</h2>
          <p className="text-[11px] text-zinc-500 mt-1">
            預設值＝期交所 2026-06-18 起適用的保證金公告。保證金會依市場風險調整，
            期貨商通知調整時回來這裡改，追繳價與斷頭價會跟著更新。
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
            onClick={() => void saveToCloud(patch((c) => ({
              ...c,
              planner: { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] },
              spot: { ...DEFAULT_SPOT },
            })))}
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            title="只清掉試算頁的參數，實際部位與平倉紀錄不受影響"
          >
            還原試算與存股比較參數
          </button>
          <span className="text-[11px] text-zinc-600">
            目前一跳 ＝ {money(tickValue(config.spec))}
          </span>
        </div>
      </div>
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

    <Section title="試算頁在算什麼（壓力測試／建倉／存股比較）">
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
          <strong className="text-zinc-100">存股比較兩邊都不計股利收入</strong>：期貨價格已內含除息貼水，
          期貨持有人靠價差拿到等值股利而且免稅，所以現貨那邊只算「因為領股利而多繳的稅」，不重複計算股利本身。
          閒置資金利息則只有在「你本來就有全額現金、只是改押保證金」時才成立。
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
          <strong className="text-zinc-100">報價</strong>：期交所 OpenAPI 的
          <span className="font-mono text-zinc-400"> DailyMarketReportFut</span>（公開資料、免金鑰）。
          給的是<strong className="text-zinc-100">每日行情</strong>（收盤與結算價），不是即時報價——
          這頁定位是收盤後對帳與風險檢視，盤中即時價請看期貨商軟體，或手動改「現在價格」。
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
  <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
    <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
    {children}
  </div>
);
