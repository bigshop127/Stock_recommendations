import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Thermometer } from 'lucide-react';
import { OverviewCard } from './OverviewCard';
import { MiniTrendChart } from './MiniTrendChart';
import { api } from '../lib/api';
import type { MarketCreditResp } from '../lib/api';
import {
  buildLeverageSnapshot,
  describePosition,
  describeRank,
  fmtYuan,
  recentPoints,
  shortDate,
  type LatestPoint,
} from '../lib/marketCredit';

interface MarketLeverageCardProps {
  data: MarketCreditResp | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}

const fmtInt = (v: number) => Math.round(v).toLocaleString('zh-TW');

/** ▲/▼ 較前日；台股慣例紅漲綠跌，只表示方向，不代表好壞 */
const Delta: React.FC<{ p: LatestPoint | null; fmt: (abs: number) => string }> = ({ p, fmt }) => {
  if (!p || p.change === null) return <span className="text-zinc-600">較前日 —</span>;
  if (p.change === 0) return <span className="text-zinc-500">較前日 持平</span>;
  const up = p.change > 0;
  return (
    <span className={up ? 'text-bull' : 'text-bear'}>
      {up ? '▲' : '▼'} {fmt(Math.abs(p.change))}
    </span>
  );
};

const Tile: React.FC<{
  label: string;
  scope: string;
  value: string;
  delta: React.ReactNode;
  sub?: React.ReactNode;
}> = ({ label, scope, value, delta, sub }) => (
  <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 min-w-0">
    <div className="flex items-start justify-between gap-1.5">
      {/* 手機兩欄時標題會比格子寬，寧可換行也不要截掉「130%」這種關鍵字 */}
      <span className="text-[11px] leading-tight text-zinc-400">{label}</span>
      <span className="text-[9px] leading-tight text-zinc-600 shrink-0 mt-px">{scope}</span>
    </div>
    <div className="text-lg font-bold font-mono text-zinc-100 mt-1 truncate">{value}</div>
    <div className="text-[11px] font-mono mt-0.5">{delta}</div>
    {sub && <div className="text-[10px] text-zinc-500 mt-1 leading-snug">{sub}</div>}
  </div>
);

export const MarketLeverageCard: React.FC<MarketLeverageCardProps> = ({
  data,
  loading,
  error,
  onRetry,
  className = '',
}) => {
  const snap = useMemo(() => (data ? buildLeverageSnapshot(data) : null), [data]);
  const keepPts = useMemo(() => (data ? recentPoints(data.series, 'keep_rate', 30) : []), [data]);
  const disposalPts = useMemo(() => (data ? recentPoints(data.series, 'disposal_accounts', 30) : []), [data]);
  const since = shortDate(snap?.since);

  return (
    <OverviewCard
      title="市場槓桿溫度"
      icon={<Thermometer className="w-5 h-5 text-primary" />}
      caption="全市場擔保維持率、斷頭壓力與融資水位（證交所臺股儀表板）"
      className={className}
      loading={loading && !data}
      error={data ? null : error}
      onRetry={onRetry}
      footer={
        data && (
          <>
            <span>來源：證交所臺股儀表板（信用交易）</span>
            <span className="flex items-center gap-2">
              {data.stale && <span className="text-amber-400">證交所暫時連不上，顯示上一份</span>}
              <span>資料日期：{data.latest_date}</span>
            </span>
          </>
        )
      }
    >
      {snap && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile
              label="擔保維持率"
              scope="全市場"
              value={snap.keepRate ? `${snap.keepRate.value.toFixed(2)}%` : '—'}
              delta={<Delta p={snap.keepRate} fmt={(v) => `${v.toFixed(2)} 百分點`} />}
              sub={
                snap.keepRange && snap.keepRange.n >= 5
                  ? `${since} 以來 ${snap.keepRange.min.toFixed(1)}%～${snap.keepRange.max.toFixed(1)}%，${describePosition(snap.keepRange)}`
                  : undefined
              }
            />
            <Tile
              label="整戶維持率＜130%"
              scope="全市場"
              value={snap.below130 ? `${fmtInt(snap.below130.value)} 戶` : '—'}
              delta={<Delta p={snap.below130} fmt={(v) => `${fmtInt(v)} 戶`} />}
              sub={describeRank(snap.below130Range) || undefined}
            />
            <Tile
              label="處分（斷頭）戶數"
              scope="全市場"
              value={snap.disposal ? `${fmtInt(snap.disposal.value)} 戶` : '—'}
              delta={<Delta p={snap.disposal} fmt={(v) => `${fmtInt(v)} 戶`} />}
              sub={
                snap.disposal
                  ? [`金額 ${fmtYuan(snap.disposalAmount)}`, describeRank(snap.disposalRange)].filter(Boolean).join('・')
                  : undefined
              }
            />
            <Tile
              label="融資餘額"
              scope="上市"
              value={snap.marginBalance ? `${(snap.marginBalance.value / 1e8).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 億` : '—'}
              delta={<Delta p={snap.marginBalance} fmt={(v) => `${(v / 1e8).toFixed(2)} 億`} />}
              sub={
                snap.shortShares ? (
                  <>
                    融券 {fmtInt(snap.shortShares.value)} 張（
                    <Delta p={snap.shortShares} fmt={(v) => `${fmtInt(v)} 張`} />）
                  </>
                ) : undefined
              }
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-300 mb-1">擔保維持率（%）・近 {keepPts.length} 交易日</div>
              <MiniTrendChart
                points={keepPts}
                kind="line"
                label="全市場擔保維持率近 30 交易日"
                format={(v) => `${v.toFixed(1)}%`}
              />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-300 mb-1">處分（斷頭）戶數・近 {disposalPts.length} 交易日</div>
              <MiniTrendChart
                points={disposalPts}
                kind="bar"
                label="全市場處分戶數近 30 交易日"
                format={(v) => `${fmtInt(v)} 戶`}
              />
            </div>
          </div>

          {snap.history && (
            <div className="p-3 rounded-lg bg-zinc-950/30 border border-border/20">
              <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1">
                <span className="text-xs text-zinc-300">
                  融資餘額占市值 <strong className="font-mono text-zinc-100">{snap.history.current.toFixed(2)}%</strong>
                  <span className="text-[10px] text-zinc-600 ml-1">上市</span>
                </span>
                <span className="text-[11px] text-zinc-500">
                  2000 年以來 {snap.history.totalYears} 個年度中，有 {snap.history.lowerYears} 年比現在低
                </span>
              </div>
              <div className="relative h-2 mt-2.5 rounded-full bg-zinc-800">
                <div
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary ring-2 ring-card"
                  style={{ left: `${Math.min(1, Math.max(0, snap.history.position)) * 100}%` }}
                  title={`目前 ${snap.history.current.toFixed(2)}%`}
                />
              </div>
              <div className="flex justify-between mt-1.5 text-[10px] font-mono text-zinc-500">
                <span>低 {snap.history.min.value.toFixed(2)}%（{snap.history.min.label}）</span>
                <span>高 {snap.history.max.value.toFixed(2)}%（{snap.history.max.label}）</span>
              </div>
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-zinc-500">
            維持率、追繳與處分資料證交所 {since || '2026/8/3'} 起才開始提供，無法回測，這裡只列「跟自己比」的位置，沒有設警戒門檻。
            擔保維持率是官方「融資＋融券合併」口徑，跟新聞常見只算融資的「大盤融資維持率」算法不同，130%～140% 那類經驗門檻不適用。
          </p>
        </div>
      )}
    </OverviewCard>
  );
};

/**
 * 再平衡頁 TAIEX 燈號卡底下的一行參考：自己抓、抓不到就整行不顯示。
 * 刻意不接進燈號判斷——這組資料 2026-08-03 才開始，沒回測過。
 */
export const MarketLeverageRefLine: React.FC = () => {
  const [snap, setSnap] = useState<ReturnType<typeof buildLeverageSnapshot> | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getMarketCredit()
      .then((resp) => {
        if (cancelled) return;
        setSnap(buildLeverageSnapshot(resp));
        setStale(!!resp.stale);
      })
      .catch(() => { /* 參考資訊，失敗就不顯示 */ });
    return () => { cancelled = true; };
  }, []);

  if (!snap || !snap.keepRate) return null;
  const k = snap.keepRate;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400 border-t border-border/40 pt-2">
      <span className="text-zinc-500">市場槓桿參考（不影響燈號）：</span>
      <span>
        全市場擔保維持率 <strong className="font-mono text-zinc-200">{k.value.toFixed(2)}%</strong>
        {k.change !== null && (
          <span className={`font-mono ml-1 ${k.change > 0 ? 'text-bull' : k.change < 0 ? 'text-bear' : 'text-zinc-500'}`}>
            {k.change > 0 ? '▲' : k.change < 0 ? '▼' : ''}{Math.abs(k.change).toFixed(2)}
          </span>
        )}
      </span>
      {snap.below130 && (
        <span>整戶＜130% <strong className="font-mono text-zinc-200">{fmtInt(snap.below130.value)}</strong> 戶</span>
      )}
      {snap.disposal && (
        <span>
          處分 <strong className="font-mono text-zinc-200">{fmtInt(snap.disposal.value)}</strong> 戶
          {describeRank(snap.disposalRange) && <span className="text-zinc-500">（{describeRank(snap.disposalRange)}）</span>}
        </span>
      )}
      <span className="text-zinc-600">{k.date}{stale ? '・非最新' : ''}</span>
      <Link to="/" className="text-primary hover:underline">看盤勢總覽 →</Link>
    </div>
  );
};
