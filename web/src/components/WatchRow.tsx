import { Link } from 'react-router-dom';
import type { WatchItem } from '../lib/api';
import { pct, scoreColor } from '../lib/format';
import { Pill } from './ui';

// 觀察清單單列。mode 決定主顯分數（swing=波段分 / daytrade=當沖機率）。
export function WatchRow({ item, mode = 'swing' }: { item: WatchItem; mode?: 'swing' | 'daytrade' }) {
  const isDay = mode === 'daytrade';
  const main = isDay ? item.daytrade_prob : item.swing_score;
  const mainText = isDay ? pct(item.daytrade_prob, 0) : (item.swing_score?.toFixed(0) ?? '—');
  const mainColor = scoreColor(isDay ? (item.daytrade_prob == null ? null : item.daytrade_prob * 100) : item.swing_score);
  return (
    <Link
      to={`/stock/${item.code}`}
      className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 active:bg-slate-700/60"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-100 truncate">{item.name}</span>
          <span className="text-xs text-slate-500">{item.code}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {item.source?.includes('puhui') && <Pill className="!bg-indigo-900/70 !text-indigo-200">老王</Pill>}
          {item.puhui_signal && <Pill>{item.puhui_signal}</Pill>}
          {item.tags?.slice(0, 2).map((t) => (
            <Pill key={t}>{t}</Pill>
          ))}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-xl font-bold ${main == null ? 'text-slate-500' : mainColor}`}>{mainText}</div>
        <div className="text-[10px] text-slate-500">
          {isDay ? '當沖機率' : '波段分'} · #{isDay ? item.rank_daytrade : item.rank_swing}
        </div>
      </div>
    </Link>
  );
}
