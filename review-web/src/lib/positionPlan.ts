// 個股建倉計畫（opt45，仿 5888 戰情卡「建倉計畫」）：用關鍵價位分批、用「最多願意虧多少」反推股數。
//
// 預設：
//   分批＝現價一批＋每一道支撐（最後一道除外）各一批；比重 3 批 40/30/30、2 批 50/50
//   停損＝收盤跌破最後一道支撐（守門）的下緣——跟關鍵價位卡「危險區」、一鍵跌破提醒同一個價
//   股數＝可承受虧損 ÷ Σ（比重 ×（進場價 − 停損價）），再照比重分配、整張或零股無條件捨去
// 全部進場後觸發停損的虧損 ≤ 可承受虧損；沒含手續費與交易稅。
import { roundLevel } from './keyLevels';
import type { KeyLevels } from './keyLevels';

export type StopMode = 'gate' | 'atr2' | 'custom';
export type LotMode = 'lot' | 'odd';

export interface PlanBatchDraft {
  label: string;
  basis: string;
  price: number;
  weight: number; // 百分比，例 40
}

export interface PlanSettings {
  maxLoss: number;
  capital: number | null;
  stopMode: StopMode;
  customStop: number | null;
  lotMode: LotMode;
}

export interface PlanBatch extends PlanBatchDraft {
  shares: number;
  amount: number;
  risk: number; // 這批觸發停損的虧損
  skipped: boolean; // 進場價不高於停損價
}

export interface PlanTarget {
  label: string;
  price: number;
  gainPct: number;
  rMultiple: number | null;
  estimated: boolean;
}

export interface PlanResult {
  stop: number;
  stopBasis: string;
  batches: PlanBatch[];
  totalShares: number;
  totalAmount: number;
  avgCost: number | null;
  lossAtStop: number;
  lossPctOfAmount: number | null;
  cappedByCapital: boolean;
  targets: PlanTarget[];
  warnings: string[];
}

// 預設可以買零股：高價股一張的風險常常就超過一般人的停損預算，整張會算出 0 股
export const DEFAULT_SETTINGS: PlanSettings = {
  maxLoss: 10000,
  capital: null,
  stopMode: 'gate',
  customStop: null,
  lotMode: 'odd',
};

const WEIGHTS: Record<number, number[]> = { 1: [100], 2: [50, 50], 3: [40, 30, 30] };

/** 由關鍵價位產生預設分批（使用者之後可以改價位與比重） */
export function defaultBatches(levels: KeyLevels): PlanBatchDraft[] {
  const supports = levels.zones.filter((z) => z.kind === 'support');
  const entryZones = supports.slice(0, Math.max(0, supports.length - 1)).slice(0, 2);
  const drafts: PlanBatchDraft[] = [{ label: '第一批', basis: '現價', price: roundLevel(levels.close), weight: 0 }];
  entryZones.forEach((z, i) => {
    drafts.push({
      label: i === 0 ? '第二批' : '第三批',
      basis: `${z.label}（${z.bases.join('、')}）`,
      price: roundLevel(z.high),
      weight: 0,
    });
  });
  const w = WEIGHTS[drafts.length];
  return drafts.map((d, i) => ({ ...d, weight: w[i] }));
}

/** 停損價與說明；算不出來回 null */
export function stopPrice(levels: KeyLevels, s: PlanSettings): { price: number; basis: string } | null {
  if (s.stopMode === 'custom') {
    return s.customStop && s.customStop > 0 ? { price: s.customStop, basis: '自訂' } : null;
  }
  if (s.stopMode === 'gate' && levels.danger !== null) {
    const last = levels.zones.filter((z) => z.kind === 'support').pop();
    return { price: roundLevel(levels.danger), basis: `收盤跌破${last ? last.label : '最後一道支撐'}下緣` };
  }
  if (levels.atr !== null) {
    return { price: roundLevel(levels.close - 2 * levels.atr), basis: '現價往下 2 個 ATR' };
  }
  return null;
}

const floorTo = (v: number, unit: number) => Math.floor(v / unit) * unit;

export function computePlan(levels: KeyLevels, drafts: PlanBatchDraft[], s: PlanSettings): PlanResult | null {
  const stop = stopPrice(levels, s);
  if (!stop || !(s.maxLoss > 0)) return null;
  const warnings: string[] = [];
  if (s.stopMode === 'gate' && levels.danger === null) warnings.push('下方沒有支撐可當停損，改用 2 個 ATR');

  const valid = drafts.map((d) => d.price > stop.price && d.weight > 0);
  if (drafts.some((d, i) => !valid[i] && d.weight > 0)) warnings.push('有批次的進場價不高於停損價，已略過');
  const weightSum = drafts.reduce((a, d, i) => a + (valid[i] ? d.weight : 0), 0);
  if (weightSum <= 0) {
    return {
      stop: stop.price, stopBasis: stop.basis, batches: drafts.map((d) => ({ ...d, shares: 0, amount: 0, risk: 0, skipped: true })),
      totalShares: 0, totalAmount: 0, avgCost: null, lossAtStop: 0, lossPctOfAmount: null, cappedByCapital: false,
      targets: [], warnings: [...warnings, '沒有可用的批次'],
    };
  }

  // 每一股的加權風險 → 總股數
  const riskPerUnit = drafts.reduce((a, d, i) => a + (valid[i] ? (d.weight / weightSum) * (d.price - stop.price) : 0), 0);
  let total = s.maxLoss / riskPerUnit;
  let capped = false;
  if (s.capital && s.capital > 0) {
    const costPerUnit = drafts.reduce((a, d, i) => a + (valid[i] ? (d.weight / weightSum) * d.price : 0), 0);
    if (total * costPerUnit > s.capital) {
      total = s.capital / costPerUnit;
      capped = true;
    }
  }

  const unit = s.lotMode === 'lot' ? 1000 : 1;
  const batches: PlanBatch[] = drafts.map((d, i) => {
    if (!valid[i]) return { ...d, shares: 0, amount: 0, risk: 0, skipped: true };
    const shares = floorTo(total * (d.weight / weightSum), unit);
    return { ...d, shares, amount: shares * d.price, risk: shares * (d.price - stop.price), skipped: false };
  });

  const totalShares = batches.reduce((a, b) => a + b.shares, 0);
  const totalAmount = batches.reduce((a, b) => a + b.amount, 0);
  const lossAtStop = batches.reduce((a, b) => a + b.risk, 0);
  const avgCost = totalShares > 0 ? totalAmount / totalShares : null;

  if (s.lotMode === 'lot' && batches.some((b) => !b.skipped && b.shares === 0)) {
    warnings.push('有批次連一張都買不到：可改用零股，或提高可承受虧損');
  }
  if (capped) warnings.push('受資金上限限制，實際停損虧損小於設定');

  const targets: PlanTarget[] = [];
  if (avgCost !== null) {
    const risk = avgCost - stop.price;
    for (const z of levels.zones.filter((zz) => zz.kind === 'resistance').reverse()) {
      const price = roundLevel(z.low);
      targets.push({
        label: z.label,
        price,
        gainPct: (price / avgCost - 1) * 100,
        rMultiple: risk > 0 ? (price - avgCost) / risk : null,
        estimated: !!z.estimated,
      });
    }
  }

  return {
    stop: stop.price,
    stopBasis: stop.basis,
    batches,
    totalShares,
    totalAmount,
    avgCost,
    lossAtStop,
    lossPctOfAmount: totalAmount > 0 ? (lossAtStop / totalAmount) * 100 : null,
    cappedByCapital: capped,
    targets,
    warnings,
  };
}

/** 股數顯示：整張顯示「N 張」，零股顯示「N 股」，混合顯示「N 張 M 股」 */
export function fmtShares(shares: number): string {
  if (shares <= 0) return '0';
  const lots = Math.floor(shares / 1000);
  const odd = shares % 1000;
  if (lots && odd) return `${lots} 張 ${odd} 股`;
  if (lots) return `${lots} 張`;
  return `${odd} 股`;
}

const PLAN_STORAGE_KEY = 'review:positionPlan:v1';

/** 可承受虧損、資金上限、停損方式、整張／零股：跨個股沿用、只存在這台瀏覽器（自訂停損價不存） */
export function loadPlanSettings(): PlanSettings {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw), customStop: null };
  } catch { /* 無痕模式或被封鎖就用預設 */ }
  return DEFAULT_SETTINGS;
}

export function savePlanSettings(s: PlanSettings): void {
  try {
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ ...s, customStop: null }));
  } catch { /* 存不了就算了 */ }
}
