// ── 標的定義【增修I】────────────────────────────────────────────
export const ETF_CODE = '00631L';
// 防守端債券 ETF：閒置資金＝固定現金保留額＋債券池（00687B:00953B＝6:4），皆視為 β=0
export const BOND_ETFS = [
  { code: '00687B', name: '國泰20年美債' },
  { code: '00953B', name: '群益優選非投等債' },
] as const;
export const DEFAULT_CASH_RESERVE = 100_000; // 固定保留現金（TWD）
export const DEFAULT_BOND_SPLIT = 0.6;       // 債券池中 00687B 佔比（00953B＝1−split）

// ── 買賣報價單（交易紀錄）與部位累算 ──────────────────────────────
export interface Trade {
  id: string;            // 唯一鍵（前端產生；lib 不生成以保持純淨）
  date: string;          // 交易日 YYYY-MM-DD（排序用）
  side: 'buy' | 'sell';  // 買進 / 賣出
  shares: number;        // 股數（≥0）
  price: number;         // 成交價 TWD（≥0）
  code?: string;         // 標的代號【增修I】；缺省＝00631L（向後相容舊資料）
}

export interface PositionAgg {
  shares: number;        // 期末總股數（期初 + 所有交易後）
  avg_cost: number;      // 加權平均成本（0＝無成本資訊或已清空）
  cash: number;          // 期末閒置現金（期初現金 − 買進金額 ＋ 賣出金額；可為負，供 UI 警示，落地時 clamp≥0）
  realized_pnl: number;  // 累計已實現損益（賣出時 (賣價−均價)×賣出股數）
  invalid_sells: number; // 超賣（賣超過持有）被 clamp 的筆數，供 UI 提示
}

/**
 * 由「期初部位」＋依日期排序的交易紀錄，累算期末總股數、加權平均成本與閒置現金。
 *   - 買進：成本基礎 += 股數×價格，均價＝成本基礎/總股數；現金 −= 股數×價格。
 *   - 賣出：只減股數（標準加權平均法，均價不變）；已實現損益＝(賣價−均價)×賣出股數；
 *           現金 += 實際賣出股數×價格（超賣 clamp 後只計實際成交部分）；
 *           超賣（賣超過持有）clamp 到持有量並計入 invalid_sells。股數歸零時均價與成本歸零。
 * 純函式、全路徑防 NaN；不依賴 Date/crypto。
 */
export function aggregatePosition(
  opening: { shares?: number; avg_cost?: number; cash?: number } | null | undefined,
  trades: Trade[] | null | undefined,
): PositionAgg {
  let shares = Math.max(0, safeNum(opening?.shares, 0));
  let avg_cost = Math.max(0, safeNum(opening?.avg_cost, 0));
  let cash = Math.max(0, safeNum(opening?.cash, 0));
  let cost_basis = shares * avg_cost;
  let realized_pnl = 0;
  let invalid_sells = 0;

  const list = Array.isArray(trades) ? [...trades] : [];
  // 依日期升冪穩定排序（同日保留輸入順序）
  list.sort((a, b) => {
    const da = typeof a?.date === 'string' ? a.date : '';
    const db = typeof b?.date === 'string' ? b.date : '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const t of list) {
    const tShares = Math.max(0, safeNum(t?.shares, 0));
    const tPrice = Math.max(0, safeNum(t?.price, 0));
    if (tShares <= 0) continue;
    if (t?.side === 'sell') {
      const sold = Math.min(tShares, shares);
      if (tShares > shares) invalid_sells += 1;
      if (sold > 0) {
        realized_pnl += (tPrice - avg_cost) * sold;
        cash += sold * tPrice;
        cost_basis -= avg_cost * sold;
        shares -= sold;
        if (shares <= 0) {
          shares = 0;
          cost_basis = 0;
          avg_cost = 0;
        }
      }
    } else {
      // 預設 / 'buy'
      cost_basis += tShares * tPrice;
      shares += tShares;
      avg_cost = shares > 0 ? cost_basis / shares : 0;
      cash -= tShares * tPrice;
    }
  }

  return {
    shares: Number.isFinite(shares) ? shares : 0,
    avg_cost: Number.isFinite(avg_cost) ? avg_cost : 0,
    cash: Number.isFinite(cash) ? cash : 0,
    realized_pnl: Number.isFinite(realized_pnl) ? realized_pnl : 0,
    invalid_sells,
  };
}

// ── 多資產部位累算【增修I】────────────────────────────────────────
export interface PortfolioPosition {
  shares: number;
  avg_cost: number;
}

export interface PortfolioAgg {
  cash: number;                                   // 全資產共用現金（買扣賣加；可為負供警示）
  realized_pnl: number;                           // 全資產累計已實現損益
  invalid_sells: number;                          // 全資產超賣筆數
  positions: Record<string, PortfolioPosition>;   // 依代號的期末部位
}

/**
 * 多資產版 aggregatePosition：所有標的共用同一池現金（任一標的買進扣現金、賣出加現金）。
 * 交易依日期全域排序後逐筆套用；缺 code 的舊交易視為 00631L。
 * 每檔標的邏輯與 aggregatePosition 一致（加權均價、賣出不改均價、超賣 clamp）。
 */
export function aggregatePortfolio(
  opening: {
    cash?: number;
    positions?: Record<string, { shares?: number; avg_cost?: number } | undefined>;
  } | null | undefined,
  trades: Trade[] | null | undefined,
): PortfolioAgg {
  let cash = Math.max(0, safeNum(opening?.cash, 0));
  let realized_pnl = 0;
  let invalid_sells = 0;

  const positions: Record<string, { shares: number; avg_cost: number; cost_basis: number }> = {};
  const openPos = opening?.positions ?? {};
  for (const code of Object.keys(openPos)) {
    const p = openPos[code];
    const shares = Math.max(0, safeNum(p?.shares, 0));
    const avg_cost = Math.max(0, safeNum(p?.avg_cost, 0));
    positions[code] = { shares, avg_cost, cost_basis: shares * avg_cost };
  }

  const list = Array.isArray(trades) ? [...trades] : [];
  list.sort((a, b) => {
    const da = typeof a?.date === 'string' ? a.date : '';
    const db = typeof b?.date === 'string' ? b.date : '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const t of list) {
    const tShares = Math.max(0, safeNum(t?.shares, 0));
    const tPrice = Math.max(0, safeNum(t?.price, 0));
    if (tShares <= 0) continue;
    const code = typeof t?.code === 'string' && t.code ? t.code : ETF_CODE;
    if (!positions[code]) positions[code] = { shares: 0, avg_cost: 0, cost_basis: 0 };
    const pos = positions[code];

    if (t?.side === 'sell') {
      const sold = Math.min(tShares, pos.shares);
      if (tShares > pos.shares) invalid_sells += 1;
      if (sold > 0) {
        realized_pnl += (tPrice - pos.avg_cost) * sold;
        cash += sold * tPrice;
        pos.cost_basis -= pos.avg_cost * sold;
        pos.shares -= sold;
        if (pos.shares <= 0) {
          pos.shares = 0;
          pos.cost_basis = 0;
          pos.avg_cost = 0;
        }
      }
    } else {
      pos.cost_basis += tShares * tPrice;
      pos.shares += tShares;
      pos.avg_cost = pos.shares > 0 ? pos.cost_basis / pos.shares : 0;
      cash -= tShares * tPrice;
    }
  }

  const out: Record<string, PortfolioPosition> = {};
  for (const code of Object.keys(positions)) {
    const p = positions[code];
    out[code] = {
      shares: Number.isFinite(p.shares) ? p.shares : 0,
      avg_cost: Number.isFinite(p.avg_cost) ? p.avg_cost : 0,
    };
  }

  return {
    cash: Number.isFinite(cash) ? cash : 0,
    realized_pnl: Number.isFinite(realized_pnl) ? realized_pnl : 0,
    invalid_sells,
    positions: out,
  };
}

// ── 防守端債券輸入／計畫【增修I】──────────────────────────────────
export interface BondInput {
  code: string;
  shares: number;        // 持有股數（≥0）
  price: number;         // 現價 TWD（>0 才能換算交易股數）
  avg_cost?: number;     // 平均成本（選填，純顯示未實現損益）
}

export interface BondPlan {
  code: string;
  shares: number;
  price: number;
  value: number;                     // shares × price
  weight: number | null;             // value / total_value
  target_value: number | null;       // 債券池 × 配比
  value_delta: number | null;        // target_value − value（+買 −賣）
  trade_shares: number | null;       // round(value_delta / price)；price≤0 → null
  post_shares: number | null;        // 整股成交後股數
  cost_basis: number | null;         // 純顯示未實現損益（avg_cost>0 且 shares>0 才有值）
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
}

export interface RebalanceInput {
  shares: number;        // 00631L 持有股數（≥0）
  price: number;         // 00631L 現價 TWD（手動或自動抓取；>0 才能算交易股數）
  avg_cost?: number;     // 00631L 每股平均成本 TWD（選填，≥0；純顯示未實現損益、不影響再平衡計算）
  cash: number;          // 現金 TWD（≥0）
  target_beta: number;   // 目標投組 β（滑桿，預設 1.3）
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑：百分比 / 絕對 β（預設 'abs'）
  threshold_pct: number; // 容忍區間 %（pct 模式用；預設 10 = ±10%）
  threshold_abs: number; // 容忍區間 絕對 β（abs 模式用；預設 0.1 = ±0.1）
  etf_beta: number;      // 00631L 標的 β（預設 2.0；進階可調）
  // 【增修I】防守端＝固定現金保留額＋債券池（00687B:00953B）
  bonds?: BondInput[];      // 債券 ETF 持倉（缺省＝無債券，退回純現金模型）
  cash_reserve?: number;    // 固定保留現金（預設 100,000）
  bond_split?: number;      // 債券池中第一檔（00687B）佔比（預設 0.6）
  locked?: {
    cash?: boolean;
    bonds?: Record<string, boolean>; // key＝債券 code；缺的 code 視為 false
  };
}

export interface RebalanceResult {
  etf_value: number;            // shares × price
  total_value: number;          // etf_value + defensive_value（現金＋債券市值）
  // 【增修I】防守端＝現金＋債券市值（皆視為 β=0）
  bond_value: number;           // Σ 債券 shares × price
  defensive_value: number;      // cash + bond_value
  defensive_weight: number | null; // defensive_value / total_value
  bond_plans: BondPlan[];       // 每檔債券的現況與應買賣計畫
  cash_reserve: number;         // 固定保留現金（echo 輸入，預設 100,000）
  target_defensive_value: number | null; // total − target_etf_value
  target_cash_value: number | null;      // min(cash_reserve, target_defensive_value)
  cash_adjust_delta: number | null;      // target_cash_value − cash（防守端內部：現金要調多少）
  // 未實現損益（純顯示；avg_cost≤0 或 shares≤0 → null）
  cost_basis: number | null;        // shares × avg_cost
  unrealized_pnl: number | null;    // etf_value − cost_basis（+獲利 −虧損）
  unrealized_pnl_pct: number | null; // unrealized_pnl / cost_basis
  etf_weight: number | null;    // etf_value / total_value；total≤0 → null
  cash_weight: number | null;
  current_beta: number | null;  // etf_weight × etf_beta；total≤0 → null
  target_beta: number;
  target_etf_weight: number | null;   // clamp(target_beta / etf_beta, 0, 1)；etf_beta≤0 → null
  target_cash_weight: number | null;
  upper_band: number;           // abs: target+abs ; pct: target×(1+pct/100)
  lower_band: number;           // 下限一律 clamp ≥ 0
  deviation_abs: number | null; // current_beta − target_beta
  deviation_pct: number | null; // (current_beta − target)/target；target=0 → null
  status: 'empty' | 'sell' | 'buy' | 'normal';
  action_label: string;         // §2.3
  // 精確達標（保持總資產不變，在 00631L↔現金 間搬錢使 β=target）
  target_etf_value: number | null;
  etf_value_delta: number | null; // target_etf_value − etf_value（+買 −賣）；不可解→null
  cash_delta: number | null;      // = −etf_value_delta
  trade_shares: number | null;    // round(etf_value_delta / price)；price≤0→null
  // 依整股成交後的實況
  post_shares: number | null;
  post_etf_value: number | null;
  post_cash: number | null;
  post_etf_weight: number | null;
  post_cash_weight: number | null;
  post_beta: number | null;
  // 觸發價位（持倉股數與現金固定，反解 00631L 價格）：
  //   價格↑→ETF權重↑→β↑，漲到 sell_trigger_price 時 β 觸上限→該賣；
  //   跌到 buy_trigger_price 時 β 觸下限→該買。無解（如現金=0、上限≥etf_beta）→null。
  sell_trigger_price: number | null;
  buy_trigger_price: number | null;
  note?: string;
  lock_capped: boolean;      // true＝即使注入新現金也無法精確達成目標 β（現金也鎖定，或目標β≥滿槓桿）
  lock_note: string | null;  // 說明文字；未鎖定、鎖定未造成影響、或已靠注入現金解決時為 null
  achieved_beta: number | null; // 依 lock_capped／注入現金後實際能達到的 β
  cash_injection_needed: number | null; // 現金未鎖定但既有防守端資金不足時，需額外「注入」多少新現金才能達成目標（全額用於買進00631L，不動用鎖定資產、不補現金保留額）；無需注入或現金也鎖定時為 null
}

/**
 * 反解：在持倉股數 shares 與防守端市值 defensive（現金＋債券市值，【增修I】前為純現金）固定下，
 * 使投組 β 恰好等於 targetBeta 的 00631L 價格。
 *   β = etf_beta × (shares×P)/(shares×P + defensive)  ⇒  P = targetBeta×defensive / (shares×(etf_beta − targetBeta))
 * 僅在 shares>0、defensive>0、0<targetBeta<etf_beta 時有解；否則（如防守端=0 時 β 恆為 etf_beta 與價格無關、
 * 或目標 β 已達/超過滿槓桿 etf_beta）回 null。
 */
export function triggerPriceForBeta(
  targetBeta: number,
  shares: number,
  defensive: number,
  etf_beta: number,
): number | null {
  const s = safeNum(shares, 0);
  const c = safeNum(defensive, 0);
  const eb = safeNum(etf_beta, 2);
  const b = safeNum(targetBeta, 0);
  if (!(s > 0) || !(c > 0) || !(eb > 0)) return null;
  if (!(b > 0) || b >= eb) return null;
  const p = (b * c) / (s * (eb - b));
  return Number.isFinite(p) && p > 0 ? p : null;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

// ── 防守端內部配置【增修K】────────────────────────────────────────
export interface DefensiveAllocation {
  cash: number;
  bond_values: number[]; // 依傳入 currentBondValues 的順序（index 0＝優先保留／最後才變現的那一檔）
}

/**
 * 決定防守端（現金＋債券池）內部如何配置到目標值。固定保留 cashReserve 現金，
 * 剩餘（bondPool）與現有債券總值比較：
 *   - 縮水（bondPool < 現有債券總值，例如加碼 00631L 要從防守端抽錢）：**優先變現瀑布**——
 *     依 currentBondValues 陣列順序（index 0 優先），先把第一檔賣到 0，賣不夠才動下一檔。
 *     這是報告「美債優先變現」的核心：index 0 放最適合在股災時變現的資產（如 00687B，
 *     具避險溢價），保留其餘資產（如 00953B 月配息）繼續供息。
 *   - 擴張或不變（bondPool ≥ 現有債券總值，例如賣 00631L 獲利了結回補防守端）：
 *     依 bondSplit 比例 snap 到目標值（第一檔佔 bondSplit、其餘平分剩下 1−bondSplit）——
 *     報告只對「變現方向」主張優先順序，回補方向維持等比例。
 * 純函式、全路徑防 NaN；currentBondValues 僅支援 1~2 檔（本站防守端固定兩檔債券）。
 */
export function allocateDefensive(
  targetDefensiveValue: number,
  currentBondValues: number[],
  cashReserve: number,
  bondSplit: number,
): DefensiveAllocation {
  const target = Math.max(0, safeNum(targetDefensiveValue, 0));
  const reserve = Math.max(0, safeNum(cashReserve, 0));
  const split = clamp(safeNum(bondSplit, DEFAULT_BOND_SPLIT), 0, 1);
  const values = (Array.isArray(currentBondValues) ? currentBondValues : []).map((v) => Math.max(0, safeNum(v, 0)));

  const cash = clamp(reserve, 0, target);
  const bondPool = Math.max(0, target - cash);
  const currentTotal = values.reduce((s, v) => s + v, 0);
  const delta = bondPool - currentTotal;

  let bond_values: number[];
  if (delta < 0) {
    // 縮水：優先變現瀑布，index 0 先賣到 0
    let remaining = -delta;
    bond_values = values.map((v) => {
      const sell = Math.min(v, remaining);
      remaining -= sell;
      return v - sell;
    });
  } else {
    // 擴張或不變：依 bondSplit 比例 snap 到目標值（僅支援兩檔，第三檔以上均分剩餘 0）
    const splits = values.map((_, i) => (i === 0 ? split : i === 1 ? 1 - split : 0));
    bond_values = splits.map((s) => bondPool * s);
  }

  return { cash, bond_values };
}

// ── 防守端內部鎖定配置【優化專案 19】──────────────────────────────────
export interface DefensiveAllocationLockedInput {
  targetDefensiveValue: number;
  cash: { value: number; reserve: number; locked: boolean };
  bonds: { code: string; value: number; locked: boolean }[]; // 順序＝優先變現順序，同 allocateDefensive
  bondSplit: number;
}

export interface DefensiveAllocationLockedResult {
  cash_value: number;
  bond_values: number[]; // 與輸入 bonds 同順序
}

export function allocateDefensiveWithLocks(
  input: DefensiveAllocationLockedInput,
): DefensiveAllocationLockedResult {
  const targetDef = Math.max(0, safeNum(input.targetDefensiveValue, 0));
  const cashVal = Math.max(0, safeNum(input.cash.value, 0));
  const cashReserve = Math.max(0, safeNum(input.cash.reserve, 0));
  const bondSplit = clamp(safeNum(input.bondSplit, DEFAULT_BOND_SPLIT), 0, 1);

  const lockedCashVal = input.cash.locked ? cashVal : 0;
  const lockedBondsSum = input.bonds.reduce((s, b) => s + (b.locked ? b.value : 0), 0);

  const unlocked_pool = Math.max(0, targetDef - lockedCashVal - lockedBondsSum);

  let cash_target = 0;
  let bondPool = 0;

  if (!input.cash.locked) {
    cash_target = clamp(cashReserve, 0, unlocked_pool);
    bondPool = unlocked_pool - cash_target;
  } else {
    cash_target = cashVal;
    bondPool = unlocked_pool;
  }

  const unlockedBonds = input.bonds.filter((b) => !b.locked);
  const bondValuesMap = new Map<string, number>();

  // Initialize map with locked values
  for (const b of input.bonds) {
    if (b.locked) {
      bondValuesMap.set(b.code, b.value);
    }
  }

  if (unlockedBonds.length === 2) {
    const values = unlockedBonds.map((b) => b.value);
    const currentTotal = values.reduce((s, v) => s + v, 0);
    const delta = bondPool - currentTotal;
    let allocated: number[];

    if (delta < 0) {
      let remaining = -delta;
      allocated = values.map((v) => {
        const sell = Math.min(v, remaining);
        remaining -= sell;
        return v - sell;
      });
    } else {
      allocated = [bondPool * bondSplit, bondPool * (1 - bondSplit)];
    }

    unlockedBonds.forEach((b, i) => {
      bondValuesMap.set(b.code, allocated[i]);
    });
  } else if (unlockedBonds.length === 1) {
    bondValuesMap.set(unlockedBonds[0].code, bondPool);
  } else if (unlockedBonds.length === 0) {
    if (!input.cash.locked) {
      cash_target += bondPool;
    }
  }

  const bond_values = input.bonds.map((b) => bondValuesMap.get(b.code) ?? 0);
  return {
    cash_value: cash_target,
    bond_values,
  };
}

function safeNum(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function computeRebalance(input: RebalanceInput): RebalanceResult {
  const shares = Math.max(0, safeNum(input?.shares, 0));
  const price = Math.max(0, safeNum(input?.price, 0));
  const avg_cost = Math.max(0, safeNum(input?.avg_cost, 0));
  const cash = Math.max(0, safeNum(input?.cash, 0));
  const target_beta = safeNum(input?.target_beta, 1.3);
  const tolerance_mode: 'pct' | 'abs' = input?.tolerance_mode === 'pct' ? 'pct' : 'abs';
  const threshold_pct = Math.max(0, safeNum(input?.threshold_pct, 10));
  const threshold_abs = Math.max(0, safeNum(input?.threshold_abs, 0.1));
  const etf_beta = safeNum(input?.etf_beta, 2.0);
  // 【增修I】防守端參數
  const cash_reserve = Math.max(0, safeNum(input?.cash_reserve, DEFAULT_CASH_RESERVE));
  const bond_split = clamp(safeNum(input?.bond_split, DEFAULT_BOND_SPLIT), 0, 1);
  const bonds: BondInput[] = (Array.isArray(input?.bonds) ? input.bonds : [])
    .filter((b): b is BondInput => !!b && typeof b.code === 'string' && b.code !== '')
    .map((b) => ({
      code: b.code,
      shares: Math.max(0, safeNum(b.shares, 0)),
      price: Math.max(0, safeNum(b.price, 0)),
      avg_cost: Math.max(0, safeNum(b.avg_cost, 0)),
    }));

  const etf_value = shares * price;
  const bond_value = bonds.reduce((sum, b) => sum + b.shares * b.price, 0);
  const defensive_value = cash + bond_value;
  const total_value = etf_value + defensive_value;

  // 未實現損益（純顯示，不參與再平衡計算）：有股數且有成本才算
  let cost_basis: number | null = null;
  let unrealized_pnl: number | null = null;
  let unrealized_pnl_pct: number | null = null;
  if (shares > 0 && avg_cost > 0) {
    cost_basis = shares * avg_cost;
    unrealized_pnl = etf_value - cost_basis;
    unrealized_pnl_pct = cost_basis > 0 ? unrealized_pnl / cost_basis : null;
  }

  // 算 target配比
  let target_etf_weight: number | null = null;
  let target_cash_weight: number | null = null;
  if (etf_beta > 0) {
    target_etf_weight = clamp(target_beta / etf_beta, 0, 1);
    target_cash_weight = 1 - target_etf_weight;
  }

  // 【增修A】容忍區間依模式：絕對 ±β（target±abs）或 百分比（target×(1±%)）；下限 clamp ≥ 0
  const upper_band =
    tolerance_mode === 'abs' ? target_beta + threshold_abs : target_beta * (1 + threshold_pct / 100);
  const lower_band = Math.max(
    tolerance_mode === 'abs' ? target_beta - threshold_abs : target_beta * (1 - threshold_pct / 100),
    0,
  );

  // 【增修I】債券計畫的「現況」部分（目標值在下方有 total 後才算）
  const mkBondPlanBase = (b: BondInput): BondPlan => {
    const value = b.shares * b.price;
    let bond_cost_basis: number | null = null;
    let bond_pnl: number | null = null;
    let bond_pnl_pct: number | null = null;
    if (b.shares > 0 && (b.avg_cost ?? 0) > 0) {
      bond_cost_basis = b.shares * (b.avg_cost ?? 0);
      bond_pnl = value - bond_cost_basis;
      bond_pnl_pct = bond_cost_basis > 0 ? bond_pnl / bond_cost_basis : null;
    }
    return {
      code: b.code,
      shares: b.shares,
      price: b.price,
      value,
      weight: null,
      target_value: null,
      value_delta: null,
      trade_shares: null,
      post_shares: null,
      cost_basis: bond_cost_basis,
      unrealized_pnl: bond_pnl,
      unrealized_pnl_pct: bond_pnl_pct,
    };
  };

  if (total_value <= 0) {
    return {
      etf_value: 0,
      total_value: 0,
      bond_value: 0,
      defensive_value: 0,
      defensive_weight: null,
      bond_plans: bonds.map(mkBondPlanBase),
      cash_reserve,
      target_defensive_value: null,
      target_cash_value: null,
      cash_adjust_delta: null,
      cost_basis,
      unrealized_pnl,
      unrealized_pnl_pct,
      etf_weight: null,
      cash_weight: null,
      current_beta: null,
      target_beta,
      target_etf_weight,
      target_cash_weight,
      upper_band,
      lower_band,
      deviation_abs: null,
      deviation_pct: null,
      status: 'empty',
      action_label: '尚未輸入持倉',
      target_etf_value: null,
      etf_value_delta: null,
      cash_delta: null,
      trade_shares: null,
      post_shares: null,
      post_etf_value: null,
      post_cash: null,
      post_etf_weight: null,
      post_cash_weight: null,
      post_beta: null,
      sell_trigger_price: null,
      buy_trigger_price: null,
      note: '尚未輸入持倉',
      lock_capped: false,
      lock_note: null,
      achieved_beta: null,
      cash_injection_needed: null,
    };
  }

  const etf_weight = etf_value / total_value;
  const cash_weight = cash / total_value;
  const defensive_weight = defensive_value / total_value;
  const current_beta = etf_weight * etf_beta;

  const deviation_abs = current_beta - target_beta;
  const deviation_pct = target_beta !== 0 ? (current_beta - target_beta) / target_beta : null;

  let status: 'sell' | 'buy' | 'normal' = 'normal';
  if (current_beta > upper_band) {
    status = 'sell';
  } else if (current_beta < lower_band) {
    status = 'buy';
  }

  let target_etf_value: number | null = null;
  let etf_value_delta: number | null = null;
  let cash_delta: number | null = null;
  let trade_shares: number | null = null;

  // 【增修I】防守端內部配置：固定保留 cash_reserve 現金，剩餘依 bond_split 分配到債券池
  let target_defensive_value: number | null = null;
  let target_cash_value: number | null = null;
  let cash_adjust_delta: number | null = null;
  const bond_plans: BondPlan[] = bonds.map(mkBondPlanBase);
  for (const p of bond_plans) p.weight = p.value / total_value;

  let lock_capped = false;
  let lock_note: string | null = null;
  let achieved_beta: number | null = null;
  let cash_injection_needed: number | null = null;

  if (target_etf_weight !== null) {
    const naive_target_etf_value = target_etf_weight * total_value;

    const lockedCash = input.locked?.cash === true;
    const lockedBonds = bonds.map((b) => input.locked?.bonds?.[b.code] === true);
    const allDefensiveLocked =
      lockedCash && (bonds.length > 0 ? lockedBonds.every(Boolean) : true);

    let target_etf_value_actual = 0;
    let effective_total_value = total_value; // 注入新現金時，防守端配置改以「原總資產＋注入」為分母

    if (allDefensiveLocked) {
      target_etf_value_actual = etf_value;
      lock_capped = Math.abs(naive_target_etf_value - etf_value) >= 1;
      lock_note = lock_capped
        ? '現金／債券皆已鎖定，投組曝險無法調整（等同鎖死整體配置）'
        : null;
    } else {
      const locked_defensive_sum =
        (lockedCash ? cash : 0) +
        bonds.reduce((s, b, i) => s + (lockedBonds[i] ? b.shares * b.price : 0), 0);
      const headroom = total_value - locked_defensive_sum;
      const shortfall = naive_target_etf_value - headroom;

      // 現金未鎖定、且既有（未鎖定）資金不足以達到目標 β 時：可從外部「注入」新現金，
      // 全額用於買進 00631L（不動用鎖定資產、不強制補現金保留額——見 opt19 增修對話定案）。
      // 解 X：(headroom+X) = target_etf_weight×(total_value+X) ⇒ X = shortfall/(1−target_etf_weight)。
      if (shortfall >= 1 && !lockedCash && 1 - target_etf_weight > 1e-9) {
        const injected = shortfall / (1 - target_etf_weight);
        target_etf_value_actual = headroom + injected;
        effective_total_value = total_value + injected;
        cash_injection_needed = injected;
        lock_capped = false;
        lock_note = `已鎖定資產現值合計 $${Math.round(locked_defensive_sum).toLocaleString()} 超過目前可用空間，需先注入新現金 $${Math.round(injected).toLocaleString()}（全額用於買進 00631L，不動用鎖定資產）才能達成目標`;
      } else {
        target_etf_value_actual = Math.min(naive_target_etf_value, headroom);
        lock_capped = Math.abs(target_etf_value_actual - naive_target_etf_value) >= 1;
        lock_note = lock_capped
          ? `已鎖定資產現值合計 $${Math.round(locked_defensive_sum).toLocaleString()} 超過目標防守端可用空間，00631L 僅能達成部分調整`
          : null;
      }
    }

    target_etf_value = target_etf_value_actual;
    etf_value_delta = target_etf_value - etf_value;
    cash_delta = -etf_value_delta;

    target_defensive_value = effective_total_value - target_etf_value;

    const defensiveInput: DefensiveAllocationLockedInput = {
      targetDefensiveValue: target_defensive_value,
      cash: { value: cash, reserve: cash_reserve, locked: input.locked?.cash === true },
      bonds: bonds.map((b, i) => ({
        code: b.code,
        value: b.shares * b.price,
        locked: input.locked?.bonds?.[b.code] === true,
      })),
      bondSplit: bond_split,
    };

    const allocation = allocateDefensiveWithLocks(defensiveInput);
    target_cash_value = allocation.cash_value;
    cash_adjust_delta = target_cash_value - cash;

    bond_plans.forEach((p, i) => {
      p.target_value = allocation.bond_values[i] ?? 0;
      p.value_delta = p.target_value - p.value;
      if (p.price > 0) {
        p.trade_shares = Math.round(p.value_delta / p.price);
        p.post_shares = p.shares + p.trade_shares;
      }
    });

    achieved_beta = effective_total_value > 0 ? (target_etf_value / effective_total_value) * etf_beta : null;
  }

  let note: string | undefined = undefined;
  if (price <= 0) {
    trade_shares = null;
    note = '填入現價才能換算交易股數';
  } else if (etf_value_delta !== null) {
    trade_shares = Math.round(etf_value_delta / price);
  }

  let post_shares: number | null = null;
  let post_etf_value: number | null = null;
  let post_cash: number | null = null;
  let post_etf_weight: number | null = null;
  let post_cash_weight: number | null = null;
  let post_beta: number | null = null;

  if (trade_shares !== null && price > 0) {
    post_shares = shares + trade_shares;
    post_etf_value = post_shares * price;
    // 【增修I】整股成交後的現金＝扣掉 00631L 交易，再扣掉債券端各檔的整股交易
    let bondTradeAmount = 0;
    let post_bond_value = 0;
    for (const p of bond_plans) {
      if (p.trade_shares !== null && p.post_shares !== null && p.price > 0) {
        bondTradeAmount += p.trade_shares * p.price;
        post_bond_value += p.post_shares * p.price;
      } else {
        post_bond_value += p.value; // 無價無法交易 → 維持現值
      }
    }
    post_cash = cash + (cash_injection_needed ?? 0) - trade_shares * price - bondTradeAmount;
    const post_total = post_etf_value + post_cash + post_bond_value;
    post_etf_weight = post_total > 0 ? post_etf_value / post_total : 0;
    post_cash_weight = post_total > 0 ? post_cash / post_total : 0;
    post_beta = post_etf_weight * etf_beta;
  }

  // 觸發價位：持倉與防守端市值（現金＋債券）固定，反解讓 β 觸上/下限的 00631L 價格【增修I】
  const sell_trigger_price = triggerPriceForBeta(upper_band, shares, defensive_value, etf_beta);
  const buy_trigger_price = triggerPriceForBeta(lower_band, shares, defensive_value, etf_beta);

  let action_label = '';
  if (status === 'normal') {
    if (tolerance_mode === 'abs') {
      const devStr = deviation_abs !== null ? Math.abs(deviation_abs).toFixed(2) : '0.00';
      action_label = `✅ 正常範圍（偏離 ${devStr} β，未超過 ±${threshold_abs} β）`;
    } else {
      const devStr = deviation_pct !== null ? (Math.abs(deviation_pct) * 100).toFixed(1) : '0.0';
      action_label = `✅ 正常範圍（偏離 ${devStr}%，未超過 ±${threshold_pct}%）`;
    }
  } else if (status === 'sell') {
    const absDeltaStr = etf_value_delta !== null ? Math.round(Math.abs(etf_value_delta)).toLocaleString() : '0';
    const absSharesStr = trade_shares !== null ? Math.abs(trade_shares).toLocaleString() : '—';
    action_label = `⚠ 已破上限 ${upper_band.toFixed(2)} → 建議賣出 00631L 約 $${absDeltaStr}（約 ${absSharesStr} 股）換現金`;
  } else if (status === 'buy') {
    const absDeltaStr = etf_value_delta !== null ? Math.round(Math.abs(etf_value_delta)).toLocaleString() : '0';
    const absSharesStr = trade_shares !== null ? Math.abs(trade_shares).toLocaleString() : '—';
    action_label = `⚠ 已破下限 ${lower_band.toFixed(2)} → 建議買進 00631L 約 $${absDeltaStr}（約 ${absSharesStr} 股）`;
  }

  return {
    etf_value,
    total_value,
    bond_value,
    defensive_value,
    defensive_weight,
    bond_plans,
    cash_reserve,
    target_defensive_value,
    target_cash_value,
    cash_adjust_delta,
    cost_basis,
    unrealized_pnl,
    unrealized_pnl_pct,
    etf_weight,
    cash_weight,
    current_beta,
    target_beta,
    target_etf_weight,
    target_cash_weight,
    upper_band,
    lower_band,
    deviation_abs,
    deviation_pct,
    status,
    action_label,
    target_etf_value,
    etf_value_delta,
    cash_delta,
    trade_shares,
    post_shares,
    post_etf_value,
    post_cash,
    post_etf_weight,
    post_cash_weight,
    post_beta,
    sell_trigger_price,
    buy_trigger_price,
    note,
    lock_capped,
    lock_note,
    achieved_beta,
    cash_injection_needed,
  };
}

// ── 資金流向百分比計算【優化專案 18】 ─────────────────────────────────
export interface FundFlowNode {
  key: string;       // 'etf' | 'cash' | 債券 code
  label: string;     // 顯示名稱：'00631L'｜'現金儲備'｜'00687B 國泰20年美債'
  amount: number;     // 絕對金額（>0）
  breakdown: { key: string; label: string; amount: number; pct: number }[];
  // ↑ 只在「對面清單（用途 for 來源／來源 for 用途）」筆數 ≥ 2 時才非空；
  //   否則回傳 []（1 對 1 搬錢時 100% 是廢話，不顯示）
}

export interface FundFlowBreakdown {
  sources: FundFlowNode[]; // value_delta < 0（且 |value_delta| ≥ 1）的 bucket，依金額大到小排序
  uses: FundFlowNode[];    // value_delta > 0（且 value_delta ≥ 1）的 bucket，依金額大到小排序
}

export function computeFundFlows(result: RebalanceResult): FundFlowBreakdown {
  if (result.status === 'empty' || result.status === 'normal') {
    return { sources: [], uses: [] };
  }

  // 1. 組出候選 bucket 清單
  const candidates: { key: string; label: string; delta: number | null }[] = [
    { key: 'etf', label: '00631L', delta: result.etf_value_delta },
    { key: 'cash', label: '現金儲備', delta: result.cash_adjust_delta },
  ];

  for (const p of result.bond_plans) {
    const bondName = BOND_ETFS.find((b) => b.code === p.code)?.name ?? '';
    candidates.push({
      key: p.code,
      label: bondName ? `${p.code} ${bondName}` : p.code,
      delta: p.value_delta,
    });
  }

  // 2. 過濾 delta === null 或 |delta| < 1 的 bucket
  const sources: FundFlowNode[] = [];
  const uses: FundFlowNode[] = [];

  for (const c of candidates) {
    if (c.delta === null) continue;
    const absDelta = Math.abs(c.delta);
    if (absDelta < 1) continue;

    if (c.delta < 0) {
      sources.push({
        key: c.key,
        label: c.label,
        amount: absDelta,
        breakdown: [],
      });
    } else {
      uses.push({
        key: c.key,
        label: c.label,
        amount: absDelta,
        breakdown: [],
      });
    }
  }

  // 3. 依金額大到小排序
  sources.sort((a, b) => b.amount - a.amount);
  uses.sort((a, b) => b.amount - a.amount);

  const total_source = sources.reduce((sum, s) => sum + s.amount, 0);
  const total_use = uses.reduce((sum, u) => sum + u.amount, 0);

  // 7. 全路徑防 NaN／除以零
  if (total_source <= 0 || total_use <= 0) {
    return { sources: [], uses: [] };
  }

  // 5. 若 uses.length >= 2：每個 source 的 breakdown = uses.map(...)
  if (uses.length >= 2) {
    for (const s of sources) {
      s.breakdown = uses.map((u) => ({
        key: u.key,
        label: u.label,
        amount: u.amount,
        pct: u.amount / total_use,
      }));
    }
  }

  // 6. 對稱處理 uses 的 breakdown (來源側，sources.length >= 2 才非空，比例 = s.amount / total_source)
  if (sources.length >= 2) {
    for (const u of uses) {
      u.breakdown = sources.map((s) => ({
        key: s.key,
        label: s.label,
        amount: s.amount,
        pct: s.amount / total_source,
      }));
    }
  }

  return { sources, uses };
}

