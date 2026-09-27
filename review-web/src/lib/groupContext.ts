import type { HeatmapStock, StockHeatmap } from './api';
import { aggregateGroups } from './groupHeatmap';
import { CODE_TO_GROUP } from './stockGroups';

/**
 * 族群連動（2026-09-27，仿 Danny Quant 研究摘要「產業連動：題材排名第 N 位」）。
 * 用上市族群熱力圖同一份資料（證交所每日收盤）、同一套聚合（aggregateGroups），
 * 看這檔所屬族群在全部族群裡排第幾、這檔在族群裡排第幾。
 * 只有 1 檔有報價的族群不列入排名（單一個股的漲跌不代表族群）。
 */

export interface GroupPeriodStat {
  /** 族群成分股平均漲跌 % */
  avg: number;
  /** 族群名次（1＝最強）；族群有報價的不到 2 檔時為 null */
  rank: number | null;
  /** 參與排名的族群數 */
  total: number;
  upCount: number;
  validCount: number;
  /** 這檔自己的漲跌 % */
  stockChange: number | null;
  /** 這檔在族群內的名次（1＝族群裡漲最多） */
  stockRankInGroup: number | null;
  /** 資料日；月份期間另有起算日 */
  date: string;
  baseDate: string;
}

export interface GroupContext {
  group: string;
  category: string;
  day: GroupPeriodStat | null;
  month: GroupPeriodStat | null;
}

const MIN_RANKED_MEMBERS = 2;

export function buildGroupPeriodStat(code: string, heatmap: StockHeatmap | null): GroupPeriodStat | null {
  const ref = CODE_TO_GROUP.get(code);
  if (!ref || !heatmap || heatmap.stocks.length === 0) return null;

  const groups = aggregateGroups(heatmap.stocks);
  const mine = groups.find((g) => g.group === ref.group);
  if (!mine) return null;

  const ranked = groups
    .filter((g) => g.valid_count >= MIN_RANKED_MEMBERS)
    .sort((a, b) => b.avg_change_pct - a.avg_change_pct);
  const idx = ranked.findIndex((g) => g.group === ref.group);

  const members: HeatmapStock[] = heatmap.stocks.filter(
    (s) => CODE_TO_GROUP.get(s.code)?.group === ref.group && s.change_pct !== null && Number.isFinite(s.change_pct),
  );
  const self = members.find((s) => s.code === code);
  const stockChange = self ? (self.change_pct as number) : null;
  const stockRankInGroup = stockChange !== null
    ? members.filter((s) => (s.change_pct as number) > stockChange).length + 1
    : null;

  return {
    avg: mine.avg_change_pct,
    rank: idx >= 0 ? idx + 1 : null,
    total: ranked.length,
    upCount: mine.up_count,
    validCount: mine.valid_count,
    stockChange,
    stockRankInGroup,
    date: heatmap.date,
    baseDate: heatmap.base_date,
  };
}

export function buildGroupContext(
  code: string,
  day: StockHeatmap | null,
  month: StockHeatmap | null,
): GroupContext | null {
  const ref = CODE_TO_GROUP.get(code);
  if (!ref) return null;
  return {
    group: ref.group,
    category: ref.category,
    day: buildGroupPeriodStat(code, day),
    month: buildGroupPeriodStat(code, month),
  };
}

/** 前段／後段的門檻：前 10%，至少 3 名 */
export function edgeCut(total: number): number {
  return Math.max(3, Math.ceil(total * 0.1));
}
