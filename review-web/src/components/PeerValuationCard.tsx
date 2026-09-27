import React from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import type { PeerValuationState } from '../lib/usePeerValuation';
import { fmtMetric } from '../lib/peerValuation';
import type { FairValue, MetricRank } from '../lib/peerValuation';

const fmtPrice = (v: number) =>
  v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(1) : v.toFixed(2);

const gapText = (g: number) => (g >= 0 ? `現價低於合理價 ${g.toFixed(1)}%` : `現價高於合理價 ${Math.abs(g).toFixed(1)}%`);

/** 區間條：同業 25～75 百分位推出的價格帶＋合理價刻度＋現價 */
const RangeBar: React.FC<{ fv: FairValue; price: number | null }> = ({ fv, price }) => {
  const pts = [fv.low, fv.high, fv.fair, ...(price ? [price] : [])];
  const min = Math.min(...pts) * 0.92;
  const max = Math.max(...pts) * 1.08;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className="relative h-7 mt-2" aria-hidden>
      <div className="absolute top-3 left-0 right-0 h-1 rounded-full bg-zinc-800" />
      <div className="absolute top-2.5 h-2 rounded-full bg-primary/30 border border-primary/40" style={{ left: pos(fv.low), width: `calc(${pos(fv.high)} - ${pos(fv.low)})` }} />
      <div className="absolute top-1.5 w-0.5 h-4 bg-primary" style={{ left: pos(fv.fair) }} />
      {price !== null && (
        <div className="absolute top-0 -translate-x-1/2 flex flex-col items-center" style={{ left: pos(price) }}>
          <div className="w-2.5 h-2.5 rotate-45 bg-amber-400 border border-amber-200/60 mt-1.5" />
        </div>
      )}
    </div>
  );
};

const FairTile: React.FC<{ title: string; fv: FairValue | null; reason: string | null; price: number | null; baseLabel: string; multipleLabel: string }> = ({
  title, fv, reason, price, baseLabel, multipleLabel,
}) => (
  <div className="p-3.5 rounded-xl bg-zinc-950/40 border border-border/40 min-w-0">
    <div className="text-[11px] text-zinc-500 font-medium">{title}</div>
    {fv ? (
      <>
        <div className="flex items-baseline gap-2 flex-wrap mt-1">
          <span className="text-xl font-bold font-mono text-zinc-100">{fmtPrice(fv.fair)}</span>
          <span className="text-[11px] font-mono text-zinc-500">區間 {fmtPrice(fv.low)}～{fmtPrice(fv.high)}</span>
        </div>
        {fv.gapPct !== null && (
          <div className={`text-xs font-semibold mt-0.5 ${fv.gapPct >= 0 ? 'text-bull' : 'text-bear'}`}>{gapText(fv.gapPct)}</div>
        )}
        <RangeBar fv={fv} price={price} />
        <div className="text-[10px] text-zinc-500 leading-relaxed">
          同業{multipleLabel}中位數 <span className="font-mono text-zinc-300">{fv.median.toFixed(1)} 倍</span> × {baseLabel}{' '}
          <span className="font-mono text-zinc-300">{fv.base.toFixed(2)} 元</span>
          <span className="text-zinc-600">（{fv.peers} 檔同業，區間＝25～75 百分位 {fv.p25.toFixed(1)}～{fv.p75.toFixed(1)} 倍）</span>
        </div>
      </>
    ) : (
      <div className="text-xs text-zinc-500 mt-2 leading-relaxed">{reason ?? '—'}</div>
    )}
  </div>
);

/** 百分位條：依名次排位置（不受極端值影響），本股放大標色，中間刻度＝中位數 */
const RankRow: React.FC<{ r: MetricRank }> = ({ r }) => {
  const n = r.sorted.length;
  const pos = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  // 左邊＝排名後段、右邊＝排名前段：本益比低者較前，所以本益比的條要反過來畫
  const place = (i: number) => (r.def.order === 'low' ? 100 - pos(i) : pos(i));
  const rankText = r.rank === null ? '—' : `第 ${r.rank} / ${r.total}${r.def.order === 'low' ? ' 低' : ' 高'}`;
  const top = r.rank !== null && r.total >= 3 && r.rank <= Math.max(1, Math.ceil(r.total * 0.25));
  return (
    <li className="grid grid-cols-[5.5rem_1fr] sm:grid-cols-[6.5rem_5.5rem_1fr_6.5rem] items-center gap-x-3 gap-y-1 py-2 border-b border-border/30 last:border-0">
      <span className="text-xs text-zinc-300 font-medium" title={r.def.hint}>{r.def.label}</span>
      <span className="font-mono text-sm font-bold text-zinc-100 text-right sm:text-left">{fmtMetric(r.def, r.own)}</span>
      <div className="relative h-4 col-span-2 sm:col-span-1" aria-hidden>
        <div className="absolute top-1.5 left-0 right-0 h-1 rounded-full bg-gradient-to-r from-zinc-800 via-zinc-700 to-primary/40" />
        <div className="absolute top-0.5 left-1/2 w-px h-3 bg-zinc-500" />
        {r.sorted.map((s, i) => (
          <div
            key={s.code}
            title={`${s.name}（${s.code}）${fmtMetric(r.def, s.value)}`}
            className={`absolute -translate-x-1/2 rounded-full ${s.isSelf ? 'top-0 w-4 h-4 bg-amber-400 border-2 border-amber-100/70 z-10' : 'top-1 w-2 h-2 bg-zinc-400/70'}`}
            style={{ left: `${place(i)}%` }}
          />
        ))}
      </div>
      <span className={`text-[11px] font-mono text-right col-span-2 sm:col-span-1 ${top ? 'text-amber-300 font-semibold' : 'text-zinc-400'}`}>
        {rankText}
        <span className="text-zinc-600 font-sans ml-1.5 sm:block sm:ml-0">中位 {fmtMetric(r.def, r.median)}</span>
      </span>
    </li>
  );
};

export const PeerValuationCard: React.FC<{ state: PeerValuationState }> = ({ state }) => {
  const { data, meta, loading, error, unsupported } = state;
  if (unsupported) return null;

  const header = (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3 mb-4 flex-wrap">
      <div className="flex items-center gap-2">
        <Scale className="w-5 h-5 text-primary" />
        <h3 className="font-semibold text-sm text-zinc-200">合理價與同業排名</h3>
      </div>
      {data && (
        <span className="text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
          {data.scope === 'group' ? (
            <Link to={`/heatmap/group/${encodeURIComponent(data.group)}`} className="hover:underline">同業：{data.group}・{data.rows.length} 檔</Link>
          ) : (
            <>族群「{data.group}」同業不足，改用大類「{data.category}」{data.rows.length} 檔</>
          )}
        </span>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
        {header}
        <div className="text-xs text-zinc-500 animate-pulse text-center py-10">載入同業估值中…</div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
        {header}
        <div className="text-xs text-zinc-500 text-center py-8">
          {error ? `同業估值暫時抓不到：${error}` : '證交所估值表沒有這一檔（上櫃、ETF 或剛上市），不估合理價'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 sm:p-6 space-y-5">
      {header}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FairTile title="本益比法合理價" fv={data.pe} reason={data.peReason} price={data.price} baseLabel="近四季 EPS" multipleLabel="本益比" />
        <FairTile title="淨值比法合理價" fv={data.pb} reason={data.pbReason} price={data.price} baseLabel="每股淨值" multipleLabel="淨值比" />
      </div>
      {data.price !== null && (data.pe || data.pb) && (
        <div className="flex items-center gap-3 text-[10px] text-zinc-500 flex-wrap -mt-2">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rotate-45 bg-amber-400" />現價 {fmtPrice(data.price)}</span>
          <span className="flex items-center gap-1"><span className="inline-block w-0.5 h-3 bg-primary" />合理價</span>
          <span className="flex items-center gap-1"><span className="inline-block w-4 h-2 rounded-full bg-primary/30 border border-primary/40" />同業 25～75 百分位推出的區間</span>
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-semibold text-zinc-300">同業排名</h4>
          <span className="text-[10px] text-zinc-500">越右邊排名越前面・黃點＝本股・中線＝中位數</span>
        </div>
        <ul>
          {/* 整個同業圈都沒有的指標（例：金融業沒有毛利率）直接不列 */}
          {data.ranks.filter((r) => r.total > 0).map((r) => <RankRow key={r.def.key} r={r} />)}
        </ul>
      </div>

      <div className="text-[10px] text-zinc-500 leading-relaxed pt-3 border-t border-border/40">
        資料：證交所個股本益比／淨值比／殖利率（{meta?.date ?? '—'}，本益比用近四季 EPS）、營益分析（{meta?.margin_period ?? '—'} 今年累計）、
        月營收（{meta?.revenue_month ?? '—'}）、成交值（最近交易日）。合理價是拿同業倍數套在本股上的參考值，不是目標價；
        高成長、景氣循環、剛轉虧為盈的公司，本益比法容易失真，要跟淨值比法、營收趨勢一起看。
      </div>
    </div>
  );
};
