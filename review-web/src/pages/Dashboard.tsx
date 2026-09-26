import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type {
  MarketIndices,
  MarketBreadth,
  MarketSectors,
  MarketInstitutional,
  StockHeatmap,
  HeatmapStock,
  Dashboard as DashboardData,
  MarketCreditResp,
  MarketRevenueResp,
  GlobalIndicesResp,
  IndexRow,
} from '../lib/api';
import {
  Activity,
  BarChart3,
  TrendingUp,
  Users,
  RefreshCw,
  LayoutGrid,
  ExternalLink,
  Flame,
  TrendingDown,
  Gauge,
  Globe,
} from 'lucide-react';
import { OverviewCard } from '../components/OverviewCard';
import { MarketLeverageCard } from '../components/MarketLeverageCard';
import { RevenueOverviewCard } from '../components/RevenueOverviewCard';
import { buildMarketSummary } from '../lib/marketSummary';
import { GroupTag } from '../components/GroupTag';
// 大盤頁分頁（2026-09-27：原本一整頁九張卡太亂，拆成四頁；自選清單移除）
type DashboardTab = 'overview' | 'flows' | 'movers' | 'credit';
const DASHBOARD_TABS: { id: DashboardTab; label: string }[] = [
  { id: 'overview', label: '盤勢總覽' },
  { id: 'flows', label: '法人與產業' },
  { id: 'movers', label: '漲跌與熱門' },
  { id: 'credit', label: '槓桿與營收' },
];

// 國際指數資料時間：一律用台北時間顯示（美股收盤在台灣是隔天清晨）
const fmtTpeTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '--';

// 期現貨指數只留這三檔（2026-09-27 使用者要求拿掉電子、金融），照這個順序排
const TW_INDEX_KEYS = ['TWSE', 'OTC', 'TX'];

// === 指數方塊（期現貨與國際指數卡共用）===
// wide：台股三檔用，名稱在左、數字在右；否則直式小方塊，給國際指數一排六個
const IndexTile: React.FC<{
  name: string;
  badge?: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  meta: React.ReactNode;
  wide?: boolean;
}> = ({ name, badge, price, change, changePct, meta, wide = false }) => {
  const tone = change === null ? 'text-zinc-500' : change >= 0 ? 'text-bull' : 'text-bear';
  const priceStr =
    price !== null ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
  const changeStr =
    (change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}` : '--') +
    (changePct !== null ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)` : '');
  const title = (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-sm font-semibold text-zinc-200 truncate">{name}</span>
      {badge && (
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-400 shrink-0">{badge}</span>
      )}
    </div>
  );
  if (wide) {
    return (
      <div className="flex items-center justify-between gap-3 p-3.5 rounded-lg bg-zinc-950/40 border border-border/30 min-w-0">
        <div className="min-w-0">
          {title}
          <div className="text-[9px] text-zinc-500 font-mono mt-1 truncate">{meta}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-bold font-mono text-zinc-100 leading-tight">{priceStr}</div>
          <div className={`text-[11px] font-mono font-medium mt-0.5 ${tone}`}>{changeStr}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="p-3 rounded-lg bg-zinc-950/40 border border-border/30 min-w-0">
      {title}
      <div className="text-base font-bold font-mono text-zinc-100 mt-1.5 leading-tight">{priceStr}</div>
      <div className={`text-[11px] font-mono font-medium mt-0.5 ${tone}`}>{changeStr}</div>
      <div className="text-[9px] text-zinc-500 font-mono mt-1 truncate">{meta}</div>
    </div>
  );
};

// 合併卡裡兩段資料各自顯示載入中／錯誤，一段抓不到不會拖累另一段
const SectionStatus: React.FC<{ loading: boolean; error: string | null; onRetry: () => void }> = ({
  loading,
  error,
  onRetry,
}) =>
  loading ? (
    <div className="h-20 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入資料中...</div>
  ) : error ? (
    <div className="h-20 flex items-center justify-center gap-3 px-3 text-xs border border-red-500/20 bg-red-500/5 rounded-lg">
      <span className="text-red-400 truncate">無法載入資料：{error}</span>
      <button
        onClick={onRetry}
        className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition shrink-0"
      >
        重試
      </button>
    </div>
  ) : null;

// === 三大法人近 10 日趨勢 ===
// 用量到的容器寬度當 viewBox（同 MiniTrendChart）：卡片改整行寬後，圖不會跟著等比放大成一大塊、字也不會變形
const InstTrendChart: React.FC<{ trend: MarketInstitutional['trend'] }> = ({ trend }) => {
  const [width, setWidth] = useState(500);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () => setWidth(Math.max(280, node.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  if (!trend || trend.length === 0) return null;
  const height = 200;
  const padding = { top: 16, right: 24, bottom: 26, left: 50 };

  const allValues = trend.flatMap((d) => [d.foreign, d.investment_trust, d.dealer, d.total]);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const valRange = maxVal - minVal || 1;

  const getX = (idx: number) =>
    padding.left + (idx / (trend.length - 1 || 1)) * (width - padding.left - padding.right);
  const getY = (val: number) =>
    padding.top + (1 - (val - minVal) / valRange) * (height - padding.top - padding.bottom);

  const getLinePath = (key: 'foreign' | 'investment_trust' | 'dealer' | 'total') =>
    trend.map((d, idx) => `${idx === 0 ? 'M' : 'L'}${getX(idx)},${getY(d[key])}`).join(' ');

  // 夠寬就每天都標日期，窄的時候隔一天標一次；從最後一天往回數，最新一天一定有標、也不會跟前一個擠在一起
  const labelEvery = width >= 560 ? 1 : 2;
  const lastIdx = trend.length - 1;

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        {minVal < 0 && maxVal > 0 && (
          <line
            x1={padding.left}
            y1={getY(0)}
            x2={width - padding.right}
            y2={getY(0)}
            stroke="#3f3f46"
            strokeDasharray="4"
          />
        )}
        <text x={padding.left - 5} y={getY(maxVal)} fill="#71717a" fontSize="10" textAnchor="end">
          {(maxVal / 1e8).toFixed(0)}億
        </text>
        <text x={padding.left - 5} y={getY(0)} fill="#71717a" fontSize="10" textAnchor="end">
          0
        </text>
        <text x={padding.left - 5} y={getY(minVal)} fill="#71717a" fontSize="10" textAnchor="end">
          {(minVal / 1e8).toFixed(0)}億
        </text>

        {trend.map((d, idx) =>
          (lastIdx - idx) % labelEvery === 0 ? (
            <text key={idx} x={getX(idx)} y={height - 6} fill="#71717a" fontSize="10" textAnchor="middle">
              {d.date.slice(5)}
            </text>
          ) : null,
        )}

        <path d={getLinePath('foreign')} fill="none" stroke="#3b82f6" strokeWidth="1.5" />
        <path d={getLinePath('investment_trust')} fill="none" stroke="#a855f7" strokeWidth="1.5" />
        <path d={getLinePath('dealer')} fill="none" stroke="#f59e0b" strokeWidth="1.5" />
        <path d={getLinePath('total')} fill="none" stroke="#ef4444" strokeWidth="2" />

        {trend.map((d, idx) => (
          <circle key={idx} cx={getX(idx)} cy={getY(d.total)} r="3" fill={d.total >= 0 ? '#ef4444' : '#22c55e'} />
        ))}
      </svg>
      <div className="flex justify-center gap-4 text-[10px] text-zinc-400 mt-1">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-0.5 bg-[#3b82f6]"></span>外資
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-0.5 bg-[#a855f7]"></span>投信
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-0.5 bg-[#f59e0b]"></span>自營商
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-1 bg-[#ef4444]"></span>合計
        </span>
      </div>
    </div>
  );
};

// === 盤面氣氛手刻 SVG 半圓儀表 ===
const AtmosphereGauge: React.FC<{
  mood: number;
  stance: 'bull' | 'bear' | 'neutral';
  degraded?: boolean;
}> = ({ mood, stance, degraded }) => {
  const displayMood = degraded ? 0 : mood;
  // Convert mood (-100 ~ +100) to radians (PI ~ 0)
  const angleRad = Math.PI - ((displayMood + 100) / 200) * Math.PI;

  const cx = 100;
  const cy = 90;
  const r = 65;

  // Pointer tip
  const nx = cx + 48 * Math.cos(angleRad);
  const ny = cy - 48 * Math.sin(angleRad);

  const stanceColor = degraded
    ? '#71717a'
    : stance === 'bull'
    ? '#ef4444' // 紅多
    : stance === 'bear'
    ? '#22c55e' // 綠空
    : '#a1a1aa';

  const stanceLabel = degraded
    ? '資料不足'
    : stance === 'bull'
    ? '偏多'
    : stance === 'bear'
    ? '偏空'
    : '中性';

  // Ticks at -100, -50, 0, +50, +100
  const tickValues = [-100, -50, 0, 50, 100];

  return (
    <div className="flex flex-col items-center justify-center relative">
      <svg viewBox="0 0 200 115" className="w-48 h-28 overflow-visible">
        {/* Arc Background Track */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="#27272a"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Bull/Bear/Neutral Colored Segments */}
        {/* Green segment (Bear: -100 ~ -20) */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(Math.PI * 0.6)} ${cy - r * Math.sin(Math.PI * 0.6)}`}
          fill="none"
          stroke="#22c55e"
          strokeWidth="6"
          strokeOpacity="0.4"
        />
        {/* Gray segment (Neutral: -20 ~ +20) */}
        <path
          d={`M ${cx + r * Math.cos(Math.PI * 0.6)} ${cy - r * Math.sin(Math.PI * 0.6)} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(Math.PI * 0.4)} ${cy - r * Math.sin(Math.PI * 0.4)}`}
          fill="none"
          stroke="#71717a"
          strokeWidth="6"
          strokeOpacity="0.4"
        />
        {/* Red segment (Bull: +20 ~ +100) */}
        <path
          d={`M ${cx + r * Math.cos(Math.PI * 0.4)} ${cy - r * Math.sin(Math.PI * 0.4)} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="#ef4444"
          strokeWidth="6"
          strokeOpacity="0.4"
        />

        {/* Ticks and labels */}
        {tickValues.map((val) => {
          const rad = Math.PI - ((val + 100) / 200) * Math.PI;
          const x1 = cx + 58 * Math.cos(rad);
          const y1 = cy - 58 * Math.sin(rad);
          const x2 = cx + 64 * Math.cos(rad);
          const y2 = cy - 64 * Math.sin(rad);
          const tx = cx + 76 * Math.cos(rad);
          const ty = cy - 76 * Math.sin(rad);
          return (
            <g key={val}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#52525b" strokeWidth="1.5" />
              <text
                x={tx}
                y={ty + 3}
                fill="#71717a"
                fontSize="8"
                fontWeight="500"
                textAnchor="middle"
                fontFamily="monospace"
              >
                {val > 0 ? `+${val}` : val}
              </text>
            </g>
          );
        })}

        {/* Pointer Needle */}
        {!degraded && (
          <line
            x1={cx}
            y1={cy}
            x2={nx}
            y2={ny}
            stroke={stanceColor}
            strokeWidth="3"
            strokeLinecap="round"
          />
        )}
        <circle cx={cx} cy={cy} r="5" fill={stanceColor} />
      </svg>

      {/* Center Value and Label */}
      <div className="text-center -mt-4">
        <div className="text-2xl font-black font-mono tracking-tight" style={{ color: stanceColor }}>
          {degraded ? '--' : mood >= 0 ? `+${mood}` : mood}
        </div>
        <div
          className="text-[10px] font-bold px-2 py-0.5 rounded-full inline-block mt-0.5 border"
          style={{
            borderColor: `${stanceColor}40`,
            backgroundColor: `${stanceColor}15`,
            color: stanceColor,
          }}
        >
          {stanceLabel}
        </div>
      </div>
    </div>
  );
};

// === 漲跌分布直方圖 ＋ 五段 Strip ===
const HistogramChart: React.FC<{
  heatmapData: StockHeatmap | null;
}> = ({ heatmapData }) => {
  const histogram = useMemo(() => {
    if (!heatmapData || !heatmapData.stocks || heatmapData.stocks.length === 0) return null;

    // 21 Buckets: <-9%, -9~-8%, ..., 0%, ..., +8~+9%, >+9%
    const buckets: { label: string; range: string; min: number; max: number; count: number; tone: 'bull' | 'bear' | 'flat' }[] = [];

    // Bucket 0: <-9%
    buckets.push({ label: '<-9%', range: '< -9%', min: -Infinity, max: -9, count: 0, tone: 'bear' });
    // Buckets -9 ~ -1
    for (let i = -9; i <= -1; i++) {
      buckets.push({
        label: `${i}%`,
        range: `${i}% ~ ${i + 1}%`,
        min: i,
        max: i + 1,
        count: 0,
        tone: 'bear',
      });
    }
    // Flat: 0%
    buckets.push({ label: '0%', range: '平盤 (0%)', min: -0.0001, max: 0.0001, count: 0, tone: 'flat' });
    // Buckets +1 ~ +9
    for (let i = 1; i <= 9; i++) {
      buckets.push({
        label: `+${i}%`,
        range: `+${i - 1}% ~ +${i}%`,
        min: i - 1,
        max: i,
        count: 0,
        tone: 'bull',
      });
    }
    // Bucket >+9%
    buckets.push({ label: '>+9%', range: '> +9%', min: 9, max: Infinity, count: 0, tone: 'bull' });

    let totalValid = 0;
    let limitUpCount = 0;
    let advancingCount = 0;
    let flatCount = 0;
    let decliningCount = 0;
    let limitDownCount = 0;

    heatmapData.stocks.forEach((s) => {
      if (s.change_pct === null || s.change_pct === undefined) return;
      const pct = s.change_pct;
      totalValid++;

      // Strip counts
      if (pct >= 9.5) {
        limitUpCount++;
        advancingCount++;
      } else if (pct > 0) {
        advancingCount++;
      } else if (pct === 0) {
        flatCount++;
      } else if (pct <= -9.5) {
        limitDownCount++;
        decliningCount++;
      } else {
        decliningCount++;
      }

      // Bucketing
      if (pct < -9) {
        buckets[0].count++;
      } else if (pct > 9) {
        buckets[buckets.length - 1].count++;
      } else if (Math.abs(pct) < 0.0001) {
        const flatIdx = buckets.findIndex((b) => b.tone === 'flat');
        if (flatIdx >= 0) buckets[flatIdx].count++;
      } else if (pct < 0) {
        // -9 to 0
        const idx = Math.floor(pct) + 10; // e.g. -8.5 -> -9 + 10 = 1
        if (buckets[idx]) buckets[idx].count++;
        else buckets[0].count++;
      } else {
        // 0 to 9
        const idx = Math.floor(pct) + 11; // e.g. 0.5 -> 0 + 11 = 11 (+1%)
        if (buckets[idx]) buckets[idx].count++;
        else buckets[buckets.length - 1].count++;
      }
    });

    const maxCount = Math.max(...buckets.map((b) => b.count), 1);

    return {
      buckets,
      totalValid,
      maxCount,
      strip: {
        limitUp: limitUpCount,
        advancing: advancingCount - limitUpCount,
        flat: flatCount,
        declining: decliningCount - limitDownCount,
        limitDown: limitDownCount,
      },
    };
  }, [heatmapData]);

  if (!histogram) {
    return (
      <div className="h-48 flex flex-col items-center justify-center text-xs text-zinc-500 italic">
        <span>漲跌分布資料不可用 (或未獲取快照)</span>
      </div>
    );
  }

  const { buckets, maxCount, totalValid, strip } = histogram;

  return (
    <div className="space-y-4">
      {/* 21-bucket Histogram Bar Chart */}
      <div className="h-40 flex items-end gap-1 pt-4 pb-2 border-b border-border/40 px-1">
        {buckets.map((b, idx) => {
          const heightPct = (b.count / maxCount) * 100;
          const barColor =
            b.tone === 'bull'
              ? 'bg-bull hover:bg-red-400'
              : b.tone === 'bear'
              ? 'bg-bear hover:bg-green-400'
              : 'bg-zinc-500 hover:bg-zinc-400';

          return (
            <div
              key={idx}
              className="flex-1 flex flex-col items-center h-full justify-end group relative"
            >
              {/* Tooltip */}
              <div className="absolute -top-8 hidden group-hover:flex flex-col items-center z-20 bg-zinc-900 border border-zinc-700 px-2 py-0.5 rounded text-[10px] font-mono text-zinc-200 whitespace-nowrap shadow-lg">
                <span>{b.range}</span>
                <span className="font-bold text-primary">{b.count} 家</span>
              </div>

              {/* Bar */}
              <div
                className={`w-full rounded-t transition-all duration-300 ${barColor}`}
                style={{ height: `${Math.max(heightPct, 2)}%` }}
              />
            </div>
          );
        })}
      </div>

      {/* X Axis Labels */}
      <div className="flex justify-between text-[9px] text-zinc-500 font-mono px-1">
        <span className="text-bear font-semibold">&lt;-9%</span>
        <span>-5%</span>
        <span className="text-zinc-400 font-bold">0%</span>
        <span>+5%</span>
        <span className="text-bull font-semibold">&gt;+9%</span>
      </div>

      {/* 5-segment strip (跌停 / 下跌 / 平盤 / 上漲 / 漲停) */}
      <div className="space-y-1.5">
        <div className="w-full h-3.5 rounded-full bg-zinc-950 flex overflow-hidden border border-border/30">
          {/* 跌停 */}
          <div
            className="bg-emerald-700 h-full transition-all"
            style={{ width: `${(strip.limitDown / (totalValid || 1)) * 100}%` }}
            title={`跌停: ${strip.limitDown} 家`}
          />
          {/* 下跌 */}
          <div
            className="bg-bear h-full transition-all"
            style={{ width: `${(strip.declining / (totalValid || 1)) * 100}%` }}
            title={`下跌: ${strip.declining} 家`}
          />
          {/* 平盤 */}
          <div
            className="bg-zinc-600 h-full transition-all"
            style={{ width: `${(strip.flat / (totalValid || 1)) * 100}%` }}
            title={`平盤: ${strip.flat} 家`}
          />
          {/* 上漲 */}
          <div
            className="bg-bull h-full transition-all"
            style={{ width: `${(strip.advancing / (totalValid || 1)) * 100}%` }}
            title={`上漲: ${strip.advancing} 家`}
          />
          {/* 漲停 */}
          <div
            className="bg-rose-700 h-full transition-all"
            style={{ width: `${(strip.limitUp / (totalValid || 1)) * 100}%` }}
            title={`漲停: ${strip.limitUp} 家`}
          />
        </div>

        <div className="grid grid-cols-5 text-center text-[10px] font-mono">
          <div className="text-emerald-400 font-semibold">
            跌停 <span className="font-bold">{strip.limitDown}</span>
          </div>
          <div className="text-bear font-semibold">
            下跌 <span className="font-bold">{strip.declining}</span>
          </div>
          <div className="text-zinc-400 font-semibold">
            平盤 <span className="font-bold">{strip.flat}</span>
          </div>
          <div className="text-bull font-semibold">
            上漲 <span className="font-bold">{strip.advancing}</span>
          </div>
          <div className="text-rose-400 font-semibold">
            漲停 <span className="font-bold">{strip.limitUp}</span>
          </div>
        </div>
        <div className="text-[9px] text-zinc-500 font-mono text-right mt-1">
          * 漲跌停統計以 ±9.5% 概算 (可能與市場寬度名單略微差異)
        </div>
      </div>
    </div>
  );
};

// === 強勢 / 弱勢 / 熱門 Top15 表格 ===
type Top15Kind = 'hot' | 'strong' | 'weak';
const TOP15_KINDS: { id: Top15Kind; label: string; icon: React.ReactNode; activeClass: string; headClass: string }[] = [
  {
    id: 'hot',
    label: '熱門 (成交值)',
    icon: <Flame className="w-3.5 h-3.5" />,
    activeClass: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
    headClass: 'text-amber-400',
  },
  {
    id: 'strong',
    label: '強勢 (漲幅 Top15)',
    icon: <TrendingUp className="w-3.5 h-3.5" />,
    activeClass: 'bg-bull/20 text-bull border border-bull/30',
    headClass: 'text-bull',
  },
  {
    id: 'weak',
    label: '弱勢 (跌幅 Top15)',
    icon: <TrendingDown className="w-3.5 h-3.5" />,
    activeClass: 'bg-bear/20 text-bear border border-bear/30',
    headClass: 'text-bear',
  },
];

const Top15RankTable: React.FC<{ rows: HeatmapStock[]; scroll?: boolean }> = ({ rows, scroll = false }) => {
  const navigate = useNavigate();
  if (rows.length === 0) {
    return <div className="h-48 flex items-center justify-center text-xs text-zinc-500 italic">無排行資料</div>;
  }
  return (
    <div className={`overflow-x-auto ${scroll ? 'max-h-[340px] overflow-y-auto' : ''}`}>
      <table className="w-full text-xs text-left">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="text-zinc-500 border-b border-border/60 font-mono text-[11px]">
            <th className="pb-2 font-semibold w-8 text-center">#</th>
            <th className="pb-2 font-semibold">代號 / 名稱</th>
            <th className="pb-2 font-semibold text-right">收盤價</th>
            <th className="pb-2 font-semibold text-right">漲跌%</th>
            <th className="pb-2 font-semibold text-right pr-2">成交值</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((st, idx) => {
            const isUp = (st.change_pct || 0) >= 0;
            return (
              <tr
                key={st.code}
                onClick={() => navigate(`/stock/${st.code}`)}
                className="border-b border-border/30 last:border-0 hover:bg-zinc-800/50 transition cursor-pointer"
              >
                <td className="py-2 font-mono text-zinc-500 text-center text-[10px]">{idx + 1}</td>
                <td className="py-2">
                  <span className="font-mono font-bold text-zinc-200 mr-1.5">{st.code}</span>
                  <span className="text-zinc-300 text-xs mr-1.5">{st.name}</span>
                  <GroupTag code={st.code} fallback={st.sector} />
                </td>
                <td className="py-2 text-right font-mono text-zinc-200 font-medium">
                  {st.close !== null ? st.close.toFixed(2) : '--'}
                </td>
                <td
                  className={`py-2 text-right font-mono ${
                    st.change_pct === null ? 'text-zinc-500' : isUp ? 'text-bull font-bold' : 'text-bear font-bold'
                  }`}
                >
                  {st.change_pct !== null ? `${isUp ? '+' : ''}${st.change_pct.toFixed(2)}%` : '--'}
                </td>
                <td className="py-2 text-right font-mono text-zinc-400 pr-2 whitespace-nowrap">
                  {st.turnover !== null ? `${(st.turnover / 1e8).toFixed(1)} 億` : '--'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const Top15Table: React.FC<{
  stocks: HeatmapStock[];
}> = ({ stocks }) => {
  const [activeTab, setActiveTab] = useState<Top15Kind>('hot');

  const lists = useMemo(() => {
    const priced = (stocks || []).filter((s) => s.close !== null);
    const withPct = priced.filter((s) => s.change_pct !== null);
    return {
      hot: priced
        .filter((s) => s.turnover !== null)
        .sort((a, b) => (b.turnover || 0) - (a.turnover || 0))
        .slice(0, 15),
      strong: [...withPct].sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0)).slice(0, 15),
      weak: [...withPct].sort((a, b) => (a.change_pct || 0) - (b.change_pct || 0)).slice(0, 15),
    };
  }, [stocks]);

  return (
    <>
      {/* 手機／平板：三個排行用按鈕切換 */}
      <div className="xl:hidden space-y-3">
        <div className="flex items-center gap-1.5 border-b border-border/40 pb-2 overflow-x-auto scrollbar-none">
          {TOP15_KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setActiveTab(k.id)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition flex items-center gap-1 whitespace-nowrap shrink-0 ${
                activeTab === k.id ? k.activeClass : 'bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400'
              }`}
            >
              {k.icon}
              {k.label}
            </button>
          ))}
        </div>
        <Top15RankTable rows={lists[activeTab]} scroll />
      </div>

      {/* 寬螢幕：三個排行並排，由左往右讀 */}
      <div className="hidden xl:grid grid-cols-3 gap-6">
        {TOP15_KINDS.map((k) => (
          <div key={k.id} className="min-w-0">
            <div className={`flex items-center gap-1 text-xs font-semibold mb-2 ${k.headClass}`}>
              {k.icon}
              {k.label}
            </div>
            <Top15RankTable rows={lists[k.id]} />
          </div>
        ))}
      </div>
    </>
  );
};

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [indicesState, setIndicesState] = useState<{
    data: MarketIndices | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [breadthState, setBreadthState] = useState<{
    data: MarketBreadth | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [sectorsState, setSectorsState] = useState<{
    data: MarketSectors | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [institutionalState, setInstitutionalState] = useState<{
    data: MarketInstitutional | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [dashboardState, setDashboardState] = useState<{
    data: DashboardData | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [heatmapState, setHeatmapState] = useState<{
    data: StockHeatmap | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });

  const [creditState, setCreditState] = useState<{
    data: MarketCreditResp | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [revenueState, setRevenueState] = useState<{
    data: MarketRevenueResp | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [globalState, setGlobalState] = useState<{
    data: GlobalIndicesResp | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });

  // 分頁記在網址 ?tab=，重新整理或從別頁返回都停在原本那頁
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: DashboardTab = DASHBOARD_TABS.some((t) => t.id === rawTab) ? (rawTab as DashboardTab) : 'overview';
  const handleTabChange = (tab: DashboardTab) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev); // 保留其他參數（例如開發用的 ?mock=1）
        if (tab === 'overview') next.delete('tab');
        else next.set('tab', tab);
        return next;
      },
      { replace: true },
    );
  };

  const isDev = import.meta.env.DEV;
  const isMockParam = new URLSearchParams(window.location.search).get('mock') === '1';
  const useMock = isDev && isMockParam;

  const loadMockData = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const mockIndices: MarketIndices = {
      date: dateStr,
      as_of: new Date().toISOString(),
      indices: [
        {
          key: 'TWSE',
          name: '加權指數',
          price: 22845.81,
          change: 182.42,
          change_pct: 0.81,
          volume: 382400000000,
          intraday: [
            { t: '09:00', v: 22663.39 },
            { t: '10:00', v: 22750.5 },
            { t: '11:00', v: 22800.2 },
            { t: '12:00', v: 22820.8 },
            { t: '13:00', v: 22845.81 },
          ],
          source: 'TWSE MIS',
        },
        {
          key: 'OTC',
          name: '櫃買指數',
          price: 268.45,
          change: -1.25,
          change_pct: -0.46,
          volume: 82400000000,
          intraday: [
            { t: '09:00', v: 269.7 },
            { t: '10:00', v: 269.1 },
            { t: '11:00', v: 268.8 },
            { t: '12:00', v: 268.5 },
            { t: '13:00', v: 268.45 },
          ],
          source: 'TWSE MIS',
        },
        {
          key: 'electronic',
          name: '電子工業',
          price: 1205.3,
          change: 15.45,
          change_pct: 1.3,
          volume: null,
          intraday: [
            { t: '09:00', v: 1189.85 },
            { t: '10:00', v: 1195.4 },
            { t: '11:00', v: 1201.2 },
            { t: '12:00', v: 1203.5 },
            { t: '13:00', v: 1205.3 },
          ],
          source: 'TWSE MIS',
        },
        {
          key: 'finance',
          name: '金融保險',
          price: 1980.25,
          change: -8.15,
          change_pct: -0.41,
          volume: null,
          intraday: [
            { t: '09:00', v: 1988.4 },
            { t: '10:00', v: 1985.2 },
            { t: '11:00', v: 1982.9 },
            { t: '12:00', v: 1981.1 },
            { t: '13:00', v: 1980.25 },
          ],
          source: 'TWSE MIS',
        },
        {
          key: 'TX',
          name: '台指期',
          price: 22860.0,
          change: 195.0,
          change_pct: 0.86,
          volume: 120000,
          intraday: [
            { t: '09:00', v: 22665.0 },
            { t: '10:00', v: 22760.0 },
            { t: '11:00', v: 22815.0 },
            { t: '12:00', v: 22835.0 },
            { t: '13:00', v: 22860.0 },
          ],
          source: 'TAIFEX',
        },
      ],
    };

    const mockBreadth: MarketBreadth = {
      date: dateStr,
      advancing: 582,
      declining: 324,
      unchanged: 92,
      limit_up: 12,
      limit_down: 3,
      total: 998,
      advancing_pct: 0.583,
      above_ma20_ratio: 0.625,
      above_ma50_ratio: 0.584,
      universe: 'TWSE',
      sample_size: 998,
      source: 'TWSE',
    };

    const mockSectors: MarketSectors = {
      date: dateStr,
      sectors: [
        { name: '半導體', change_pct: 1.45, turnover: 124500000000, source: 'TWSE' },
        { name: '電腦及週邊', change_pct: 0.82, turnover: 24500000000, source: 'TWSE' },
        { name: '光電', change_pct: 1.15, turnover: 15400000000, source: 'TWSE' },
        { name: '電機機械', change_pct: 2.1, turnover: 14500000000, source: 'TWSE' },
        { name: '金融保險', change_pct: 0.35, turnover: 18200000000, source: 'TWSE' },
        { name: '電子零組件', change_pct: -0.65, turnover: 18200000000, source: 'TWSE' },
        { name: '鋼鐵', change_pct: -0.95, turnover: 850000005, source: 'TWSE' },
        { name: '航運', change_pct: -1.82, turnover: 32000000000, source: 'TWSE' },
      ],
    };

    const mockInstitutional: MarketInstitutional = {
      date: dateStr,
      unit: '元',
      latest: {
        foreign: 8520000000,
        investment_trust: 2410000000,
        dealer: -1540000000,
        total: 9390000000,
      },
      trend: [
        { date: '2026-06-15', foreign: -4200000000, investment_trust: 1200000000, dealer: -50000000, total: -3500000000 },
        { date: '2026-06-16', foreign: 1500000000, investment_trust: 800000000, dealer: 200000000, total: 2500000000 },
        { date: '2026-06-17', foreign: 3200000000, investment_trust: 1400000000, dealer: -800000000, total: 3800000000 },
        { date: '2026-06-18', foreign: -1200000000, investment_trust: 900000000, dealer: 400000000, total: 100000000 },
        { date: '2026-06-19', foreign: 8520000000, investment_trust: 2410000000, dealer: -1540000000, total: 9390000000 },
      ],
      source: 'TWSE',
    };

    const mockDash: DashboardData = {
      date: dateStr,
      as_of_date: dateStr,
      market_regime: { label: 'bullish', score: 0.65, gate: 0.5 },
      water_level: 0.65,
      water_level_text: '偏多',
      puhui_sentiment: { label: 'positive', score: 72 },
      watchlist: [],
      degraded: false,
      generated_at: new Date().toISOString(),
    };

    // Mock Heatmap Stocks (100 items with distributed change_pct)
    const mockHeatmapStocks: HeatmapStock[] = [
      { code: '2330', name: '台積電', sector: '半導體', close: 1045, change_pct: 1.95, turnover: 38500000000 },
      { code: '2454', name: '聯發科', sector: '半導體', close: 1285, change_pct: 3.22, turnover: 14500000000 },
      { code: '2317', name: '鴻海', sector: '電腦及週邊', close: 205.5, change_pct: 0.98, turnover: 21000000000 },
      { code: '2382', name: '廣達', sector: '電腦及週邊', close: 290, change_pct: -1.36, turnover: 12000000000 },
      { code: '3231', name: '緯創', sector: '電腦及週邊', close: 112, change_pct: -2.61, turnover: 9500000000 },
      { code: '2603', name: '長榮', sector: '航運', close: 185, change_pct: -4.15, turnover: 16500000000 },
      { code: '2308', name: '台達電', sector: '電子零組件', close: 390, change_pct: 2.36, turnover: 8800000000 },
      { code: '3008', name: '大立光', sector: '光電', close: 2550, change_pct: 9.91, turnover: 7800000000 },
      { code: '1519', name: '華城', sector: '電機機械', close: 680, change_pct: 9.85, turnover: 11200000000 },
      { code: '2379', name: '瑞昱', sector: '半導體', close: 540, change_pct: -9.85, turnover: 6500000000 },
    ];
    // Add 80 synthetic stocks to make histogram rich
    for (let i = 1; i <= 80; i++) {
      const pct = parseFloat(((Math.random() - 0.45) * 12).toFixed(2));
      mockHeatmapStocks.push({
        code: `600${i}`,
        name: `測試股${i}`,
        sector: i % 2 === 0 ? '電子零組件' : '金融保險',
        close: Math.round(50 + Math.random() * 200),
        change_pct: pct > 9.9 ? 9.9 : pct < -9.9 ? -9.9 : pct,
        turnover: Math.round(100000000 + Math.random() * 5000000000),
      });
    }

    const mockHeatmapData: StockHeatmap = {
      date: dateStr,
      period: 'day',
      base_date: dateStr,
      market: 'TWSE',
      stocks: mockHeatmapStocks,
      source: 'TWSE',
    };

    setIndicesState({ data: mockIndices, loading: false, error: null });
    setBreadthState({ data: mockBreadth, loading: false, error: null });
    setSectorsState({ data: mockSectors, loading: false, error: null });
    setInstitutionalState({ data: mockInstitutional, loading: false, error: null });
    setDashboardState({ data: mockDash, loading: false, error: null });
    setHeatmapState({ data: mockHeatmapData, loading: false, error: null });
  };

  const fetchIndices = async () => {
    setIndicesState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketIndices({ range: '1d' });
      setIndicesState({ data, loading: false, error: null });
    } catch (err: any) {
      setIndicesState({ data: null, loading: false, error: err.message || '無法取得指數資料' });
    }
  };

  const fetchBreadth = async () => {
    setBreadthState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketBreadth();
      setBreadthState({ data, loading: false, error: null });
    } catch (err: any) {
      setBreadthState({ data: null, loading: false, error: err.message || '無法取得市場多空寬度' });
    }
  };

  const fetchSectors = async () => {
    setSectorsState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketSectors();
      setSectorsState({ data, loading: false, error: null });
    } catch (err: any) {
      setSectorsState({ data: null, loading: false, error: err.message || '無法取得類股表現' });
    }
  };

  const fetchInstitutional = async () => {
    setInstitutionalState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketInstitutional();
      setInstitutionalState({ data, loading: false, error: null });
    } catch (err: any) {
      setInstitutionalState({ data: null, loading: false, error: err.message || '無法取得三大法人買賣超' });
    }
  };

  const fetchDashboard = async () => {
    setDashboardState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.dashboard();
      setDashboardState({ data, loading: false, error: null });
    } catch (err: any) {
      setDashboardState({ data: null, loading: false, error: err.message || '無法取得 Dashboard 資料' });
    }
  };

  const fetchHeatmap = async (force = false) => {
    setHeatmapState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.marketStockHeatmap({ period: 'day' }, force);
      setHeatmapState({ data, loading: false, error: null });
    } catch (err: any) {
      // Graceful degradation when opt6 API missing or fails
      setHeatmapState({ data: null, loading: false, error: err.message || '無法取得個股快照' });
    }
  };

  const fetchCredit = async (force = false) => {
    setCreditState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.getMarketCredit(force);
      setCreditState({ data, loading: false, error: null });
    } catch (err: any) {
      setCreditState((prev) => ({ data: prev.data, loading: false, error: err.message || '無法取得信用交易資料' }));
    }
  };

  const fetchRevenue = async (force = false) => {
    setRevenueState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.getMarketRevenue(force);
      setRevenueState({ data, loading: false, error: null });
    } catch (err: any) {
      setRevenueState((prev) => ({ data: prev.data, loading: false, error: err.message || '無法取得月營收資料' }));
    }
  };

  // 國際指數：gateway 自抓 Yahoo、不經 engine，mock 模式照樣抓真的
  const fetchGlobal = async (force = false) => {
    setGlobalState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await api.getGlobalIndices(force);
      setGlobalState({ data, loading: false, error: null });
    } catch (err: any) {
      setGlobalState({ data: null, loading: false, error: err.message || '無法取得國際指數' });
    }
  };

  const fetchAllData = (force = false) => {
    if (useMock) {
      loadMockData();
      fetchGlobal(force);
      fetchCredit(force); // gateway 自抓證交所、不經 engine，mock 模式照樣抓真的
      fetchRevenue(force);
      return;
    }
    fetchIndices();
    fetchBreadth();
    fetchSectors();
    fetchInstitutional();
    fetchDashboard();
    fetchHeatmap(force);
    fetchGlobal(force);
    fetchCredit(force);
    fetchRevenue(force);
  };

  useEffect(() => {
    fetchAllData();
  }, [useMock]);

  // Market Summary Logic
  const summary = useMemo(() => {
    return buildMarketSummary({
      breadth: breadthState.data,
      institutional: institutionalState.data,
      water_level: dashboardState.data?.water_level,
      regime: dashboardState.data?.market_regime,
    });
  }, [breadthState.data, institutionalState.data, dashboardState.data]);

  const getHeatmapColor = (pct: number | null) => {
    if (pct === null) return 'rgba(63, 63, 70, 0.4)';
    if (pct >= 0) {
      const alpha = Math.min(0.1 + (pct / 3) * 0.9, 1.0);
      return `rgba(239, 68, 68, ${alpha})`;
    } else {
      const alpha = Math.min(0.1 + (Math.abs(pct) / 3) * 0.9, 1.0);
      return `rgba(34, 197, 94, ${alpha})`;
    }
  };

  // Market indices lookup helper for top chips
  const getIndexChip = (key: string, label: string) => {
    const item = indicesState.data?.indices.find((i) => i.key.toUpperCase() === key.toUpperCase());
    if (!item) {
      return { label, price: '--', changeStr: '--', isUp: true };
    }
    const isUp = (item.change || 0) >= 0;
    const priceStr =
      item.price !== null ? item.price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '--';
    const changePctStr =
      item.change_pct !== null ? `${isUp ? '+' : ''}${item.change_pct.toFixed(2)}%` : '--';
    return { label, price: priceStr, changeStr: changePctStr, isUp };
  };

  const chipKeys = [
    { key: 'TWSE', label: '加權' },
    { key: 'OTC', label: '櫃買' },
    { key: 'TX', label: '台指期' },
  ];

  // Sector up:down count helper
  const sectorRatio = useMemo(() => {
    if (!sectorsState.data?.sectors) return null;
    let up = 0;
    let down = 0;
    sectorsState.data.sectors.forEach((s) => {
      if (s.change_pct !== null && s.change_pct > 0) up++;
      else if (s.change_pct !== null && s.change_pct < 0) down++;
    });
    return { up, down };
  }, [sectorsState.data]);

  // Institutional total (億)
  const instTotalYi = useMemo(() => {
    if (!institutionalState.data?.latest) return null;
    return (institutionalState.data.latest.total / 1e8).toFixed(1);
  }, [institutionalState.data]);

  // 期現貨指數卡：只留加權、櫃買、台指期
  const twIndices = useMemo(() => {
    const rows = indicesState.data?.indices || [];
    return TW_INDEX_KEYS.map((k) => rows.find((i) => i.key.toUpperCase() === k)).filter(
      (i): i is IndexRow => !!i,
    );
  }, [indicesState.data]);

  // TWSE Index summary row
  const twseIndex = useMemo(() => {
    return indicesState.data?.indices.find((i) => i.key.toUpperCase() === 'TWSE');
  }, [indicesState.data]);

  // Valid stock count for heatmap histogram
  const heatmapValidCount = useMemo(() => {
    if (!heatmapState.data?.stocks) return 0;
    return heatmapState.data.stocks.filter((s) => s.change_pct !== null && s.change_pct !== undefined).length;
  }, [heatmapState.data]);

  return (
    <div className="space-y-5">
      {/* 1. 市場狀態列 (頂條: 5 chips + 資料時間 + 刷新鈕) */}
      <div className="bg-card border border-border rounded-xl px-4 py-2.5 flex items-center justify-between flex-wrap gap-3 shadow-sm">
        <div className="flex items-center gap-2 overflow-x-auto py-0.5 scrollbar-none">
          {chipKeys.map((c) => {
            const chip = getIndexChip(c.key, c.label);
            return (
              <button
                key={c.key}
                onClick={() => {
                  handleTabChange('overview');
                  setTimeout(() => document.getElementById('index-card')?.scrollIntoView({ behavior: 'smooth' }), 50);
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-border/40 transition shrink-0 text-left cursor-pointer"
              >
                <span className="text-xs font-bold text-zinc-300">{chip.label}</span>
                <span className="text-xs font-mono font-bold text-zinc-100">{chip.price}</span>
                <span
                  className={`text-[11px] font-mono font-medium ${
                    chip.isUp ? 'text-bull' : 'text-bear'
                  }`}
                >
                  {chip.changeStr}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {indicesState.data?.as_of && (
            <span className="text-[10px] text-zinc-500 font-mono hidden sm:inline">
              {new Date(indicesState.data.as_of).toLocaleTimeString()}
            </span>
          )}
          {useMock && (
            <span className="text-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-400 px-2 py-0.5 rounded font-mono">
              Mock Mode
            </span>
          )}
          <button
            onClick={() => fetchAllData(true)}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 transition text-zinc-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>
      </div>

      {/* 分頁導覽 */}
      <div className="border-b border-border/80">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {DASHBOARD_TABS.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 橫向閱讀版面（2026-09-27）：每張卡都整行寬、由上往下疊，卡片裡的內容由左往右排；
          每張卡只在自己的分頁出現，排列照 DOM 順序 */}
      <div className="grid grid-cols-1 gap-5">
        {/* ── 盤勢總覽：盤面氣氛 → 期現貨與國際指數 ── */}

        {/* 盤面分析卡 */}
        {activeTab === 'overview' && (
        <OverviewCard
          title="盤面氣氛與關鍵指標"
          icon={<Gauge className="w-5 h-5 text-primary" />}
          caption="極速規則式診斷 · 零 LLM 延遲"
          footer={
            <>
              <span>規則式合成，非投資建議</span>
              {indicesState.data && (
                <span>資料時間: {new Date(indicesState.data.as_of).toLocaleTimeString()}</span>
              )}
            </>
          }
        >
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* 左：儀表＋一句話總結＋訊號 */}
            <div className="lg:col-span-2 flex items-center justify-around gap-3 bg-zinc-950/40 p-3 rounded-xl border border-border/30">
              {/* Semi-circle Gauge */}
              <AtmosphereGauge
                mood={summary.mood}
                stance={summary.stance}
                degraded={summary.degraded}
              />

              {/* Headline & Signals */}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-sm font-bold text-zinc-100 tracking-tight leading-snug">
                  {summary.headline}
                </div>

                <ul className="space-y-1">
                  {summary.signals.map((sig, idx) => {
                    const dotColor =
                      sig.tone === 'bull'
                        ? 'bg-bull'
                        : sig.tone === 'bear'
                        ? 'bg-bear'
                        : 'bg-zinc-500';
                    return (
                      <li key={idx} className="flex items-start gap-1.5 text-xs text-zinc-300">
                        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} mt-1.5 shrink-0`} />
                        <span className="leading-tight text-[11px]">{sig.text}</span>
                      </li>
                    );
                  })}
                  {summary.signals.length === 0 && summary.degraded && (
                    <li className="text-xs text-zinc-500 italic">目前無足夠市場數據合成訊號</li>
                  )}
                </ul>
              </div>
            </div>

            {/* 右：六個關鍵數字（3×2） */}
            <div className="lg:col-span-3 grid grid-cols-3 gap-2 text-center text-xs">
              {/* Cell 1: 大盤漲跌 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">大盤指數</div>
                <div className="text-xs font-bold font-mono text-zinc-100 mt-1">
                  {twseIndex?.price !== undefined && twseIndex.price !== null
                    ? twseIndex.price.toLocaleString(undefined, { minimumFractionDigits: 0 })
                    : '--'}
                </div>
                <div
                  className={`text-[10px] font-mono mt-0.5 ${
                    (twseIndex?.change || 0) >= 0 ? 'text-bull' : 'text-bear'
                  }`}
                >
                  {twseIndex?.change !== undefined && twseIndex.change !== null
                    ? `${twseIndex.change >= 0 ? '+' : ''}${twseIndex.change.toFixed(1)}`
                    : '--'}
                </div>
              </div>

              {/* Cell 2: 漲跌家數 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">漲跌家數 (上市)</div>
                <div className="text-xs font-bold font-mono mt-1 flex items-center justify-center gap-1">
                  <span className="text-bull">
                    {breadthState.data?.advancing !== undefined ? breadthState.data.advancing : '--'}
                  </span>
                  <span className="text-zinc-600">:</span>
                  <span className="text-bear">
                    {breadthState.data?.declining !== undefined ? breadthState.data.declining : '--'}
                  </span>
                </div>
                <div className="text-[9px] text-zinc-500 font-mono mt-0.5">上漲:下跌</div>
              </div>

              {/* Cell 3: 類股漲跌比 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">類股漲跌比</div>
                <div className="text-xs font-bold font-mono mt-1 flex items-center justify-center gap-1">
                  <span className="text-bull">{sectorRatio ? sectorRatio.up : '--'}</span>
                  <span className="text-zinc-600">:</span>
                  <span className="text-bear">{sectorRatio ? sectorRatio.down : '--'}</span>
                </div>
                <div className="text-[9px] text-zinc-500 font-mono mt-0.5">開紅:開綠</div>
              </div>

              {/* Cell 4: 漲停:跌停 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">漲停 : 跌停</div>
                <div className="text-xs font-bold font-mono mt-1 flex items-center justify-center gap-1">
                  <span className="text-rose-400">
                    {breadthState.data?.limit_up !== undefined ? breadthState.data.limit_up : '--'}
                  </span>
                  <span className="text-zinc-600">:</span>
                  <span className="text-emerald-400">
                    {breadthState.data?.limit_down !== undefined ? breadthState.data.limit_down : '--'}
                  </span>
                </div>
                <div className="text-[9px] text-zinc-500 font-mono mt-0.5">極端情緒家數</div>
              </div>

              {/* Cell 5: 三大法人 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">三大法人合計</div>
                <div
                  className={`text-xs font-bold font-mono mt-1 ${
                    instTotalYi !== null && parseFloat(instTotalYi) >= 0
                      ? 'text-bull'
                      : 'text-bear'
                  }`}
                >
                  {instTotalYi !== null
                    ? `${parseFloat(instTotalYi) >= 0 ? '+' : ''}${instTotalYi} 億`
                    : '--'}
                </div>
                <div className="text-[9px] text-zinc-500 font-mono mt-0.5">現貨買賣超</div>
              </div>

              {/* Cell 6: 大盤水位 */}
              <div className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30 flex flex-col justify-center">
                <div className="text-[10px] text-zinc-500">大盤水位 %</div>
                <div className="text-xs font-bold font-mono text-zinc-100 mt-1">
                  {dashboardState.data?.water_level !== undefined &&
                  dashboardState.data?.water_level !== null
                    ? `${(dashboardState.data.water_level * 100).toFixed(0)}%`
                    : '--'}
                </div>
                <div className="text-[9px] text-zinc-500 font-mono mt-0.5">Regime 水位</div>
              </div>
            </div>
          </div>
        </OverviewCard>
        )}

        {/* 期現貨與國際指數（2026-09-27 合併）：上排台股三檔、下排國際六檔 */}
        {activeTab === 'overview' && (
        <OverviewCard
          id="index-card"
          title="期現貨與國際指數"
          icon={<TrendingUp className="w-5 h-5 text-primary" />}
          caption="加權、櫃買、台指期 · 美股三大指數、費城半導體、日經 225、韓國綜合"
        >
          <div className="space-y-5">
            <section>
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="text-xs font-semibold text-zinc-300">台股期現貨</span>
                {indicesState.data && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    資料時間: {new Date(indicesState.data.as_of).toLocaleString()}
                  </span>
                )}
              </div>
              {indicesState.loading || indicesState.error || !indicesState.data ? (
                <SectionStatus loading={indicesState.loading} error={indicesState.error} onRetry={fetchIndices} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {twIndices.map((idx) => (
                    <IndexTile
                      key={idx.key}
                      wide
                      name={idx.name}
                      price={idx.price}
                      change={idx.change}
                      changePct={idx.change_pct}
                      meta={`來源: ${idx.source}`}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="pt-4 border-t border-border/30">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-primary" />
                  國際股市
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  {globalState.data ? `來源: ${globalState.data.source} · ` : ''}時間為台北時間
                </span>
              </div>
              {globalState.loading || globalState.error || !globalState.data ? (
                <SectionStatus
                  loading={globalState.loading}
                  error={globalState.error}
                  onRetry={() => fetchGlobal(true)}
                />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {globalState.data.indices.map((idx) => (
                    <IndexTile
                      key={idx.key}
                      name={idx.name}
                      badge={idx.region}
                      price={idx.price}
                      change={idx.change}
                      changePct={idx.change_pct}
                      meta={
                        idx.ok ? (
                          <>
                            {idx.session === 'open' ? <span className="text-emerald-400">盤中</span> : '收盤'}{' '}
                            {fmtTpeTime(idx.as_of)}
                          </>
                        ) : (
                          <span className="text-amber-400">暫時抓不到</span>
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </OverviewCard>
        )}

        {/* ── 漲跌與熱門：漲跌家數分布 → 強勢／弱勢／熱門 Top15 ── */}
        {activeTab === 'movers' && (
        <OverviewCard
          title="漲跌家數分布直方圖"
          icon={<BarChart3 className="w-5 h-5 text-primary" />}
          caption="上市普通股 1% 級距直條圖與漲跌停 Strip"
          loading={heatmapState.loading}
          error={heatmapState.error}
          onRetry={() => fetchHeatmap(true)}
          footer={
            <>
              <span>資料源：上市普通股快照 (不含 ETF/除權息股)</span>
              {heatmapState.data && <span>有效個股: {heatmapValidCount} 家</span>}
            </>
          }
        >
          <HistogramChart heatmapData={heatmapState.data} />
        </OverviewCard>
        )}

        {/* ── 法人與產業：三大法人 → 產業類股熱力 Top10 ── */}
        {activeTab === 'flows' && (
        <OverviewCard
          title="三大法人現貨資金流向"
          icon={<Users className="w-5 h-5 text-primary" />}
          caption="外資、投信、自營商買賣超與近 10 日趨勢"
          loading={institutionalState.loading}
          error={institutionalState.error}
          onRetry={fetchInstitutional}
          footer={
            institutionalState.data && (
              <>
                <span>來源: {institutionalState.data.source}</span>
                <span>資料日期: {institutionalState.data.date}</span>
              </>
            )
          }
        >
          {institutionalState.data && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* 左：當日買賣超 */}
              <div className="lg:col-span-4 grid grid-cols-2 gap-3 content-start">
                {[
                  { label: '外資與陸資', value: institutionalState.data.latest.foreign },
                  { label: '投信', value: institutionalState.data.latest.investment_trust },
                  { label: '自營商', value: institutionalState.data.latest.dealer },
                ].map((row) => (
                  <div key={row.label} className="bg-zinc-950/40 p-3 rounded-lg border border-border/30 text-center">
                    <div className="text-[10px] text-zinc-500">{row.label}</div>
                    <div className={`text-sm font-bold font-mono mt-1 ${row.value >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {row.value >= 0 ? '+' : ''}
                      {(row.value / 1e8).toFixed(2)} 億
                    </div>
                  </div>
                ))}
                <div className="bg-primary/5 p-3 rounded-lg border border-primary/20 text-center">
                  <div className="text-[10px] text-zinc-400">合計現貨買賣超</div>
                  <div
                    className={`text-sm font-black font-mono mt-1 ${
                      institutionalState.data.latest.total >= 0 ? 'text-bull' : 'text-bear'
                    }`}
                  >
                    {institutionalState.data.latest.total >= 0 ? '+' : ''}
                    {(institutionalState.data.latest.total / 1e8).toFixed(2)} 億
                  </div>
                </div>
              </div>

              {/* 右：近 10 日趨勢 */}
              <div className="lg:col-span-8 min-w-0">
                <div className="text-xs font-semibold text-zinc-300 mb-2">近 10 日三大法人買賣超趨勢</div>
                <InstTrendChart trend={institutionalState.data.trend.slice(-10)} />
              </div>
            </div>
          )}
        </OverviewCard>
        )}

        {/* ── 槓桿與營收：市場槓桿溫度 → 多空寬度 → 上市營收動能 ── */}
        {activeTab === 'credit' && (
        <MarketLeverageCard
          data={creditState.data}
          loading={creditState.loading}
          error={creditState.error}
          onRetry={() => fetchCredit(true)}
        />
        )}

        {activeTab === 'credit' && (
        <OverviewCard
          title="市場多空寬度指標"
          icon={<Activity className="w-5 h-5 text-primary" />}
          caption="站上 20MA / 50MA 個股比例與全市場家數"
          loading={breadthState.loading}
          error={breadthState.error}
          onRetry={fetchBreadth}
          footer={
            breadthState.data && (
              <>
                <span>來源: {breadthState.data.source}</span>
                <span>資料日期: {breadthState.data.date}</span>
              </>
            )
          }
        >
          {breadthState.data && (
            <div className="space-y-4">
              {/* 一排五格：上漲、下跌、平盤、站上 20MA、站上 50MA */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500">上漲家數</div>
                  <div className="text-sm font-bold font-mono text-bull mt-1">{breadthState.data.advancing}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">漲停 {breadthState.data.limit_up}</div>
                </div>
                <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500">下跌家數</div>
                  <div className="text-sm font-bold font-mono text-bear mt-1">{breadthState.data.declining}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">跌停 {breadthState.data.limit_down}</div>
                </div>
                <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500">平盤家數</div>
                  <div className="text-sm font-bold font-mono text-zinc-300 mt-1">{breadthState.data.unchanged}</div>
                </div>
                <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500">站上 20MA 比例</div>
                  <div className="text-sm font-bold font-mono text-zinc-100 mt-1">
                    {(breadthState.data.above_ma20_ratio * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-zinc-950/40 p-3 rounded-lg border border-border/30">
                  <div className="text-[10px] text-zinc-500">站上 50MA 比例</div>
                  <div className="text-sm font-bold font-mono text-zinc-100 mt-1">
                    {(breadthState.data.above_ma50_ratio * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* 漲／平／跌比例條 */}
              <div className="w-full h-3 rounded-full bg-zinc-800 flex overflow-hidden">
                <div
                  className="bg-bull h-full"
                  style={{
                    width: `${(breadthState.data.advancing / (breadthState.data.total || 1)) * 100}%`,
                  }}
                />
                <div
                  className="bg-zinc-600 h-full"
                  style={{
                    width: `${(breadthState.data.unchanged / (breadthState.data.total || 1)) * 100}%`,
                  }}
                />
                <div
                  className="bg-bear h-full"
                  style={{
                    width: `${(breadthState.data.declining / (breadthState.data.total || 1)) * 100}%`,
                  }}
                />
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-zinc-500 font-mono">
                <span>統計範圍 (Universe): {breadthState.data.universe}</span>
                <span>樣本總數 (Sample Size): {breadthState.data.sample_size}</span>
              </div>
            </div>
          )}
        </OverviewCard>
        )}

        {/* 強勢／弱勢／熱門 Top15（漲跌與熱門分頁） */}
        {activeTab === 'movers' && (
        <OverviewCard
          title="強勢／弱勢／熱門 Top15"
          icon={<Flame className="w-5 h-5 text-amber-400" />}
          caption="點選個股列快速進入審查頁面"
          loading={heatmapState.loading}
          error={heatmapState.error}
          onRetry={() => fetchHeatmap(true)}
          footer={
            <>
              <span>快照即時排序 (點選跳轉個股頁)</span>
              {heatmapState.data && <span>更新: {heatmapState.data.date}</span>}
            </>
          }
        >
          <Top15Table stocks={heatmapState.data?.stocks || []} />
        </OverviewCard>
        )}

        {/* 產業熱力 Top10 縮卡（法人與產業分頁） */}
        {activeTab === 'flows' && (
        <OverviewCard
          title="產業類股熱力 (Top 10)"
          icon={<LayoutGrid className="w-5 h-5 text-primary" />}
          caption="市場成交量與漲跌幅產業佈局"
          actions={
            <Link
              to="/heatmap"
              className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              開啟熱力圖 <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          }
          loading={sectorsState.loading}
          error={sectorsState.error}
          onRetry={fetchSectors}
          footer={
            sectorsState.data && (
              <>
                <span>來源: TWSE</span>
                <span>資料日期: {sectorsState.data.date}</span>
              </>
            )
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {sectorsState.data?.sectors
                .slice()
                .sort((a, b) => {
                  if (a.change_pct === null) return 1;
                  if (b.change_pct === null) return -1;
                  return b.change_pct - a.change_pct;
                })
                .slice(0, 10)
                .map((sec) => {
                  const isUp = sec.change_pct !== null && sec.change_pct >= 0;
                  return (
                    <div
                      key={sec.name}
                      onClick={() => navigate('/heatmap')}
                      style={{ backgroundColor: getHeatmapColor(sec.change_pct) }}
                      className="p-2.5 rounded-lg border border-border/10 flex flex-col justify-between transition hover:scale-[1.02] cursor-pointer"
                    >
                      <div className="text-[11px] font-semibold text-white tracking-tight truncate">
                        {sec.name}
                      </div>
                      <div className="mt-2 text-right">
                        <div className="text-xs font-black font-mono text-white">
                          {sec.change_pct !== null
                            ? `${isUp ? '+' : ''}${sec.change_pct.toFixed(2)}%`
                            : '--'}
                        </div>
                        <div className="text-[8px] text-zinc-300 font-mono mt-0.5">
                          {(sec.turnover / 1e8).toFixed(1)} 億
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </OverviewCard>
        )}

        {/* 上市營收動能（槓桿與營收分頁，排在寬度卡下面） */}
        {activeTab === 'credit' && (
        <RevenueOverviewCard
          data={revenueState.data}
          loading={revenueState.loading}
          error={revenueState.error}
          onRetry={() => fetchRevenue(true)}
        />
        )}
      </div>
    </div>
  );
};
