/**
 * futuresStore.ts — 期貨損益總覽的設定持久化（本機 localStorage ＋ 雲端 gateway）。
 *
 * 結構刻意比照 rebalanceStore：所有讀寫都過 normalizeFutures()，缺欄位補預設、
 * 型別不對就 clamp，避免舊資料或手改的雲端檔把頁面弄爆。雲端那份（gateway 的
 * data/futures_positions.json）為事實來源，本機這份是離線快取。
 */
import { MAX_IMPORTED_REFS } from './futuresImport';
import {
  DEFAULT_SPEC,
  CONTRACT_CODE,
  DEFAULT_STRESS_DROPS,
  findPreset,
  type FuturesSpec,
  type FuturesPosition,
  type ClosedTrade,
  type CashFlow,
  type Side,
  type EntryBatch,
  type ProductConfig,
} from './futures';

const VERSION = 'v1';
const KEY = `review:futures:${VERSION}`;

/** 建倉試算的參數（純規劃用，不影響實際部位的損益計算） */
export interface PlannerConfig {
  capital: number;           // 帳戶可用本金（空著＝沿用保證金專戶現金）
  target_leverage: number;   // 槓桿滑桿的位置（1.0～10.0）
  gain_pct: number;          // 上漲目標（0.2＝+20%）
  reserve_multiple: number;  // 出金時要留下的原始保證金倍數
  trailing_peak: number;     // 移動停損的參考最高價（0＝用目標價）
  trailing_dist: number;     // 回檔多少就出場（元／點）
  plan_base_leverage: number; // 歷史校準計畫的底倉槓桿
  plan_peak: number;         // 加碼跌幅的基準高點（0＝用現價）
  batches: EntryBatch[];     // 分批進場的價格與口數
  stress_drops: number[];    // 壓力測試的情境
}

/**
 * 帳戶設定。**多商品併存**：帳戶可能同時持有多個商品（例如 SRF ETF 期貨＋個股
 * 期貨），每個商品自己一組契約規格／報價／beta，`positions`/`closed` 各自靠
 * `product` 欄位指到 `products` 的 key。`cash`/`cash_flows`/`stop_loss` 維持
 * 帳戶層級（本來就是跨商品共用的現金與停損設定）。
 */
export interface FuturesConfig {
  products: Record<string, ProductConfig>; // 帳戶目前持有／設定過的商品
  active_product: string;    // 設定頁/建倉試算頁「目前在編輯哪個商品」的 UI 狀態，不影響部位歸屬
  cash: number;              // 保證金專戶現金餘額（入金 ± 已實現損益）
  positions: FuturesPosition[];
  closed: ClosedTrade[];
  cash_flows: CashFlow[];    // 帳戶資金進出流水帳（入金／出金），現金餘額的異動來源之一
  stop_loss: Record<string, number>; // 每筆部位的停損價（key＝position id）
  planner: Record<string, PlannerConfig>; // 逐商品一份建倉試算參數
  /** 截圖匯入已經吃過的成交指紋（見 futuresImport.ts 的 ImportState.imported_refs） */
  imported_refs: string[];
}

export const DEFAULT_PLANNER: PlannerConfig = {
  capital: 0,
  target_leverage: 1.2,
  gain_pct: 0.2,
  reserve_multiple: 2.5,
  trailing_peak: 0,
  trailing_dist: 2,
  // 歷史校準計畫的兩個輸入。底倉槓桿預設 1.2 是回測結論（見 futures.ts 的
  // CALIBRATED_PLAN），不是隨手填的；基準高點 0 代表「用現價當高點」。
  plan_base_leverage: 1.2,
  plan_peak: 0,
  batches: [{ price: 0, lots: 0 }, { price: 0, lots: 0 }, { price: 0, lots: 0 }],
  stress_drops: [...DEFAULT_STRESS_DROPS],
};

function clonePlanner(): PlannerConfig {
  return { ...DEFAULT_PLANNER, batches: DEFAULT_PLANNER.batches.map((b) => ({ ...b })), stress_drops: [...DEFAULT_PLANNER.stress_drops] };
}

/** 內建預設商品的初始 ProductConfig（給 SEED 與舊格式遷移共用） */
export function defaultProduct(code: string): ProductConfig {
  const preset = findPreset(code);
  return {
    code,
    name: preset?.name || code,
    quote_contract: code,
    underlying: preset?.underlying || '',
    spec: preset?.spec ? { ...preset.spec } : { ...DEFAULT_SPEC },
    beta: 1,
    index_ref: 0,
    index_linked: Boolean(preset?.index_linked),
    price: 0,
    prices: {},
    price_month: '',
    price_as_of: '',
    price_source: 'daily',
    is_custom: !preset,
  };
}

const SEED: FuturesConfig = {
  products: { [CONTRACT_CODE]: defaultProduct(CONTRACT_CODE) },
  active_product: CONTRACT_CODE,
  cash: 0,
  positions: [],
  closed: [],
  cash_flows: [],
  stop_loss: {},
  planner: { [CONTRACT_CODE]: clonePlanner() },
  imported_refs: [],
};

export function seedFuturesConfig(): FuturesConfig {
  return {
    ...SEED,
    products: { [CONTRACT_CODE]: defaultProduct(CONTRACT_CODE) },
    positions: [],
    closed: [],
    cash_flows: [],
    stop_loss: {},
    planner: { [CONTRACT_CODE]: clonePlanner() },
    imported_refs: [],
  };
}

function num(v: unknown, fb: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    if (Number.isFinite(p)) return p;
  }
  return fb;
}

function str(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}

function safeSide(v: unknown): Side {
  return v === 'short' ? 'short' : 'long';
}

// 月份一律正規化成 'YYYYMM'；'2026-08' / '2026/08' 這類輸入也接受
function safeMonth(v: unknown): string {
  const s = str(v).replace(/[^0-9]/g, '');
  return /^\d{6}$/.test(s) ? s : '';
}

function safeDate(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function sanitizeSpec(v: unknown): FuturesSpec {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    contract_size: Math.max(1, num(o.contract_size, DEFAULT_SPEC.contract_size)),
    tick_size: Math.max(0.0001, num(o.tick_size, DEFAULT_SPEC.tick_size)),
    initial_margin: Math.max(0, num(o.initial_margin, DEFAULT_SPEC.initial_margin)),
    maintenance_margin: Math.max(0, num(o.maintenance_margin, DEFAULT_SPEC.maintenance_margin)),
    fee_per_lot: Math.max(0, num(o.fee_per_lot, DEFAULT_SPEC.fee_per_lot)),
    tax_rate: Math.max(0, num(o.tax_rate, DEFAULT_SPEC.tax_rate)),
    rollover_days: Math.max(0, Math.round(num(o.rollover_days, DEFAULT_SPEC.rollover_days))),
    liquidation_ratio: Math.min(1, Math.max(0, num(o.liquidation_ratio, DEFAULT_SPEC.liquidation_ratio))),
  };
}

/**
 * 截圖匯入的來源指紋。存下來才問得出「這筆成交上次已經吃過了」——
 * 掉了的話同一張截圖匯第二次會重複計帳（gateway 那份白名單也要有，見 routes/futures.js）。
 */
function safeRef(v: unknown): string {
  return str(v).slice(0, 160);
}

/** 券商實收費用：非負有限數才留，其餘 null＝沒這個資料、請用 spec 推估 */
function feeOrNull(v: unknown): number | null {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 商品代碼：大寫英數，長度上限比舊版的 6 碼寬一些（自建個股期貨代碼可能更長） */
function safeProductCode(v: unknown, fb = ''): string {
  const s = str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return s || fb;
}

function sanitizePosition(v: unknown, i: number, codes: string[], defaultCode: string): FuturesPosition | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const month = safeMonth(o.month);
  if (!month) return null; // 沒有到期月份的部位無法算轉倉，直接丟掉
  const lots = Math.max(0, num(o.lots, 0));
  const entry_price = Math.max(0, num(o.entry_price, 0));
  const entry_date = safeDate(o.entry_date);
  const side = safeSide(o.side);
  const rawProduct = safeProductCode(o.product);
  const product = rawProduct && codes.includes(rawProduct) ? rawProduct : defaultCode;
  const id = str(o.id) || `f_${product}_${month}_${side}_${i}_${lots}_${entry_price}`;
  const note = str(o.note);
  const ref = safeRef(o.ref);
  return {
    id, product, month, side, lots, entry_price, entry_date,
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
  };
}

function sanitizeClosed(v: unknown, i: number, codes: string[], defaultCode: string): ClosedTrade | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const month = safeMonth(o.month);
  if (!month) return null;
  const lots = Math.max(0, num(o.lots, 0));
  const entry_price = Math.max(0, num(o.entry_price, 0));
  const exit_price = Math.max(0, num(o.exit_price, 0));
  const exit_date = safeDate(o.exit_date);
  const entry_date = safeDate(o.entry_date);
  const side = safeSide(o.side);
  const rawProduct = safeProductCode(o.product);
  const product = rawProduct && codes.includes(rawProduct) ? rawProduct : defaultCode;
  const id = str(o.id) || `c_${product}_${month}_${side}_${i}_${lots}_${exit_price}`;
  const note = str(o.note);
  const ref = safeRef(o.ref);
  const fee = feeOrNull(o.fee);
  const tax = feeOrNull(o.tax);
  return {
    id, product, month, side, lots, entry_price, exit_price, exit_date,
    ...(entry_date ? { entry_date } : {}),
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
    ...(fee !== null ? { fee } : {}),
    ...(tax !== null ? { tax } : {}),
  };
}

/**
 * 一筆資金進出。金額一律存正數、方向存在 type，這樣舊資料誤把出金存成負數時
 * （Math.abs 後 type 仍是 withdraw）不會變成「負的出金＝入金」。金額 0 的丟掉。
 */
function sanitizeFlow(v: unknown, i: number): CashFlow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const date = safeDate(o.date);
  if (!date) return null; // 沒有日期就沒辦法歸到權益曲線的哪一段，直接丟掉
  const amount = Math.abs(num(o.amount, 0));
  if (!(amount > 0)) return null;
  const type: CashFlow['type'] = o.type === 'withdraw' ? 'withdraw' : 'deposit';
  const id = str(o.id) || `cf_${date}_${type}_${i}_${amount}`;
  const note = str(o.note).slice(0, 100);
  return { id, date, type, amount, ...(note ? { note } : {}) };
}

function sanitizeFlows(v: unknown): CashFlow[] {
  return (Array.isArray(v) ? v : [])
    .map((f, i) => sanitizeFlow(f, i))
    .filter((f): f is CashFlow => f !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function sanitizeBatches(v: unknown): EntryBatch[] {
  const arr = Array.isArray(v) ? v : [];
  const out: EntryBatch[] = arr.slice(0, 6).map((b) => {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return { price: Math.max(0, num(o.price, 0)), lots: Math.max(0, num(o.lots, 0)) };
  });
  // 一律補滿 3 格，UI 才有固定的三張卡可以填
  while (out.length < 3) out.push({ price: 0, lots: 0 });
  return out;
}

// 負值＝上漲情境（空單看的是那一側），故區間是 (−1, 1) 而不是 (0, 1)
function sanitizeDrops(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  const out = [...new Set(arr
    .map((d) => num(d, NaN))
    .filter((d) => Number.isFinite(d) && d > -1 && d < 1 && d !== 0))]
    .slice(0, 14)
    .sort((a, b) => a - b);
  return out.length > 0 ? out : [...DEFAULT_PLANNER.stress_drops];
}

/** 各月份報價：key 必須是 'YYYYMM'，價格必須 > 0，否則丟掉 */
function sanitizePrices(v: unknown): Record<string, number> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    const m = safeMonth(k);
    if (!m) continue;
    const p = num(val, 0);
    if (p > 0) out[m] = p;
  }
  return out;
}

/** 匯入指紋帳本：字串、去重、只留最近 MAX_IMPORTED_REFS 筆，免得雲端檔無限長大 */
function sanitizeRefs(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out = arr.map((x) => str(x).slice(0, 160)).filter(Boolean);
  return [...new Set(out)].slice(-MAX_IMPORTED_REFS);
}

/**
 * 一個商品的完整設定。個股期貨跟 SRF/NYF 一樣沒有 OpenAPI 保證金端點，契約規格
 * 一律手動輸入——這裡只負責 clamp／補預設值，不驗證數字合不合理（那是使用者
 * 該對照期交所公告自己填的事）。`code` 沒對到 SYMBOL_PRESETS 時視為自建商品。
 */
function sanitizeProduct(v: unknown, code: string): ProductConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const preset = findPreset(code);
  return {
    code,
    name: str(o.name) || preset?.name || code,
    quote_contract: safeProductCode(o.quote_contract, code) || code,
    underlying: str(o.underlying) || preset?.underlying || '',
    spec: sanitizeSpec(o.spec),
    beta: Math.min(5, Math.max(0.01, num(o.beta, 1))),
    index_ref: Math.max(0, num(o.index_ref, 0)),
    index_linked: preset ? preset.index_linked : Boolean(o.index_linked),
    price: Math.max(0, num(o.price, 0)),
    prices: sanitizePrices(o.prices),
    price_month: safeMonth(o.price_month),
    price_as_of: /^\d{4}-\d{2}-\d{2}/.test(str(o.price_as_of)) ? str(o.price_as_of) : '',
    price_source: o.price_source === 'live' ? 'live' : (o.price_source === 'manual' ? 'manual' : 'daily'),
    is_custom: !preset,
  };
}

function sanitizeProducts(v: unknown): Record<string, ProductConfig> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Record<string, ProductConfig> = {};
  for (const [k, val] of Object.entries(o)) {
    const code = safeProductCode(k);
    if (!code) continue;
    out[code] = sanitizeProduct(val, code);
  }
  return out;
}

/**
 * 舊格式遷移：8/24 以前的帳戶設定整包只有一組 `contract`/`spec`/`beta`/`index_ref`/
 * `prices`（見 FuturesConfig 的舊版定義），把它們包成 products 表裡的單一商品。
 * VM 正式站現在存的就是這個格式，遷移錯了會讓既有 SRF 部位的保證金/風險指標跟
 * 遷移前對不起來——這段動了要先跑 futures.test.ts 的遷移回歸案例。
 */
function legacyProduct(parsed: Record<string, unknown>): { code: string; product: ProductConfig } {
  const code = safeProductCode(parsed.contract, CONTRACT_CODE) || CONTRACT_CODE;
  const preset = findPreset(code);
  return {
    code,
    product: {
      code,
      name: preset?.name || code,
      quote_contract: code,
      underlying: preset?.underlying || '',
      spec: sanitizeSpec(parsed.spec),
      beta: Math.min(5, Math.max(0.01, num(parsed.beta, 1))),
      index_ref: Math.max(0, num(parsed.index_ref, 0)),
      index_linked: Boolean(preset?.index_linked),
      price: Math.max(0, num(parsed.price, 0)),
      prices: sanitizePrices(parsed.prices),
      price_month: safeMonth(parsed.price_month),
      price_as_of: /^\d{4}-\d{2}-\d{2}/.test(str(parsed.price_as_of)) ? str(parsed.price_as_of) : '',
      price_source: parsed.price_source === 'live' ? 'live' : 'daily',
      is_custom: !preset,
    },
  };
}

function sanitizePlanner(v: unknown): PlannerConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    capital: Math.max(0, num(o.capital, DEFAULT_PLANNER.capital)),
    target_leverage: Math.min(10, Math.max(0.1, num(o.target_leverage, DEFAULT_PLANNER.target_leverage))),
    gain_pct: Math.min(5, Math.max(-0.9, num(o.gain_pct, DEFAULT_PLANNER.gain_pct))),
    reserve_multiple: Math.min(10, Math.max(1, num(o.reserve_multiple, DEFAULT_PLANNER.reserve_multiple))),
    trailing_peak: Math.max(0, num(o.trailing_peak, DEFAULT_PLANNER.trailing_peak)),
    trailing_dist: Math.max(0, num(o.trailing_dist, DEFAULT_PLANNER.trailing_dist)),
    plan_base_leverage: Math.min(5, Math.max(0.1, num(o.plan_base_leverage, DEFAULT_PLANNER.plan_base_leverage))),
    plan_peak: Math.max(0, num(o.plan_peak, DEFAULT_PLANNER.plan_peak)),
    batches: sanitizeBatches(o.batches),
    stress_drops: sanitizeDrops(o.stress_drops),
  };
}

export function normalizeFutures(parsed: Record<string, unknown>): FuturesConfig {
  const rawProducts = parsed.products;
  const hasNewShape = Boolean(rawProducts && typeof rawProducts === 'object' && Object.keys(rawProducts as object).length > 0);

  let products: Record<string, ProductConfig>;
  let migratedDefaultCode = '';
  if (hasNewShape) {
    products = sanitizeProducts(rawProducts);
  } else {
    // 舊格式（8/24 以前）：整帳戶只有一組 contract/spec/beta/index_ref/prices，遷移成單一商品
    const { code, product } = legacyProduct(parsed);
    products = { [code]: product };
    migratedDefaultCode = code;
  }
  if (Object.keys(products).length === 0) {
    const { code, product } = legacyProduct({});
    products = { [code]: product };
    migratedDefaultCode = code;
  }
  const codes = Object.keys(products);
  const wantedActive = safeProductCode(parsed.active_product);
  const active_product = codes.includes(wantedActive) ? wantedActive : (migratedDefaultCode && codes.includes(migratedDefaultCode) ? migratedDefaultCode : codes[0]);

  const positions = (Array.isArray(parsed.positions) ? parsed.positions : [])
    .map((p, i) => sanitizePosition(p, i, codes, active_product))
    .filter((p): p is FuturesPosition => p !== null);
  const closed = (Array.isArray(parsed.closed) ? parsed.closed : [])
    .map((t, i) => sanitizeClosed(t, i, codes, active_product))
    .filter((t): t is ClosedTrade => t !== null);

  // 停損價只保留還存在的部位，避免刪了部位後留下孤兒設定
  const ids = new Set(positions.map((p) => p.id));
  const stopIn = (parsed.stop_loss && typeof parsed.stop_loss === 'object'
    ? parsed.stop_loss : {}) as Record<string, unknown>;
  const stop_loss: Record<string, number> = {};
  for (const [k, v] of Object.entries(stopIn)) {
    if (!ids.has(k)) continue;
    const p = num(v, 0);
    if (p > 0) stop_loss[k] = p;
  }

  // planner 舊格式是單一物件（沒有逐商品 key）；新格式才是 `Record<code, PlannerConfig>`
  const plannerIn = (parsed.planner && typeof parsed.planner === 'object' ? parsed.planner : {}) as Record<string, unknown>;
  const planner: Record<string, PlannerConfig> = {};
  if (hasNewShape) {
    for (const c of codes) planner[c] = sanitizePlanner(plannerIn[c]);
  } else {
    for (const c of codes) planner[c] = c === active_product ? sanitizePlanner(plannerIn) : clonePlanner();
  }

  return {
    products,
    active_product,
    cash: num(parsed.cash, 0), // 權益數可以是負的（穿價），不 clamp
    positions,
    closed,
    cash_flows: sanitizeFlows(parsed.cash_flows),
    stop_loss,
    planner,
    imported_refs: sanitizeRefs(parsed.imported_refs),
  };
}

export function getFuturesConfig(): FuturesConfig {
  const raw = localStorage.getItem(KEY);
  if (raw === null) {
    localStorage.setItem(KEY, JSON.stringify(SEED));
    return seedFuturesConfig();
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return normalizeFutures(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('Failed to parse futures config from localStorage, resetting to seed', e);
  }
  localStorage.setItem(KEY, JSON.stringify(SEED));
  return seedFuturesConfig();
}

export function saveFuturesConfig(cfg: FuturesConfig): void {
  const clean = normalizeFutures(cfg as unknown as Record<string, unknown>);
  localStorage.setItem(KEY, JSON.stringify(clean));
  window.dispatchEvent(new CustomEvent('userstore:futures'));
}

export function subscribeFutures(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener('userstore:futures', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('userstore:futures', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
