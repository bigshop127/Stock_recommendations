import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Factory } from 'lucide-react';
import { api, type RevenueCompanyResp } from '../lib/api';
import { fmtPct, fmtPp, fmtRevenue, monthLabel, toneClass, topPercent } from '../lib/marketRevenue';

/**
 * 個股頁「產業分析」分頁：本公司月營收 vs 所屬官方產業（同市場）。
 * ETF、存託憑證、尚未申報的公司查不到（404）——那就整張不顯示，不擋分頁其他內容。
 */
export const RevenueVsIndustryCard: React.FC<{ code: string }> = ({ code }) => {
  // 結果綁著代號存：切到別檔時舊結果自動不算數（顯示載入中），不用在 effect 裡先清空
  const [result, setResult] = useState<{ code: string; data: RevenueCompanyResp | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getRevenueCompany(code)
      .then((resp) => { if (!cancelled) setResult({ code, data: resp }); })
      // 404（ETF 等）或暫時連不上：不顯示這張卡
      .catch(() => { if (!cancelled) setResult({ code, data: null }); });
    return () => { cancelled = true; };
  }, [code]);

  if (!result || result.code !== code) {
    return <div className="bg-card border border-border rounded-xl p-6 h-40 animate-pulse" />;
  }
  const data = result.data;
  if (!data) return null;

  const c = data.company;
  const ind = data.industry;
  const marketLabel = c.market === 'otc' ? '上櫃' : '上市';
  const share = ind && c.revenue !== null && ind.revenue > 0 ? (c.revenue / ind.revenue) * 100 : null;

  const rows: { label: string; self: number | null; peer: number | null }[] = [
    { label: '年增率', self: c.yoy_pct, peer: ind?.yoy_pct ?? null },
    { label: '月增率', self: c.mom_pct, peer: ind?.mom_pct ?? null },
    { label: '累計年增', self: c.cum_yoy_pct, peer: ind?.cum_yoy_pct ?? null },
  ];

  return (
    <div className="bg-card border border-border rounded-xl p-6">
      <div className="flex items-center justify-between border-b border-border/60 pb-3 mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Factory className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-sm text-zinc-200">月營收動能 vs 所屬產業</h3>
          <span className="text-[11px] text-zinc-500">{monthLabel(c.month)}（{c.month}）</span>
        </div>
        {ind && (
          <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-primary/10 text-primary border border-primary/20">
            官方產業：{ind.name}・{marketLabel} {ind.count} 家
          </span>
        )}
      </div>

      {!c.current && (
        <div className="mb-3 text-[11px] text-amber-400">
          這家公司最新申報的是 {c.month}，產業其他公司已經到 {data.month}，下表先不比較。
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 border-b border-border/60">
              <th className="text-left font-semibold pb-2">項目</th>
              <th className="text-right font-semibold pb-2">本公司</th>
              <th className="text-right font-semibold pb-2">產業整體</th>
              <th className="text-right font-semibold pb-2">差距</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => {
              const diff = c.current && r.self !== null && r.peer !== null ? r.self - r.peer : null;
              return (
                <tr key={r.label} className="border-b border-border/30 last:border-0">
                  <td className="py-2.5 text-zinc-300 font-sans">{r.label}</td>
                  <td className={`py-2.5 text-right font-bold ${toneClass(r.self)}`}>{fmtPct(r.self)}</td>
                  <td className={`py-2.5 text-right ${toneClass(r.peer)}`}>{c.current ? fmtPct(r.peer) : '—'}</td>
                  <td className="py-2.5 text-right">
                    {diff === null ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span className={diff >= 0 ? 'text-bull' : 'text-bear'}>
                        {diff >= 0 ? '贏 ' : '輸 '}{fmtPp(diff)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 space-y-1.5 text-xs text-zinc-400 leading-relaxed">
        <div>
          本月營收 <strong className="font-mono text-zinc-200">{fmtRevenue(c.revenue)}</strong>
          {share !== null && <>，占產業 <strong className="font-mono text-zinc-200">{share < 0.1 ? '<0.1' : share.toFixed(1)}%</strong></>}
          {data.rank && c.current && (
            <>
              ；年增率在同產業 {data.rank.of} 家中排第 <strong className="font-mono text-zinc-200">{data.rank.rank}</strong>
              <span className="text-zinc-500">（{topPercent(data.rank.rank, data.rank.of)}）</span>
            </>
          )}
        </div>
        {c.note && <div className="text-zinc-500">公司申報的增減原因：{c.note}</div>}
      </div>

      <div className="mt-4 pt-3 border-t border-border/30 flex items-center justify-between flex-wrap gap-2 text-[10px] text-zinc-500">
        <span>
          來源：證交所／櫃買每月營業收入彙總表{data.published ? `（${data.published} 出表）` : ''}；產業是官方現行分類，跟下方同儕表的產業分類不同。
          {data.stale && <span className="text-amber-400 ml-1">暫時連不上，顯示上一份</span>}
        </span>
        {ind && c.market === 'listed' && (
          <Link to={`/heatmap?view=revenue&industry=${encodeURIComponent(ind.name as string)}`} className="text-primary hover:underline text-xs">
            看「{ind.name}」營收明細 →
          </Link>
        )}
      </div>
    </div>
  );
};
