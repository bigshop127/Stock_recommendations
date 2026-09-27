import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { ChipRow, InstNetResp, OhlcvRow, StockMetricsResp } from '../lib/api';
import { getFolderList, getFolders, subscribeFolders, loadFoldersFromCloud } from '../lib/userStore';
import { cardMetrics, sortCards, runPool, CARD_SORTS } from '../lib/folderCards';
import type { CardItem, CardSortKey, CardMetrics } from '../lib/folderCards';
import { MiniCandles } from '../components/MiniCandles';
import { GroupTag } from '../components/GroupTag';

// 同一檔 10 分鐘內換資料夾、回上一頁不重抓（日 K 與籌碼都是收盤資料）
const TTL_MS = 10 * 60 * 1000;
const cardCache = new Map<string, { at: number; metrics: CardMetrics }>();

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * 法人 5 日優先用證交所 T86（整個資料夾共用一個請求，instP）；T86 沒有這檔（上櫃）或整個抓不到，
 * 才逐檔打個股籌碼——那支背後是三次 FinMind，20 檔的資料夾一打就是 60 次額度。
 */
async function loadCard(code: string, force: boolean, instP: Promise<InstNetResp | null>): Promise<CardMetrics> {
  const hit = cardCache.get(code);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.metrics;
  // 日 K 抓 ~130 個日曆天（夠 60 根＋前面 20 根算月線）；籌碼拿不到不影響卡片
  const [ohlcv, inst] = await Promise.all([
    api.ohlcv(code, { adjust: true, start: isoDaysAgo(130) }).then((r) => r.data as OhlcvRow[]),
    instP,
  ]);
  const fromMarket = inst?.items[code];
  const chips = fromMarket
    ? null
    : await api.stockChips(code, { days: 5 }).then((r) => r.data as ChipRow[]).catch(() => null);
  const metrics = cardMetrics(ohlcv, chips);
  if (fromMarket) {
    metrics.inst5 = fromMarket.net_lots;
    metrics.instDays = fromMarket.days;
  }
  cardCache.set(code, { at: Date.now(), metrics });
  return metrics;
}

const pct = (v: number | null, digits = 2) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);
const tone = (v: number | null) => (v === null ? 'text-zinc-500' : v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-zinc-300');
const fmtClose = (v: number) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2));

const Card: React.FC<{ item: CardItem; state: 'loading' | 'ready' | 'error' }> = ({ item, state }) => {
  const m = item.metrics;
  const s = item.stock;
  const revMonth = s?.revenue_month ? `${Number(s.revenue_month.slice(5))}月` : '';
  return (
    <Link
      to={`/stock/${item.code}`}
      className="block bg-card border border-border rounded-xl p-3 hover:border-primary/50 hover:bg-zinc-900/40 transition min-w-0"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-sm text-zinc-100 truncate">{item.name || item.code}</span>
            <span className="text-[11px] text-zinc-500 font-mono shrink-0">{item.code}</span>
          </div>
          <GroupTag code={item.code} className="mt-0.5" />
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono font-bold text-sm ${tone(m?.changePct ?? null)}`}>{m?.close ? fmtClose(m.close) : '—'}</div>
          <div className={`font-mono text-[11px] ${tone(m?.changePct ?? null)}`}>{pct(m?.changePct ?? null)}</div>
        </div>
      </div>

      <div className="mt-2 rounded-lg bg-zinc-950/50 border border-border/30 px-1 py-1">
        {state === 'loading' && !m ? (
          <div className="h-[88px] animate-pulse bg-zinc-800/30 rounded" />
        ) : state === 'error' && !m ? (
          <div className="h-[88px] flex items-center justify-center text-[10px] text-zinc-600">K 線抓不到</div>
        ) : (
          <MiniCandles bars={m?.bars ?? []} ma20={m?.ma20} height={88} />
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5 mt-2 text-center">
        <div className="rounded-md bg-zinc-950/40 border border-border/30 py-1">
          <div className="text-[9px] text-zinc-500">量比</div>
          <div className={`font-mono text-xs font-semibold ${m?.volRatio !== null && m?.volRatio !== undefined && m.volRatio >= 1.5 ? 'text-amber-300' : 'text-zinc-200'}`}>
            {m?.volRatio !== null && m?.volRatio !== undefined ? `${m.volRatio.toFixed(2)}×` : '—'}
          </div>
        </div>
        <div className="rounded-md bg-zinc-950/40 border border-border/30 py-1" title={m?.instDays ? `最近 ${m.instDays} 個交易日三大法人買賣超合計` : ''}>
          <div className="text-[9px] text-zinc-500">法人 5 日</div>
          <div className={`font-mono text-xs font-semibold ${tone(m?.inst5 ?? null)}`}>
            {m?.inst5 !== null && m?.inst5 !== undefined ? `${m.inst5 > 0 ? '+' : ''}${Math.round(m.inst5).toLocaleString()}` : '—'}
          </div>
        </div>
        <div className="rounded-md bg-zinc-950/40 border border-border/30 py-1" title={s?.revenue_month ? `${s.revenue_month} 營收年增率` : ''}>
          <div className="text-[9px] text-zinc-500">營收年增{revMonth && `（${revMonth}）`}</div>
          <div className={`font-mono text-xs font-semibold ${tone(s?.rev_yoy ?? null)}`}>{pct(s?.rev_yoy ?? null, 1)}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[10px] text-zinc-500 font-mono">
        <span>{s?.pe ? `本益比 ${s.pe.toFixed(1)}` : s ? '本益比 —' : ''}</span>
        <span>{m?.fromHigh60 !== null && m?.fromHigh60 !== undefined ? `離 60 日高 ${m.fromHigh60.toFixed(1)}%` : ''}</span>
      </div>
    </Link>
  );
};

export const FolderWall: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [folderList, setFolderList] = useState(() => getFolderList());
  const [folders, setFolders] = useState(() => getFolders());
  const [sortKey, setSortKey] = useState<CardSortKey>(() => {
    try { return (localStorage.getItem('review:folderWall:sort') as CardSortKey) || 'order'; } catch { return 'order'; }
  });
  const [cards, setCards] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; metrics: CardMetrics | null }>>({});
  const [metrics, setMetrics] = useState<StockMetricsResp | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    void loadFoldersFromCloud();
    return subscribeFolders(() => {
      setFolderList(getFolderList());
      setFolders(getFolders());
    });
  }, []);

  const folderId = searchParams.get('f') && folderList.some((f) => f.id === searchParams.get('f'))
    ? (searchParams.get('f') as string)
    : folderList[0]?.id;
  const stocks = useMemo(() => (folderId ? folders[folderId] || [] : []), [folders, folderId]);
  const codesKey = stocks.map((s) => s.code).join(',');

  useEffect(() => {
    const codes = codesKey ? codesKey.split(',') : [];
    if (!codes.length) return;
    let cancelled = false;
    const force = reloadTick > 0;
    api.getStockMetrics(codes).then((r) => { if (!cancelled) setMetrics(r); }).catch(() => { /* 估值只是加註 */ });
    // 全部卡片都走快取時不必打 T86；只要有一張要重抓就整批問一次（gateway 那邊也有快取）
    const needFetch = force || codes.some((c) => {
      const hit = cardCache.get(c);
      return !hit || Date.now() - hit.at >= TTL_MS;
    });
    const instP: Promise<InstNetResp | null> = needFetch ? api.marketInstNet(codes, 5).catch(() => null) : Promise.resolve(null);
    void runPool(
      codes.map((code) => async () => {
        try {
          const m = await loadCard(code, force, instP);
          if (!cancelled) setCards((prev) => ({ ...prev, [code]: { state: 'ready', metrics: m } }));
        } catch {
          if (!cancelled) setCards((prev) => ({ ...prev, [code]: { state: 'error', metrics: prev[code]?.metrics ?? null } }));
        }
      }),
      3,
    );
    return () => { cancelled = true; };
  }, [codesKey, reloadTick]);

  const metricByCode = useMemo(() => new Map((metrics?.items ?? []).map((m) => [m.code, m])), [metrics]);
  const items: CardItem[] = stocks.map((s, i) => ({
    code: s.code,
    name: s.name || metricByCode.get(s.code)?.name || s.code,
    order: i,
    metrics: cards[s.code]?.metrics ?? null,
    stock: metricByCode.get(s.code) ?? null,
  }));
  const sorted = sortCards(items, sortKey);
  const latestDate = items.map((i) => i.metrics?.date).filter(Boolean).sort().pop();

  const chooseSort = (k: CardSortKey) => {
    setSortKey(k);
    try { localStorage.setItem('review:folderWall:sort', k); } catch { /* 記不住就算了 */ }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-zinc-200">資料夾卡片牆</h1>
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 border border-border hover:bg-zinc-700"
        >
          <RefreshCw className="w-3.5 h-3.5" />重新整理
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {folderList.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setSearchParams({ f: f.id }, { replace: true })}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
              f.id === folderId ? 'bg-primary text-white border-primary' : 'bg-zinc-900 text-zinc-400 border-border hover:text-zinc-200'
            }`}
          >
            {f.label}（{(folders[f.id] || []).length}）
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <span className="text-zinc-500 mr-1">排序</span>
        {CARD_SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => chooseSort(s.key)}
            className={`px-2.5 py-1 rounded-lg border transition ${
              sortKey === s.key ? 'bg-zinc-800 text-zinc-100 border-zinc-600 font-semibold' : 'bg-zinc-950 text-zinc-400 border-border/60 hover:text-zinc-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {stocks.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-zinc-500">
          這個資料夾還沒有股票。到左邊「個股多維度審查」的資料夾按 ＋ 加入，或在個股頁用資料夾按鈕加入。
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
          {sorted.map((item) => (
            <Card key={item.code} item={item} state={cards[item.code]?.state ?? 'loading'} />
          ))}
        </div>
      )}

      <p className="text-[10px] text-zinc-500 leading-relaxed">
        K 線＝近 60 個交易日還原日 K（橘線＝月線）{latestDate ? `，資料到 ${latestDate}` : ''}；量比＝5 日均量 ÷ 20 日均量；
        法人 5 日＝三大法人最近 5 個交易日買賣超合計（張，上市取證交所三大法人日報、上櫃取個股籌碼）；營收年增、本益比來自證交所／櫃買（上櫃沒有本益比）。點卡片進個股頁。
      </p>
    </div>
  );
};
