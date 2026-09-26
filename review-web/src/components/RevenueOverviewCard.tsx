import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Factory } from 'lucide-react';
import { OverviewCard } from './OverviewCard';
import { MiniTrendChart } from './MiniTrendChart';
import type { MarketRevenueResp, RevenueAggregate } from '../lib/api';
import { compactRevenueAxis, fmtPct, fmtRevenue, monthLabel, revenueMovers, toneClass } from '../lib/marketRevenue';

interface RevenueOverviewCardProps {
  data: MarketRevenueResp | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}

const heatmapLink = (name: string) => `/heatmap?view=revenue&industry=${encodeURIComponent(name)}`;

const Metric: React.FC<{ label: string; value: number | null }> = ({ label, value }) => (
  <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 text-center min-w-0">
    <div className="text-[10px] text-zinc-500">{label}</div>
    <div className={`text-sm font-bold font-mono mt-1 ${toneClass(value)}`}>{fmtPct(value)}</div>
  </div>
);

const MoverList: React.FC<{ title: string; rows: RevenueAggregate[]; empty: string }> = ({ title, rows, empty }) => (
  <div className="min-w-0">
    <div className="text-[11px] font-semibold text-zinc-400 mb-1.5">{title}</div>
    {rows.length === 0 ? (
      <div className="text-[11px] text-zinc-600">{empty}</div>
    ) : (
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.name}>
            <Link
              to={heatmapLink(r.name as string)}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs hover:bg-zinc-800/60 transition"
            >
              <span className="text-zinc-200 truncate">{r.name}</span>
              <span className="flex items-baseline gap-2 shrink-0">
                <span className={`font-mono font-semibold ${toneClass(r.yoy_pct)}`}>{fmtPct(r.yoy_pct)}</span>
                <span className="text-[10px] text-zinc-500 font-mono w-12 text-right">
                  占 {r.share_pct !== null && r.share_pct !== undefined ? `${r.share_pct.toFixed(1)}%` : '—'}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    )}
  </div>
);

/** 盤勢總覽：全體上市月營收（證交所月營收彙總表＋臺股儀表板 12 個月趨勢） */
export const RevenueOverviewCard: React.FC<RevenueOverviewCardProps> = ({
  data,
  loading,
  error,
  onRetry,
  className = '',
}) => {
  const movers = useMemo(() => (data ? revenueMovers(data.industries, 3) : null), [data]);
  const trendPts = useMemo(
    () => (data?.trend || []).map((t) => ({ date: t.month, value: t.revenue })),
    [data],
  );
  const o = data?.overview;

  return (
    <OverviewCard
      title="上市營收動能"
      icon={<Factory className="w-5 h-5 text-primary" />}
      caption="全體上市公司月營收與產業成長／衰退（證交所月營收彙總表）"
      className={className}
      loading={loading && !data}
      error={data ? null : error}
      onRetry={onRetry}
      footer={
        data && (
          <>
            <span>來源：證交所上市公司每月營業收入彙總表</span>
            <span className="flex items-center gap-2">
              {data.stale && <span className="text-amber-400">暫時連不上，顯示上一份</span>}
              <span>營收月份：{data.month}{data.published ? `（${data.published.slice(5).replace('-', '/')} 出表）` : ''}</span>
            </span>
          </>
        )
      }
    >
      {data && o && movers && (
        <div className="space-y-4">
          {/* 寬螢幕一排讀完：總覽｜近 12 個月｜成長／衰退產業（2026-09-27 大盤頁改橫向閱讀） */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-3 space-y-3 min-w-0">
              <div>
                <div className="text-[11px] text-zinc-500">{monthLabel(data.month)}營收（{o.count.toLocaleString('zh-TW')} 家）</div>
                <div className="text-2xl font-black font-mono text-zinc-100 mt-0.5">{fmtRevenue(o.revenue)}</div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="年增" value={o.yoy_pct} />
                <Metric label="月增" value={o.mom_pct} />
                <Metric label="累計年增" value={o.cum_yoy_pct} />
              </div>
              <div className="text-[11px] text-zinc-500">
                32 個官方產業中 <span className="text-bull font-semibold">{movers.upCount}</span> 個年增、
                <span className="text-bear font-semibold">{movers.downCount}</span> 個年減
              </div>
            </div>
            <div className="lg:col-span-5 min-w-0">
              <div className="text-xs font-semibold text-zinc-300 mb-1">近 12 個月營收</div>
              {trendPts.length > 0 ? (
                <MiniTrendChart
                  points={trendPts}
                  kind="bar"
                  label="全體上市公司近 12 個月營收"
                  format={(v) => (v === 0 ? '0' : fmtRevenue(v))}
                  axisFormat={compactRevenueAxis(Math.max(...trendPts.map((p) => p.value)) * 1.1)}
                  height={140}
                />
              ) : (
                <div className="h-[140px] flex items-center justify-center text-[11px] text-zinc-500">趨勢資料暫時抓不到</div>
              )}
            </div>
            <div className="md:col-span-2 lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-4 min-w-0 pt-3 border-t border-border/30 lg:pt-0 lg:border-t-0 lg:pl-5 lg:border-l">
              <MoverList title="年增率最高的產業" rows={movers.up} empty="沒有年增的產業" />
              <MoverList title="年增率衰退的產業" rows={movers.down} empty="這個月沒有產業年減" />
            </div>
          </div>

          <div className="flex justify-end">
            <Link to="/heatmap?view=revenue" className="text-xs text-primary hover:underline">
              看 32 個產業的營收熱力圖 →
            </Link>
          </div>
        </div>
      )}
    </OverviewCard>
  );
};
