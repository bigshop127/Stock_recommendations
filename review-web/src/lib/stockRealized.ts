/**
 * stockRealized.ts — 個股／ETF 已實現損益的純計算核心（opt36）。
 *
 * 純函式，沒有 React、沒有 I/O，方便單元測試（stockRealized.test.ts）。
 * 比照 futures.ts 的定位：頁面只管畫面與輸入，算術一律走這裡。
 *
 * 跟期貨的已實現損益比，台股現股/ETF 有兩個算式上的差異，改動時要記得：
 *   1. 證交稅**只收賣方那一腿**，不像期貨的期交稅兩腿都收。
 *   2. 沒有「契約單位」這種東西，`qty` 直接就是股數，金額＝價格 × 股數。
 * 手續費仍是兩腿都收（買進/賣出各一次），這點跟期貨一樣。
 */

export type StockKind = 'stock' | 'etf';
export type Side = 'long' | 'short';

/** 費率設定（可在頁面上調整）。稅率是現行法規值，不是券商可議價的項目。 */
export interface FeeRates {
  fee_rate: number;        // 券商手續費牌告費率（買/賣各收一次）：0.1425%
  fee_discount: number;    // 手續費折扣，1＝不打折，0.6＝6 折
  stock_tax_rate: number;  // 個股證交稅（僅收賣方）：0.3%
  etf_tax_rate: number;    // ETF 證交稅（僅收賣方）：0.1%（現行法規優惠稅率）
}

export const DEFAULT_FEE_RATES: FeeRates = {
  fee_rate: 0.001425,
  fee_discount: 1,
  stock_tax_rate: 0.003,
  etf_tax_rate: 0.001,
};

/**
 * 一筆已實現交易。跟期貨的 `ClosedTrade` 同一個設計精神：`fee`/`tax` 有值就是
 * 券商實收（截圖辨識或手動填入），`null` 才用 `FeeRates` 推估——已實現損益是
 * 會影響對帳的真金白銀，實收優先於估算。
 */
export interface StockRealizedTrade {
  id: string;
  symbol: string;        // 台股代號，例如 '2330'、'0050'
  name: string;          // 股名快照，避免之後對不到名字
  kind: StockKind;       // 決定證交稅率；預設用代號規則判斷，可手動覆蓋
  /**
   * long＝現股買進後賣出；short＝融券賣出後買進回補。**只影響顯示與日期先後的
   * 提示，不影響金額計算**——`buy_price`/`sell_price` 是依交易類型命名（對應
   * 券商畫面的「買進均價」「賣出均價」兩欄），不是依先後順序命名，所以毛損益
   * 與證交稅兩種方向共用同一條公式，詳見 stockRealizedBreakdown()。
   */
  side: Side;
  qty: number;           // 股數（不是張數）
  buy_price: number;     // 買進均價
  sell_price: number;    // 賣出均價
  buy_date: string;      // 'YYYY-MM-DD'，可留空
  /**
   * 'YYYY-MM-DD'，必填——篩選用的主要日期。現股交易這是真正的平倉/實現日；
   * 融券交易嚴格說賣出（放空）發生在買進（回補）之前，這裡仍固定拿 sell_date
   * 篩選月份/區間，是刻意的簡化（融券在台股個人投資屬少數情境，兩腿時間通常
   * 相距不遠，不值得為此多養一套「取兩腿較晚日期」的邏輯）。
   */
  sell_date: string;
  fee: number | null;
  tax: number | null;
  note?: string;
  /** 截圖匯入的來源指紋，去重用 */
  ref?: string;
}

/** 台股 ETF 代號慣例＝'00' 開頭（含槓桿/反向的 00xxxL / 00xxxR），其餘視為個股 */
export function detectKind(symbol: string): StockKind {
  return /^00\d/.test(symbol) ? 'etf' : 'stock';
}

export interface StockRealizedBreakdown {
  gross: number;
  fee: number;
  tax: number;
  net: number;
  /** true＝手續費與證交稅都是券商實收，不是估算值 */
  actual_cost: boolean;
}

export function stockRealizedBreakdown(t: StockRealizedTrade, rates: FeeRates): StockRealizedBreakdown {
  const qty = Math.max(0, t.qty);
  const buy = Math.max(0, t.buy_price);
  const sell = Math.max(0, t.sell_price);

  /**
   * `buy_price`/`sell_price` 是**依交易類型命名**，不是依先後順序命名——跟券商
   * 「已實現損益查詢」畫面的「買進均價」「賣出均價」兩欄一一對應。融券是先賣
   * 後買，但「賣出均價」欄位存的還是那筆賣出的價格，所以毛損益與證交稅**兩種
   * 方向共用同一條公式，不必依 side 拆兩套**：
   *   毛損益＝(賣出均價－買進均價) × 股數——現股「低買高賣」跟融券「高賣低買」
   *   賺錢時這個式子都是正的。
   *   證交稅只收賣方那一腿，而賣方那一腿就是 `sell_price`，跟 side 無關。
   * `side` 只用來標示現股/融券（顯示用）與 UI 上「買進日/賣出日」何者在前的
   * 提示，不影響這裡的金額計算。
   */
  const gross = (sell - buy) * qty;

  const feeGiven = typeof t.fee === 'number' && Number.isFinite(t.fee) && t.fee >= 0;
  const taxGiven = typeof t.tax === 'number' && Number.isFinite(t.tax) && t.tax >= 0;

  const fee = feeGiven
    ? (t.fee as number)
    : (buy + sell) * qty * Math.max(0, rates.fee_rate) * Math.max(0, rates.fee_discount);

  const taxRate = t.kind === 'etf' ? rates.etf_tax_rate : rates.stock_tax_rate;
  const tax = taxGiven ? (t.tax as number) : sell * qty * Math.max(0, taxRate);

  return { gross, fee, tax, net: gross - fee - tax, actual_cost: feeGiven && taxGiven };
}

export function stockRealizedNet(t: StockRealizedTrade, rates: FeeRates): number {
  return stockRealizedBreakdown(t, rates).net;
}

/** 'YYYY-MM-DD' → 'YYYY-MM'；認不出來回 '' */
export function monthOf(dateStr: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr.slice(0, 7) : '';
}

/** 日期是否落在 [start, end] 區間內（任一端留空＝不限制那一側） */
export function inDateRange(dateStr: string, start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}
