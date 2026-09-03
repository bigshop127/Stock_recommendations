import {
  aggregatePortfolio,
  BOND_ETFS,
  DEFAULT_CASH_RESERVE,
  DEFAULT_BOND_PRIORITY,
  DEFAULT_MACRO_THRESHOLDS,
  ETF_CODE,
  type Trade,
  type BondPriority,
  type MacroState,
  type MacroCombination,
  type MacroIndicator,
} from './rebalance';

const VERSION = 'v1';
const KEY = `review:rebalance:${VERSION}`;

// 【增修I】防守端債券 ETF 持倉（shares/avg_cost 衍生；price 手動或抓價）
export interface BondHolding {
  code: string;
  shares: number;   // 衍生：由 opening + trades 累算，唯讀
  avg_cost: number; // 衍生
  price: number;    // 現價（抓最新價或手動）
}

export interface OpeningBond {
  code: string;
  shares: number;
  avg_cost: number;
}

export interface RebalanceConfig {
  shares: number;                // 00631L 期末總股數（衍生：由 opening + trades 累算，唯讀）
  avg_cost: number;              // 加權平均成本（衍生，唯讀）
  price: number;
  cash: number;                  // 閒置現金（衍生：期初現金 − 全部買進 ＋ 全部賣出，clamp≥0，唯讀）【增修H/I】
  bonds: BondHolding[];          // 防守端債券 ETF（00687B / 00953B）【增修I】
  cash_reserve: number;          // 固定保留現金（預設 100,000）【增修I】
  bond_priority: BondPriority;   // 變現／回補優先順序（預設 'regime_aware'）【regime-aware／2026-09 單一優先回補】
  macro: MacroState;             // 宏觀 regime 指標（Fed 利率 / 長天期美債殖利率 / 匯率）【regime-aware】
  target_beta: number;           // 預設 1.3
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑，預設 'abs'
  threshold_pct: number;         // 預設 10
  threshold_abs: number;         // 預設 0.1
  etf_beta: number;              // 預設 2.0
  tier1_dd: number;              // 預設 0.10
  tier2_dd: number;              // 預設 0.25【2026-09 優化兩階】
  tier3_dd: number;              // 預設 0.28【2026-09 優化兩階】
  beta_mid: number;              // 小股災中繼目標 β，預設 1.6【2026-09 優化兩階】
  // 買賣報價單機制（多資產：trade.code 缺省＝00631L）
  opening: { shares: number; avg_cost: number; cash: number; bonds: OpeningBond[] }; // 期初部位【增修H/I】
  trades: Trade[];               // 買賣紀錄（可增刪）
  locked: { cash: boolean; bonds: Record<string, boolean> };
}

const SEED_CONFIG: RebalanceConfig = {
  shares: 0,
  avg_cost: 0,
  price: 0,
  cash: 0,
  bonds: BOND_ETFS.map((b) => ({ code: b.code, shares: 0, avg_cost: 0, price: 0 })),
  cash_reserve: DEFAULT_CASH_RESERVE,
  bond_priority: DEFAULT_BOND_PRIORITY,
  macro: { thresholds: { ...DEFAULT_MACRO_THRESHOLDS }, combination: 'any' },
  target_beta: 1.3,
  tolerance_mode: 'abs',
  threshold_pct: 10,
  threshold_abs: 0.1,
  etf_beta: 2.0,
  tier1_dd: 0.10,
  tier2_dd: 0.25,
  tier3_dd: 0.28,
  beta_mid: 1.6,
  opening: {
    shares: 0,
    avg_cost: 0,
    cash: 0,
    bonds: BOND_ETFS.map((b) => ({ code: b.code, shares: 0, avg_cost: 0 })),
  },
  trades: [],
  locked: { cash: false, bonds: { '00687B': false, '00953B': false } },
};

function seedCopy(): RebalanceConfig {
  return {
    ...SEED_CONFIG,
    bonds: SEED_CONFIG.bonds.map((b) => ({ ...b })),
    opening: { ...SEED_CONFIG.opening, bonds: SEED_CONFIG.opening.bonds.map((b) => ({ ...b })) },
    trades: [],
    locked: { cash: SEED_CONFIG.locked.cash, bonds: { ...SEED_CONFIG.locked.bonds } },
    macro: { thresholds: { ...DEFAULT_MACRO_THRESHOLDS }, combination: SEED_CONFIG.macro.combination },
  };
}

function safeNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// 【增修A】容忍模式守衛：非 'pct'/'abs' 一律落 'abs'（含舊資料缺欄位）
function safeMode(val: unknown): 'pct' | 'abs' {
  return val === 'pct' ? 'pct' : 'abs';
}

// 【regime-aware】變現優先順序守衛：非明確的 bond1_first/bond2_first 一律落 'regime_aware'
function safeBondPriority(val: unknown): BondPriority {
  return val === 'bond1_first' || val === 'bond2_first' ? val : DEFAULT_BOND_PRIORITY;
}

function safeCombination(val: unknown): MacroCombination {
  return val === 'majority' || val === 'all' ? val : 'any';
}

// 單一宏觀指標：current/reference 皆缺 → undefined（視為無資料、不觸發）
function sanitizeMacroIndicator(v: unknown): MacroIndicator | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const cur = typeof o.current === 'number' && Number.isFinite(o.current) ? o.current : null;
  const ref = typeof o.reference === 'number' && Number.isFinite(o.reference) ? o.reference : null;
  if (cur === null && ref === null) return undefined;
  return {
    current: cur,
    reference: ref,
    as_of: typeof o.as_of === 'string' ? o.as_of : undefined,
    ref_date: typeof o.ref_date === 'string' ? o.ref_date : undefined,
  };
}

// 宏觀 regime 設定：門檻缺欄位補預設、指標值缺→undefined、combination 守衛
function sanitizeMacro(v: unknown): MacroState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const t = (o.thresholds && typeof o.thresholds === 'object' ? o.thresholds : {}) as Record<string, unknown>;
  return {
    fed_rate: sanitizeMacroIndicator(o.fed_rate),
    treasury_yield: sanitizeMacroIndicator(o.treasury_yield),
    fx: sanitizeMacroIndicator(o.fx),
    thresholds: {
      fed_rate_rise: Math.max(0, safeNumber(t.fed_rate_rise, DEFAULT_MACRO_THRESHOLDS.fed_rate_rise)),
      treasury_yield_rise: Math.max(0, safeNumber(t.treasury_yield_rise, DEFAULT_MACRO_THRESHOLDS.treasury_yield_rise)),
      fx_rise_pct: Math.max(0, safeNumber(t.fx_rise_pct, DEFAULT_MACRO_THRESHOLDS.fx_rise_pct)),
    },
    combination: safeCombination(o.combination),
    fetched_at: typeof o.fetched_at === 'string' ? o.fetched_at : undefined,
  };
}

// 清洗單筆交易；無效（負股數/負價）clamp，回傳仍保留供顯示。缺 code 的舊資料視為 00631L【增修I】
function sanitizeTrade(t: unknown, idx: number): Trade | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const shares = Math.max(0, safeNumber(o.shares, 0));
  const price = Math.max(0, safeNumber(o.price, 0));
  const side: 'buy' | 'sell' = o.side === 'sell' ? 'sell' : 'buy';
  const date = typeof o.date === 'string' && o.date ? o.date : '';
  const code = typeof o.code === 'string' && o.code ? o.code : ETF_CODE;
  const id = typeof o.id === 'string' && o.id ? o.id : `t_${date}_${idx}_${shares}_${price}`;
  return { id, date, side, shares, price, code };
}

function sanitizeTrades(val: unknown): Trade[] {
  if (!Array.isArray(val)) return [];
  return val.map((t, i) => sanitizeTrade(t, i)).filter((t): t is Trade => t !== null);
}

// 期初債券部位：對每一檔已知債券 ETF 找對應輸入（缺＝0）【增修I】
function sanitizeOpeningBonds(val: unknown): OpeningBond[] {
  const list = Array.isArray(val) ? (val as Record<string, unknown>[]) : [];
  return BOND_ETFS.map((b) => {
    const found = list.find((x) => x && typeof x === 'object' && x.code === b.code);
    return {
      code: b.code,
      shares: Math.max(0, safeNumber(found?.shares, 0)),
      avg_cost: Math.max(0, safeNumber(found?.avg_cost, 0)),
    };
  });
}

/**
 * 統一正規化：清洗所有欄位、遷移舊資料（無 opening → 用舊 shares/avg_cost 當期初；
 * 無 bonds → 補零持倉；交易缺 code → 00631L），並「重算衍生 shares/avg_cost/cash」
 * ＝ aggregatePortfolio(opening, trades)（多資產共用現金：任一標的買扣賣加）。
 * getRebalanceConfig / saveRebalanceConfig 皆走此函式，確保頂層衍生值永遠與報價單一致
 *（告警腳本 rebalance_alert.cjs 讀頂層 shares/avg_cost/cash/bonds，故此為單一事實來源）。
 */
function normalizeConfig(parsed: Record<string, unknown>): RebalanceConfig {
  const trades = sanitizeTrades(parsed.trades);

  // 遷移：舊資料無 opening 欄位時，用舊頂層 shares/avg_cost 作為期初部位（不丟失原持倉）；
  // 【增修H】opening 無 cash 欄位時，用舊頂層 cash 作為期初現金；
  // 【增修I】opening 無 bonds 欄位時，補零持倉（舊資料本來就沒買債）
  let opening: RebalanceConfig['opening'];
  const op = parsed.opening as Record<string, unknown> | undefined;
  if (op && typeof op === 'object') {
    opening = {
      shares: Math.max(0, safeNumber(op.shares, 0)),
      avg_cost: Math.max(0, safeNumber(op.avg_cost, 0)),
      cash: Math.max(0, safeNumber(op.cash, Math.max(0, safeNumber(parsed.cash, 0)))),
      bonds: sanitizeOpeningBonds(op.bonds),
    };
  } else {
    opening = {
      shares: Math.max(0, safeNumber(parsed.shares, 0)),
      avg_cost: Math.max(0, safeNumber(parsed.avg_cost, 0)),
      cash: Math.max(0, safeNumber(parsed.cash, 0)),
      bonds: sanitizeOpeningBonds(undefined),
    };
  }

  const agg = aggregatePortfolio(
    {
      cash: opening.cash,
      positions: {
        [ETF_CODE]: { shares: opening.shares, avg_cost: opening.avg_cost },
        ...Object.fromEntries(opening.bonds.map((b) => [b.code, { shares: b.shares, avg_cost: b.avg_cost }])),
      },
    },
    trades,
  );

  // 頂層債券持倉：shares/avg_cost 衍生、price 沿用輸入（手動/抓價）【增修I】
  const bondsIn = Array.isArray(parsed.bonds) ? (parsed.bonds as Record<string, unknown>[]) : [];
  const bonds: BondHolding[] = BOND_ETFS.map((b) => {
    const found = bondsIn.find((x) => x && typeof x === 'object' && x.code === b.code);
    const pos = agg.positions[b.code];
    return {
      code: b.code,
      shares: pos ? pos.shares : 0,
      avg_cost: pos ? pos.avg_cost : 0,
      price: Math.max(0, safeNumber(found?.price, 0)),
    };
  });

  const etfPos = agg.positions[ETF_CODE];
  
  let locked: RebalanceConfig['locked'];
  const l = parsed.locked as Record<string, unknown> | undefined;
  if (l && typeof l === 'object') {
    const cash = l.cash === true;
    const bonds: Record<string, boolean> = {};
    const bObj = l.bonds as Record<string, unknown> | undefined;
    BOND_ETFS.forEach((b) => {
      bonds[b.code] = bObj?.[b.code] === true;
    });
    locked = { cash, bonds };
  } else {
    locked = { cash: false, bonds: { '00687B': false, '00953B': false } };
  }

  return {
    shares: etfPos ? etfPos.shares : 0,   // 衍生
    avg_cost: etfPos ? etfPos.avg_cost : 0, // 衍生
    price: Math.max(0, safeNumber(parsed.price, SEED_CONFIG.price)),
    cash: Math.max(0, agg.cash), // 衍生【增修H/I】（負值 clamp 0，UI 另行警示）
    bonds,
    cash_reserve: Math.max(0, safeNumber(parsed.cash_reserve, DEFAULT_CASH_RESERVE)),
    bond_priority: safeBondPriority(parsed.bond_priority),
    macro: sanitizeMacro(parsed.macro),
    target_beta: safeNumber(parsed.target_beta, SEED_CONFIG.target_beta),
    tolerance_mode: safeMode(parsed.tolerance_mode),
    threshold_pct: Math.max(0, safeNumber(parsed.threshold_pct, SEED_CONFIG.threshold_pct)),
    threshold_abs: Math.max(0, safeNumber(parsed.threshold_abs, SEED_CONFIG.threshold_abs)),
    etf_beta: Math.max(0.1, safeNumber(parsed.etf_beta, SEED_CONFIG.etf_beta)),
    tier1_dd: Math.min(1, Math.max(0, safeNumber(parsed.tier1_dd, SEED_CONFIG.tier1_dd))),
    tier2_dd: Math.min(1, Math.max(0, safeNumber(parsed.tier2_dd, SEED_CONFIG.tier2_dd))),
    tier3_dd: Math.min(1, Math.max(0, safeNumber(parsed.tier3_dd, SEED_CONFIG.tier3_dd))),
    beta_mid: Math.max(0.1, safeNumber(parsed.beta_mid, SEED_CONFIG.beta_mid)),
    opening,
    trades,
    locked,
  };
}

export function getRebalanceConfig(): RebalanceConfig {
  const dataStr = localStorage.getItem(KEY);
  if (dataStr === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
    return seedCopy();
  }
  try {
    const parsed = JSON.parse(dataStr);
    if (parsed && typeof parsed === 'object') {
      return normalizeConfig(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse rebalance config from localStorage, resetting to seed data', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED_CONFIG));
  return seedCopy();
}

export function saveRebalanceConfig(cfg: RebalanceConfig): void {
  // 一律走 normalizeConfig：重算衍生 shares/avg_cost/cash，避免呼叫端傳入不一致的頂層值
  const sanitized = normalizeConfig(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(sanitized));
  window.dispatchEvent(new CustomEvent('userstore:rebalance'));
}

export function subscribeRebalance(cb: () => void): () => void {
  const handleCustomEvent = () => cb();
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === KEY) {
      cb();
    }
  };

  window.addEventListener('userstore:rebalance', handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener('userstore:rebalance', handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}
