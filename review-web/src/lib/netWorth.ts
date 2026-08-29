/**
 * netWorth.ts — 資產變化圖／淨資產快照的純計算核心。
 *
 * 跟 stockRealized.ts 同一個定位：純函式，沒有 React、沒有 I/O，方便單元測試。
 * 每筆快照四個數字（銀行／股票現金／股票庫存市值／期貨權益）都是「當下這一刻的
 * 存量」，不是損益——淨資產＝四個數字直接加總，沒有費用/稅金要扣。
 */

export interface NetWorthSnapshot {
  id: string;
  date: string; // 'YYYY-MM-DD'
  bank: number;
  stock_cash: number; // 已入帳＋在途交割的總額（stock_pending_settlement 已經算在裡面）
  stock_pending_settlement: number; // 拆出來顯示用，正＝應收、負＝應付
  stock_holdings_value: number;
  futures_equity: number;
  note?: string;
}

export function snapshotTotal(s: NetWorthSnapshot): number {
  return s.bank + s.stock_cash + s.stock_holdings_value + s.futures_equity;
}

/** 已入帳、不用等交割就能動用的現金——stock_cash 扣掉還在途的淨額 */
export function settledStockCash(s: NetWorthSnapshot): number {
  return s.stock_cash - s.stock_pending_settlement;
}

export interface NetWorthComposition {
  bank: number;
  /** 已入帳、不用等交割就能動用的券商現金——單獨一格顯示，不歸在 stock 底下
   *  （避免跟庫存市值混在一起看起來像同一種東西）。 */
  cash: number;
  /** 只算「股市特定」的部分：庫存市值＋在途交割淨額，不含已入帳現金（見 cash）。 */
  stock: number;
  futures: number;
  /** 完整總資產，與 snapshotTotal() 一致——bank + cash + stock + futures 應該剛好等於 total，
   *  四格拆分是為了不重複計算，不是為了讓總數對不起來。 */
  total: number;
}

export function snapshotComposition(s: NetWorthSnapshot): NetWorthComposition {
  return {
    bank: s.bank,
    cash: settledStockCash(s),
    stock: s.stock_pending_settlement + s.stock_holdings_value,
    futures: s.futures_equity,
    total: snapshotTotal(s),
  };
}

/** 'YYYY-MM-DD' 今天日期（本地時區），新增快照的預設日期 */
export function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
