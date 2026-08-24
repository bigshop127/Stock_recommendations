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

/** 一筆未平倉部位（同商品同月份同方向可以分筆記，均價各自算） */
export interface FuturesPosition {
  id: string;
  /**
   * 商品代碼，對應 FuturesConfig.products 的 key（見 futuresStore.ts）。
   * 帳戶可能同時持有多個商品（例如 SRF ETF 期貨＋個股期貨），月份代碼本身
   * 在不同商品間會撞號（都可能有 202609），一定要靠這個欄位才分得出來。
   */
  product: string;
  month: string;        // 到期月份 'YYYYMM'
  side: Side;
  lots: number;         // 口數
  entry_price: number;  // 進場價
  entry_date: string;   // 'YYYY-MM-DD'
  note?: string;
  /**
   * 券商成交回報的來源指紋（`成交時間|委託書號|…`）。只有截圖匯入會填。
   * 用途單一：**同一筆成交不要被匯入兩次**。使用者一天可能截好幾次圖，
   * 內容比對（月份/口數/價格）在「同價分兩筆成交」時會誤判成重複，
   * 有這個欄位才問得出「這筆是不是我上次已經吃過的那一筆」。
   */
  ref?: string;
}

/** 已平倉紀錄（用來累算已實現損益，並讓權益數對得起來） */
export interface ClosedTrade {
  id: string;
  /** 商品代碼，語意同 FuturesPosition.product */
  product: string;
  month: string;
  side: Side;           // 開倉方向
  lots: number;
  entry_price: number;
  exit_price: number;
  exit_date: string;
  entry_date?: string;  // 建倉日（券商平倉查詢有給；手動平倉時從部位帶過來）
  note?: string;
  /**
   * 券商實收的來回手續費與期交稅（元）。**有填就以它為準**，沒填才用 spec 推估。
   *
   * Why：spec 的 `fee_per_lot` 是「設定值」，券商實收未必一樣（實測玉山是 40 元/口，
   * 專案預設 30），一趟 3 口就差 60 元。已實現損益是會結算進保證金餘額的真金白銀，
   * 推估值會讓「帳戶現金」跟券商對不起來，而那正是這頁最不該說謊的數字。
   */
  fee?: number;
  tax?: number;
  /** 券商平倉查詢那一列的來源指紋（`平倉日|委託書號|…`），用於匯入去重 */
  ref?: string;
}

/**
 * 一筆帳戶資金進出（入金／出金）。
 *
 * 為什麼要單獨記而不是直接改現金餘額：入出金**不是損益**。直接改餘額的話，
 * 權益數曲線會出現一段憑空的跳升／跳降，被當成賺賠——出金 20 萬會在圖上長出
 * 一段假的最大回撤。有了這本流水帳，報酬率與回撤才能把外部資金扣掉再算。
 *
 * `amount` 一律存正數，方向由 `type` 決定；要加減現金餘額請用 flowDelta()。
 */
export type CashFlowType = 'deposit' | 'withdraw';

export interface CashFlow {
  id: string;
  date: string;        // 'YYYY-MM-DD'
  type: CashFlowType;
  amount: number;      // 恆為正數
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

// ── 到期日與營業日 ───────────────────────────────────────────────────────────

/** 台股休市日集合（'YYYY-MM-DD'）。由 /api/market/holidays 抓證交所公告後餵進來。 */
export type Holidays = ReadonlySet<string> | undefined;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** 是不是台股營業日：非週末、且不在休市日清單裡 */
export function isBusinessDay(date: string, holidays?: Holidays): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays?.has(date);
}

/** 從 date 起（含當日）往後找第一個營業日；最多找 30 天，避免壞資料無限迴圈 */
export function nextBusinessDay(date: string, holidays?: Holidays, includeSelf = true): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (!includeSelf) d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < 30; i += 1) {
    const iso = isoOf(d);
    if (isBusinessDay(iso, holidays)) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

/**
 * 最後交易日＝到期月份的**第三個星期三**；該日休市時**順延**至次一營業日。
 *
 * 順延（不是提前）是期交所明文規定：「最後交易日若為假日或因不可抗力因素未能進行
 * 交易時，以其最近之次一營業日為最後交易日。」
 *
 * `holidays` 沒傳時退回純第三個星期三——證交所的休市日曆只涵蓋當年度，跨年的
 * 月份本來就查不到，此時 UI 會標示「未經假日校正」。
 */
export function lastTradingDay(month: string, holidays?: Holidays): string | null {
  const m = /^(\d{4})(\d{2})$/.exec(String(month || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); // 0=日 … 3=三
  const offset = (3 - firstDow + 7) % 7;
  const d = new Date(Date.UTC(y, mo - 1, 1 + offset + 14));
  const base = isoOf(d);
  if (!holidays) return base;
  return nextBusinessDay(base, holidays) ?? base;
}

/**
 * 最後結算日 ＝ 最後交易日（同一天）。
 *
 * ⚠️ 這裡曾經寫成「次一營業日」，是**錯的**。國內股價指數類與股票／ETF 期貨的
 * 最後結算價都是用**到期日當天**的價格算的（指數類取收盤前 30 分鐘標的指數算術
 * 平均、股票/ETF 類取收盤前 60 分鐘標的證券成交價算術平均），所以最後結算日就是
 * 最後交易日。會採「次一營業日」的是**國外**指數期貨（日經 225、S&P 500 那些）。
 *
 * 函式保留是為了讓呼叫端語意清楚，不是因為它算的是不同的日子。
 */
export function finalSettlementDay(month: string, holidays?: Holidays): string | null {
  return lastTradingDay(month, holidays);
}

/** 次一日曆天（不管是不是營業日）；格式不對就原樣回傳 */
export function nextDay(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return isoOf(d);
}

/** 兩個 'YYYY-MM-DD' 之間差幾個日曆天（to − from）；格式不對回 null */
export function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * from（不含）到 to（含）之間還有幾個**營業日**——轉倉真正在乎的是「還能下幾次單」，
 * 不是日曆天。沒有假日曆時只扣週末。to 早於 from 回負數。
 */
export function tradingDaysBetween(from: string, to: string, holidays?: Holidays): number | null {
  const span = daysBetween(from, to);
  if (span === null) return null;
  if (span === 0) return 0;
  const step = span > 0 ? 1 : -1;
  const d = new Date(from + 'T00:00:00Z');
  let count = 0;
  for (let i = 0; i < Math.abs(span); i += 1) {
    d.setUTCDate(d.getUTCDate() + step);
    if (isBusinessDay(isoOf(d), holidays)) count += step;
  }
  return count;
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

/** 已平倉損益的拆解：毛損益、手續費、交易稅、淨額 */
export interface ClosedBreakdown {
  gross: number;
  fees: number;
  tax: number;
  net: number;
  /** 費用是券商實收（截圖匯入帶進來的）還是用 spec 推估的 */
  actual_cost: boolean;
}

/**
 * 已平倉損益的拆解——已實現明細要分別顯示毛損益與費用，而費用該用哪個數字是有規則的
 * （見下），那規則只能有一份。`closedPnl` 只是取這裡的 net。
 *
 * 費用優先吃紀錄上券商實收的 `fee`／`tax`，沒有才用 spec 推估（見 ClosedTrade 的註解）。
 * 兩個欄位各自獨立判斷：截圖只認得出手續費、認不出交易稅時，至少手續費是真的。
 */
export function closedBreakdown(t: ClosedTrade, spec: FuturesSpec): ClosedBreakdown {
  const lots = Math.max(0, safe(t.lots));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const entry = Math.max(0, safe(t.entry_price));
  const exit = Math.max(0, safe(t.exit_price));
  const gross = sign(t.side) * (exit - entry) * unit * lots;
  const feeGiven = Number.isFinite(t.fee as number) && (t.fee as number) >= 0;
  const taxGiven = Number.isFinite(t.tax as number) && (t.tax as number) >= 0;
  const fees = feeGiven
    ? (t.fee as number)
    : Math.max(0, safe(spec.fee_per_lot)) * lots * 2;
  const tax = taxGiven
    ? (t.tax as number)
    : (entry + exit) * unit * lots * Math.max(0, safe(spec.tax_rate));
  return { gross, fees, tax, net: gross - fees - tax, actual_cost: feeGiven && taxGiven };
}

/** 已平倉損益（含來回費用）——用來累算已實現損益 */
export function closedPnl(t: ClosedTrade, spec: FuturesSpec): number {
  return closedBreakdown(t, spec).net;
}

/** closeLots() 的結果：一筆平倉紀錄，以及沒平完剩下的部位（全平＝null） */
export interface CloseLotsResult {
  closed: ClosedTrade;
  remaining: FuturesPosition | null;
}

/**
 * 把一筆部位平掉指定口數（**允許部分平倉**）。
 *
 * Why 要能部分平：原本只有「整筆平掉」一種操作，但真實交易 14 口是分 2/6/3 口出場的
 * （券商平倉查詢就是這樣一列一列給），只能整筆平的話使用者得先刪部位再手打兩筆，
 * 中間任何一步漏掉，已實現損益與保證金餘額就一起歪掉。
 *
 * 沒平完的剩餘部位**沿用同一個 id**，這樣掛在 id 上的停損價才不會因為減碼而不見。
 */
export function closeLots(
  pos: FuturesPosition,
  lots: number,
  exitPrice: number,
  exitDate: string,
  extra?: { id?: string; fee?: number; tax?: number; ref?: string; note?: string },
): CloseLotsResult | null {
  const have = Math.max(0, safe(pos?.lots));
  const want = Math.max(0, safe(lots));
  const price = Math.max(0, safe(exitPrice));
  if (!(have > 0) || !(want > 0) || want > have || !(price > 0)) return null;

  const closed: ClosedTrade = {
    id: extra?.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    product: pos.product,
    month: pos.month,
    side: pos.side,
    lots: want,
    entry_price: pos.entry_price,
    exit_price: price,
    exit_date: exitDate,
    ...(pos.entry_date ? { entry_date: pos.entry_date } : {}),
    ...(Number.isFinite(extra?.fee as number) ? { fee: extra!.fee } : {}),
    ...(Number.isFinite(extra?.tax as number) ? { tax: extra!.tax } : {}),
    ...(extra?.ref ? { ref: extra.ref } : {}),
    ...(extra?.note ? { note: extra.note } : {}),
  };
  const remaining: FuturesPosition | null = want < have ? { ...pos, lots: have - want } : null;
  return { closed, remaining };
}

// ── 帳戶資金進出 ────────────────────────────────────────────────────────────

/** 這筆進出對保證金專戶現金餘額的增減：入金 +、出金 −（金額一律取絕對值） */
export function flowDelta(f: CashFlow): number {
  const amt = Math.abs(safe(f?.amount));
  return f?.type === 'withdraw' ? -amt : amt;
}

export interface CashFlowSummary {
  deposit: number;   // 期間累計入金
  withdraw: number;  // 期間累計出金（正數）
  net: number;       // 淨投入＝入金 − 出金（可為負，代表已經領回比投入多）
  count: number;
}

/**
 * 資金進出彙總。`range` 兩端都是**含**，不填就是全部。
 *
 * 算報酬率時要用的是「基準日之後」的流量，故 equityStats 傳的 from 會是基準日的
 * 次一天——基準日當天的入金在那天收盤的權益數裡已經反映過了，再扣一次會重複。
 */
export function summarizeCashFlows(
  flows: CashFlow[] | undefined,
  range?: { from?: string; to?: string },
): CashFlowSummary {
  let deposit = 0;
  let withdraw = 0;
  let count = 0;
  for (const f of Array.isArray(flows) ? flows : []) {
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(f.date))) continue;
    if (range?.from && f.date < range.from) continue;
    if (range?.to && f.date > range.to) continue;
    const d = flowDelta(f);
    if (d === 0) continue;
    if (d > 0) deposit += d; else withdraw += -d;
    count += 1;
  }
  return { deposit, withdraw, net: deposit - withdraw, count };
}

// ── 報價：逐月份 ────────────────────────────────────────────────────────────

/**
 * 報價來源。不同到期月份是**不同的合約、不同的價格**（正價差時遠月更貴），
 * 所以帳戶彙總必須逐月份取價，不能全部套同一個數字——同時持有兩個月份時
 * 用單一價格評價，損益、追繳價、壓力測試會一起偏掉。
 *
 * 傳 number 時代表「所有月份都用這個價」，是單一月份持倉下的簡寫，
 * 也讓舊呼叫端與測試不用改寫。
 */
export type PriceInput = number | { byMonth: Record<string, number>; fallback?: number };

/** 取某月份的價格；該月沒報價時退回 fallback（通常是使用者手填的參考價） */
export function priceOf(input: PriceInput, month: string): number {
  if (typeof input === 'number') return Math.max(0, safe(input));
  const v = input?.byMonth?.[month];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return Math.max(0, safe(input?.fallback, 0));
}

/** 把整份報價平移 delta（壓力測試與情境試算用：各月份一起動，價差維持不變） */
export function shiftPrices(input: PriceInput, delta: number): PriceInput {
  const d = safe(delta);
  if (typeof input === 'number') return Math.max(0, input + d);
  const byMonth: Record<string, number> = {};
  for (const [m, v] of Object.entries(input?.byMonth ?? {})) byMonth[m] = Math.max(0, safe(v) + d);
  return { byMonth, fallback: Math.max(0, safe(input?.fallback, 0) + d) };
}

/** 把整份報價按比例縮放（跌 10% ＝ scalePrices(prices, 0.9)） */
export function scalePrices(input: PriceInput, ratio: number): PriceInput {
  const r = Math.max(0, safe(ratio, 1));
  if (typeof input === 'number') return Math.max(0, input * r);
  const byMonth: Record<string, number> = {};
  for (const [m, v] of Object.entries(input?.byMonth ?? {})) byMonth[m] = Math.max(0, safe(v) * r);
  return { byMonth, fallback: Math.max(0, safe(input?.fallback, 0) * r) };
}

// ── 帳戶層級彙總（保證金 / 風險指標 / 追繳斷頭價）────────────────────────────

export interface AccountSummary {
  total_lots: number;            // 總口數（不分方向，保證金按這個算）
  net_lots: number;              // 淨口數（多－空），決定價格風險方向
  long_lots: number;
  short_lots: number;
  contract_value: number;        // 名目曝險總額
  unrealized: number;            // 未實現損益（含來回費用）
  /**
   * 未實現損益的**毛額**（只有價差，不扣任何費用）。
   *
   * 存在的理由只有一個：跟期貨商對帳。期貨商 App 上的「未平倉損益」是毛額——出場那趟
   * 的手續費與期交稅還沒發生，他們不會先扣。本頁的 `unrealized` 則是刻意扣掉來回費用
   * 的淨額（那才是真正的損益平衡點）。兩個口徑都對，但拿去比對帳會差出一趟費用。
   */
  unrealized_gross: number;
  realized: number;              // 已實現損益（含費用）
  equity: number;                // 權益數＝保證金專戶現金 ＋ 未實現損益
  /** 期貨商口徑的權益數＝現金 ＋ **毛**未實現損益。只用於對帳顯示，不參與任何風控判斷。 */
  equity_broker: number;
  required_initial: number;      // 所需原始保證金
  required_maintenance: number;  // 所需維持保證金
  excess: number;                // 超額保證金＝權益數 − 所需原始保證金（負值代表已低於原始）
  risk_indicator: number | null; // 風險指標＝權益數 / 所需**原始**保證金（無部位時 null）
  /** 追繳線落在風險指標尺規上的位置＝維持保證金 ÷ 原始保證金（例：6,700/8,700＝77%） */
  margin_call_ratio: number | null;
  leverage: number | null;       // 槓桿＝名目曝險 / 權益數
  months: string[];              // 有未平倉口數的月份（排序後）
  reference_month: string;       // 口數最多的月份——追繳價／斷頭價以它的價格表示
  reference_price: number;       // 參考月份的現價
  margin_call_shift: number | null;  // 各月份一起移動多少會觸發追繳（負值＝下跌）
  liquidation_shift: number | null;  // 各月份一起移動多少會被強制平倉
  margin_call_price: number | null;  // 參考月份的追繳價（＝reference_price + margin_call_shift）
  liquidation_price: number | null;  // 參考月份的斷頭價
  status: 'flat' | 'ok' | 'warn' | 'call' | 'danger';
  /**
   * 以下三個欄位只有 summarizeAccountAll()（多商品彙總）才會填，summarizeAccount()
   * （單商品）維持 undefined——舊有呼叫端不用改就能繼續動作。
   */
  reference_product?: string;        // 參考月份所屬的商品代碼
  /** 觸發追繳／斷頭需要「大盤同時變動」的比例（負值＝下跌）；換算個別商品價格要再乘該商品的 beta */
  margin_call_move?: number | null;
  liquidation_move?: number | null;
  by_product?: ProductSummaryRow[];  // 逐商品的口數／曝險／損益／保證金小計
}

/** 逐商品的彙總小計，供多商品帳戶的畫面拆分顯示 */
export interface ProductSummaryRow {
  product: string;
  lots: number;
  contract_value: number;
  unrealized: number;
  required_initial: number;
  required_maintenance: number;
}

/**
 * 帳戶彙總。cash＝保證金專戶的現金餘額（入金 ± 已實現損益，不含未實現）。
 *
 * ⚠️ 風險指標的分母是**原始**保證金，不是維持保證金——這兩件事很容易混在一起，
 * 但它們是不同的門檻，各自對應不同的後果：
 *
 *   風險指標 ＝ 權益數 ÷ 未沖銷部位所需**原始**保證金（期交所定義，期貨商 App 顯示的就是它）
 *     ├ ＜ 25%  → 盤中代為沖銷（斷頭）。所以斷頭線是 25% × 原始保證金。
 *     └ ＜ 100% → 只是不能再開新倉，還不會被追繳。
 *
 *   追繳 ＝ 權益數 ＜ 所需**維持**保證金（另一條線，跟風險指標的 100% 不同一件事）
 *
 * 用維持保證金當分母會算出一個比實際大 原始/維持 倍的數字（SRF 約 1.3 倍），
 * 對不上期貨商 App，而且會把斷頭價算得比真的低——等於告訴你還有不存在的緩衝。
 */
export function summarizeAccount(
  positions: FuturesPosition[],
  price: PriceInput,
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
  let unrealized_gross = 0;
  const lotsByMonth = new Map<string, number>();

  for (const pos of list) {
    const lots = Math.max(0, safe(pos.lots));
    if (lots <= 0) continue;
    const s = sign(pos.side);
    total_lots += lots;
    net_lots += s * lots;
    if (s > 0) long_lots += lots; else short_lots += lots;
    const pnl = positionPnl(pos, priceOf(price, pos.month), spec);
    contract_value += pnl.contract_value;
    unrealized += pnl.net_pnl;
    unrealized_gross += pnl.gross_pnl;
    lotsByMonth.set(pos.month, (lotsByMonth.get(pos.month) ?? 0) + lots);
  }

  const months = [...lotsByMonth.keys()].sort();
  // 參考月份＝口數最多的那個（平手取近月），追繳價／斷頭價用它的價格來表達
  let reference_month = '';
  let refLots = -1;
  for (const m of months) {
    const l = lotsByMonth.get(m) ?? 0;
    if (l > refLots) { refLots = l; reference_month = m; }
  }
  const reference_price = total_lots > 0 ? priceOf(price, reference_month) : priceOf(price, '');

  const realized = (Array.isArray(closed) ? closed : []).reduce((sum, t) => sum + closedPnl(t, spec), 0);
  const cashBal = safe(cash);
  const equity = cashBal + unrealized;
  const equity_broker = cashBal + unrealized_gross;
  const required_initial = Math.max(0, safe(spec.initial_margin)) * total_lots;
  const required_maintenance = Math.max(0, safe(spec.maintenance_margin)) * total_lots;
  const excess = equity - required_initial;
  const risk_indicator = required_initial > 0 ? equity / required_initial : null;
  const margin_call_ratio = required_initial > 0 ? required_maintenance / required_initial : null;
  const leverage = equity > 0 && contract_value > 0 ? contract_value / equity : null;

  // 追繳價／斷頭價：解「所有月份一起移動 δ 時，權益數 ＝ 門檻」。
  // 月份之間的價差是市場結構（正/逆價差），崩盤時整條曲線一起下移而不是收斂到同一點，
  // 所以用平移建模比「全部設成同一個價」誠實得多。
  //   equity(δ) = equity(0) + unit·net_lots·δ − taxRate·unit·total_lots·δ
  // ⇒ δ* = (門檻 − equity(0)) / (unit·(net_lots − taxRate·total_lots))
  // 只有一個月份時，reference_price + δ* 與舊版的解析解完全相同。
  // net_lots = 0（完全對沖）時價格不再影響權益數，無解 → null。
  const taxRate = Math.max(0, safe(spec.tax_rate));
  const denom = unit * (net_lots - taxRate * total_lots);
  const shiftToEquity = (target: number): number | null => {
    if (net_lots === 0 || denom === 0) return null;
    return (target - equity) / denom;
  };

  const margin_call_shift = shiftToEquity(required_maintenance);
  const liquidation_shift = shiftToEquity(required_initial * Math.max(0, safe(spec.liquidation_ratio, 0.25)));
  const priceAt = (shift: number | null) => (shift === null ? null : Math.max(0, reference_price + shift));

  // 三條線各自獨立，不能靠同一個比值分級：斷頭看風險指標（÷原始）、
  // 追繳看權益數有沒有掉到維持保證金以下、warn 只是「不能再開新倉」。
  let status: AccountSummary['status'] = 'flat';
  if (total_lots > 0 && risk_indicator !== null) {
    if (risk_indicator < Math.max(0, safe(spec.liquidation_ratio, 0.25))) status = 'danger';
    else if (equity < required_maintenance) status = 'call';
    else if (equity < required_initial) status = 'warn';
    else status = 'ok';
  }

  return {
    total_lots, net_lots, long_lots, short_lots,
    contract_value, unrealized, unrealized_gross, realized, equity, equity_broker,
    required_initial, required_maintenance, excess,
    risk_indicator, margin_call_ratio, leverage,
    months, reference_month, reference_price,
    margin_call_shift, liquidation_shift,
    margin_call_price: priceAt(margin_call_shift),
    liquidation_price: priceAt(liquidation_shift),
    status,
  };
}

/**
 * 帳戶彙總——多商品版。行為與 summarizeAccount() 完全一致，唯一差別是每個部位
 * 依 `pos.product` 各自查自己的 spec／價格，不是全部套同一組。
 *
 * ⚠️ 追繳／斷頭價的解法必須跟著改：summarizeAccount() 解的是「參考商品的價格平移
 * δ」，這在只有一個商品時成立（所有部位共用同一個價格軸），但兩個不同商品
 * （例如 0050 期貨跟聯電期）的價格不能用同一個絕對平移量描述。這裡改成解
 * 「大盤同時變動 X%」，每個部位用自己商品的 beta 換算價格變動：
 *
 *   price_p(X) = price_p(0) · (1 + beta_p · X)
 *   equity(X)  = equity(0) + X · Σ_pos [ lots_p · unit_p · price_p(0) · beta_p · (sign_p − taxRate_p) ]
 *
 * 對 X 仍是線性（每個部位對 X 的偏微分是常數），所以解法跟原本一樣簡單，只是
 * denom 從「單一 spec 的封閉式」變成逐部位加總。只有一個商品、beta＝1 時，
 * X·beta_p·price_p(0) 就等於原本的 δ，兩個函式的 margin_call_shift／
 * liquidation_shift／margin_call_price／liquidation_price 逐位元相同
 * （見 futures.test.ts 的回歸測試）。
 */
export function summarizeAccountAll(
  positions: FuturesPosition[],
  products: Record<string, ProductPriceSpec>,
  cash: number,
  closed: ClosedTrade[] = [],
): AccountSummary {
  const keys = Object.keys(products);
  const fallbackKey = keys[0];
  const resolve = (code: string): ProductPriceSpec | undefined => products[code] ?? (fallbackKey ? products[fallbackKey] : undefined);
  const list = Array.isArray(positions) ? positions : [];

  let total_lots = 0;
  let net_lots = 0;
  let long_lots = 0;
  let short_lots = 0;
  let contract_value = 0;
  let unrealized = 0;
  let unrealized_gross = 0;
  let denom = 0;
  const lotsByRef = new Map<string, number>();      // key = `${product}:${month}`，找口數最多的那筆當參考
  const byProduct = new Map<string, ProductSummaryRow>();

  for (const pos of list) {
    const lots = Math.max(0, safe(pos.lots));
    if (lots <= 0) continue;
    const pp = resolve(pos.product);
    if (!pp) continue;
    const spec = pp.spec;
    const unit = Math.max(1, safe(spec.contract_size, 1000));
    const price0 = priceOf(pp.price, pos.month);
    const beta = Math.max(0, safe(pp.beta, 1));
    const s = sign(pos.side);
    const taxRate = Math.max(0, safe(spec.tax_rate));

    total_lots += lots;
    net_lots += s * lots;
    if (s > 0) long_lots += lots; else short_lots += lots;

    const pnl = positionPnl(pos, price0, spec);
    contract_value += pnl.contract_value;
    unrealized += pnl.net_pnl;
    unrealized_gross += pnl.gross_pnl;

    const k = unit * price0 * beta;
    denom += lots * k * (s - taxRate);

    const refKey = `${pos.product}:${pos.month}`;
    lotsByRef.set(refKey, (lotsByRef.get(refKey) ?? 0) + lots);

    const row = byProduct.get(pos.product) ?? {
      product: pos.product, lots: 0, contract_value: 0, unrealized: 0,
      required_initial: 0, required_maintenance: 0,
    };
    row.lots += lots;
    row.contract_value += pnl.contract_value;
    row.unrealized += pnl.net_pnl;
    row.required_initial += Math.max(0, safe(spec.initial_margin)) * lots;
    row.required_maintenance += Math.max(0, safe(spec.maintenance_margin)) * lots;
    byProduct.set(pos.product, row);
  }

  // 參考商品／月份＝口數最多的那組（平手取排序後第一個，跟 summarizeAccount 的
  // 「平手取近月」精神一致，只是 key 多了商品這一段）
  let reference_product = '';
  let reference_month = '';
  let refLots = -1;
  for (const key of [...lotsByRef.keys()].sort()) {
    const l = lotsByRef.get(key) ?? 0;
    if (l > refLots) {
      refLots = l;
      const [prod, month] = key.split(':');
      reference_product = prod;
      reference_month = month;
    }
  }
  const refPP = reference_product ? resolve(reference_product) : (fallbackKey ? products[fallbackKey] : undefined);
  const refBeta = refPP ? Math.max(0, safe(refPP.beta, 1)) : 1;
  const reference_price = total_lots > 0 && refPP ? priceOf(refPP.price, reference_month) : 0;

  const months = [...new Set(list.map((p) => p.month))].sort();
  const required_initial = [...byProduct.values()].reduce((sum, r) => sum + r.required_initial, 0);
  const required_maintenance = [...byProduct.values()].reduce((sum, r) => sum + r.required_maintenance, 0);

  const realized = (Array.isArray(closed) ? closed : []).reduce((sum, t) => {
    const pp = resolve(t.product);
    return pp ? sum + closedPnl(t, pp.spec) : sum;
  }, 0);
  const cashBal = safe(cash);
  const equity = cashBal + unrealized;
  const equity_broker = cashBal + unrealized_gross;
  const excess = equity - required_initial;
  const risk_indicator = required_initial > 0 ? equity / required_initial : null;
  const margin_call_ratio = required_initial > 0 ? required_maintenance / required_initial : null;
  const leverage = equity > 0 && contract_value > 0 ? contract_value / equity : null;

  const shiftToMove = (target: number): number | null => {
    if (denom === 0) return null;
    return (target - equity) / denom;
  };
  // liquidation_ratio 是期交所統一規定（25%），各商品理論上會一樣；有分歧時用參考商品的值
  const liquidationRatio = Math.max(0, safe(refPP?.spec.liquidation_ratio, 0.25));
  const margin_call_move = shiftToMove(required_maintenance);
  const liquidation_move = shiftToMove(required_initial * liquidationRatio);
  const moveToShift = (move: number | null) => (move === null ? null : reference_price * refBeta * move);
  const margin_call_shift = moveToShift(margin_call_move);
  const liquidation_shift = moveToShift(liquidation_move);
  const priceAt = (shift: number | null) => (shift === null ? null : Math.max(0, reference_price + shift));

  let status: AccountSummary['status'] = 'flat';
  if (total_lots > 0 && risk_indicator !== null) {
    if (risk_indicator < liquidationRatio) status = 'danger';
    else if (equity < required_maintenance) status = 'call';
    else if (equity < required_initial) status = 'warn';
    else status = 'ok';
  }

  return {
    total_lots, net_lots, long_lots, short_lots,
    contract_value, unrealized, unrealized_gross, realized, equity, equity_broker,
    required_initial, required_maintenance, excess,
    risk_indicator, margin_call_ratio, leverage,
    months, reference_month, reference_price,
    margin_call_shift, liquidation_shift,
    margin_call_price: priceAt(margin_call_shift),
    liquidation_price: priceAt(liquidation_shift),
    status,
    reference_product,
    margin_call_move,
    liquidation_move,
    by_product: [...byProduct.values()],
  };
}

// ── 轉倉提醒 ────────────────────────────────────────────────────────────────

export interface RolloverAlert {
  product: string;
  month: string;
  lots: number;
  last_trading_day: string | null;
  days_left: number | null;          // 距最後交易日還有幾個日曆天（負數＝已過期）
  trading_days_left: number | null;  // 還剩幾個營業日＝還能下幾次單（負數＝已過期）
  holiday_adjusted: boolean;         // true＝第三個星期三休市，已順延到次一營業日
  calendar_known: boolean;           // false＝沒有這個月份的假日曆，日期未經校正
  due: boolean;                      // 已進入提醒區間
  expired: boolean;                  // 最後交易日已過
  level: 'none' | 'soon' | 'urgent' | 'expired';
}

/**
 * 每個「商品＋有未平倉口數的月份」各給一則轉倉狀態——多商品時月份代碼會撞號
 * （兩個商品都可能有 202609），不能只用月份分組。
 *
 * 提醒區間用**營業日**判斷而不是日曆天：到期前一週如果卡到連假，日曆天還有 7 天
 * 但實際只剩 2 個交易日能處理，用日曆天算會晚兩天才亮燈。沒有假日曆時退回日曆天。
 *
 * level：urgent＝剩 2 個營業日內、soon＝已進提醒區間（預設前 7 天）、expired＝已過期。
 */
export function rolloverAlerts(
  positions: FuturesPosition[],
  specs: Record<string, FuturesSpec>,
  today: string,
  holidays?: Holidays,
): RolloverAlert[] {
  const byKey = new Map<string, { product: string; month: string; lots: number }>();
  for (const pos of Array.isArray(positions) ? positions : []) {
    const lots = Math.max(0, safe(pos.lots));
    if (lots <= 0) continue;
    const key = `${pos.product}:${pos.month}`;
    const row = byKey.get(key) ?? { product: pos.product, month: pos.month, lots: 0 };
    row.lots += lots;
    byKey.set(key, row);
  }

  const out: RolloverAlert[] = [];
  for (const { product, month, lots } of byKey.values()) {
    const spec = specs[product];
    const window = Math.max(0, safe(spec?.rollover_days, 7));
    const raw = lastTradingDay(month);                 // 未經假日校正的第三個星期三
    const ltd = lastTradingDay(month, holidays);       // 校正後
    // 假日曆只涵蓋當年度：月份不在涵蓋範圍內時，這個日期沒被真正驗證過
    const calendar_known = Boolean(holidays) && raw !== null
      && [...(holidays ?? [])].some((h) => h.slice(0, 4) === raw.slice(0, 4));
    const days_left = ltd ? daysBetween(today, ltd) : null;
    const trading_days_left = ltd ? tradingDaysBetween(today, ltd, holidays) : null;
    const expired = days_left !== null && days_left < 0;
    // 提醒區間優先用營業日；沒有假日曆時 tradingDaysBetween 只扣週末，仍比日曆天準
    const left = trading_days_left ?? days_left;
    const due = !expired && left !== null && left >= 0 && left <= window;
    let level: RolloverAlert['level'] = 'none';
    if (expired) level = 'expired';
    else if (left !== null && left <= 2) level = 'urgent';
    else if (due) level = 'soon';
    out.push({
      product,
      month,
      lots,
      last_trading_day: ltd,
      days_left,
      trading_days_left,
      holiday_adjusted: Boolean(holidays) && raw !== null && ltd !== null && raw !== ltd,
      calendar_known,
      due,
      expired,
      level,
    });
  }
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.product < b.product ? -1 : a.product > b.product ? 1 : 0)));
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

/**
 * 保證金來源：
 *   指數類（TX / MTX / TMF）＝期交所 OpenAPI `v1/IndexFuturesAndOptionsMargining`
 *     的 2026-07-28 公告值（該端點每日更新，opt25 會接成自動同步）。
 *   股票／ETF 類（SRF / NYF）＝期交所 2026-06-18 公告，**該類沒有 OpenAPI 端點**，
 *     只有 taifex.com.tw/cht/5/stockMargining 的 HTML 表格，目前仍需手動維護。
 *
 * 代碼是期交所 `DailyMarketReportFut` 的 Contract 欄位實際值（已對 361 個代碼核對），
 * 抓行情就是拿它去打 /api/futures/quote?contract=XXX。
 */
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
    code: 'TX',
    name: '臺股期貨（大台）',
    underlying: '加權指數',
    unit_label: '元/點',
    price_label: '台指點數',
    index_linked: true,
    spec: {
      contract_size: 200, tick_size: 1,
      initial_margin: 636000, maintenance_margin: 488000,
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
      initial_margin: 159000, maintenance_margin: 122000,
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
      initial_margin: 31800, maintenance_margin: 24400,
      fee_per_lot: 30, tax_rate: 0.00002, rollover_days: 7, liquidation_ratio: 0.25,
    },
  },
];

export function findPreset(code: string): (SymbolPreset & { spec: FuturesSpec }) | null {
  const c = String(code || '').trim().toUpperCase();
  return SYMBOL_PRESETS.find((p) => p.code === c) ?? null;
}

// ── 帳戶持有的商品（多商品併存）──────────────────────────────────────────────

/**
 * 帳戶目前持有／設定過的一個商品（內建的 SYMBOL_PRESETS 之一，或使用者自建的
 * 個股期貨）。FuturesConfig.products 是 `code → ProductConfig` 的表，
 * FuturesPosition.product／ClosedTrade.product 指到這裡的 key。
 *
 * 個股期貨沒有 OpenAPI 保證金端點（跟 SRF/NYF 同一類），契約規格一律手動輸入，
 * 跟既有 SRF/NYF 的維護模式一致——`is_custom` 只是用來在 UI 上跟 5 個內建預設分開列。
 */
export interface ProductConfig {
  code: string;               // 帳戶內部 key（內建商品＝SYMBOL_PRESETS 的 code；自建商品由使用者輸入）
  name: string;                // 顯示名稱，如「聯電期」
  quote_contract: string;      // 期交所 DailyMarketReportFut 的 Contract 欄位值（抓每日行情用）
  underlying: string;          // 標的描述，如「2303 聯電」或「0050」
  spec: FuturesSpec;
  beta: number;                // 標的相對大盤的連動係數，供斷頭價/追繳價的多商品情境換算與壓力測試用
  index_ref: number;           // 現價當下的加權指數
  index_linked: boolean;       // true＝標的本身就是大盤指數（beta 固定 1）
  price: number;               // 參考價／缺月份時的退路（抓期交所或手動輸入）
  prices: Record<string, number>; // 各到期月份的價格 'YYYYMM' → 價
  price_month: string;
  price_as_of: string;
  price_source: 'live' | 'daily' | 'manual';
  is_custom: boolean;          // true＝使用者自建（個股期貨等），false＝SYMBOL_PRESETS 內建
}

/** summarizeAccountAll／stressTest 需要的最小資訊：這個商品現在怎麼估價、規格是什麼 */
export interface ProductPriceSpec {
  spec: FuturesSpec;
  price: PriceInput;
  beta: number;
  index_ref?: number;
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
  drop: number;                  // 大盤變動比例（0.05＝跌 5%；負值＝上漲）
  index_after: number | null;    // 變動後的加權指數（沒填參考指數時 null）
  price_after: number;           // 變動後的參考月份價格
  unrealized: number;            // 該情境的未實現損益（含來回費用）
  equity: number;                // 該情境的權益數
  excess: number;                // 超額保證金
  risk_indicator: number | null;
  status: AccountSummary['status'];
  stopped_lots: number;          // 該情境下被停損出場的口數
  stop_realized: number;         // 停損實現的損益（已計入權益數）
}

/** 預設的壓力情境：小幅上漲到 2008 級崩盤（負值＝上漲，空單看的是這一側） */
export const DEFAULT_STRESS_DROPS = [-0.05, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3];

/**
 * 停損模擬：把在該情境下已經觸價的部位當成**真的出場**。
 *
 * 這比「假設你抱到斷頭」誠實：停損觸發後損益實現進保證金專戶、佔用的保證金也
 * 一併釋放，剩下的部位才繼續承受行情。沒設停損的部位維持原樣。
 */
function applyStops(
  positions: FuturesPosition[],
  products: Record<string, ProductPriceSpec>,
  stopLoss?: Record<string, number>,
): { remaining: FuturesPosition[]; realized: number; stoppedLots: number } {
  if (!stopLoss || Object.keys(stopLoss).length === 0) {
    return { remaining: Array.isArray(positions) ? positions : [], realized: 0, stoppedLots: 0 };
  }
  const remaining: FuturesPosition[] = [];
  let realized = 0;
  let stoppedLots = 0;
  for (const p of Array.isArray(positions) ? positions : []) {
    const pp = products[p.product];
    if (!pp) { remaining.push(p); continue; }
    const stop = safe(stopLoss[p.id], 0);
    const px = priceOf(pp.price, p.month);
    // 多單跌破停損、空單漲破停損 → 出場
    const hit = stop > 0 && (p.side === 'long' ? px <= stop : px >= stop);
    if (hit) {
      realized += positionPnl(p, stop, pp.spec).net_pnl;
      stoppedLots += Math.max(0, safe(p.lots));
    } else {
      remaining.push(p);
    }
  }
  return { remaining, realized, stoppedLots };
}

/**
 * 大盤變動 X% 時帳戶會變成什麼樣子——多商品版：每個商品各自的 beta 把「大盤變動」
 * 換算成自己的價格變動（跟 summarizeAccountAll 解斷頭價用的是同一套模型），
 * 縮放完再直接重跑 summarizeAccountAll()，費用/期交稅/多空對沖的處理跟總覽頁
 * 完全一致，不會出現「總覽算的跟壓力測試算的對不起來」。
 *
 * `drops` 是「大盤變動比例」本身（0.05＝跌 5%），不是任一商品自己的價格變動比例——
 * 每個商品用自己的 beta 再換算一次，這樣兩個 beta 不同的商品（例如 0050 期貨
 * beta≈1.05、某檔波動更大的個股期貨 beta≈1.3）才會在同一個「大盤跌多少」的情境
 * 下各自算出合理的價格變動。
 */
export function stressTest(
  positions: FuturesPosition[],
  products: Record<string, ProductPriceSpec>,
  cash: number,
  opts: { drops?: number[]; stopLoss?: Record<string, number> } = {},
): StressRow[] {
  const drops = (opts.drops ?? DEFAULT_STRESS_DROPS).slice().sort((a, b) => a - b);

  return drops.map((d) => {
    const drop = safe(d);
    const after: Record<string, ProductPriceSpec> = {};
    for (const [code, pp] of Object.entries(products)) {
      const beta = Math.max(0, safe(pp.beta, 1));
      after[code] = { ...pp, price: scalePrices(pp.price, Math.max(0, 1 - beta * drop)) };
    }
    const { remaining, realized, stoppedLots } = applyStops(positions, after, opts.stopLoss);
    const s = summarizeAccountAll(remaining, after, safe(cash) + realized, []);
    const refCode = s.reference_product || Object.keys(products)[0] || '';
    const refIndex = safe(products[refCode]?.index_ref, 0);
    return {
      drop,
      index_after: refIndex > 0 ? refIndex * (1 - drop) : null,
      price_after: s.reference_price,
      unrealized: s.unrealized,
      equity: s.equity,
      excess: s.excess,
      risk_indicator: s.risk_indicator,
      status: s.status,
      stopped_lots: stoppedLots,
      stop_realized: realized,
    };
  });
}

/** 口數最多的月份（平手取近月）；沒有部位時回空字串 */
export function referenceMonthOf(positions: FuturesPosition[]): string {
  const byMonth = new Map<string, number>();
  for (const p of Array.isArray(positions) ? positions : []) {
    const lots = Math.max(0, safe(p.lots));
    if (lots <= 0) continue;
    byMonth.set(p.month, (byMonth.get(p.month) ?? 0) + lots);
  }
  let best = '';
  let bestLots = -1;
  for (const m of [...byMonth.keys()].sort()) {
    const l = byMonth.get(m) ?? 0;
    if (l > bestLots) { bestLots = l; best = m; }
  }
  return best;
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

/** 目前未平倉部位壓成「一筆」的樣子，給分批試算的第一格用 */
export interface HoldingSnapshot {
  lots: number;        // 總口數（不分方向）
  avg_price: number;   // 依口數加權的平均進場價
  long_lots: number;
  short_lots: number;
  mixed: boolean;      // 多空並存：平均成本沒有單一意義，UI 要標出來
}

/**
 * 把現有未平倉部位彙總成一筆「建倉」，讓分批試算的第 1 格能直接吃真實持倉。
 *
 * 平均價用**口數加權**（跟 weightedEntry 同一套算法），不是把各筆進場價直接平均——
 * 20 口 @104.31 與 3 口 @104.50 的平均成本不是 104.405。
 *
 * 多空並存時 `mixed` 為 true：兩個方向的成本混在一起算沒有意義（空單的「成本」是
 * 反向的），數字照給但呼叫端必須講清楚，不能讓人以為那是真的平均成本。
 */
export function holdingAsBatch(positions: FuturesPosition[]): HoldingSnapshot {
  let lots = 0;
  let cost = 0;
  let long_lots = 0;
  let short_lots = 0;
  for (const p of Array.isArray(positions) ? positions : []) {
    const l = Math.max(0, safe(p?.lots));
    const price = Math.max(0, safe(p?.entry_price));
    if (l <= 0 || price <= 0) continue;
    lots += l;
    cost += price * l;
    if (p.side === 'short') short_lots += l; else long_lots += l;
  }
  return {
    lots,
    avg_price: lots > 0 ? cost / lots : 0,
    long_lots,
    short_lots,
    mixed: long_lots > 0 && short_lots > 0,
  };
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

/** 所有未平倉部位在指定報價下的未實現損益合計（含來回費用），逐月份取價 */
export function pnlAtPrice(positions: FuturesPosition[], price: PriceInput, spec: FuturesSpec): number {
  return (Array.isArray(positions) ? positions : [])
    .reduce((sum, p) => sum + positionPnl(p, priceOf(price, p.month), spec).net_pnl, 0);
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
  price: PriceInput,
  gainPct: number,
  reserveMultiple = 2.5,
): TargetPlan {
  const g = safe(gainPct);
  const refMonth = referenceMonthOf(positions);
  const p0 = priceOf(price, refMonth);
  const target_price = p0 * (1 + g);

  // 各月份按同一比例上漲（價差結構維持），再逐月份取價算損益
  const now = pnlAtPrice(positions, price, spec);
  const then = pnlAtPrice(positions, scalePrices(price, 1 + g), spec);
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
  price: PriceInput,
  peakPrice: number,
  distance: number,
): TrailingStopPlan {
  const refMonth = referenceMonthOf(positions);
  const refPrice = priceOf(price, refMonth);
  const peak = safe(peakPrice) > 0 ? safe(peakPrice) : refPrice;
  const dist = Math.abs(safe(distance));
  const net = (Array.isArray(positions) ? positions : [])
    .reduce((s, p) => s + sign(p.side) * Math.max(0, safe(p.lots)), 0);
  const dir = net < 0 ? -1 : 1; // 空單：停損價在最低價之上
  const stop_price = Math.max(0, peak - dir * dist);

  // peak / stop 都是「參考月份」的價格，換算成整份報價的平移量後再逐月份評價
  const atPeak = pnlAtPrice(positions, shiftPrices(price, peak - refPrice), spec);
  const atStop = pnlAtPrice(positions, shiftPrices(price, stop_price - refPrice), spec);

  return {
    peak_price: peak,
    stop_price,
    distance: dist,
    ticks: spec.tick_size > 0 ? Math.round(dist / spec.tick_size) : 0,
    locked_pnl: atStop,
    give_back: Math.abs(atPeak - atStop),
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
  flows?: CashFlow[];   // 有記資金進出時，報告會多一行「淨投入 vs 現在值多少」
}

const nt = (v: number) => `${v < 0 ? '-' : ''}NT$ ${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pctText = (v: number | null, d = 1) => (v === null ? '—' : `${(v * 100).toFixed(d)}%`);

/** 把整頁的關鍵數字擠成一段可複製的純文字。UI 只負責複製，內容全在這裡決定。 */
export function buildRiskReport(input: RiskReportInput): string {
  const { symbol_name, spec, summary: s, price, cash, index, beta, stress, plan, alerts, flows } = input;
  const L: string[] = [];

  L.push('【期貨部位風控評估】');
  L.push('─'.repeat(34));
  L.push(`商品：${symbol_name}（一口 ${spec.contract_size.toLocaleString('en-US')} 單位）`);
  L.push(`現在價格：${price.toFixed(2)}${s.reference_month ? `（${s.reference_month} 月份）` : ''}${index > 0 ? `，對應加權指數約 ${Math.round(index).toLocaleString('en-US')} 點（beta ${beta.toFixed(2)}）` : ''}`);
  L.push(`部位：多 ${s.long_lots} 口 / 空 ${s.short_lots} 口，淨 ${s.net_lots >= 0 ? '+' : ''}${s.net_lots} 口`);
  if (s.months.length > 1) {
    L.push(`持有月份：${s.months.join('、')}（各月份分別報價，追繳／斷頭價以 ${s.reference_month} 表示）`);
  }
  L.push(`名目曝險：${nt(s.contract_value)}${s.leverage !== null ? `（槓桿 ${s.leverage.toFixed(2)} 倍）` : ''}`);
  L.push('');
  L.push('【保證金水位】');
  L.push(`保證金專戶現金：${nt(cash)}`);
  L.push(`未實現損益：${nt(s.unrealized)}`);
  L.push(`權益數：${nt(s.equity)}`);
  L.push(`所需原始／維持保證金：${nt(s.required_initial)} ／ ${nt(s.required_maintenance)}`);
  L.push(`超額保證金：${nt(s.excess)}`);
  L.push(`風險指標：${pctText(s.risk_indicator)}（權益數 ÷ 原始保證金；＜25% 盤中代為沖銷）`);
  const cf = summarizeCashFlows(flows);
  if (cf.count > 0) {
    L.push(`淨投入資金：${nt(cf.net)}（入金 ${nt(cf.deposit)} − 出金 ${nt(cf.withdraw)}，共 ${cf.count} 筆）`);
    L.push(`相對淨投入的累積損益：${nt(s.equity - cf.net)}${cf.net > 0 ? `（${pctText((s.equity - cf.net) / cf.net)}）` : ''}`);
  }
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
      const tag = r.status === 'flat' ? '⬜ 已全數出場'
        : r.status === 'danger' ? '🟥 斷頭'
        : r.status === 'call' ? '🟨 追繳'
        : r.status === 'warn' ? '⚠️ 低於原始' : '✅ 正常';
      const move = r.drop >= 0 ? `-${(r.drop * 100).toFixed(0)}%` : `+${(-r.drop * 100).toFixed(0)}%`;
      const stopped = r.stopped_lots > 0 ? `、停損出場 ${r.stopped_lots} 口(${nt(r.stop_realized)})` : '';
      L.push(`  大盤 ${move} → 價 ${r.price_after.toFixed(2)}、權益 ${nt(r.equity)}、風險指標 ${pctText(r.risk_indicator, 0)}${stopped} ${tag}`);
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

/** scripts/futures_alert.cjs 每日寫進 data/futures_equity_history.json 的一列快照 */
export interface FuturesEquityRow {
  date: string;
  equity: number;
  cash: number;
  unrealized: number;
  contract_value: number;
  net_lots: number;
  total_lots: number;
  risk_indicator: number | null;
  price: number;
  status: string;
}

export interface EquityPoint {
  date: string;
  equity: number;
  peak: number;          // 到當日為止的權益數高點
  drawdown: number;      // (equity − peak) / peak，≤ 0；peak ≤ 0 時為 0
  risk_indicator: number | null;
  net_flow: number;      // 上一個快照日之後到當日（含）的淨入出金；第一個點恆為 0
  twr_index: number;     // 扣除入出金的淨值指數（起點 ＝ 1）
  twr_drawdown: number;  // 用 twr_index 算的回撤，≤ 0——出金不會在這條線上變成假回撤
}

export interface EquityStats {
  points: EquityPoint[];
  first: EquityPoint | null;
  last: EquityPoint | null;
  total_return: number | null;   // (last.equity − first.equity) / first.equity；first ≤ 0 → null
  max_drawdown: number;          // 最深的 drawdown（負值；無資料 → 0）
  max_drawdown_date: string;     // 最深那天
  days: number;                  // 資料筆數
  net_flow: number;              // 期間淨入出金（基準日之後）
  pnl_ex_flow: number;           // 期間真正賺賠＝權益數變化 − 淨入出金
  twr_return: number | null;     // 扣除入出金的期間報酬率（時間加權，跟基金淨值同一個口徑）
  max_drawdown_twr: number;      // 扣除入出金的最大回撤
  max_drawdown_twr_date: string;
  has_flows: boolean;            // 期間內真的有入出金——沒有的話兩套數字會完全一樣
}

/**
 * 從快照列算出權益曲線與回撤。rows 需已依日期升冪；函式內仍要自己排一次防呆。
 *
 * `flows` 傳入資金進出流水帳後，會另外算一組**扣掉外部資金**的數字：
 *   - 每個相鄰快照之間的報酬率 r ＝ (今日權益 − 期間淨入出金 − 昨日權益) ÷ 昨日權益
 *   - 把 r 連乘起來就是淨值指數（時間加權報酬，TWR），入出金不影響它
 * 這是唯一能同時回答「我操作得好不好」與「回撤有多深」的口徑；直接看權益數的話，
 * 出金會被算成虧損、入金會被算成獲利。
 */
export function equityStats(
  rows: FuturesEquityRow[],
  range?: { from?: string; to?: string },
  flows?: CashFlow[],
  /**
   * 目前設定的每口原始保證金。有給就用它把每一列的風險指標**重算**，不吃快照裡存的值。
   *
   * Why：快照的 `risk_indicator` 是寫入當天用當天的公式與當天的保證金算的。公式改過
   * （曾經誤用維持保證金當分母）、或期貨商調整保證金之後，同一條曲線上就會混著兩種
   * 口徑的數字，而看曲線的人無從分辨。重算的代價是「歷史點會隨現行保證金變動」，
   * 但那正是使用者要問的問題：以現在的保證金看，那天有多接近斷頭。
   */
  initialMarginPerLot?: number,
): EquityStats {
  // Sort rows in ascending order by date
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  // Apply date range filter
  const filtered = sorted.filter((row) => {
    if (range?.from && row.date < range.from) return false;
    if (range?.to && row.date > range.to) return false;
    return true;
  });

  if (filtered.length === 0) {
    return {
      points: [],
      first: null,
      last: null,
      total_return: null,
      max_drawdown: 0,
      max_drawdown_date: '',
      days: 0,
      net_flow: 0,
      pnl_ex_flow: 0,
      twr_return: null,
      max_drawdown_twr: 0,
      max_drawdown_twr_date: '',
      has_flows: false,
    };
  }

  let runningPeak = -Infinity;
  const points: EquityPoint[] = [];
  let maxDrawdown = 0; // Negative or 0
  let maxDrawdownDate = filtered[0].date;

  // 扣除入出金的淨值指數：起點 1，之後逐日連乘期間報酬率
  let twrIndex = 1;
  let twrPeak = 1;
  let maxDrawdownTwr = 0;
  let maxDrawdownTwrDate = filtered[0].date;
  let flowCount = 0;

  for (let i = 0; i < filtered.length; i += 1) {
    const row = filtered[i];
    const equity = row.equity;
    if (equity > runningPeak) {
      runningPeak = equity;
    }
    let drawdown = 0;
    if (runningPeak > 0) {
      drawdown = (equity - runningPeak) / runningPeak;
    }

    // 第一個點是基準日：當天的入出金已經反映在那天收盤的權益數裡，不能再扣一次，
    // 所以流量區間取「前一個快照日的次一天 ～ 當日」（左開右閉）。
    let netFlow = 0;
    if (i > 0) {
      const prev = filtered[i - 1];
      const f = summarizeCashFlows(flows, { from: nextDay(prev.date), to: row.date });
      netFlow = f.net;
      flowCount += f.count;
      const base = prev.equity;
      // 權益數歸零或轉負時報酬率沒有意義（分母 ≤ 0），指數持平不亂跳
      const r = base > 0 ? (equity - netFlow - base) / base : 0;
      twrIndex = Math.max(0, twrIndex * (1 + r));
    }
    if (twrIndex > twrPeak) twrPeak = twrIndex;
    const twrDrawdown = twrPeak > 0 ? (twrIndex - twrPeak) / twrPeak : 0;

    const im = safe(initialMarginPerLot, 0);
    const lots = Math.max(0, safe(row.total_lots));
    const risk_indicator = im > 0 && lots > 0
      ? equity / (im * lots)
      : (im > 0 && lots === 0 ? null : row.risk_indicator);

    points.push({
      date: row.date,
      equity,
      peak: runningPeak,
      drawdown,
      risk_indicator,
      net_flow: netFlow,
      twr_index: twrIndex,
      twr_drawdown: twrDrawdown,
    });

    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownDate = row.date;
    }
    if (twrDrawdown < maxDrawdownTwr) {
      maxDrawdownTwr = twrDrawdown;
      maxDrawdownTwrDate = row.date;
    }
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  let totalReturn: number | null = null;
  if (firstPoint.equity > 0) {
    totalReturn = (lastPoint.equity - firstPoint.equity) / firstPoint.equity;
  }

  const netFlowTotal = points.reduce((s, p) => s + p.net_flow, 0);

  return {
    points,
    first: firstPoint,
    last: lastPoint,
    total_return: totalReturn,
    max_drawdown: maxDrawdown,
    max_drawdown_date: maxDrawdownDate,
    days: points.length,
    net_flow: netFlowTotal,
    pnl_ex_flow: lastPoint.equity - firstPoint.equity - netFlowTotal,
    // 只有一個點時「期間報酬」不存在（TWR 需要至少一段區間），維持 null 而不是 0%
    twr_return: points.length > 1 ? twrIndex - 1 : null,
    max_drawdown_twr: maxDrawdownTwr,
    max_drawdown_twr_date: maxDrawdownTwrDate,
    has_flows: flowCount > 0,
  };
}

// ── 歷史校準：這個標的撐得住幾倍槓桿 ────────────────────────────────────────
/*
  這一段的數字全部來自一次回測，不是拍腦袋的預設值。資料與方法：

  價格序列（2000-01-05 → 2026-08-21，6,537 個交易日）
    · 2009-01 之後＝0050 還原權息收盤價（Yahoo；含 2014-01 的 1:4 分割修正）
    · 2000-01～2009-01＝0050 還沒上市，用加權指數當代理，波動用重疊期實測 beta
      （1.00，相關 0.83）校正，配息用 3.0%/年 補上，**不外加任何 alpha**——不把
      2009 年後台積電的後見之明搬回過去。
    · 再逐日扣掉台灣短期利率，把「現貨總報酬」轉成「期貨超額報酬」：
      F = S·e^((r−q)T)，配息由基差吸收，多單不領息但也不付息，淨效果就是少賺一個 r。

  模擬：逐日洗價、盤中用當日最低價檢查風險指標、追繳補錢／補不足就砍倉、
       月轉倉成本、±20% 帶狀再平衡。保證金用「佔契約價值的百分比」而非固定元數，
       因為期交所會隨標的價位調整級距，拿今天的 7,900 元去套 2000 年會失真。

  兩種讀法都做了，因為它們回答不同的問題：
    · 歷史單一路徑 → 「那 26 年實際會怎樣」。缺點是答案被「剛好從 2000 年泡沫頂點
      起算」綁架，而且結尾那段大多頭會讓高槓桿看起來很聰明。
    · 區塊自助抽樣（40 日區塊、400 條 20 年路徑）→ 「換一段歷史還成不成立」。
      缺點是打散了長期均值回歸，對「逢低加碼」不利，所以它給的是保守下限。
  下面的常數取自後者，因為做部位大小要看尾端風險，不是看中位數。
*/

/** 回測期間真的發生過的崩盤（合成 SRF 序列的高點→谷底跌幅） */
export interface HistoricalCrash {
  name: string;
  from: string;
  to: string;
  drop: number;      // 負數
  proxied: boolean;  // true＝這段用加權指數代理（0050 當時還沒上市）
}

export const HISTORICAL_CRASHES: HistoricalCrash[] = [
  { name: '網科泡沫', from: '2000-02-18', to: '2001-10-03', drop: -0.666, proxied: true },
  { name: '金融海嘯', from: '2007-10-29', to: '2008-11-20', drop: -0.585, proxied: true },
  { name: '2022 升息熊市', from: '2022-01-18', to: '2022-10-25', drop: -0.337, proxied: false },
  { name: 'COVID 崩盤', from: '2020-01-15', to: '2020-03-19', drop: -0.276, proxied: false },
  { name: '2025 關稅衝擊', from: '2025-01-08', to: '2025-04-09', drop: -0.267, proxied: false },
  { name: '2011 歐債', from: '2011-02-08', to: '2011-12-19', drop: -0.265, proxied: true },
  { name: '2015 中國股災', from: '2015-04-28', to: '2015-08-24', drop: -0.213, proxied: false },
  { name: '2024 日圓套利平倉', from: '2024-07-12', to: '2024-08-05', drop: -0.188, proxied: false },
];

/**
 * 各槓桿的回測體檢表（400 條 × 20 年區塊自助抽樣，已扣月轉倉成本，保證金專戶不計息）。
 *
 * 對照組：同一批路徑下「直接抱 0050 現貨、不用期貨」的中位 CAGR 是 **9.1%**。
 * 期貨 1 倍只有 5.0%，差的 4.1 個百分點就是融資成本(≈1.9%)＋轉倉成本(≈2.2%)——
 * 這就是為什麼「用期貨做 1 倍」永遠是虧的：你付了槓桿的錢卻沒有用到槓桿。
 */
export interface LeverageStat {
  leverage: number;
  median_cagr: number;   // 20 年 CAGR 中位數
  p05_cagr: number;      // 第 5 百分位（倒楣路徑）
  loss_prob: number;     // 20 年下來還是賠錢的機率
  median_mdd: number;    // 最大回撤中位數
  ruin_prob: number;     // 本金實質歸零的機率
}

export const LEVERAGE_CALIBRATION: LeverageStat[] = [
  { leverage: 0.50, median_cagr: 0.0306, p05_cagr: -0.010, loss_prob: 0.10, median_mdd: -0.36, ruin_prob: 0 },
  { leverage: 0.75, median_cagr: 0.0439, p05_cagr: -0.021, loss_prob: 0.14, median_mdd: -0.52, ruin_prob: 0 },
  { leverage: 1.00, median_cagr: 0.0499, p05_cagr: -0.037, loss_prob: 0.18, median_mdd: -0.64, ruin_prob: 0 },
  { leverage: 1.25, median_cagr: 0.0529, p05_cagr: -0.048, loss_prob: 0.21, median_mdd: -0.72, ruin_prob: 0 },
  { leverage: 1.50, median_cagr: 0.0518, p05_cagr: -0.068, loss_prob: 0.25, median_mdd: -0.77, ruin_prob: 0 },
  { leverage: 1.75, median_cagr: 0.0467, p05_cagr: -0.093, loss_prob: 0.30, median_mdd: -0.84, ruin_prob: 0 },
  { leverage: 2.00, median_cagr: 0.0376, p05_cagr: -0.115, loss_prob: 0.34, median_mdd: -0.88, ruin_prob: 0.020 },
  { leverage: 2.50, median_cagr: 0.0153, p05_cagr: -0.179, loss_prob: 0.46, median_mdd: -0.95, ruin_prob: 0.115 },
  { leverage: 3.00, median_cagr: -0.0362, p05_cagr: -0.182, loss_prob: 0.59, median_mdd: -0.98, ruin_prob: 0.303 },
];

/** 回測建議的預設參數。想改就改，這裡只是「歷史上表現最穩的那一組」。 */
export const CALIBRATED_PLAN = {
  base_leverage: 1.2,
  dip_step: 0.20,     // 距高點每跌 20% 加一級
  dip_add: 0.25,      // 每級加 0.25 倍槓桿
  dip_levels: 3,      // 最多加三級 → 上限 1.95 倍
  trim_step: 0.40,    // 從加碼成本起漲 40% 減一級
  trim_frac: 0.30,    // 每級減掉當時部位的三成
  trim_levels: 2,
  /** 轉倉成本超過這條線，加槓桿在數學上就打不贏直接持有 0050（回測解出來的臨界值） */
  roll_cost_breakeven: 0.015,
};

/** 在給定本金下，某個槓桿長什麼樣 */
export interface LeverageRow {
  leverage: number;
  lots: number;
  notional: number;
  margin_used: number;
  risk_indicator: number | null;
  margin_call_price: number | null;
  margin_call_drop: number | null;    // 負數，離追繳還有多少跌幅
  liquidation_price: number | null;
  liquidation_drop: number | null;
  killed_by: HistoricalCrash[];       // 這個槓桿會被哪幾次歷史崩盤斷頭
  stat: LeverageStat | null;          // 回測體檢（只有整齊的檔位才有）
}

function statFor(lv: number): LeverageStat | null {
  return LEVERAGE_CALIBRATION.find((s) => Math.abs(s.leverage - lv) < 1e-9) ?? null;
}

/**
 * 槓桿階梯表：同一筆本金在各種槓桿下的口數、風險指標、追繳／斷頭價，
 * 以及「歷史上哪幾次崩盤會直接把這個部位掃掉」。
 *
 * 追繳價與斷頭價不自己重算，一律借道 summarizeAccount()——那是全站唯一的風控算式
 * （含期交稅那一項），複製一份出來遲早會漂掉。
 */
export function leverageLadder(
  capital: number,
  price: number,
  spec: FuturesSpec,
  levels: number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5],
): LeverageRow[] {
  const cap = Math.max(0, safe(capital));
  const p = Math.max(0, safe(price));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  if (cap <= 0 || p <= 0) return [];

  return levels.map((lv) => {
    const lots = Math.max(0, Math.round((cap * lv) / (p * unit)));
    if (lots <= 0) {
      return {
        leverage: lv, lots: 0, notional: 0, margin_used: 0, risk_indicator: null,
        margin_call_price: null, margin_call_drop: null,
        liquidation_price: null, liquidation_drop: null, killed_by: [], stat: statFor(lv),
      };
    }
    const pos: FuturesPosition[] = [{
      id: 'lev-' + lv, product: 'SRF', month: '000000', side: 'long', lots,
      entry_price: p, entry_date: '',
    }];
    const s = summarizeAccount(pos, p, spec, cap);
    const liqDrop = s.liquidation_shift !== null ? s.liquidation_shift / p : null;
    return {
      leverage: lv,
      lots,
      notional: s.contract_value,
      margin_used: s.required_initial,
      risk_indicator: s.risk_indicator,
      margin_call_price: s.margin_call_price,
      margin_call_drop: s.margin_call_shift !== null ? s.margin_call_shift / p : null,
      liquidation_price: s.liquidation_price,
      liquidation_drop: liqDrop,
      // 崩盤跌幅比斷頭跌幅還深＝這個部位在那一次會被代沖銷
      killed_by: liqDrop === null ? [] : HISTORICAL_CRASHES.filter((c) => c.drop <= liqDrop),
      stat: statFor(lv),
    };
  });
}

/** 加碼階梯的一階 */
export interface DipStep {
  level: number;
  drop: number;            // 相對基準高點的跌幅（負數）
  price: number;           // 觸發價
  target_leverage: number; // 到價後想維持的槓桿
  target_lots: number;     // 到價時**帳上總共**該有幾口
  add_lots: number;        // 相對上一階要再加幾口
  equity_then: number;     // 到價時的權益數（部位已依前面各階加過碼）
  /**
   * true＝這一階的口數是被原始保證金上限壓下來的，不是策略想要的數字。
   * add_lots 為 0 時，這個旗標是「押不起」與「本來就不用加」的唯一分界——
   * 兩者在畫面上要講不同的話，講錯會讓人以為自己還有加碼空間。
   */
  capped: boolean;
}

/** 獲利減碼階梯的一階 */
export interface TrimStep {
  level: number;
  gain: number;        // 相對加碼成本的漲幅
  price: number;       // 觸發價
  close_lots: number;  // 這一階要平掉幾口
  remain_lots: number; // 平完剩幾口
  locked: number;      // 這一階平倉實現的損益（淨額）
}

export interface EntryPlan {
  peak_price: number;
  base_price: number;
  base_leverage: number;
  base_lots: number;
  base_notional: number;
  base_margin: number;
  /** 底倉之外預留的「加碼額度」，以名目金額表示＝(上限槓桿 − 底倉槓桿) × 本金 */
  reserve_notional: number;
  reserve_pct: number;      // 佔本金幾成
  reserve_lots: number;     // 還能再加幾口
  max_leverage: number;
  steps: DipStep[];
  trims: TrimStep[];
}

export interface EntryPlanOptions {
  base_leverage?: number;
  dip_step?: number;
  dip_add?: number;
  dip_levels?: number;
  trim_step?: number;
  trim_frac?: number;
  trim_levels?: number;
  peak_price?: number;
}

/**
 * 「平常放幾口、跌到哪裡加、漲到哪裡減」的完整計畫書。
 *
 * 兩個容易搞錯的地方，這裡刻意寫死：
 *
 * 1. **加碼的跌幅是從「高點」算，不是從「你的成本」算。** 從成本算會有一個致命的
 *    自我強化：每加一次碼成本就下移，於是「再跌 20%」的門檻也跟著下移，愈跌愈密集，
 *    最後在半山腰就把子彈打完。回測裡這正是把帳戶打到 −95% 的那組參數。
 *
 * 2. **每一階的口數是用「到價當下的權益數」重算，不是現在的權益數。** 跌 20% 時
 *    帳上已經虧了一輪，權益數變小，同樣的槓桿對應的口數也變少。用現在的權益去排
 *    加碼表，會排出一張到時候根本押不起的單。
 */
export function entryPlan(
  capital: number,
  price: number,
  spec: FuturesSpec,
  opts: EntryPlanOptions = {},
): EntryPlan {
  const o = { ...CALIBRATED_PLAN, ...opts };
  const cap = Math.max(0, safe(capital));
  const p = Math.max(0, safe(price));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const im = Math.max(0, safe(spec.initial_margin));
  const peak = safe(opts.peak_price) > 0 ? safe(opts.peak_price) : p;

  const baseLev = Math.max(0, safe(o.base_leverage));
  const dipStep = Math.max(0.01, safe(o.dip_step, 0.2));
  const dipAdd = Math.max(0, safe(o.dip_add));
  const dipLevels = Math.max(0, Math.round(safe(o.dip_levels)));
  const maxLev = baseLev + dipAdd * dipLevels;

  const lotsAt = (equity: number, lv: number, px: number) =>
    px > 0 ? Math.max(0, Math.round((equity * lv) / (px * unit))) : 0;

  const base_lots = cap > 0 && p > 0 ? lotsAt(cap, baseLev, p) : 0;

  const steps: DipStep[] = [];
  let prevLots = base_lots;
  for (let i = 1; i <= dipLevels; i++) {
    const drop = -dipStep * i;
    const stepPrice = peak * (1 + drop);
    if (!(stepPrice > 0)) break;
    // 到價時的權益數：底倉先跌一段，之前各階加的碼也各自跌了一段
    let equity = cap;
    if (p > 0) {
      equity -= base_lots * unit * (p - stepPrice);
      for (const s of steps) equity -= s.add_lots * unit * (s.price - stepPrice);
    }
    const lv = baseLev + dipAdd * i;
    const affordable = im > 0 ? Math.floor(equity / im) : Number.MAX_SAFE_INTEGER;
    const wanted = lotsAt(equity, lv, stepPrice);
    const target = Math.max(0, Math.min(wanted, affordable));
    steps.push({
      level: i,
      drop,
      price: stepPrice,
      target_leverage: lv,
      target_lots: target,
      add_lots: Math.max(0, target - prevLots),
      equity_then: equity,
      capped: wanted > affordable,
    });
    prevLots = Math.max(prevLots, target);
  }

  // 減碼階梯：從現價（＝這一輪的加碼成本）起算
  const trims: TrimStep[] = [];
  const trimStep = Math.max(0, safe(o.trim_step));
  const trimFrac = Math.min(0.9, Math.max(0, safe(o.trim_frac)));
  const trimLevels = Math.max(0, Math.round(safe(o.trim_levels)));
  let remain = base_lots;
  for (let i = 1; i <= trimLevels && trimStep > 0 && base_lots > 0; i++) {
    const gain = trimStep * i;
    const tp = p * (1 + gain);
    const close = Math.min(remain, Math.max(1, Math.round(remain * trimFrac)));
    if (close <= 0) break;
    const gross = close * unit * (tp - p);
    const fees = close * 2 * Math.max(0, safe(spec.fee_per_lot))
      + Math.max(0, safe(spec.tax_rate)) * unit * close * (p + tp);
    remain -= close;
    trims.push({ level: i, gain, price: tp, close_lots: close, remain_lots: remain, locked: gross - fees });
    if (remain <= 0) break;
  }

  const reserve_notional = Math.max(0, (maxLev - baseLev) * cap);
  return {
    peak_price: peak,
    base_price: p,
    base_leverage: baseLev,
    base_lots,
    base_notional: base_lots * unit * p,
    base_margin: base_lots * im,
    reserve_notional,
    reserve_pct: cap > 0 ? reserve_notional / cap : 0,
    reserve_lots: p > 0 ? Math.round(reserve_notional / (p * unit)) : 0,
    max_leverage: maxLev,
    steps,
    trims,
  };
}

export interface RollCostEstimate {
  rolls_per_year: number;
  per_side_pct: number;   // 單邊成本佔名目金額
  per_year_pct: number;   // 一年轉倉成本佔名目金額
  per_year_cash: number;  // 換算成錢（依目前名目曝險）
  breakeven_pct: number;
  verdict: 'ok' | 'tight' | 'bad';
}

/**
 * 轉倉成本估算——這頁最被低估的一項。
 *
 * 一次轉倉＝平掉近月 ＋ 開次月，兩邊都要付手續費、期交稅與滑價。月轉倉一年 12 次
 * 就是 24 邊。以現行費率與 1 檔滑價估，那是名目金額的 **2.1%/年**；回測解出來的
 * 臨界值是 1.5%/年——超過這條線，加槓桿賺到的東西全部被轉倉吃掉，還不如直接抱 0050。
 * 解法是用季月合約把 12 次降到 4 次，不是去凹手續費。
 */
export function rollCostEstimate(
  price: number,
  spec: FuturesSpec,
  rollsPerYear = 12,
  slippageTicks = 1,
  notional = 0,
): RollCostEstimate {
  const p = Math.max(0, safe(price));
  const unit = Math.max(1, safe(spec.contract_size, 1000));
  const lotValue = p * unit;
  const rolls = Math.max(0, safe(rollsPerYear));
  const perSide = lotValue > 0
    ? Math.max(0, safe(spec.fee_per_lot)) / lotValue
      + Math.max(0, safe(spec.tax_rate))
      + (Math.max(0, safe(slippageTicks)) * Math.max(0, safe(spec.tick_size))) / p
    : 0;
  const perYear = perSide * 2 * rolls;
  const be = CALIBRATED_PLAN.roll_cost_breakeven;
  return {
    rolls_per_year: rolls,
    per_side_pct: perSide,
    per_year_pct: perYear,
    per_year_cash: perYear * Math.max(0, safe(notional)),
    breakeven_pct: be,
    verdict: perYear > be ? 'bad' : perYear > be * 0.7 ? 'tight' : 'ok',
  };
}
