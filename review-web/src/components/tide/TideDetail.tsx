import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, X } from 'lucide-react';
import type { InstFlowPayload } from '../../lib/api';
import {
  fmtMd,
  fmtYi,
  INST_SHORT,
  LONG_WINDOW,
  memberRows,
  quadrantTag,
  WINDOW,
  type FlowFrame,
  type FlowUnit,
  type Inst,
  type Level,
} from '../../lib/capitalFlow';

/**
 * 點泡泡後的明細：這個族群當日／近 5 日／近 20 日買賣超、資金加速度，以及成分股清單。
 * 數字跟著泡泡圖目前停在的那一天與選的法人別走。
 */
export const TideDetail: React.FC<{
  payload: InstFlowPayload;
  unit: FlowUnit;
  unitIndex: number;
  frame: FlowFrame;
  inst: Inst;
  level: Level;
  /** 放在桌機右欄時比較窄：股價與漲跌幅疊成兩行 */
  compact?: boolean;
  onClose: () => void;
}> = ({ payload, unit, unitIndex, frame, inst, level, compact = false, onClose }) => {
  const rows = useMemo(() => memberRows(payload, unit, inst, frame.dayIndex), [payload, unit, inst, frame.dayIndex]);
  const x = frame.x[unitIndex];
  const y = frame.y[unitIndex];
  const who = INST_SHORT[inst];
  const tone = (v: number | null) => (v === null || v === 0 ? 'text-zinc-400' : v > 0 ? 'text-bull' : 'text-bear');
  const netWord = (v: number | null) => (v !== null && v < 0 ? '淨賣超' : '淨買超');

  const stats: [string, number | null, string][] = [
    [`當日${who}${netWord(frame.today[unitIndex])}`, frame.today[unitIndex], '億'],
    [`近 ${WINDOW} 日${who}${netWord(x)}`, x, '億'],
    [`近 ${LONG_WINDOW} 日${who}${netWord(frame.long[unitIndex])}`, frame.long[unitIndex], '億'],
    ['資金加速度', y, '億/天'],
  ];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-zinc-800 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-bold text-zinc-100">{unit.name}</h3>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {level === 'group' ? `${unit.category}・${unit.name}` : '大類'}・{unit.members.length} 檔・{fmtMd(frame.date)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {level === 'group' && (
            <Link
              to={`/heatmap/group/${encodeURIComponent(unit.name)}`}
              className="flex items-center gap-0.5 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary transition hover:bg-primary/20"
            >
              族群熱力圖
              <ChevronRight className="h-3 w-3" />
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="pt-3">
        <span
          className={`inline-block rounded-md border px-2 py-1 text-xs font-bold ${
            x >= 0 ? 'border-bull/30 bg-bull/10 text-bull' : 'border-bear/30 bg-bear/10 text-bear'
          }`}
        >
          {quadrantTag(x, y)}
        </span>
      </div>

      <dl className="mt-2 divide-y divide-zinc-800/70 text-sm">
        {stats.map(([label, value, unitText]) => (
          <div key={label} className="flex items-center justify-between py-2">
            <dt className="text-zinc-400">{label}</dt>
            <dd className={`font-mono font-bold ${tone(value)}`}>
              {value === null ? <span className="text-xs font-normal text-zinc-600">資料回補中</span> : `${fmtYi(value)} ${unitText}`}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-baseline justify-between border-t border-dashed border-zinc-700 pt-3">
        <h4 className="text-xs font-bold text-zinc-300">成分股</h4>
        <span className="text-[10px] text-zinc-500">依近 {WINDOW} 日{who}買賣超排序・單位 億</span>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-[10px] text-zinc-500">
            <tr>
              <th className="py-1.5 text-left font-medium">個股</th>
              <th className="py-1.5 text-right font-medium">股價</th>
              <th className="py-1.5 text-right font-medium">當日</th>
              <th className="py-1.5 text-right font-medium">連買賣</th>
              <th className="py-1.5 text-right font-medium">{WINDOW} 日累計</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50 font-mono">
            {rows.map((r) => (
              <tr key={r.code} className="hover:bg-zinc-800/30">
                <td className="py-1.5 pr-1">
                  <Link to={`/stock/${r.code}`} className="group flex items-baseline gap-1.5">
                    <span className="text-zinc-500 underline decoration-zinc-700 underline-offset-2 group-hover:text-primary">{r.code}</span>
                    <span className="font-sans font-semibold text-zinc-200 group-hover:text-primary">{r.name}</span>
                  </Link>
                </td>
                <td className="py-1.5 text-right">
                  {r.close === null ? (
                    <span className="text-zinc-600">—</span>
                  ) : (
                    <>
                      <span className="text-zinc-300">{r.close.toLocaleString('en-US')}</span>
                      {r.chg !== null && (
                        <span className={`text-[10px] ${compact ? 'block leading-tight' : 'ml-1'} ${tone(r.chg)}`}>
                          {r.chg > 0 ? '+' : ''}
                          {r.chg.toFixed(2)}%
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className={`py-1.5 text-right ${tone(r.today)}`}>{fmtYi(r.today)}</td>
                <td className={`py-1.5 text-right font-sans text-[11px] ${tone(r.streak)}`}>
                  {r.streak === 0 ? '—' : `${r.streak > 0 ? '買' : '賣'} ${Math.abs(r.streak)} 天`}
                </td>
                <td className={`py-1.5 text-right font-bold ${tone(r.sum5)}`}>{fmtYi(r.sum5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
