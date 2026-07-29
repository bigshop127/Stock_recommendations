/**
 * futures.ts — 小型臺灣50 ETF 期貨（SRF）損益／保證金／轉倉的純計算核心。
 *
 * 全部是純函式，沒有 React、沒有 I/O，方便單元測試（futures.test.ts）。
 * 頁面（pages/FuturesPnl.tsx）只負責畫面與輸入，算術一律走這裡。
 *
 * 期貨跟現股最大的差別，也是這頁存在的理由：
 *   1. 有槓桿 → 看的是「保證金權益數 / 風險指標」，不是「賺賠幾 %」。
 *   2. 每日結算（逐日洗價）→ 未實現損益每天真的從保證金專戶進出，權益數會跳動。
 *   3. 會到期 → 想維持部位就得轉倉，忘了轉會被現金結算掉。
 *
 * 契約規格來源：臺灣期貨交易所（2026-06-18 起適用的保證金表）。保證金會被期交所
 * 依風險調整，故全部做成可設定值，預設值只是「現在的公告值」。
 */

/** 商品規格與費用設定（可在頁面上調整；預設＝期交所 2026-06-18 公告值） */
export interface FuturesSpec {
  contract_size: number;       // 契約單位（股/口）：SRF＝1,000 股（大型 NYF 是 10,000）
  tick_size: number;           // 最小升降單位：0.05 元
  initial_margin: number;      // 原始保證金（元/口）
  maintenance_margin: number;  // 維持保證金（元/口）
  fee_per_lot: number;         // 期貨商手續費（元/口，單邊）
  tax_rate: number;            // 期交稅率（成交金額 × 稅率，單邊）：股價指數類＝十萬分之二
  rollover_days: number;       // 到期前幾天開始提醒轉倉（預設 7＝前一週）
  liquidation_ratio: number;   // 盤中強制平倉的風險指標門檻（期交所規定＝25%）
}

export const CONTRACT_CODE = 'SRF';
export const CONTRACT_NAME = '小型臺灣50 ETF 期貨';
export const UNDERLYING_CODE = '0050';

export const DEFAULT_SPEC: FuturesSpec = {
  contract_size: 1000,
  tick_size: 0.05,
  initial_margin: 7900,
  maintenance_margin: 6100,
  fee_per_lot: 30,
  tax_rate: 0.00002,
  rollover_days: 7,
  liquidation_ratio: 0.25,
};

/** 一口跳動一檔＝多少錢（SRF：0.05 × 1,000 ＝ 50 元） */
export function tickValue(spec: FuturesSpec): number {
  return spec.tick_size * spec.contract_size;
}

export type Side = 'long' | 'short';

/** 一筆未平倉部位（同月份同方向可以分筆記，均價各自算） */
export interface FuturesPosition {
  id: string;
  month: string;        // 到期月份 'YYYYMM'
  side: Side;
  lots: number;         // 口數
  entry_price: number;  // 進場價
  entry_date: string;   // 'YYYY-MM-DD'
  note?: string;
}

/** 已平倉紀錄（用來累算已實現損益，並讓權益數對得起來） */
export interface ClosedTrade {
  id: string;
  month: string;
  side: Side;           // 開倉方向
  lots: number;
  entry_price: number;
  exit_price: number;
  exit_date: string;
  note?: string;
}

function safe(n: unknown, fb = 0): number {
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  if (typeof n === 'string') {
    const p = parseFloat(n);
    if (Number.isFinite(p)) return p;
  }
  return fb;
}

const sign = (side: Side) => (side === 'short' ? -1 : 1);

// ── 到期日 ───────────────────────────────────────────────────────────────────

/**
 * 最後交易日＝到期月份的**第三個星期三**（期交所規則）。
 *
 * 注意：遇到國定假日會順延至次一營業日，本函式**不含台股假日曆**，所以算出來的是
 * 「規則上的第三個星期三」。實務上只有極少數年份會撞到假日（例：228、清明連假），
 * 頁面提供每個部位的「最後交易日覆寫」欄位處理這種例外。
 */
export function lastTradingDay(month: string): string | null {
  const m = /^(\d{4})(\d{2})$/.exec(String(month || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); // 0=日 … 3=三
  const offset = (3 - firstDow + 7) % 7;
  const day = 1 + offset + 14;
  const d = new Date(Date.UTC(y, mo - 1, day));
  return d.toISOString().slice(0, 10);
}

/** 最後結算日＝最後交易日的次一營業日（週末順延；同樣不含國定假日） */
export function finalSettlementDay(month: string): string | null {
  const ltd = lastTradingDay(month);
  if (!ltd) return null;
  const d = new Date(ltd + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** 兩個 'YYYY-MM-DD' 之間差幾個日曆天（to − from）；格式不對回 null */
export function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ── 單筆部位損益 ─────────────────────────────────────────────────────────────

export interface PositionPnl {
  contract_value: number;   // 契約總值＝價格 × 契約單位 × 口數（＝實際曝險，不是保證金）
  cost_value: number;       // 進場時的契約總值
  gross_pnl: number;        // 未實現損益（未扣費用）
  fees: number;             // 來回手續費（進場已付＋出場預估）
  tax: number;              // 來回期交稅（進場已付＋出場預估）
  net_pnl: number;          // 扣掉來回費用後的未實現損益
  return_on_margin: number; // 淨損益 / 這筆佔用的原始保證金（＝真正的報酬率口徑）
  break_even: number;       // 損益平衡價（含來回費用）
  margin_required: number;  // 這筆佔用的原始保證金
}

/**
 * 單筆部位的未實現損益。
 *
 * 費用採「來回」計算（進場那次已經付了、出場那次遲早要付），這樣損益平衡價才是
 * 真的平衡；只算單邊會讓人以為打平其實還虧一趟手續費。
 */
export function positionPnl(pos: FuturesPosition, price: number, spec: FuturesSpec): PositionPnl {
  const lots = Math.max(0, safe(pos.lots));
  const entry = Math.max(0, safe(pos.entry_price));
  const p = Math.max(0, safe(price));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const s = sign(pos.side);

  const contract_value = p * unit * lots;
  const cost_value = entry * unit * lots;
  const gross_pnl = s * (p - entry) * unit * lots;

  const fees = Math.max(0, safe(spec.fee_per_lot)) * lots * 2;
  const taxRate = Math.max(0, safe(spec.tax_rate));
  const tax = (cost_value + contract_value) * taxRate;
  const net_pnl = gross_pnl - fees - tax;

  const margin_required = Math.max(0, safe(spec.initial_margin)) * lots;
  const return_on_margin = margin_required > 0 ? net_pnl / margin_required : 0;

  // 損益平衡：s × (P − entry) × unit × lots ＝ fees + tax(P)
  // tax 與 P 有關（出場那腿），故解一次方程式：
  //   s·unit·lots·P − s·unit·lots·entry = fees + taxRate·unit·lots·(entry + P)
  //   P·(s·unit·lots − taxRate·unit·lots) = fees + taxRate·unit·lots·entry + s·unit·lots·entry
  const ul = unit * lots;
  const denom = s * ul - taxRate * ul;
  const break_even = denom !== 0 ? (fees + taxRate * ul * entry + s * ul * entry) / denom : entry;

  return { contract_value, cost_value, gross_pnl, fees, tax, net_pnl, return_on_margin, break_even, margin_required };
}

/** 已平倉損益（含來回費用）——用來累算已實現損益 */
export function closedPnl(t: ClosedTrade, spec: FuturesSpec): number {
  const lots = Math.max(0, safe(t.lots));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const entry = Math.max(0, safe(t.entry_price));
  const exit = Math.max(0, safe(t.exit_price));
  const gross = sign(t.side) * (exit - entry) * unit * lots;
  const fees = Math.max(0, safe(spec.fee_per_lot)) * lots * 2;
  const tax = (entry + exit) * unit * lots * Math.max(0, safe(spec.tax_rate));
  return gross - fees - tax;
}

// ── 帳戶層級彙總（保證金 / 風險指標 / 追繳斷頭價）────────────────────────────

export interface AccountSummary {
  total_lots: number;            // 總口數（不分方向，保證金按這個算）
  net_lots: number;              // 淨口數（多－空），決定價格風險方向
  long_lots: number;
  short_lots: number;
  contract_value: number;        // 名目曝險總額
  unrealized: number;            // 未實現損益（含來回費用）
  realized: number;              // 已實現損益（含費用）
  equity: number;                // 權益數＝保證金專戶現金 ＋ 未實現損益
  required_initial: number;      // 所需原始保證金
  required_maintenance: number;  // 所需維持保證金
  excess: number;                // 超額保證金＝權益數 − 所需原始保證金（負值代表已低於原始）
  risk_indicator: number | null; // 風險指標＝權益數 / 所需維持保證金（無部位時 null）
  leverage: number | null;       // 槓桿＝名目曝險 / 權益數
  margin_call_price: number | null;  // 權益數跌到「維持保證金」時的標的價格（會收到追繳通知）
  liquidation_price: number | null;  // 風險指標跌到 25% 時的標的價格（盤中會被強制平倉）
  status: 'flat' | 'ok' | 'warn' | 'call' | 'danger';
}

/**
 * 帳戶彙總。cash＝保證金專戶的現金餘額（入金 ± 已實現損益，不含未實現）。
 *
 * 風險指標定義照期交所/期貨商慣例：權益數 ÷ 未沖銷部位所需**維持**保證金。
 * 低於 100% → 期貨商發追繳通知（要補到原始保證金）；盤中低於 25% → 強制平倉。
 */
export function summarizeAccount(
  positions: FuturesPosition[],
  price: number,
  spec: FuturesSpec,
  cash: number,
  closed: ClosedTrade[] = [],
): AccountSummary {
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const list = Array.isArray(positions) ? positions : [];

  let total_lots = 0;
  let net_lots = 0;
  let long_lots = 0;
  let short_lots = 0;
  let contract_value = 0;
  let unrealized = 0;
  let signedEntryNotional = 0;  // Σ sign·lots·entry（價格風險方向）
  let grossEntryNotional = 0;   // Σ lots·entry（期交稅按成交金額算，不分方向）
  let totalFees = 0;

  for (const pos of list) {
    const lots = Math.max(0, safe(pos.lots));
    if (lots <= 0) continue;
    const s = sign(pos.side);
    total_lots += lots;
    net_lots += s * lots;
    if (s > 0) long_lots += lots; else short_lots += lots;
    const pnl = positionPnl(pos, price, spec);
    contract_value += pnl.contract_value;
    unrealized += pnl.net_pnl;
    totalFees += pnl.fees;
    signedEntryNotional += s * lots * Math.max(0, safe(pos.entry_price));
    grossEntryNotional += lots * Math.max(0, safe(pos.entry_price));
  }

  const realized = (Array.isArray(closed) ? closed : []).reduce((sum, t) => sum + closedPnl(t, spec), 0);
  const cashBal = safe(cash);
  const equity = cashBal + unrealized;
  const required_initial = Math.max(0, safe(spec.initial_margin)) * total_lots;
  const required_maintenance = Math.max(0, safe(spec.maintenance_margin)) * total_lots;
  const excess = equity - required_initial;
  const risk_indicator = required_maintenance > 0 ? equity / required_maintenance : null;
  const leverage = equity > 0 && contract_value > 0 ? contract_value / equity : null;

  // 追繳價／斷頭價：解 equity(P) = 門檻。權益數對 P 是一次函數（期交稅那項也含 P，
  // 一併放進來解，得到的是精確值而非近似）：
  //   equity(P) = cash + unit·(net_lots·P − signedEntryNotional)
  //               − fees − taxRate·unit·(grossEntryNotional + P·total_lots)
  // ⇒ P·unit·(net_lots − taxRate·total_lots) = 門檻 − cash + unit·signedEntryNotional
  //                                            + fees + taxRate·unit·grossEntryNotional
  // net_lots = 0（完全對沖）時價格不再影響權益數，無解 → null。
  const taxRate = Math.max(0, safe(spec.tax_rate));
  const priceAtEquity = (target: number): number | null => {
    const denom = unit * (net_lots - taxRate * total_lots);
    if (net_lots === 0 || denom === 0) return null;
    const numer = target - cashBal + unit * signedEntryNotional + totalFees + taxRate * unit * grossEntryNotional;
    return numer / denom;
  };

  const margin_call_price = priceAtEquity(required_maintenance);
  const liquidation_price = priceAtEquity(required_maintenance * Math.max(0, safe(spec.liquidation_ratio, 0.25)));

  let status: AccountSummary['status'] = 'flat';
  if (total_lots > 0 && risk_indicator !== null) {
    if (risk_indicator < spec.liquidation_ratio) status = 'danger';
    else if (risk_indicator < 1) status = 'call';
    else if (equity < required_initial) status = 'warn';
    else status = 'ok';
  }

  return {
    total_lots, net_lots, long_lots, short_lots,
    contract_value, unrealized, realized, equity,
    required_initial, required_maintenance, excess,
    risk_indicator, leverage,
    margin_call_price: margin_call_price === null ? null : Math.max(0, margin_call_price),
    liquidation_price: liquidation_price === null ? null : Math.max(0, liquidation_price),
    status,
  };
}

// ── 轉倉提醒 ────────────────────────────────────────────────────────────────

export interface RolloverAlert {
  month: string;
  lots: number;
  last_trading_day: string | null;
  final_settlement_day: string | null;
  days_left: number | null;     // 距最後交易日還有幾個日曆天（負數＝已過期）
  due: boolean;                 // 已進入提醒區間
  expired: boolean;             // 最後交易日已過
  level: 'none' | 'soon' | 'urgent' | 'expired';
}

/**
 * 每個有未平倉口數的月份各給一則轉倉狀態。
 * level：urgent＝剩 2 天內、soon＝已進提醒區間（預設前 7 天）、expired＝已過最後交易日。
 */
export function rolloverAlerts(
  positions: FuturesPosition[],
  spec: FuturesSpec,
  today: string,
): RolloverAlert[] {
  const byMonth = new Map<string, number>();
  for (const pos of Array.isArray(positions) ? positions : []) {
    const lots = Math.max(0, safe(pos.lots));
    if (lots <= 0) continue;
    byMonth.set(pos.month, (byMonth.get(pos.month) || 0) + lots);
  }

  const window = Math.max(0, safe(spec.rollover_days, 7));
  const out: RolloverAlert[] = [];
  for (const [month, lots] of byMonth) {
    const ltd = lastTradingDay(month);
    const days_left = ltd ? daysBetween(today, ltd) : null;
    const expired = days_left !== null && days_left < 0;
    const due = days_left !== null && days_left >= 0 && days_left <= window;
    let level: RolloverAlert['level'] = 'none';
    if (expired) level = 'expired';
    else if (days_left !== null && days_left <= 2) level = 'urgent';
    else if (due) level = 'soon';
    out.push({
      month,
      lots,
      last_trading_day: ltd,
      final_settlement_day: finalSettlementDay(month),
      days_left,
      due,
      expired,
      level,
    });
  }
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/**
 * 轉倉成本估算：平掉近月 + 建立遠月，兩趟手續費與期交稅，加上兩個月份的價差
 *（遠月通常較貴＝正價差，轉倉要多付這段）。
 */
export function rolloverCost(
  lots: number,
  nearPrice: number,
  farPrice: number,
  spec: FuturesSpec,
): { spread: number; spread_cost: number; fees: number; tax: number; total: number } {
  const n = Math.max(0, safe(lots));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const spread = safe(farPrice) - safe(nearPrice);
  const spread_cost = spread * unit * n;
  const fees = Math.max(0, safe(spec.fee_per_lot)) * n * 2;
  const tax = (safe(nearPrice) + safe(farPrice)) * unit * n * Math.max(0, safe(spec.tax_rate));
  return { spread, spread_cost, fees, tax, total: spread_cost + fees + tax };
}

// ── 風險控管：停損 ──────────────────────────────────────────────────────────

/** 設定停損價後，這筆部位最大會賠多少（含來回費用），以及佔權益數幾 % */
export function stopLossRisk(
  pos: FuturesPosition,
  stopPrice: number,
  spec: FuturesSpec,
  equity: number,
): { loss: number; pct_of_equity: number | null; ticks: number } {
  const loss = positionPnl(pos, stopPrice, spec).net_pnl;
  const ticks = spec.tick_size > 0
    ? Math.abs(safe(stopPrice) - safe(pos.entry_price)) / spec.tick_size
    : 0;
  return {
    loss,
    pct_of_equity: equity > 0 ? loss / equity : null,
    ticks: Math.round(ticks),
  };
}

// ── 商品切換（多契約規格預設）────────────────────────────────────────────────

/**
 * 一個可交易商品的完整預設。`code` 同時是期交所 OpenAPI 的 Contract 欄位值，
 * 抓行情就是拿它去打 /api/futures/quote?contract=XXX。
 *
 * 指數類期貨（MTX/TMF）沒有「股數」的概念，contract_size 存的是**每點多少錢**，
 * 這樣 price × contract_size × lots 仍然等於名目曝險，全部算式不用分岔。
 */
export interface SymbolPreset {
  code: string;
  name: string;
  underlying: string;     // 標的（0050 或 加權指數）
  unit_label: string;     // contract_size 的單位：'股/口' 或 '元/點'
  price_label: string;    // 「現在價格」欄位的標籤
  index_linked: boolean;  // true＝標的本身就是大盤指數（beta 固定 1，不需另填指數）
}

export const SYMBOL_PRESETS: (SymbolPreset & { spec: FuturesSpec })[] = [
  {
    code: 'SRF',
    name: '小型臺灣50 ETF 期貨',
    underlying: '0050',
    unit_label: '股/口',
    price_label: '0050 期貨價格',
    index_linked: false,
    spec: {
      contract_size: 1000, tick_size: 0.05,
      initial_margin: 7900, maintenance_margin: 6100,
      fee_per_lot: 30, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25,
    },
  },
  {
    code: 'NYF',
    name: '臺灣50 ETF 期貨（大型）',
    underlying: '0050',
    unit_label: '股/口',
    price_label: '0050 期貨價格',
    index_linked: false,
    spec: {
      contract_size: 10000, tick_size: 0.05,
      initial_margin: 79000, maintenance_margin: 61000,
      fee_per_lot: 60, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25,
    },
  },
  {
    code: 'MTX',
    name: '小型臺指期貨',
    underlying: '加權指數',
    unit_label: '元/點',
    price_label: '小型台指點數',
    index_linked: true,
    spec: {
      contract_size: 50, tick_size: 1,
      initial_margin: 79500, maintenance_margin: 61000,
      fee_per_lot: 50, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25,
    },
  },
  {
    code: 'TMF',
    name: '微型臺指期貨',
    underlying: '加權指數',
    unit_label: '元/點',
    price_label: '微型台指點數',
    index_linked: true,
    spec: {
      contract_size: 10, tick_size: 1,
      initial_margin: 15900, maintenance_margin: 12200,
      fee_per_lot: 30, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25,
    },
  },
];

export function findPreset(code: string): (SymbolPreset & { spec: FuturesSpec }) | null {
  const c = String(code || '').trim().toUpperCase();
  return SYMBOL_PRESETS.find((p) => p.code === c) ?? null;
}

// ── 大盤連動 ────────────────────────────────────────────────────────────────

/**
 * 標的價格 ↔ 加權指數的換算。
 *
 * beta＝標的相對大盤的連動係數：0050 對加權指數約 1.0～1.1（權值股集中度更高），
 * 台指期本身就是大盤所以 beta＝1。價格變動 % ＝ beta × 指數變動 %，反推得
 *   指數 = 參考指數 ×（1 + (價格變動 %) / beta）
 *
 * 這個換算的用途是把「標的跌到 95 元」翻譯成「大盤跌到 37,000 點」——後者才是
 * 看盤時腦中真正有感的刻度。
 */
export function indexAtPrice(
  price: number,
  refPrice: number,
  refIndex: number,
  beta = 1,
): number | null {
  const p = safe(price);
  const rp = safe(refPrice);
  const ri = safe(refIndex);
  const b = safe(beta, 1);
  if (!(rp > 0) || !(ri > 0) || !(b > 0)) return null;
  return ri * (1 + (p - rp) / rp / b);
}

// ── 壓力測試 ────────────────────────────────────────────────────────────────

export interface StressRow {
  drop: number;                  // 大盤修正比例（0.05＝跌 5%）
  index_after: number | null;    // 修正後的加權指數（沒填參考指數時 null）
  price_after: number;           // 修正後的標的價格
  unrealized: number;            // 該價位的未實現損益（含來回費用）
  equity: number;                // 該價位的權益數
  excess: number;                // 超額保證金
  risk_indicator: number | null;
  status: AccountSummary['status'];
}

/** 預設的壓力情境：從一般回檔到 2008 級崩盤 */
export const DEFAULT_STRESS_DROPS = [0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3];

/**
 * 大盤跌 X% 時帳戶會變成什麼樣子。
 *
 * 直接重跑 summarizeAccount()，所以費用、期交稅、多空對沖的處理跟總覽頁完全一致，
 * 不會出現「總覽算的跟壓力測試算的對不起來」。
 */
export function stressTest(
  positions: FuturesPosition[],
  spec: FuturesSpec,
  cash: number,
  price: number,
  opts: { drops?: number[]; index?: number; beta?: number } = {},
): StressRow[] {
  const drops = (opts.drops ?? DEFAULT_STRESS_DROPS).slice().sort((a, b) => a - b);
  const beta = Math.max(0, safe(opts.beta, 1));
  const refIndex = safe(opts.index, 0);
  const p0 = Math.max(0, safe(price));

  return drops.map((d) => {
    const drop = Math.max(0, safe(d));
    const price_after = Math.max(0, p0 * (1 - beta * drop));
    const s = summarizeAccount(positions, price_after, spec, cash, []);
    return {
      drop,
      index_after: refIndex > 0 ? refIndex * (1 - drop) : null,
      price_after,
      unrealized: s.unrealized,
      equity: s.equity,
      excess: s.excess,
      risk_indicator: s.risk_indicator,
      status: s.status,
    };
  });
}

// ── 建倉試算：槓桿 → 口數 ───────────────────────────────────────────────────

export interface LotSuggestion {
  lots: number;             // 建議口數（已同時受槓桿目標與保證金上限限制）
  by_leverage: number;      // 純照槓桿目標算出來的口數
  max_by_margin: number;    // 本金押得起的最大口數（原始保證金上限）
  capped: boolean;          // true＝槓桿目標算出來的口數超過保證金押得起的量
  notional: number;         // 建議口數的名目曝險
  leverage: number;         // 建議口數的實際槓桿
  margin_used: number;      // 佔用的原始保證金
  margin_usage: number;     // 保證金佔本金比例（越高越沒有回檔緩衝）
}

/**
 * 「我要 N 倍槓桿，該下幾口？」
 *
 * 槓桿的定義是**名目曝險 ÷ 本金**，不是「保證金的倍數」——後者會算出嚇死人的數字
 * 而且沒有意義。另外一定要同時檢查保證金押不押得起：槓桿 10 倍在 0050 期貨上大約
 * 需要 8% 的本金當保證金，看起來還好，但那代表跌 10% 就穿價。
 */
export function suggestLots(
  capital: number,
  price: number,
  targetLeverage: number,
  spec: FuturesSpec,
): LotSuggestion {
  const cap = Math.max(0, safe(capital));
  const p = Math.max(0, safe(price));
  const lev = Math.max(0, safe(targetLeverage));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const im = Math.max(0, safe(spec.initial_margin));

  const lotValue = p * unit;
  const by_leverage = lotValue > 0 ? Math.max(0, Math.round((cap * lev) / lotValue)) : 0;
  const max_by_margin = im > 0 ? Math.floor(cap / im) : by_leverage;
  const lots = Math.max(0, Math.min(by_leverage, max_by_margin));

  const notional = lots * lotValue;
  const margin_used = lots * im;
  return {
    lots,
    by_leverage,
    max_by_margin,
    capped: by_leverage > max_by_margin,
    notional,
    leverage: cap > 0 ? notional / cap : 0,
    margin_used,
    margin_usage: cap > 0 ? margin_used / cap : 0,
  };
}

// ── 分批進場：加權平均成本 ──────────────────────────────────────────────────

export interface EntryBatch {
  price: number;
  lots: number;
}

export interface WeightedEntry {
  lots: number;
  avg_price: number;
  cost: number;        // Σ 價 × 口（未乘契約單位）
  notional: number;    // 乘上契約單位後的名目金額
}

/** 分批建倉／加碼後的加權平均成本。口數為 0 的批次自動忽略。 */
export function weightedEntry(batches: EntryBatch[], spec: FuturesSpec): WeightedEntry {
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  let lots = 0;
  let cost = 0;
  for (const b of Array.isArray(batches) ? batches : []) {
    const l = Math.max(0, safe(b?.lots));
    const p = Math.max(0, safe(b?.price));
    if (l <= 0 || p <= 0) continue;
    lots += l;
    cost += p * l;
  }
  const avg_price = lots > 0 ? cost / lots : 0;
  return { lots, avg_price, cost, notional: avg_price * unit * lots };
}

// ── 上漲規劃：目標價 / 出金 / 移動停損 ──────────────────────────────────────

/** 所有未平倉部位在指定價格的未實現損益合計（含來回費用） */
export function pnlAtPrice(positions: FuturesPosition[], price: number, spec: FuturesSpec): number {
  return (Array.isArray(positions) ? positions : [])
    .reduce((sum, p) => sum + positionPnl(p, price, spec).net_pnl, 0);
}

export interface TargetPlan {
  target_price: number;
  gain_pct: number;
  profit: number;            // 從現價漲到目標價會多賺多少（淨額）
  equity_after: number;      // 到價時的權益數
  roi_on_equity: number | null;   // 相對目前權益數的報酬率
  roi_on_margin: number | null;   // 相對所需原始保證金的報酬率
  reserve: number;           // 為了維持部位必須留下的保證金水位
  safe_withdraw: number;     // 到價後可以安全出金的金額
}

/**
 * 「漲 X% 我賺多少、可以領走多少」。
 *
 * 出金額度不是「賺多少領多少」——期貨部位還在，領太多會讓風險指標掉回警戒區。
 * 這裡留下 `reserveMultiple` 倍的原始保證金當緩衝（預設 2.5 倍，約可承受 15% 回檔）。
 */
export function targetPlan(
  positions: FuturesPosition[],
  spec: FuturesSpec,
  cash: number,
  price: number,
  gainPct: number,
  reserveMultiple = 2.5,
): TargetPlan {
  const p0 = Math.max(0, safe(price));
  const g = safe(gainPct);
  const target_price = p0 * (1 + g);

  const now = pnlAtPrice(positions, p0, spec);
  const then = pnlAtPrice(positions, target_price, spec);
  const profit = then - now;

  const equity_now = safe(cash) + now;
  const equity_after = safe(cash) + then;

  const total_lots = (Array.isArray(positions) ? positions : [])
    .reduce((s, x) => s + Math.max(0, safe(x.lots)), 0);
  const required_initial = Math.max(0, safe(spec.initial_margin)) * total_lots;
  const reserve = required_initial * Math.max(1, safe(reserveMultiple, 2.5));

  return {
    target_price,
    gain_pct: g,
    profit,
    equity_after,
    roi_on_equity: equity_now > 0 ? profit / equity_now : null,
    roi_on_margin: required_initial > 0 ? profit / required_initial : null,
    reserve,
    safe_withdraw: Math.max(0, equity_after - reserve),
  };
}

export interface TrailingStopPlan {
  peak_price: number;
  stop_price: number;
  distance: number;
  ticks: number;
  locked_pnl: number;       // 觸發停損時鎖住的損益（相對現在的未實現，是絕對值不是增量）
  give_back: number;        // 從最高點回吐多少
}

/**
 * 移動停損：部位漲到 peak 後，回檔 distance 就出場。
 *
 * 方向由淨部位決定——空單的移動停損是往上追（peak＝最低價），這裡用 net_lots 的
 * 正負判斷，避免多空並存時算反邊。
 */
export function trailingStopPlan(
  positions: FuturesPosition[],
  spec: FuturesSpec,
  peakPrice: number,
  distance: number,
): TrailingStopPlan {
  const peak = Math.max(0, safe(peakPrice));
  const dist = Math.abs(safe(distance));
  const net = (Array.isArray(positions) ? positions : [])
    .reduce((s, p) => s + sign(p.side) * Math.max(0, safe(p.lots)), 0);
  const dir = net < 0 ? -1 : 1; // 空單：停損價在最低價之上
  const stop_price = Math.max(0, peak - dir * dist);

  return {
    peak_price: peak,
    stop_price,
    distance: dist,
    ticks: spec.tick_size > 0 ? Math.round(dist / spec.tick_size) : 0,
    locked_pnl: pnlAtPrice(positions, stop_price, spec),
    give_back: Math.abs(pnlAtPrice(positions, peak, spec) - pnlAtPrice(positions, stop_price, spec)),
  };
}

// ── 存股：期貨 vs 現貨的一年持有成本 ────────────────────────────────────────

export interface SpotVsFuturesInput {
  notional: number;            // 想持有的曝險金額（＝現貨要花的錢）
  lots: number;                // 對應的期貨口數
  dividend_yield: number;      // 標的現金殖利率（0.035＝3.5%）
  income_tax_rate: number;     // 個人綜所稅邊際稅率
  idle_rate: number;           // 閒置資金的年化報酬（定存/貨幣基金）
  rollovers_per_year: number;  // 一年轉倉幾次（月結算＝11～12）
  spread_per_rollover: number; // 每次轉倉的月份價差（元/單位，正值＝正價差要多付）
  broker_discount: number;     // 現股手續費折數（0.6＝六折）
}

export interface SpotVsFuturesResult {
  spot: {
    trading_fee: number;     // 買進＋賣出手續費
    transaction_tax: number; // 證交稅（ETF 0.1%）
    dividend: number;        // 一年領到的現金股利
    dividend_tax: number;    // 股利所得稅（已扣 8.5% 可抵減，上限 8 萬）
    nhi_premium: number;     // 二代健保補充保費（單筆股利 ≥ 2 萬才課）
    total_cost: number;
  };
  futures: {
    margin: number;          // 佔用的原始保證金
    idle_cash: number;       // 同等曝險下省下來、可以生利息的資金
    interest: number;        // 閒置資金一年的利息
    rollover_fee: number;
    rollover_tax: number;
    spread_cost: number;
    total_cost: number;      // 轉倉成本 − 利息（負值＝淨賺）
  };
  advantage: number;         // 現貨成本 − 期貨成本，正值＝用期貨划算
}

/**
 * 「用期貨存股」到底省不省？
 *
 * ⚠️ 一個關鍵前提：這裡**兩邊都不計股利收入**。理由是期貨價格已經反映除息貼水
 * （近月合約會比現貨便宜約當期股利），所以期貨持有人是靠價差自動拿到等值股利、
 * 而且免稅。把股利當現貨的「收入」會重複計算，故現貨這邊只算**因為領股利而多繳的稅**。
 *
 * 另一個前提：閒置資金＝名目曝險 − 保證金，也就是「要拿到同樣曝險，現貨得押 100%
 * 的錢、期貨只要押保證金，中間差額可以去生利息」。這在你**本來就有這筆錢**時成立；
 * 如果是拿小本金去開高槓桿，這段利息是假的，別把它當成期貨的優勢。
 */
export function compareSpotVsFutures(
  input: SpotVsFuturesInput,
  spec: FuturesSpec,
): SpotVsFuturesResult {
  const notional = Math.max(0, safe(input.notional));
  const lots = Math.max(0, safe(input.lots));
  const unit = Math.max(1, safe(spec.contract_size, 1000));

  // ── 現貨 ──
  const feeRate = 0.001425 * Math.max(0, Math.min(1, safe(input.broker_discount, 0.6)));
  const trading_fee = notional * feeRate * 2;              // 買一次賣一次
  const transaction_tax = notional * 0.001;                // ETF 證交稅 0.1%
  const dividend = notional * Math.max(0, safe(input.dividend_yield));
  const grossTax = dividend * Math.max(0, safe(input.income_tax_rate));
  const credit = Math.min(dividend * 0.085, 80000);        // 8.5% 可抵減，上限 8 萬
  const dividend_tax = Math.max(0, grossTax - credit);
  const nhi_premium = dividend >= 20000 ? dividend * 0.0211 : 0;
  const spotCost = trading_fee + transaction_tax + dividend_tax + nhi_premium;

  // ── 期貨 ──
  const margin = lots * Math.max(0, safe(spec.initial_margin));
  const idle_cash = Math.max(0, notional - margin);
  const interest = idle_cash * Math.max(0, safe(input.idle_rate));
  const n = Math.max(0, safe(input.rollovers_per_year));
  const rollover_fee = lots * Math.max(0, safe(spec.fee_per_lot)) * 2 * n;
  // 每次轉倉＝平近月＋建遠月，兩腿都課期交稅，用目前名目金額近似成交金額
  const rollover_tax = notional * 2 * Math.max(0, safe(spec.tax_rate)) * n;
  const spread_cost = Math.max(0, safe(input.spread_per_rollover)) * unit * lots * n;
  const futuresCost = rollover_fee + rollover_tax + spread_cost - interest;

  return {
    spot: { trading_fee, transaction_tax, dividend, dividend_tax, nhi_premium, total_cost: spotCost },
    futures: { margin, idle_cash, interest, rollover_fee, rollover_tax, spread_cost, total_cost: futuresCost },
    advantage: spotCost - futuresCost,
  };
}

// ── 風控報告（純文字，貼 Line / 筆記用）────────────────────────────────────

export interface RiskReportInput {
  symbol_name: string;
  spec: FuturesSpec;
  summary: AccountSummary;
  price: number;
  cash: number;
  index: number;
  beta: number;
  stress: StressRow[];
  plan?: TargetPlan | null;
  alerts?: RolloverAlert[];
}

const nt = (v: number) => `${v < 0 ? '-' : ''}NT$ ${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pctText = (v: number | null, d = 1) => (v === null ? '—' : `${(v * 100).toFixed(d)}%`);

/** 把整頁的關鍵數字擠成一段可複製的純文字。UI 只負責複製，內容全在這裡決定。 */
export function buildRiskReport(input: RiskReportInput): string {
  const { symbol_name, spec, summary: s, price, cash, index, beta, stress, plan, alerts } = input;
  const L: string[] = [];

  L.push('【期貨部位風控評估】');
  L.push('─'.repeat(34));
  L.push(`商品：${symbol_name}（一口 ${spec.contract_size.toLocaleString('en-US')} 單位）`);
  L.push(`現在價格：${price.toFixed(2)}${index > 0 ? `（對應加權指數約 ${Math.round(index).toLocaleString('en-US')} 點，beta ${beta.toFixed(2)}）` : ''}`);
  L.push(`部位：多 ${s.long_lots} 口 / 空 ${s.short_lots} 口，淨 ${s.net_lots >= 0 ? '+' : ''}${s.net_lots} 口`);
  L.push(`名目曝險：${nt(s.contract_value)}${s.leverage !== null ? `（槓桿 ${s.leverage.toFixed(2)} 倍）` : ''}`);
  L.push('');
  L.push('【保證金水位】');
  L.push(`保證金專戶現金：${nt(cash)}`);
  L.push(`未實現損益：${nt(s.unrealized)}`);
  L.push(`權益數：${nt(s.equity)}`);
  L.push(`所需原始／維持保證金：${nt(s.required_initial)} ／ ${nt(s.required_maintenance)}`);
  L.push(`超額保證金：${nt(s.excess)}`);
  L.push(`風險指標：${pctText(s.risk_indicator)}`);
  L.push('');
  L.push('【危險價位】');
  if (s.margin_call_price === null) {
    L.push('多空完全對沖或無部位，價格不影響權益數，無追繳／斷頭價。');
  } else {
    const callIdx = indexAtPrice(s.margin_call_price, price, index, beta);
    const cutIdx = s.liquidation_price !== null ? indexAtPrice(s.liquidation_price, price, index, beta) : null;
    const callDrop = price > 0 ? (s.margin_call_price - price) / price : 0;
    const cutDrop = price > 0 && s.liquidation_price !== null ? (s.liquidation_price - price) / price : 0;
    L.push(`🟨 追繳價：${s.margin_call_price.toFixed(2)}（${(callDrop * 100).toFixed(2)}%${callIdx !== null ? `，加權指數約 ${Math.round(callIdx).toLocaleString('en-US')} 點` : ''}）`);
    if (s.liquidation_price !== null) {
      L.push(`🟥 斷頭價：${s.liquidation_price.toFixed(2)}（${(cutDrop * 100).toFixed(2)}%${cutIdx !== null ? `，加權指數約 ${Math.round(cutIdx).toLocaleString('en-US')} 點` : ''}）`);
    }
  }

  if (stress.length > 0) {
    L.push('');
    L.push('【壓力測試】');
    for (const r of stress) {
      const tag = r.status === 'danger' ? '🟥 斷頭' : r.status === 'call' ? '🟨 追繳' : r.status === 'warn' ? '⚠️ 低於原始' : '✅ 正常';
      L.push(`  大盤 -${(r.drop * 100).toFixed(0)}% → 價 ${r.price_after.toFixed(2)}、權益 ${nt(r.equity)}、風險指標 ${pctText(r.risk_indicator, 0)} ${tag}`);
    }
  }

  if (plan) {
    L.push('');
    L.push('【上漲規劃】');
    L.push(`目標 +${(plan.gain_pct * 100).toFixed(0)}% → ${plan.target_price.toFixed(2)}`);
    L.push(`預估淨利：${nt(plan.profit)}（對權益數 ${pctText(plan.roi_on_equity)}、對保證金 ${pctText(plan.roi_on_margin)}）`);
    L.push(`到價後安全出金上限：${nt(plan.safe_withdraw)}`);
  }

  const due = (alerts ?? []).filter((a) => a.due || a.expired);
  if (due.length > 0) {
    L.push('');
    L.push('【轉倉提醒】');
    for (const a of due) {
      L.push(a.expired
        ? `  ${a.month} 已過最後交易日（${a.last_trading_day}），${a.lots} 口應已現金結算`
        : `  ${a.month} 還有 ${a.days_left} 天到期（${a.last_trading_day}），持有 ${a.lots} 口`);
    }
  }

  L.push('');
  L.push('─'.repeat(34));
  L.push(`產生時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`);
  L.push('※ 試算僅供風險檢視，實際保證金與結算以期交所／期貨商公告為準。');
  return L.join('\n');
}
