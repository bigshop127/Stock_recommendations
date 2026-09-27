// 一鍵匯出戰情卡（opt45，仿 5888「股票戰情卡」直式海報）：把個股頁已經算好的東西排成一張圖。
// 刻意不放參考圖裡寫死的「劇本機率」與每檔都一樣的罐頭「催化劑／風險」——只放算得出來的數字。
import React, { useMemo, useRef, useState } from 'react';
import { X, Download, Share2, Loader2 } from 'lucide-react';
import type { OhlcvRow } from '../lib/api';
import type { KeyLevels } from '../lib/keyLevels';
import { LEVEL_COLORS, fmtLevel } from '../lib/keyLevels';
import type { Highlight } from '../lib/stockHighlights';
import type { PeerValuation } from '../lib/peerValuation';
import type { StockBrief } from '../lib/stockBrief';
import { cardMetrics } from '../lib/folderCards';
import { computePlan, defaultBatches, fmtShares, loadPlanSettings } from '../lib/positionPlan';
import { CODE_TO_GROUP } from '../lib/stockGroups';
import { MiniCandles } from './MiniCandles';

export interface PosterProps {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  highlights: Highlight[];
  levels: KeyLevels | null;
  dailyRows: OhlcvRow[] | null;
  peer: PeerValuation | null;
  peerLoading: boolean;
  brief: StockBrief;
  onClose: () => void;
}

const POSTER_W = 540;
const TAG_TONE: Record<Highlight['tone'], string> = {
  bull: 'bg-red-500/15 text-red-300 border-red-500/40',
  bear: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  info: 'bg-zinc-800 text-zinc-300 border-zinc-700',
};
const signed = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const upDown = (v: number | null) => (v === null ? 'text-zinc-300' : v >= 0 ? 'text-red-400' : 'text-emerald-400');
const tpeNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

const Section: React.FC<{ title: string; children: React.ReactNode; right?: React.ReactNode }> = ({ title, children, right }) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
    <div className="flex items-baseline justify-between mb-2">
      <div className="text-[12px] font-bold text-zinc-200 tracking-wide">{title}</div>
      {right && <div className="text-[10px] text-zinc-500">{right}</div>}
    </div>
    {children}
  </div>
);

/** 海報本體：固定 540px 寬，匯出時 ×2 → 1080px */
const Poster = React.forwardRef<HTMLDivElement, Omit<PosterProps, 'onClose' | 'peerLoading'>>(
  ({ code, name, price, changePct, highlights, levels, dailyRows, peer, brief }, ref) => {
    const metrics = useMemo(() => cardMetrics(dailyRows, null), [dailyRows]);
    const plan = useMemo(() => (levels ? computePlan(levels, defaultBatches(levels), loadPlanSettings()) : null), [levels]);
    const group = CODE_TO_GROUP.get(code);
    const chartLevels = (levels?.zones ?? [])
      .filter((z) => z.label === '壓力一' || z.label === '短撐' || z.label === '守門')
      .map((z) => ({ price: z.kind === 'resistance' ? z.low : z.high, color: LEVEL_COLORS[z.kind], width: z.label === '守門' ? 2 : 1 }));
    const px = price ?? metrics.close;
    const chg = changePct ?? metrics.changePct;
    const fair = peer?.pe ?? peer?.pb ?? null;
    const plus = brief.plus.slice(0, 2);
    const minus = brief.minus.slice(0, 2);

    return (
      <div ref={ref} style={{ width: POSTER_W, backgroundColor: '#09090b' }} className="text-zinc-100 p-5 space-y-3 font-sans">
        <div className="flex items-center justify-between text-[10px] text-zinc-500">
          <span className="font-semibold tracking-widest text-sky-400">個股戰情卡</span>
          <span>個股全面審視網・{tpeNow()}</span>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-black leading-none">{name}</span>
              <span className="text-sm text-zinc-400 font-mono">{code}</span>
            </div>
            {group && <div className="text-[11px] text-sky-300 mt-1">{group.category}／{group.group}</div>}
          </div>
          <div className="text-right shrink-0">
            <div className={`text-[26px] font-black font-mono leading-none ${upDown(chg)}`}>{px !== null ? fmtLevel(px) : '—'}</div>
            {chg !== null && <div className={`text-xs font-mono mt-1 ${upDown(chg)}`}>{signed(chg, 2)}</div>}
          </div>
        </div>

        {highlights.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {highlights.slice(0, 6).map((h) => (
              <span key={h.key} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${TAG_TONE[h.tone]}`}>{h.text}</span>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-2 pt-2 pb-1">
          <MiniCandles bars={metrics.bars} ma20={metrics.ma20} levels={chartLevels} height={150} />
          <div className="flex gap-3 text-[9px] text-zinc-500 px-1 pt-1">
            <span>近 {metrics.bars.length} 日還原日 K</span>
            <span className="text-amber-400">— 月線</span>
            <span style={{ color: LEVEL_COLORS.resistance }}>┄ 壓力一</span>
            <span style={{ color: LEVEL_COLORS.support }}>┄ 短撐／守門</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Section title="關鍵價位" right={levels?.atr ? `ATR ${fmtLevel(levels.atr)}（${levels.atrPct?.toFixed(1)}%）` : undefined}>
            {levels ? (
              <ul className="space-y-1">
                {levels.zones.map((z) => (
                  <li key={z.label} className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold" style={{ color: LEVEL_COLORS[z.kind] }}>{z.label}</span>
                    <span className="font-mono text-zinc-200">{fmtLevel(z.kind === 'resistance' ? z.low : z.high)}</span>
                    <span className="font-mono text-zinc-500 w-12 text-right">{signed(z.distancePct)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-zinc-500">日 K 不足</div>
            )}
          </Section>

          <Section title="合理價" right={peer ? `同業：${peer.scopeName}` : undefined}>
            {fair ? (
              <div className="space-y-1">
                <div className="text-xl font-black font-mono">{fmtLevel(fair.fair)}</div>
                <div className="text-[10px] text-zinc-500 font-mono">區間 {fmtLevel(fair.low)}～{fmtLevel(fair.high)}</div>
                {fair.gapPct !== null && (
                  <div className={`text-[11px] font-semibold ${fair.gapPct >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {fair.gapPct >= 0 ? `現價低於合理價 ${fair.gapPct.toFixed(1)}%` : `現價高於合理價 ${Math.abs(fair.gapPct).toFixed(1)}%`}
                  </div>
                )}
                <div className="text-[9px] text-zinc-500">
                  {fair.method === 'pe' ? '同業本益比中位數' : '同業淨值比中位數'} {fair.median.toFixed(1)} 倍 × {fair.method === 'pe' ? 'EPS' : '每股淨值'} {fair.base.toFixed(2)}
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-zinc-500 leading-relaxed">{peer ? peer.peReason ?? '無法估算' : '上櫃、ETF 或同業資料不足，不估'}</div>
            )}
          </Section>
        </div>

        <Section title="研究摘要" right={brief.overall !== null ? `綜合 ${Math.round(brief.overall)} 分・${brief.stateLabel}` : brief.stateLabel}>
          <div className="text-[11px] text-zinc-300 mb-1.5 leading-relaxed">{brief.headline}</div>
          <div className="grid grid-cols-2 gap-2 text-[10.5px] leading-snug">
            <ul className="space-y-1">
              {plus.length ? plus.map((b) => <li key={b.text} className="text-red-300">＋ {b.text}</li>) : <li className="text-zinc-600">（無明顯加分）</li>}
            </ul>
            <ul className="space-y-1">
              {minus.length ? minus.map((b) => <li key={b.text} className="text-emerald-300">－ {b.text}</li>) : <li className="text-zinc-600">（無明顯扣分）</li>}
            </ul>
          </div>
        </Section>

        {plan && plan.totalShares > 0 && (
          <Section title="建倉計畫" right={`停損虧損上限 ${Math.round(loadPlanSettings().maxLoss).toLocaleString()} 元`}>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono">
              {plan.batches.filter((b) => !b.skipped && b.shares > 0).map((b) => (
                <span key={b.label}><span className="text-zinc-500 font-sans">{b.label}</span> {fmtLevel(b.price)}・{fmtShares(b.shares)}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mt-1.5">
              <span><span className="text-zinc-500">停損</span> <span className="font-mono text-teal-300">{fmtLevel(plan.stop)}</span></span>
              {plan.avgCost !== null && <span><span className="text-zinc-500">均價</span> <span className="font-mono">{fmtLevel(plan.avgCost)}</span></span>}
              {plan.targets.map((t) => (
                <span key={t.label}>
                  <span className="text-zinc-500">{t.label}</span> <span className="font-mono text-orange-300">{fmtLevel(t.price)}</span>
                  {t.rMultiple !== null && <span className="text-zinc-500 font-mono">（{t.rMultiple.toFixed(1)}R）</span>}
                </span>
              ))}
            </div>
          </Section>
        )}

        <div className="text-[9px] text-zinc-600 leading-relaxed pt-1 border-t border-zinc-800">
          資料：還原日 K {levels?.date ?? metrics.date ?? '—'}；合理價用證交所本益比／淨值比與細分族群同業；摘要與價位皆由規則計算。
          僅供個人研究參考，不構成投資建議。
        </div>
      </div>
    );
  },
);
Poster.displayName = 'Poster';

export const StockPosterModal: React.FC<PosterProps> = (props) => {
  const { onClose, peerLoading, code, name } = props;
  const posterRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'download' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const zoom = Math.min(1, (typeof window !== 'undefined' ? window.innerWidth - 32 : POSTER_W) / POSTER_W);
  const canShareFiles = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

  const render = async (): Promise<Blob> => {
    const node = posterRef.current;
    if (!node) throw new Error('海報還沒準備好');
    // 匯出時暫時拿掉預覽縮放，免得輸出也被縮小
    setExporting(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const { toBlob } = await import('html-to-image');
      const blob = await toBlob(node, { pixelRatio: 2, backgroundColor: '#09090b', cacheBust: true });
      if (!blob) throw new Error('轉成圖片失敗');
      return blob;
    } finally {
      setExporting(false);
    }
  };

  const fileName = `${code}_${name}_戰情卡_${tpeNow().slice(0, 10)}.png`;

  const download = async () => {
    setBusy('download');
    setError(null);
    try {
      const blob = await render();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    setBusy('share');
    setError(null);
    try {
      const blob = await render();
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `${name}（${code}）戰情卡` });
      } else {
        throw new Error('這個瀏覽器不支援直接分享圖片，請改用下載');
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/75 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="w-full max-w-[580px] space-y-3 my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-semibold text-zinc-200">匯出戰情卡</div>
          <div className="flex items-center gap-2">
            {canShareFiles && (
              <button
                type="button"
                onClick={share}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-800 text-zinc-200 border border-border hover:bg-zinc-700 disabled:opacity-50"
              >
                {busy === 'share' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}分享
              </button>
            )}
            <button
              type="button"
              onClick={download}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {busy === 'download' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}下載 PNG
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800" aria-label="關閉">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {peerLoading && <div className="text-[11px] text-zinc-500">同業估值載入中，合理價稍後補上…</div>}
        {error && <div className="text-[11px] text-red-400">{error}</div>}
        <div className="rounded-xl overflow-hidden border border-zinc-800 w-fit mx-auto" style={{ zoom: exporting ? 1 : zoom }}>
          <Poster
            ref={posterRef}
            code={props.code}
            name={props.name}
            price={props.price}
            changePct={props.changePct}
            highlights={props.highlights}
            levels={props.levels}
            dailyRows={props.dailyRows}
            peer={props.peer}
            brief={props.brief}
          />
        </div>
        <p className="text-[10px] text-zinc-500 text-center">輸出 1080 px 寬的 PNG；建倉計畫用你在技術分析分頁設定的可承受虧損。</p>
      </div>
    </div>
  );
};
