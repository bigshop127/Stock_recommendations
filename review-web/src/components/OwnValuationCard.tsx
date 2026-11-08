// 合理價（opt53）：營收推估未來四季 EPS × 自身近 3 年本益比（或淨值比 × 每股淨值）。算法見 lib/ownValuation.ts。
import React from 'react';
import { Target } from 'lucide-react';
import type { OwnValuation, OwnValuationResult, PriceBand } from '../lib/ownValuation';
import { ZONE_LABEL, vsFairText } from '../lib/ownValuation';

const fmtValPrice = (v: number) =>
  v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(1) : v.toFixed(2);
const fmtYi = (v: number) => `${Math.round(v / 1e8).toLocaleString()} 億`;
const fmtYm = (iso: string | null) => (iso ? iso.slice(0, 7).replace('-', '/') : '—');
const monthNo = (ym: string) => Number(ym.slice(5, 7));

/** 便宜～昂貴的價格帶＋合理價刻度＋現價菱形 */
const ZoneBar: React.FC<{ prices: PriceBand; price: number | null }> = ({ prices, price }) => {
  const pts = [prices.cheap, prices.expensive, ...(price ? [price] : [])];
  const min = Math.min(...pts) * 0.92;
  const max = Math.max(...pts) * 1.06;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className="relative h-7 mt-2" aria-hidden>
      <div className="absolute top-3 left-0 right-0 h-1 rounded-full bg-zinc-800" />
      <div
        className="absolute top-2.5 h-2 rounded-l-full bg-red-500/25 border border-red-500/30"
        style={{ left: pos(prices.cheap), width: `calc(${pos(prices.fair)} - ${pos(prices.cheap)})` }}
      />
      <div
        className="absolute top-2.5 h-2 rounded-r-full bg-emerald-500/20 border border-emerald-500/30"
        style={{ left: pos(prices.fair), width: `calc(${pos(prices.expensive)} - ${pos(prices.fair)})` }}
      />
      <div className="absolute top-1.5 w-0.5 h-4 bg-primary" style={{ left: pos(prices.fair) }} />
      {price !== null && (
        <div className="absolute top-0 -translate-x-1/2" style={{ left: pos(price) }}>
          <div className="w-2.5 h-2.5 rotate-45 bg-amber-400 border border-amber-200/60 mt-1.5" />
        </div>
      )}
    </div>
  );
};

const PriceTriple: React.FC<{ prices: PriceBand; className?: string }> = ({ prices, className = '' }) => (
  <span className={`font-mono ${className}`}>
    <span className="text-zinc-500 font-sans">便宜</span> {fmtValPrice(prices.cheap)}
    <span className="text-zinc-600"> ・ </span>
    <span className="text-zinc-500 font-sans">合理</span> {fmtValPrice(prices.fair)}
    <span className="text-zinc-600"> ・ </span>
    <span className="text-zinc-500 font-sans">昂貴</span> {fmtValPrice(prices.expensive)}
  </span>
);

const Basis: React.FC<{ v: OwnValuation }> = ({ v }) => {
  const multiple = v.method === 'pe' ? '本益比' : '淨值比';
  const band = `${v.band.p25.toFixed(1)}／${v.band.p50.toFixed(1)}／${v.band.p75.toFixed(1)} 倍`;
  return (
    <div className="space-y-1.5 text-[11px] text-zinc-400 leading-relaxed">
      <div>
        {v.method === 'pe' ? '推估未來四季 EPS' : '每股淨值'}{' '}
        <span className="font-mono text-zinc-200">{v.base.toFixed(2)} 元</span> × 自身近 {v.years} 年{multiple} 25／50／75 百分位{' '}
        <span className="font-mono text-zinc-200">{band}</span>
        <span className="text-zinc-600">
          （{fmtYm(v.bandStart)}～{fmtYm(v.bandEnd)}，{v.band.n} 個交易日）
        </span>
      </div>
      {v.forward && (
        <div className="text-zinc-500">
          推估 EPS ＝ {v.forward.quarter} EPS <span className="font-mono text-zinc-300">{v.forward.quarterEps.toFixed(2)}</span> × 4 ×
          最近 3 個月營收（{monthNo(v.forward.months[0])}～{monthNo(v.forward.months[2])} 月{' '}
          <span className="font-mono text-zinc-300">{fmtYi(v.forward.revenue3m)}</span>）÷ {v.forward.quarter.slice(5)} 營收（
          <span className="font-mono text-zinc-300">{fmtYi(v.forward.quarterRevenue)}</span>）
          <span className="text-zinc-600">
            ，營收比 {v.forward.quarter.slice(5)} {v.forward.growthPct >= 0 ? '多' : '少'} {Math.abs(v.forward.growthPct).toFixed(1)}%
          </span>
        </div>
      )}
      {v.conservative && (
        <div className="text-zinc-500">
          保守參考（營收不再成長，用近四季實際 EPS <span className="font-mono text-zinc-300">{v.conservative.eps.toFixed(2)}</span>）：
          <PriceTriple prices={v.conservative.prices} className="text-zinc-300" />
        </div>
      )}
    </div>
  );
};

export const OwnValuationCard: React.FC<{
  result: OwnValuationResult | null;
  loading: boolean;
}> = ({ result, loading }) => {
  const v = result && result.ok ? result.v : null;
  const gap = v && v.price ? vsFairText(v.price, v.prices.fair) : null;
  return (
    <div className="bg-card border border-border rounded-xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap border-b border-border/60 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-sm text-zinc-200">合理價（跟自己過去 3 年比）</h3>
        </div>
        {v && (
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
            {v.method === 'pe' ? '本益比法・看未來 EPS' : '淨值比法'}
          </span>
        )}
      </div>

      {loading && !result ? (
        <div className="h-28 rounded-lg bg-zinc-900/50 animate-pulse" />
      ) : !result ? null : !result.ok ? (
        <div className="text-xs text-zinc-500 leading-relaxed">{result.reason}</div>
      ) : (
        <div className="space-y-3">
          {v!.switchReason && (
            <div className="text-[11px] text-amber-300/90">改用淨值比：{v!.switchReason}</div>
          )}
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[11px] text-zinc-500">合理價</div>
              <div className="text-2xl font-bold font-mono text-zinc-100 leading-tight">{fmtValPrice(v!.prices.fair)}</div>
            </div>
            <div className="text-right">
              {v!.zone && (
                <div className="text-xs text-zinc-300">
                  現價 <span className="font-mono">{fmtValPrice(v!.price!)}</span> 落在「{ZONE_LABEL[v!.zone]}」
                </div>
              )}
              {gap && (
                <div className={`text-xs font-semibold mt-0.5 ${gap.cheap ? 'text-bull' : 'text-bear'}`}>{gap.text}</div>
              )}
            </div>
          </div>
          <div>
            <ZoneBar prices={v!.prices} price={v!.price} />
            <div className="text-xs">
              <PriceTriple prices={v!.prices} className="text-zinc-200" />
            </div>
          </div>
          <Basis v={v!} />
          <div className="text-[10px] text-zinc-600 leading-relaxed border-t border-border/40 pt-2">
            本益比、淨值比是證交所口徑（近四季）。推估假設營收維持最近 3 個月的水準、獲利率維持最近一季；
            金融股、近 3 年虧損過或本益比忽高忽低的改用淨值比。這是參考區間，不是目標價；同業對照見下方。
          </div>
        </div>
      )}
    </div>
  );
};
