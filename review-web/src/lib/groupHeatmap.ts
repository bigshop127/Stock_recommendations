import type { HeatmapStock } from './api';
import { CODE_TO_GROUP, STOCK_GROUPS } from './stockGroups';

export interface GroupAgg {
  group: string;
  category: string;
  avg_change_pct: number;   // 成分股簡單平均（沿用 opt6 口徑）
  turnover: number;         // 族群成交值合計
  turnover_share: number;   // 佔全市場成交值 %
  count: number;            // 成分股檔數（有出現在 universe 者）
  valid_count: number;      // change_pct 非 null 檔數
  up_count: number;
}

/**
 * 該名稱是否為自建對照表中的族群。
 * 必須用 hasOwnProperty 而非 `in`：`in` 會命中原型鏈，讓 'constructor'／'toString'
 * ／'__proto__' 等被誤判為存在的族群。
 */
export function isCuratedGroup(name: string): boolean {
  for (const groups of Object.values(STOCK_GROUPS)) {
    if (Object.prototype.hasOwnProperty.call(groups, name)) return true;
  }
  return false;
}

/** 聚合全部 curated 族群 */
export function aggregateGroups(stocks: HeatmapStock[]): GroupAgg[] {
  const groupMap = new Map<string, {
    category: string;
    sumChangePct: number;
    turnover: number;
    count: number;
    valid_count: number;
    up_count: number;
  }>();

  // 1. 計算全市場（即輸入的 stocks）總成交值
  let totalMarketTurnover = 0;
  for (const s of stocks) {
    if (s.turnover !== null && !isNaN(s.turnover)) {
      totalMarketTurnover += s.turnover;
    }
  }

  // 2. 依 CODE_TO_GROUP 聚合
  for (const s of stocks) {
    const ref = CODE_TO_GROUP.get(s.code);
    if (!ref) continue;

    const { group, category } = ref;
    if (!groupMap.has(group)) {
      groupMap.set(group, {
        category,
        sumChangePct: 0,
        turnover: 0,
        count: 0,
        valid_count: 0,
        up_count: 0,
      });
    }

    const item = groupMap.get(group)!;
    item.count += 1;

    if (s.turnover !== null && !isNaN(s.turnover)) {
      item.turnover += s.turnover;
    }

    if (s.change_pct !== null && !isNaN(s.change_pct)) {
      item.sumChangePct += s.change_pct;
      item.valid_count += 1;
      if (s.change_pct > 0) {
        item.up_count += 1;
      }
    }
  }

  // 3. 轉為 GroupAgg[]，排除 valid_count === 0 的族群
  const result: GroupAgg[] = [];
  for (const [group, item] of groupMap.entries()) {
    if (item.valid_count === 0) continue;

    const avg_change_pct = item.sumChangePct / item.valid_count;
    const turnover_share = totalMarketTurnover > 0 ? (item.turnover / totalMarketTurnover) * 100 : 0;

    result.push({
      group,
      category: item.category,
      avg_change_pct,
      turnover: item.turnover,
      turnover_share,
      count: item.count,
      valid_count: item.valid_count,
      up_count: item.up_count,
    });
  }

  return result;
}

/** 依成交值取前 N（預設 30） */
export function selectTopGroups(groups: GroupAgg[], n = 30): GroupAgg[] {
  return [...groups]
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, n);
}
