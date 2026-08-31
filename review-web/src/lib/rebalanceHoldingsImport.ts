// 券商 App「庫存查詢」截圖 → 自動帶入再平衡計算機的期初部位（00631L／債券 ETF／現金）。
// 只認代號在 ETF_CODE / BOND_ETFS 之列的列，其餘持股（其他個股）不影響這台計算機，
// 只列在 unmatched 裡讓使用者知道截圖裡還有哪些沒被用到。
import { ETF_CODE, BOND_ETFS } from './rebalance';
import type { RebalanceConfig, OpeningBond } from './rebalanceStore';

export interface HoldingsScanRow {
  symbol: string;
  name: string;
  shares: number;
  avg_cost: number | null;
  market_price: number | null;
}

export interface HoldingsScanScreen {
  title: string;
  cash: number | null;
  rows: HoldingsScanRow[];
  warnings: string[];
}

export interface HoldingsImportOp {
  code: string;
  label: string;
  text: string;
}

export interface HoldingsImportPlan {
  ops: HoldingsImportOp[];
  changed: boolean;
  next_opening: RebalanceConfig['opening'];
  unmatched: string[];
}

const TRACKED_NAME: Record<string, string> = {
  [ETF_CODE]: '元大台灣50正2',
  ...Object.fromEntries(BOND_ETFS.map((b) => [b.code, b.name])),
};

const fmtQty = (n: number) => Math.round(n).toLocaleString();
const fmtPrice = (n: number) => n.toFixed(2);

export function buildHoldingsImportPlan(config: RebalanceConfig, screens: HoldingsScanScreen[]): HoldingsImportPlan {
  // 同一標的可能出現在多張截圖：後面那張蓋過前面（使用者通常最後補拍最新的一張）。
  const matched = new Map<string, HoldingsScanRow>();
  const unmatchedSet = new Set<string>();
  let cash: number | null = null;

  for (const screen of screens) {
    if (screen.cash !== null) cash = screen.cash;
    for (const row of screen.rows) {
      if (row.symbol === ETF_CODE || BOND_ETFS.some((b) => b.code === row.symbol)) {
        matched.set(row.symbol, row);
      } else if (row.symbol) {
        unmatchedSet.add(row.name && row.name !== row.symbol ? `${row.symbol}(${row.name})` : row.symbol);
      }
    }
  }

  const ops: HoldingsImportOp[] = [];

  const etfRow = matched.get(ETF_CODE);
  const nextShares = etfRow ? etfRow.shares : config.opening.shares;
  const nextAvgCost = etfRow && etfRow.avg_cost !== null ? etfRow.avg_cost : config.opening.avg_cost;
  if (etfRow && (nextShares !== config.opening.shares || nextAvgCost !== config.opening.avg_cost)) {
    ops.push({
      code: ETF_CODE,
      label: TRACKED_NAME[ETF_CODE],
      text: `${ETF_CODE} 期初部位：${fmtQty(config.opening.shares)} 股 @ ${fmtPrice(config.opening.avg_cost)} → ${fmtQty(nextShares)} 股 @ ${fmtPrice(nextAvgCost)}`,
    });
  }

  const nextBonds: OpeningBond[] = config.opening.bonds.map((b) => {
    const row = matched.get(b.code);
    if (!row) return b;
    const shares = row.shares;
    const avg_cost = row.avg_cost !== null ? row.avg_cost : b.avg_cost;
    if (shares !== b.shares || avg_cost !== b.avg_cost) {
      ops.push({
        code: b.code,
        label: TRACKED_NAME[b.code] ?? b.code,
        text: `${b.code} 期初部位：${fmtQty(b.shares)} 股 @ ${fmtPrice(b.avg_cost)} → ${fmtQty(shares)} 股 @ ${fmtPrice(avg_cost)}`,
      });
    }
    return { code: b.code, shares, avg_cost };
  });

  const nextCash = cash !== null ? cash : config.opening.cash;
  if (cash !== null && cash !== config.opening.cash) {
    ops.push({
      code: '_cash',
      label: '期初現金',
      text: `期初現金：$${Math.round(config.opening.cash).toLocaleString()} → $${Math.round(cash).toLocaleString()}`,
    });
  }

  return {
    ops,
    changed: ops.length > 0,
    next_opening: { shares: nextShares, avg_cost: nextAvgCost, cash: nextCash, bonds: nextBonds },
    unmatched: [...unmatchedSet],
  };
}
