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
