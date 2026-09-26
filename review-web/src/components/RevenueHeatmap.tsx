import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { api, type MarketRevenueResp, type RevenueAggregate, type RevenueIndustryResp } from '../lib/api';
import { squarify, type TreemapInput } from '../lib/treemap';
import { MiniTrendChart } from './MiniTrendChart';
import { GroupTag } from './GroupTag';
import {
  compactRevenueAxis,
  divergingColor,
  fmtPct,
  fmtRevenue,
  revenueTreemapInputs,
  sortCompanies,
  toneClass,
  type CompanySortKey,
} from '../lib/marketRevenue';

const CANVAS_W = 1000;
const CANVAS_H = 640;
// 營收年增率動輒 ±50%，色階到 ±50% 才最深（股價漲跌那幾個檢視是 ±5%）
const SATURATION = 50;

const errMsg = (err: unknown, fallback: string) => (err instanceof Error && err.message) || fallback;

interface RevenueHeatmapProps {
  /** 上方的檢視切換鈕（族群／個股／產業聚合／產業營收），由熱力圖頁傳進來 */
  viewToggle: React.ReactNode;
}

/**
 * 熱力圖「產業營收」檢視：證交所官方 32 個產業，格子大小＝當月營收、顏色＝年增率。
 * 點產業在下方展開明細（12 個月趨勢＋成分公司），選到的產業寫進網址 ?industry=。
 */
export const RevenueHeatmap: React.FC<RevenueHeatmapProps> = ({ viewToggle }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('industry') || '';

  const [data, setData] = useState<MarketRevenueResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<TreemapInput<RevenueAggregate> | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // 明細綁著產業名存：換產業時舊的自動不算數，不用在 effect 裡先清空
  const [detailState, setDetailState] = useState<{ name: string; data: RevenueIndustryResp | null; error: string | null } | null>(null);
  const [sortKey, setSortKey] = useState<CompanySortKey>('revenue');
  const [showAll, setShowAll] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // 明細載完要捲過去；但從網址直接帶產業進來時，明細可能比熱力圖主資料先到（面板還沒畫），
  // 所以只先記下「要捲」，等面板真的出現再捲
  const scrollPending = useRef(false);

  const fetchRevenue = useCallback(
    (force: boolean) =>
      api.getMarketRevenue(force)
        .then((d) => { setData(d); setError(null); })
        .catch((err) => setError(errMsg(err, '無法取得月營收資料')))
        .finally(() => setLoading(false)),
    [],
  );

  // 重新整理鈕（事件裡可以先把 loading 打開）
  const load = (force = false) => {
    setLoading(true);
    return fetchRevenue(force);
  };

  useEffect(() => {
    fetchRevenue(false);
  }, [fetchRevenue]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api.getRevenueIndustry(selected)
      .then((resp) => {
        if (cancelled) return;
        setDetailState({ name: selected, data: resp, error: null });
        scrollPending.current = true;
      })
      .catch((err) => {
        if (!cancelled) setDetailState({ name: selected, data: null, error: errMsg(err, '無法取得產業明細') });
      });
    return () => { cancelled = true; };
  }, [selected]);

  useEffect(() => {
    if (!scrollPending.current || !data || !detailState?.data || !detailRef.current) return;
    scrollPending.current = false;
    detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [data, detailState]);

  const current = detailState && detailState.name === selected ? detailState : null;
  const detail = current?.data ?? null;
  const detailError = current?.error ?? null;
  const detailLoading = !!selected && !current;

  const selectIndustry = (name: string) => {
    setShowAll(false);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (name) next.set('industry', name);
        else next.delete('industry');
        return next;
      },
      { replace: true },
    );
  };

  const tiles = useMemo(
    () => (data ? squarify(revenueTreemapInputs(data.industries), CANVAS_W, CANVAS_H) : []),
    [data],
  );

  const handleMouseMove = (e: React.MouseEvent<SVGElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // 靠右半邊時提示框往左放，免得被裁掉
    const x = e.clientX - rect.left;
    setTooltipPos({ x: x > rect.width / 2 ? x - 255 : x + 15, y: e.clientY - rect.top - 15 });
  };

  const truncate = (name: string, width: number) => {
    const maxChars = Math.floor(width / 11);
    return name.length > maxChars ? name.substring(0, Math.max(1, maxChars - 1)) + '..' : name;
  };

  const header = (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-zinc-100">產業熱力圖</h2>
          {data && (
            <span className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50 text-[10px] font-mono text-zinc-400 font-medium">
              營收月份: {data.month}{data.published ? `（${data.published} 出表）` : ''}
            </span>
          )}
          {data?.stale && <span className="text-[10px] text-amber-400">暫時連不上，顯示上一份</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          證交所官方 32 個產業（僅上市）。區塊面積＝當月營收，顏色＝營收年增率（紅＝成長、綠＝衰退）。點產業看 12 個月趨勢與成分公司。
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0 flex-wrap">
        {viewToggle}
        <button
          onClick={() => load(true)}
          className="p-2 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all shadow-sm"
          title="重新整理"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="h-[60vh] flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <span className="text-sm font-mono text-zinc-400 animate-pulse">載入產業營收中...</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="h-[50vh] flex flex-col items-center justify-center text-center p-6 border border-zinc-800 bg-zinc-900/20 rounded-xl max-w-xl mx-auto">
          <AlertCircle className="w-12 h-12 text-zinc-600 mb-4" />
          <span className="text-sm text-red-400 font-semibold mb-2">載入產業營收失敗</span>
          <span className="text-xs text-zinc-500 font-mono mb-6">{error || '無資料'}</span>
          <button
            onClick={() => load(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-semibold transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新整理
          </button>
        </div>
      </div>
    );
  }

  const companies = detail ? sortCompanies(detail.companies, sortKey) : [];
  const shownCompanies = showAll ? companies : companies.slice(0, 15);

  return (
    <div className="space-y-6">
      {header}

      <div className="relative border border-zinc-800 bg-zinc-900/10 rounded-xl p-3 flex items-center justify-center overflow-hidden">
        <svg
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          className="w-full h-auto rounded-lg select-none"
          role="img"
          aria-label={`上市 32 個產業 ${data.month} 營收熱力圖`}
          onMouseLeave={() => setHovered(null)}
        >
          {tiles.map((tile) => {
            const d = tile.item.datum;
            const isSel = selected === tile.item.key;
            const isHover = hovered?.key === tile.item.key;
            return (
              <g key={tile.item.key} className="cursor-pointer">
                <rect
                  x={tile.x}
                  y={tile.y}
                  width={tile.w}
                  height={tile.h}
                  fill={divergingColor(d.yoy_pct, SATURATION)}
                  stroke={isSel ? '#fafafa' : '#121214'}
                  strokeWidth={isSel ? 3 : 1}
                  fillOpacity={isHover || isSel ? 0.95 : 0.8}
                  onMouseEnter={() => setHovered(tile.item)}
                  onMouseMove={handleMouseMove}
                  onClick={() => selectIndustry(isSel ? '' : tile.item.key)}
                  className="transition-colors duration-150"
                />
                {tile.w > 70 && tile.h > 40 ? (
                  <g className="pointer-events-none select-none">
                    <text x={tile.x + tile.w / 2} y={tile.y + tile.h / 2 - 6} textAnchor="middle" dominantBaseline="middle" className="fill-white font-bold text-xs">
                      {truncate(tile.item.key, tile.w - 8)}
                    </text>
                    <text x={tile.x + tile.w / 2} y={tile.y + tile.h / 2 + 10} textAnchor="middle" dominantBaseline="middle" className="fill-zinc-200 font-mono text-[10px]">
                      {fmtPct(d.yoy_pct, 1)}
                    </text>
                  </g>
                ) : tile.w >= 32 && tile.h >= 22 ? (
                  <text x={tile.x + tile.w / 2} y={tile.y + tile.h / 2} textAnchor="middle" dominantBaseline="middle" className="fill-white font-semibold text-[10px] pointer-events-none select-none">
                    {truncate(tile.item.key, tile.w - 4)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {hovered && (
          <div
            className="absolute z-30 bg-zinc-950/95 border border-zinc-800 rounded-xl p-3 shadow-xl text-xs space-y-2 pointer-events-none w-60 backdrop-blur-sm"
            style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          >
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
              <span className="font-bold text-zinc-100">{hovered.key}</span>
              <span className="font-mono text-zinc-500 text-[10px]">{data.month}</span>
            </div>
            <div className="grid grid-cols-2 gap-y-1 font-mono text-[11px] text-zinc-400">
              <div>當月營收:</div>
              <div className="text-zinc-200 text-right">{fmtRevenue(hovered.datum.revenue)}</div>
              <div>占上市營收:</div>
              <div className="text-zinc-200 text-right">
                {hovered.datum.share_pct !== null && hovered.datum.share_pct !== undefined ? `${hovered.datum.share_pct.toFixed(2)}%` : '—'}
              </div>
              <div>年增率:</div>
              <div className={`text-right font-bold ${toneClass(hovered.datum.yoy_pct)}`}>{fmtPct(hovered.datum.yoy_pct)}</div>
              <div>月增率:</div>
              <div className={`text-right ${toneClass(hovered.datum.mom_pct)}`}>{fmtPct(hovered.datum.mom_pct)}</div>
              <div>累計年增:</div>
              <div className={`text-right ${toneClass(hovered.datum.cum_yoy_pct)}`}>{fmtPct(hovered.datum.cum_yoy_pct)}</div>
              <div>公司家數:</div>
              <div className="text-zinc-200 text-right">{hovered.datum.count} 家</div>
            </div>
            <div className="text-[10px] text-zinc-500 italic text-center pt-1 border-t border-zinc-900">
              點擊看【{hovered.key}】營收明細
            </div>
          </div>
        )}
      </div>

      {selected && (
        <div ref={detailRef} className="border border-zinc-800 bg-card rounded-xl p-5 space-y-4 scroll-mt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-sm text-zinc-200">
              {selected}・{data.month} 營收明細
              <span className="text-[11px] text-zinc-500 font-normal ml-2">上市</span>
            </h3>
            <button
              onClick={() => selectIndustry('')}
              className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition"
              title="關閉明細"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {detailLoading && !detail ? (
            <div className="h-40 flex items-center justify-center text-xs text-zinc-500 animate-pulse">載入產業明細中...</div>
          ) : detailError ? (
            <div className="text-xs text-red-400">{detailError}</div>
          ) : detail ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  ['當月營收', fmtRevenue(detail.industry.revenue), ''],
                  ['占上市營收', detail.industry.share_pct !== null && detail.industry.share_pct !== undefined ? `${detail.industry.share_pct.toFixed(2)}%` : '—', ''],
                  ['年增率', fmtPct(detail.industry.yoy_pct), toneClass(detail.industry.yoy_pct)],
                  ['月增率', fmtPct(detail.industry.mom_pct), toneClass(detail.industry.mom_pct)],
                  ['累計年增', fmtPct(detail.industry.cum_yoy_pct), toneClass(detail.industry.cum_yoy_pct)],
                  ['公司家數', `${detail.industry.count} 家`, ''],
                ].map(([label, value, tone]) => (
                  <div key={label} className="bg-zinc-950/40 p-2.5 rounded-lg border border-border/30">
                    <div className="text-[10px] text-zinc-500">{label}</div>
                    <div className={`text-sm font-bold font-mono mt-0.5 ${tone || 'text-zinc-100'}`}>{value}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                <div className="lg:col-span-2 min-w-0">
                  <div className="text-xs font-semibold text-zinc-300 mb-1">近 12 個月營收</div>
                  {detail.trend && detail.trend.length ? (
                    <MiniTrendChart
                      points={detail.trend.map((t) => ({ date: t.month, value: t.revenue }))}
                      kind="bar"
                      label={`${selected}近 12 個月營收`}
                      format={(v) => (v === 0 ? '0' : fmtRevenue(v))}
                      axisFormat={compactRevenueAxis(Math.max(...detail.trend.map((t) => t.revenue)) * 1.1)}
                      height={170}
                    />
                  ) : (
                    <div className="h-[170px] flex items-center justify-center text-[11px] text-zinc-500">趨勢資料暫時抓不到</div>
                  )}
                </div>

                <div className="lg:col-span-3 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-zinc-300">成分公司（{companies.length} 家）</span>
                    <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-800/80 rounded-md p-0.5">
                      {([['revenue', '營收'], ['yoy_pct', '年增'], ['mom_pct', '月增']] as [CompanySortKey, string][]).map(([k, label]) => (
                        <button
                          key={k}
                          onClick={() => setSortKey(k)}
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold transition ${
                            sortKey === k ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          依{label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-zinc-500 border-b border-border/60">
                          <th className="text-left font-semibold pb-1.5">公司</th>
                          <th className="text-right font-semibold pb-1.5">當月營收</th>
                          <th className="text-right font-semibold pb-1.5">年增</th>
                          <th className="text-right font-semibold pb-1.5">月增</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {shownCompanies.map((c) => (
                          <tr key={c.code} className="border-b border-border/20 last:border-0 hover:bg-zinc-800/40">
                            <td className="py-1.5 font-sans">
                              <Link to={`/stock/${c.code}?tab=industry`} className="text-zinc-200 hover:text-primary">
                                <span className="font-mono text-zinc-500 mr-1.5">{c.code}</span>
                                {c.name}
                              </Link>
                              <GroupTag code={c.code} className="ml-1.5" />
                            </td>
                            <td className="py-1.5 text-right text-zinc-300">{fmtRevenue(c.revenue)}</td>
                            <td className={`py-1.5 text-right font-semibold ${toneClass(c.yoy_pct)}`}>{fmtPct(c.yoy_pct, 1)}</td>
                            <td className={`py-1.5 text-right ${toneClass(c.mom_pct)}`}>{fmtPct(c.mom_pct, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {companies.length > 15 && (
                    <button
                      onClick={() => setShowAll((v) => !v)}
                      className="mt-2 text-[11px] text-primary hover:underline"
                    >
                      {showAll ? '只看前 15 家' : `顯示全部 ${companies.length} 家`}
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 border border-zinc-800 bg-zinc-900/20 rounded-xl">
        <div className="text-[11px] text-zinc-500 leading-relaxed space-y-1">
          <div>* 資料：證交所「上市公司每月營業收入彙總表」逐家加總（排除存託憑證），跟證交所臺股儀表板的產業數字一致；12 個月趨勢取自儀表板。</div>
          <div>* 產業是<strong>證交所官方現行 32 類</strong>，跟「產業聚合」檢視（沿用 FinMind 分類，有「電子工業」舊大類）不同。</div>
          <div>* 最小的幾個產業面積有下限（占總額 0.4%），真實金額見提示框。上市公司每月 10 日前公告上月營收，保險業可延到 15 日。</div>
        </div>
        <div className="shrink-0 w-full sm:w-64">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Info className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-400 font-medium">營收年增率色階</span>
          </div>
          <div className="h-2.5 w-full rounded bg-gradient-to-r from-[#15803d] via-[#3f3f46] to-[#b91c1c]" />
          <div className="flex justify-between text-[10px] text-zinc-400 font-mono mt-1 font-medium">
            <span>-50% 綠</span>
            <span>0%</span>
            <span>+50% 紅</span>
          </div>
        </div>
      </div>
    </div>
  );
};
