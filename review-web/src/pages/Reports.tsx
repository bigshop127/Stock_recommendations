import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Newspaper, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { Report, ReportsList } from '../lib/api';
import { ReportView } from '../components/ReportView';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 2026-09-24 → 2026-09-24（四）；日期字串本身就是台北日期，不經過 Date 時區換算。 */
function labelOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${date}（${WEEKDAY[w]}）`;
}

/**
 * 老王每日報告：把浦惠投顧的每日整理直接放進審視網，不必再靠 Obsidian／git 同步。
 * 資料源是 gateway 的 /api/reports（純讀 VM 上的 reports/，跟 engine 無關）。
 * ?date=YYYY-MM-DD 可直接開指定日期（書籤／分享用），省略＝最新一篇。
 */
export const Reports: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  // 結果連同它對應的請求 key 一起存：key 對不上＝還在載入，effect 本體不必同步 setState
  const [listRes, setListRes] = useState<{ key: number; list?: ReportsList; error?: string } | null>(null);
  const [reportRes, setReportRes] = useState<{ key: string; report?: Report; error?: string } | null>(null);

  // 日期清單（新→舊）
  useEffect(() => {
    let cancelled = false;
    api.reportsList()
      .then((list) => { if (!cancelled) setListRes({ key: reloadKey, list }); })
      .catch((e: unknown) => { if (!cancelled) setListRes({ key: reloadKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const list = listRes?.key === reloadKey ? listRes.list ?? null : null;
  const dates = useMemo(() => list?.dates ?? [], [list]);
  const wanted = params.get('date');
  const date = wanted && dates.includes(wanted) ? wanted : list?.latest ?? null;
  const reportKey = date ? `${date}|${reloadKey}` : null;

  // 內文
  useEffect(() => {
    if (!date || !reportKey) return;
    let cancelled = false;
    api.report(date)
      .then((report) => { if (!cancelled) setReportRes({ key: reportKey, report }); })
      .catch((e: unknown) => { if (!cancelled) setReportRes({ key: reportKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [date, reportKey]);

  const report = reportRes && reportRes.key === reportKey ? reportRes.report ?? null : null;
  const error =
    (listRes?.key === reloadKey ? listRes.error : undefined) ??
    (reportRes && reportRes.key === reportKey ? reportRes.error : undefined) ??
    null;

  const idx = date ? dates.indexOf(date) : -1;
  const olderDate = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
  const newerDate = idx > 0 ? dates[idx - 1] : null;
  const go = (d: string | null) => {
    if (!d) return;
    // 最新一篇不寫進網址，書籤永遠指向「最新」
    setParams(d === list?.latest ? {} : { date: d });
    window.scrollTo({ top: 0 });
  };

  const btn =
    'inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium border border-border bg-card text-zinc-300 ' +
    'hover:bg-zinc-800/60 disabled:opacity-30 disabled:hover:bg-card transition-colors';

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Newspaper className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold text-zinc-100">老王每日報告</h1>
      </div>
      <p className="text-xs text-zinc-500 mb-4 flex flex-wrap gap-x-4 gap-y-1">
        <span>🔴 看多</span>
        <span>🟢 看空</span>
        <span>🟠 中性觀望</span>
        <span>（與股市紅漲綠跌相反）</span>
      </p>

      {/* 日期切換 */}
      <div className="flex items-center gap-2 mb-4">
        <button type="button" className={btn} disabled={!olderDate} onClick={() => go(olderDate)} aria-label="前一篇（較舊）">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <select
          className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm border border-border bg-card text-zinc-100"
          value={date ?? ''}
          disabled={!dates.length}
          onChange={(e) => go(e.target.value)}
          aria-label="選擇報告日期"
        >
          {dates.map((d) => (
            <option key={d} value={d}>{labelOf(d)}</option>
          ))}
        </select>
        <button type="button" className={btn} disabled={!newerDate} onClick={() => go(newerDate)} aria-label="後一篇（較新）">
          <ChevronRight className="w-4 h-4" />
        </button>
        <button type="button" className={btn} onClick={() => setReloadKey((k) => k + 1)} aria-label="重新載入">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm px-4 py-3 mb-4">
          載入失敗：{error}
        </div>
      )}

      {!error && !report && (
        <div className="flex h-48 items-center justify-center text-zinc-500 text-sm">載入報告中…</div>
      )}

      {report && (
        <article className="rounded-xl border border-border bg-card px-4 py-5 md:px-8 md:py-7">
          <ReportView markdown={report.markdown} />
        </article>
      )}

      {report && (
        <p className="text-[11px] text-zinc-600 mt-3 text-right">{report.path}</p>
      )}
    </div>
  );
};
