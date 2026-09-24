import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildMonthCells, formatReportDate, monthOf, monthTitle, shiftMonth } from '../lib/reportCalendar';

const WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六'];

interface PanelProps {
  /** 目前選中的報告日期（月曆打開時先顯示它所在的月份）。 */
  selected: string;
  /** 有報告的日期。 */
  dates: string[];
  onSelect: (date: string) => void;
}

/**
 * 整個月的月曆：有報告的日子底色淡綠、可點；週末與老王休假（沒報告）維持原樣、不可點。
 * 只能翻到「有報告的最早月～最新月」之間。
 */
export function CalendarPanel({ selected, dates, onSelect }: PanelProps) {
  const has = useMemo(() => new Set(dates), [dates]);
  const [ym, setYm] = useState(() => monthOf(selected));

  const { min, max } = useMemo(() => {
    const months = dates.map(monthOf).sort();
    return { min: months[0] ?? monthOf(selected), max: months[months.length - 1] ?? monthOf(selected) };
  }, [dates, selected]);

  const cells = buildMonthCells(ym);
  const count = cells.filter((d) => d !== null && has.has(d)).length;
  const navBtn =
    'p-2 rounded-lg border border-border text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button type="button" className={navBtn} disabled={ym <= min} onClick={() => setYm(shiftMonth(ym, -1))} aria-label="上個月">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-semibold text-zinc-100">
          {monthTitle(ym)}
          <span className="ml-2 text-xs font-normal text-zinc-500">{count} 篇</span>
        </div>
        <button type="button" className={navBtn} disabled={ym >= max} onClick={() => setYm(shiftMonth(ym, 1))} aria-label="下個月">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="text-center text-[11px] text-zinc-500 py-1">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`blank-${i}`} />;
          const hasReport = has.has(d);
          const isSelected = d === selected;
          const cls = !hasReport
            ? 'text-zinc-500 cursor-default'
            : isSelected
              ? 'bg-emerald-500/60 text-white font-bold ring-2 ring-primary'
              : 'bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/35';
          return (
            <button
              key={d}
              type="button"
              disabled={!hasReport}
              onClick={() => onSelect(d)}
              aria-label={hasReport ? `${formatReportDate(d)}，有報告` : formatReportDate(d)}
              aria-current={isSelected ? 'date' : undefined}
              className={`h-10 rounded-lg text-sm tabular-nums transition-colors ${cls}`}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 mt-3 text-[11px] text-zinc-500">
        <span className="inline-block w-3 h-3 rounded bg-emerald-500/25" />
        淡綠色＝當天有報告（週末與休假日沒有）
      </div>
    </div>
  );
}

/** 日期按鈕＋點開的月曆（點空白處或按 Esc 關閉，選了日期自動關閉）。 */
export function ReportCalendar({ selected, dates, onSelect }: PanelProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!dates.length}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-card text-zinc-100 hover:bg-zinc-800/60 disabled:opacity-50"
      >
        <span className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-primary shrink-0" />
          <span className="truncate">{selected ? formatReportDate(selected) : '載入中…'}</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <button type="button" tabIndex={-1} aria-label="關閉月曆" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="選擇報告日期" className="absolute left-0 top-full mt-2 z-30 w-full sm:w-80 rounded-xl border border-border bg-card shadow-2xl p-3">
            <CalendarPanel
              selected={selected}
              dates={dates}
              onSelect={(d) => {
                setOpen(false);
                onSelect(d);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
