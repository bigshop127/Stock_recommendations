import React from 'react';
import { Link } from 'react-router-dom';
import { CODE_TO_GROUP } from '../lib/stockGroups';

/**
 * 個股族群小標籤（2026-09-27）：有收錄就顯示細分族群（例：南電→ABF載板），
 * 沒收錄才退回官方產業別、改用灰色，一眼分得出是哪一種。
 * link=true 會連到該族群的熱力圖；放在「整列可點」的表格或清單裡時不要開，免得點擊互相搶。
 */
export const GroupTag: React.FC<{
  code: string;
  fallback?: string | null;
  link?: boolean;
  className?: string;
}> = ({ code, fallback, link = false, className = '' }) => {
  const ref = CODE_TO_GROUP.get(code);
  const label = ref?.group ?? fallback ?? '';
  if (!label) return null;
  const tone = ref
    ? 'bg-primary/10 text-sky-300 border-primary/25'
    : 'bg-zinc-800/80 text-zinc-500 border-border/40';
  const cls = `inline-block max-w-full truncate align-middle text-[10px] leading-4 px-1.5 rounded border font-sans font-medium ${tone} ${className}`;
  const title = ref ? `${ref.category}／${ref.group}` : `官方產業別：${label}（尚未收錄族群）`;
  if (link && ref) {
    return (
      <Link
        to={`/heatmap/group/${encodeURIComponent(ref.group)}`}
        title={`${title}（點我看族群熱力圖）`}
        className={`${cls} hover:bg-primary/20`}
      >
        {label}
      </Link>
    );
  }
  return (
    <span title={title} className={cls}>
      {label}
    </span>
  );
};
