/**
 * stockRealizedImport.ts — 個股／ETF 券商截圖辨識結果 → 已實現損益紀錄（opt36）。
 *
 * 比期貨的 futuresImport.ts 簡單很多：期貨截圖有「未平倉／平倉／成交回報」三種
 * 畫面要互相比對併帳，而台股券商的「已實現損益查詢」畫面**每一列本來就是一筆
 * 完整結算好的交易**（買賣雙腿、手續費、證交稅、損益都在同一列），不需要拿
 * 部位去湊、也不需要判斷「這筆是新倉還是平倉」——本質上就是「用來源指紋去重後
 * 直接新增」。
 */
import {
  DEFAULT_FEE_RATES,
  detectKind,
  stockRealizedBreakdown,
  type FeeRates,
  type Side,
  type StockKind,
  type StockRealizedTrade,
} from './stockRealized';
import type { StockRealizedConfig } from './stockRealizedStore';

/** gateway 辨識並正規化過的一列已實現交易（見 routes/stock_realized_ocr.js） */
export interface ScanTradeRow {
  symbol: string;
  name: string;
  kind: StockKind;
  side: Side;
  qty: number;
  buy_price: number;
  sell_price: number;
  buy_date: string;
  sell_date: string;
  fee: number | null;
  tax: number | null;
  /** 券商畫面上直接顯示的損益，只用來跟本頁算出來的淨額對帳，不會存進紀錄 */
  net_pnl: number | null;
  ref: string;
}

export interface StockScanScreen {
  title: string;
  rows: ScanTradeRow[];
  totals: { count: number | null; pnl: number | null };
  warnings: string[];
}

export interface ImportOp {
  text: string;
  skipped: boolean;
  amount: number | null;
}

export interface ImportCheck {
  label: string;
  screen: string;
  computed: string;
  ok: boolean;
}

export interface ImportPlan {
  ops: ImportOp[];
  warnings: string[];
  checks: ImportCheck[];
  changed: boolean;
  next: StockRealizedConfig;
  added_count: number;
  skipped_count: number;
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;

function makeTrade(r: ScanTradeRow, idx: number): StockRealizedTrade {
  const symbol = r.symbol;
  const kind = r.kind || detectKind(symbol);
  return {
    id: `s_${symbol}_${r.sell_date}_${r.side}_import_${idx}_${r.qty}_${r.sell_price}`,
    symbol,
    name: r.name || symbol,
    kind,
    side: r.side || 'long',
    qty: r.qty,
    buy_price: r.buy_price,
    sell_price: r.sell_price,
    buy_date: r.buy_date,
    sell_date: r.sell_date,
    fee: r.fee,
    tax: r.tax,
    ref: r.ref,
  };
}

/**
 * 建立匯入計畫。`config` 是目前雲端/本機的已實現損益設定，`screens` 是這一輪
 * 掃描到的畫面（可能不只一張）。回傳的 `next` 是套用後的完整設定，UI 按下
 * 「套用」時直接整包存回去即可。
 */
export function buildImportPlan(
  config: StockRealizedConfig,
  screens: StockScanScreen[],
  rates: FeeRates = DEFAULT_FEE_RATES,
): ImportPlan {
  const seenRefs = new Set<string>([
    ...config.imported_refs,
    ...config.trades.map((t) => t.ref).filter((r): r is string => Boolean(r)),
  ]);

  const ops: ImportOp[] = [];
  const warnings: string[] = [];
  const newTrades: StockRealizedTrade[] = [];
  const newRefs: string[] = [];
  let screenPnlTotal = 0;
  let hasScreenPnl = false;
  let computedPnlTotal = 0;
  let screenCountTotal = 0;
  let hasScreenCount = false;

  screens.forEach((screen) => {
    warnings.push(...screen.warnings);
    if (screen.totals.pnl !== null) { screenPnlTotal += screen.totals.pnl; hasScreenPnl = true; }
    if (screen.totals.count !== null) { screenCountTotal += screen.totals.count; hasScreenCount = true; }

    screen.rows.forEach((r, i) => {
      const ref = r.ref || `s|${r.symbol}|${r.sell_date}|${r.qty}|${r.buy_price}|${r.sell_price}`;
      if (seenRefs.has(ref)) {
        ops.push({ text: `已匯入過，略過：${r.name || r.symbol}（${r.symbol}）${r.sell_date} 賣出 ${r.qty} 股`, skipped: true, amount: null });
        return;
      }
      seenRefs.add(ref);
      const trade = { ...makeTrade(r, newTrades.length + i), ref };
      newTrades.push(trade);
      newRefs.push(ref);
      const net = stockRealizedBreakdown(trade, rates).net;
      computedPnlTotal += net;
      ops.push({
        text: `新增：${trade.name}（${trade.symbol}）${trade.sell_date} 賣出 ${trade.qty} 股 @${trade.sell_price}`,
        skipped: false,
        amount: net,
      });
    });
  });

  const checks: ImportCheck[] = [];
  if (hasScreenCount) {
    const computedCount = newTrades.length;
    checks.push({
      label: '筆數',
      screen: String(screenCountTotal),
      computed: String(computedCount),
      ok: screenCountTotal === computedCount,
    });
  }
  if (hasScreenPnl) {
    checks.push({
      label: '損益合計',
      screen: money(screenPnlTotal),
      computed: money(computedPnlTotal),
      // 截圖上的損益通常是「毛損益」或券商自己的淨額口徑，跟本頁淨額算法可能有
      // 些微差異，容許 1% 或 50 元的誤差，避免每次都跳「對不起來」的假警報。
      ok: Math.abs(screenPnlTotal - computedPnlTotal) <= Math.max(50, Math.abs(screenPnlTotal) * 0.01),
    });
  }

  const next: StockRealizedConfig = {
    ...config,
    trades: [...config.trades, ...newTrades],
    imported_refs: [...new Set([...config.imported_refs, ...newRefs])].slice(-300),
  };

  return {
    ops,
    warnings,
    checks,
    changed: newTrades.length > 0,
    next,
    added_count: newTrades.length,
    skipped_count: ops.filter((o) => o.skipped).length,
  };
}
