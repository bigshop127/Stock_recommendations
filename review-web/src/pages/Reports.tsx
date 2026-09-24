import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Newspaper, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { Report, ReportsList } from '../lib/api';
import { ReportView } from '../components/ReportView';
import { ReportCalendar } from '../components/ReportCalendar';
import { stripFrontmatter } from '../lib/reportMarkdown';
import { ALL_TAB, joinSections, resolveTab, splitReport } from '../lib/reportSections';

// 字級（px）：滑桿連續調整，記在這台裝置的瀏覽器裡（只是個人偏好，讀不到就用預設）
const FONT_KEY = 'review:reports:fontSize';
const FONT_MIN = 13;
const FONT_MAX = 26;
const FONT_DEFAULT = 16;

function loadFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return n;
  } catch {
    /* 私密視窗／封鎖網站資料時會丟例外，直接用預設 */
  }
  return FONT_DEFAULT;
}

function saveFontSize(n: number) {
  try {
    localStorage.setItem(FONT_KEY, String(n));
  } catch {
    /* 存不了就算了，只是下次不記得 */
  }
}

/**
 * 老王每日報告：把浦惠投顧的每日整理直接放進審視網，不必再靠 Obsidian／git 同步。
 * 資料源是 gateway 的 /api/reports（純讀 VM 上的 reports/，跟 engine 無關）。
 * 網址參數：?date=YYYY-MM-DD 直達指定日期（省略＝最新一篇）、?tab=段落名 直達某個小分頁。
 * 換日時 tab 會保留：新的一天有同名段落就停在那段，沒有就回到第一段。
 */
export const Reports: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
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

  // 依「## 段落」切成小分頁
  const split = useMemo(() => (report ? splitReport(stripFrontmatter(report.markdown)) : null), [report]);
  const sections = split?.sections ?? [];
  const hasTabs = sections.length >= 2;
  const activeTab = hasTabs ? resolveTab(sections, params.get('tab')) : ALL_TAB;
  const activeIdx = sections.findIndex((s) => s.key === activeTab);
  const prevSection = activeIdx > 0 ? sections[activeIdx - 1] : null;
  const nextSection = activeIdx >= 0 && activeIdx < sections.length - 1 ? sections[activeIdx + 1] : null;

  // 選中的分頁按鈕若在分頁列的可視範圍外（用「下一段」或換日切過去的），橫向捲到置中；只動分頁列本身，不動整頁
  useEffect(() => {
    const bar = tabBarRef.current;
    const el = bar?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !el) return;
    bar.scrollTo({ left: el.offsetLeft - (bar.clientWidth - el.clientWidth) / 2, behavior: 'smooth' });
  }, [activeTab, report]);

  const idx = date ? dates.indexOf(date) : -1;
  const olderDate = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
  const newerDate = idx > 0 ? dates[idx - 1] : null;

  const go = (d: string | null) => {
    if (!d) return;
    const next = new URLSearchParams(params);
    // 最新一篇不寫進網址，書籤永遠指向「最新」；tab 保留，換日後停在同名段落
    if (d === list?.latest) next.delete('date');
    else next.set('date', d);
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  const selectTab = (key: string, scrollToTabs = false) => {
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
    if (scrollToTabs) tabsRef.current?.scrollIntoView({ block: 'start' });
  };

  const changeFont = (n: number) => {
    setFontSize(n);
    saveFontSize(n);
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

      {/* 日期：前一篇／月曆／後一篇／重新載入 */}
      <div className="flex items-center gap-2 mb-3">
        <button type="button" className={btn} disabled={!olderDate} onClick={() => go(olderDate)} aria-label="前一篇（較舊）">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <ReportCalendar selected={date ?? ''} dates={dates} onSelect={go} />
        <button type="button" className={btn} disabled={!newerDate} onClick={() => go(newerDate)} aria-label="後一篇（較新）">
          <ChevronRight className="w-4 h-4" />
        </button>
        <button type="button" className={btn} onClick={() => setReloadKey((k) => k + 1)} aria-label="重新載入">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* 字級：連續滑桿 */}
      <div className="flex items-center gap-3 mb-4 text-zinc-400">
        <span className="text-xs shrink-0">字級</span>
        <span className="leading-none shrink-0" style={{ fontSize: 12 }} aria-hidden="true">A</span>
        <input
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          step={0.5}
          value={fontSize}
          onChange={(e) => changeFont(Number(e.target.value))}
          className="flex-1 min-w-0 accent-primary"
          aria-label="報告字體大小"
        />
        <span className="leading-none shrink-0" style={{ fontSize: 22 }} aria-hidden="true">A</span>
        <span className="w-12 text-right text-xs tabular-nums shrink-0">{fontSize}px</span>
        <button
          type="button"
          className="text-xs px-2 py-1 rounded-md border border-border hover:bg-zinc-800/60 disabled:opacity-30 shrink-0"
          disabled={fontSize === FONT_DEFAULT}
          onClick={() => changeFont(FONT_DEFAULT)}
        >
          預設
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

      {report && split && (
        <article
          className="rounded-xl border border-border bg-card px-4 py-5 md:px-8 md:py-7"
          style={{ ['--rpt-font-size' as string]: `${fontSize}px` }}
        >
          {/* 標題＋摘要：永遠顯示在分頁列上方 */}
          {split.head && <ReportView markdown={split.head} />}

          {/* 小分頁（樣式與網址同步比照再平衡計算機） */}
          {hasTabs && (
            <div ref={tabsRef} className="border-b border-border/80 my-4 scroll-mt-4">
              <div ref={tabBarRef} className="relative flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none" role="tablist" aria-label="報告段落">
                {[...sections.map((s) => ({ key: s.key, label: s.label })), { key: ALL_TAB, label: ALL_TAB }].map((t) => {
                  const isActive = activeTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => selectTab(t.key)}
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
          )}

          {/* 分頁內容：選一段就只顯示那一段；「全部」＝所有段落接起來 */}
          {hasTabs && activeTab !== ALL_TAB ? (
            <ReportView panel markdown={sections[activeIdx].markdown} />
          ) : (
            <ReportView panel={hasTabs} markdown={joinSections(sections)} />
          )}

          {/* 上一段／下一段：讀完不用捲回最上面找分頁列 */}
          {hasTabs && activeTab !== ALL_TAB && (prevSection || nextSection) && (
            <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-border/80">
              {prevSection ? (
                <button type="button" className={btn} onClick={() => selectTab(prevSection.key, true)}>
                  <ChevronLeft className="w-4 h-4" />
                  <span className="truncate max-w-[9em]">{prevSection.label}</span>
                </button>
              ) : <span />}
              {nextSection ? (
                <button type="button" className={btn} onClick={() => selectTab(nextSection.key, true)}>
                  <span className="truncate max-w-[9em]">{nextSection.label}</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : <span />}
            </div>
          )}

          {/* 結尾的「閱讀原文」連結：永遠顯示 */}
          {split.footer && (
            <div className="mt-6 pt-4 border-t border-border/80">
              <ReportView markdown={split.footer} />
            </div>
          )}
        </article>
      )}

      {report && (
        <p className="text-[11px] text-zinc-600 mt-3 text-right">{report.path}</p>
      )}
    </div>
  );
};
