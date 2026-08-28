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
  stock: number; // stock_cash + stock_holdings_value 合併顯示（使用者的心智模型是「股市那邊的錢」，不分現金/庫存）
  futures: number;
  total: number;
}

export function snapshotComposition(s: NetWorthSnapshot): NetWorthComposition {
  const bank = s.bank;
  const stock = s.stock_cash + s.stock_holdings_value;
  const futures = s.futures_equity;
  return { bank, stock, futures, total: bank + stock + futures };
}

/** 'YYYY-MM-DD' 今天日期（本地時區），新增快照的預設日期 */
export function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
