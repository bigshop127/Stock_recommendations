import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pause, Play, RefreshCw, Search, Waves } from 'lucide-react';
import { api, type InstFlowPayload, type InstitutionalTrades, type MarketInstitutional } from '../lib/api';
import {
  buildCube,
  buildFrames,
  buildUnits,
  conclusionText,
  FETCH_DAYS,
  flowHeadline,
  fmtMd,
  fmtYi,
  foreignVsTrust,
  INST_LABEL,
  INST_SHORT,
  INSTS,
  instStreak,
  keyFlows,
  LEVEL_LABEL,
  LONG_WINDOW,
  MAX_FRAMES,
  topUnits,
  unitAvgChange,
  upDownCounts,
  weekdayOf,
  WINDOW,
  type Inst,
  type Level,
  type UnitValue,
} from '../lib/capitalFlow';
import { TideChart } from '../components/tide/TideChart';
import { TideDetail } from '../components/tide/TideDetail';
import { TideSummary, type InstTotals } from '../components/tide/TideSummary';

/**
 * 資金潮汐（opt54，2026-11-10 改版）：法人資金流向泡泡圖。
 *
 * 一顆泡泡＝一個族群（可切大類），橫軸近 5 日法人買賣超、縱軸加速流入，
 * 可以播放過去最多 10 個交易日看泡泡怎麼移動；點泡泡看成分股。
 * 資料 /api/market/inst-flow（gateway 自己抓證交所），第一次使用會在背景回補，這裡輪詢到補齊為止。
 */

/** 播放速度：每個交易日停留多久；開頭先停一下讓人看清楚起點 */
const MS_PER_DAY = 700;
const HOLD_MS = 450;
const POLL_MS = 5000;

type RankTab = 'in' | 'out' | 'up' | 'down';
const RANK_TABS: [RankTab, string][] = [
  ['in', '流入'],
  ['out', '流出'],
  ['up', '加速'],
  ['down', '降溫'],
];
const LEVELS: Level[] = ['group', 'category'];

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const segBtn = (active: boolean) =>
  `px-3 py-1.5 text-xs font-semibold rounded-md transition ${active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`;

export const CapitalTide: React.FC = () => {
  const [payload, setPayload] = useState<InstFlowPayload | null>(null);
  const [official, setOfficial] = useState<MarketInstitutional | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inst, setInst] = useState<Inst>('all');
  const [level, setLevel] = useState<Level>('group');
  /** null＝停在最新一天；數字＝第幾個播放日（播放中是小數） */
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [rankTab, setRankTab] = useState<RankTab>('in');

  const isWide = useMediaQuery('(min-width: 1280px)');
  const chartCardRef = useRef<HTMLElement>(null);
  const playFromRef = useRef(0);

  const load = useCallback(
    () =>
      api
        .marketInstFlow({ days: FETCH_DAYS, quotes: MAX_FRAMES })
        .then(
          (p) => {
            setPayload(p);
            setError(null);
          },
          (e: unknown) => setError(errText(e)),
        )
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
    // 三大法人的官方金額走 engine；抓不到就用個股估算頂著，不擋整頁
    api.marketInstitutional({ days: 20 }).then(setOfficial).catch(() => setOfficial(null));
  }, [load]);

  // 後端還在回補歷史資料時每 5 秒再問一次，補齊（或後端這一輪停了）就不問
  useEffect(() => {
    if (!payload || payload.have >= payload.want || !payload.refreshing) return;
    const timer = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [payload, load]);

  // ── 泡泡、播放日 ──
  const units = useMemo(() => (payload ? buildUnits(payload.codes, level) : []), [payload, level]);
  const frames = useMemo(() => (payload ? buildFrames(buildCube(payload, units, inst)) : []), [payload, units, inst]);
  const last = frames.length - 1;
  const ph = playhead === null ? last : Math.min(playhead, last);
  const cur = last >= 0 ? frames[Math.round(ph)] : null;
  const latest = last >= 0 ? frames[last] : null;

  const headline = useMemo(() => (latest ? flowHeadline(units, latest) : null), [units, latest]);
  const highlight = useMemo(
    () => (headline ? [headline.to?.unit, headline.from?.unit].filter((u): u is number => u !== undefined) : []),
    [headline],
  );
  const selectedIdx = selectedName === null ? -1 : units.findIndex((u) => u.name === selectedName);
  const selected = selectedIdx >= 0 ? selectedIdx : null;

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !payload) return null;
    const hit = new Set<number>();
    units.forEach((u, i) => {
      const inName = u.name.toLowerCase().includes(q);
      const inMember = u.members.some((m) => payload.codes[m].startsWith(q) || payload.names[m].toLowerCase().includes(q));
      if (inName || inMember) hit.add(i);
    });
    return hit;
  }, [query, units, payload]);
  // 搜尋只剩一兩顆時，直接把它們當重點泡泡（標名字、畫軌跡），不用再去圖上找
  const focusUnits = useMemo(
    () => (matched && matched.size > 0 && matched.size <= 3 ? [...highlight, ...matched] : highlight),
    [highlight, matched],
  );

  const rank = useMemo<UnitValue[]>(() => {
    if (!cur) return [];
    switch (rankTab) {
      case 'in': return topUnits(units, cur.x, 8, true, (v) => v > 0);
      case 'out': return topUnits(units, cur.x, 8, false, (v) => v < 0);
      case 'up': return topUnits(units, cur.y, 8, true, (v) => v > 0);
      default: return topUnits(units, cur.y, 8, false, (v) => v < 0);
    }
  }, [units, cur, rankTab]);

  // ── 盤後結論：固定看最新一天、全體法人、細分族群 ──
  const summary = useMemo(() => {
    if (!payload) return null;
    const groupUnits = buildUnits(payload.codes, 'group');
    const lastFrame = (i: Inst) => buildFrames(buildCube(payload, groupUnits, i), 1)[0];
    const all = lastFrame('all');
    if (!all) return null;
    return {
      date: all.date,
      flows: keyFlows(groupUnits, all),
      duo: foreignVsTrust(groupUnits, lastFrame('foreign').x, lastFrame('trust').x),
      counts: upDownCounts(unitAvgChange(payload, groupUnits, all.dayIndex)),
    };
  }, [payload]);

  const instSummary = useMemo<{ totals: InstTotals; conclusionStreaks: Parameters<typeof conclusionText>[0] } | null>(() => {
    if (!payload || !payload.days.length) return null;
    const date = payload.dates[payload.dates.length - 1];
    // 官方金額（元）要有「泡泡圖最新那一天」才用；法人日報比收盤統計晚出，兩邊可能差一天
    const officialTrend = official?.trend ?? [];
    const k = officialTrend.findIndex((r) => r.date === date);
    let trend: InstitutionalTrades[];
    let isOfficial = false;
    if (k >= 0) {
      const yi = (v: number) => v / 1e8;
      trend = officialTrend.slice(0, k + 1).map((r) => ({
        foreign: yi(r.foreign),
        investment_trust: yi(r.investment_trust),
        dealer: yi(r.dealer),
        total: yi(r.total),
      }));
      isOfficial = true;
    } else {
      const sum = (a: number[]) => a.reduce((s, v) => s + v, 0) / 100;
      trend = payload.days.map((d) => {
        const f = sum(d.f);
        const t = sum(d.t);
        const dl = sum(d.d);
        return { foreign: f, investment_trust: t, dealer: dl, total: f + t + dl };
      });
    }
    const now = trend[trend.length - 1];
    const prev = trend.length > 1 ? trend[trend.length - 2] : null;
    return {
      totals: {
        official: isOfficial,
        foreign: [now.foreign, prev ? prev.foreign : null],
        trust: [now.investment_trust, prev ? prev.investment_trust : null],
        dealer: [now.dealer, prev ? prev.dealer : null],
      },
      conclusionStreaks: { foreign: instStreak(trend, 'foreign'), trust: instStreak(trend, 'investment_trust') },
    };
  }, [payload, official]);

  // ── 播放 ──
  useEffect(() => {
    if (!playing || last < 1) return;
    let raf = 0;
    let prev = performance.now();
    let hold = HOLD_MS;
    let pos = playFromRef.current;
    const step = (now: number) => {
      // 分頁切到背景再回來時 now 會跳一大段，夾住免得一口氣跳到底
      const dt = Math.min(100, now - prev);
      prev = now;
      if (hold > 0) hold -= dt;
      else pos += dt / MS_PER_DAY;
      if (pos >= last) {
        setPlayhead(null);
        setPlaying(false);
        return;
      }
      setPlayhead(pos);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, last]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      setPlayhead(Math.round(ph) >= last ? null : Math.round(ph));
      return;
    }
    // 停在最後一天就從頭播，停在中間就接著播
    playFromRef.current = playhead === null || ph >= last ? 0 : ph;
    setPlayhead(playFromRef.current);
    setPlaying(true);
  };
  const seek = (i: number) => {
    setPlaying(false);
    const v = Math.max(0, Math.min(last, i));
    setPlayhead(v >= last ? null : v);
  };

  const changeLevel = (lv: Level) => {
    setLevel(lv);
    setSelectedName(null);
  };
  const pickGroup = (name: string) => {
    setLevel('group');
    setSelectedName(name);
    chartCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // ── 畫面 ──
  if (loading && !payload) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center gap-3">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <span className="animate-pulse font-mono text-sm font-medium text-zinc-400">載入法人資金流向中…</span>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="mx-auto my-12 flex h-[60vh] max-w-xl flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/20 p-6 text-center">
        <Waves className="mb-4 h-12 w-12 text-zinc-600" />
        <span className="mb-2 text-sm font-semibold text-red-400">載入資金潮汐資料失敗</span>
        <span className="mb-6 font-mono text-xs text-zinc-500">{error || '無資料'}</span>
        <button
          onClick={() => { setLoading(true); void load(); }}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新整理
        </button>
      </div>
    );
  }

  const backfilling = payload.have < payload.want;
  const who = INST_SHORT[inst];
  const selectedUnit = selected !== null ? units[selected] : null;
  const detail = selectedUnit && cur && selected !== null ? (
    <TideDetail
      payload={payload}
      unit={selectedUnit}
      unitIndex={selected}
      frame={cur}
      inst={inst}
      level={level}
      compact={isWide}
      onClose={() => setSelectedName(null)}
    />
  ) : null;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* 標題 */}
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-100">
            <Waves className="h-5 w-5 text-primary" />
            資金潮汐・法人資金流去哪？
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            每天盤後整理外資、投信、自營商在各族群的買賣超，一眼看出資金正在加碼、撤出的地方。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 lg:flex-none">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋族群、代號或股名…"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-xs text-zinc-100 transition-colors focus:border-primary/50 focus:outline-none lg:w-56"
            />
          </div>
          <button
            onClick={() => void load()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重新整理
          </button>
        </div>
      </div>

      {(backfilling || error) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {backfilling && (
            <div className="flex items-center gap-2">
              {payload.refreshing && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              <span>
                歷史資料{payload.refreshing ? '回補中' : '還沒補齊'}：已有 {payload.have}／{payload.want} 個交易日
                {payload.refreshing ? '（第一次使用約需兩三分鐘，畫面會自己更新）' : '，按「重新整理」再補一次'}。
              </span>
            </div>
          )}
          {error && <div>最近一次更新失敗：{error}</div>}
          {payload.errors?.length ? <div className="mt-1 font-mono text-[10px] text-amber-300/70">{payload.errors.join('；')}</div> : null}
        </div>
      )}

      {summary && instSummary && (
        <TideSummary
          date={summary.date}
          conclusion={conclusionText(instSummary.conclusionStreaks, summary.counts)}
          counts={summary.counts}
          totals={instSummary.totals}
          flows={summary.flows}
          duo={summary.duo}
          onPick={pickGroup}
        />
      )}

      {!cur || !latest ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 text-center text-sm text-zinc-500">
          {payload.refreshing && <Loader2 className="mb-3 h-8 w-8 animate-spin text-primary" />}
          至少要 {WINDOW * 2} 個交易日才畫得出泡泡圖，目前 {payload.have} 個
          {payload.refreshing ? '，資料補上來會自動顯示。' : '。'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-3 xl:items-start">
          {/* 泡泡圖 */}
          <section ref={chartCardRef} className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4 xl:col-span-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-bold text-zinc-100">法人資金流向</h3>
              <span className="text-[11px] text-zinc-500">更新時間 {fmtMd(latest.date)}</span>
            </div>

            {/* 法人別分頁 */}
            <div className="mt-2 flex border-b border-zinc-800">
              {INSTS.map((i) => (
                <button
                  key={i}
                  onClick={() => setInst(i)}
                  className={`-mb-px flex-1 border-b-2 px-2 py-2 text-sm font-semibold transition sm:flex-none sm:px-5 ${
                    inst === i ? 'border-bull text-bull' : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {INST_LABEL[i]}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
                  {LEVELS.map((lv) => (
                    <button key={lv} onClick={() => changeLevel(lv)} className={segBtn(level === lv)}>
                      {LEVEL_LABEL[lv]}
                    </button>
                  ))}
                </div>
                <span className="hidden text-[11px] text-zinc-500 underline decoration-amber-400/70 decoration-2 underline-offset-4 sm:inline">
                  點擊泡泡查看成分股
                </span>
              </div>
              <button
                onClick={togglePlay}
                disabled={last < 1}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-900 px-3.5 py-1.5 text-sm font-bold text-zinc-100 transition hover:border-zinc-400 disabled:opacity-40"
              >
                {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                {playing ? '暫停' : `過去 ${frames.length} 天`}
              </button>
            </div>

            {headline && (headline.from || headline.to) && (
              <p className="mt-3 text-sm leading-relaxed text-zinc-300">
                {who}的資金重心，近 {WINDOW} 日
                {headline.from && headline.to ? (
                  <>
                    正從 <b className="text-bear">{headline.from.name}</b>
                    <span className="text-zinc-500">（{fmtYi(headline.from.value)} 億）</span>流向{' '}
                    <b className="text-bull">{headline.to.name}</b>
                    <span className="text-zinc-500">（{fmtYi(headline.to.value)} 億）</span>
                  </>
                ) : headline.to ? (
                  <>
                    集中流入 <b className="text-bull">{headline.to.name}</b>
                    <span className="text-zinc-500">（{fmtYi(headline.to.value)} 億）</span>，沒有族群被賣超
                  </>
                ) : (
                  <>
                    撤出最多的是 <b className="text-bear">{headline.from?.name}</b>
                    <span className="text-zinc-500">（{fmtYi(headline.from?.value)} 億）</span>，沒有族群被買超
                  </>
                )}
              </p>
            )}

            <div className="mt-2">
              <TideChart
                units={units}
                frames={frames}
                playhead={ph}
                playing={playing}
                highlight={focusUnits}
                selected={selected}
                matched={matched}
                instShort={who}
                onSelect={(u) => setSelectedName(u === null ? null : units[u].name)}
              />
            </div>

            {/* 日期滑桿 */}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => seek(Math.round(ph) - 1)}
                disabled={Math.round(ph) <= 0}
                aria-label="前一個交易日"
                className="rounded-md border border-zinc-800 p-1.5 text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(last, 0)}
                step={1}
                value={Math.round(ph)}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="播放日期"
                className="h-1.5 min-w-0 flex-1 cursor-pointer accent-red-500"
                style={{ colorScheme: 'dark' }}
              />
              <button
                onClick={() => seek(Math.round(ph) + 1)}
                disabled={Math.round(ph) >= last}
                aria-label="後一個交易日"
                className="rounded-md border border-zinc-800 p-1.5 text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="w-[5.5rem] shrink-0 text-right font-mono text-base font-bold tabular-nums text-zinc-100">
                {fmtMd(cur.date)}
                <span className="ml-1 font-sans text-xs font-medium text-zinc-500">（{weekdayOf(cur.date)}）</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
              加速流入＝近 {WINDOW} 天比前 {WINDOW} 天，平均每天多買多少（億）。泡泡大小＝近 {WINDOW} 日成交金額；兩軸都是中間放大的刻度。
              範圍：上市普通股 {units.reduce((n, u) => n + u.members.length, 0).toLocaleString()} 檔、{units.length} 個{LEVEL_LABEL[level]}（不含 ETF、上櫃）。
              金額＝買賣超股數 × 當日成交均價，是估算值。
            </p>
          </section>

          {/* 右欄：明細（寬螢幕）＋排行 */}
          <aside className="min-w-0 space-y-4 sm:space-y-6">
            {isWide && (
              <div className="flex max-h-[720px] flex-col rounded-xl border border-border bg-card p-4">
                {detail ?? (
                  <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 p-4 text-center">
                    <span className="text-xs text-zinc-500">在左邊點任一顆泡泡</span>
                    <span className="mt-1 text-[10px] text-zinc-600">這裡會列出它的買賣超與成分股</span>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-xs font-bold text-zinc-300">
                {LEVEL_LABEL[level]}排行
                <span className="ml-1.5 font-normal text-zinc-500">{who}・{fmtMd(cur.date)}</span>
              </h3>
              <div className="mt-2 grid grid-cols-4 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
                {RANK_TABS.map(([key, label]) => (
                  <button key={key} onClick={() => setRankTab(key)} className={`whitespace-nowrap ${segBtn(rankTab === key)}`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-2 divide-y divide-zinc-800/60 text-xs">
                {rank.length === 0 && <div className="py-4 text-center text-zinc-600">沒有符合的{LEVEL_LABEL[level]}</div>}
                {rank.map((r, idx) => (
                  <button
                    key={r.unit}
                    onClick={() => setSelectedName(r.name)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-1 py-2 text-left transition hover:bg-zinc-800/30 ${
                      selected === r.unit ? 'bg-zinc-800/40' : ''
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 font-mono text-[10px] text-zinc-500">#{idx + 1}</span>
                      <span className="truncate font-bold text-zinc-200">{r.name}</span>
                    </span>
                    <span className={`shrink-0 font-mono font-bold ${r.value >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {fmtYi(r.value)} {rankTab === 'in' || rankTab === 'out' ? '億' : '億/天'}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-zinc-600">
                {rankTab === 'in' || rankTab === 'out' ? `近 ${WINDOW} 日買賣超` : `近 ${WINDOW} 日比前 ${WINDOW} 日，平均每天多買（賣）多少`}
                ；近 {LONG_WINDOW} 日累計在點開的明細裡。
              </p>
            </div>
          </aside>
        </div>
      )}

      {/* 手機／窄螢幕：明細從底部滑上來 */}
      {!isWide && detail && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60" onClick={() => setSelectedName(null)}>
          <div
            className="flex max-h-[84vh] w-full flex-col overscroll-contain rounded-t-2xl border-t border-border bg-card p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {detail}
          </div>
        </div>
      )}
    </div>
  );
};
