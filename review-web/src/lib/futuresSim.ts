// 模擬建倉：「如果我現在買（賣）N 口大台／小台／微台…」。
//
// 完全重用 futures.ts 的帳戶算式（summarizeAccountAll／stressTest／positionPnl），
// 所以保證金、風險指標、追繳價、費用與期交稅的口徑跟總覽頁、壓力測試頁一模一樣；
// 這裡只負責把一筆「假想部位」疊上去、對不同口數各跑一次。純函式，不碰雲端設定。
//
// 期貨沒有「權利金」：買賣雙方都只付保證金（原始保證金才能開倉、低於維持保證金被追繳、
// 風險指標低於 25% 被強制平倉）。權利金是選擇權買方才有的概念，這裡不處理。
import {
  positionPnl, stressTest, summarizeAccountAll,
  type AccountSummary, type FuturesPosition, type FuturesSpec, type ProductPriceSpec, type Side,
} from './futures';

/** 假想部位在 products 表裡的 key（不會跟任何真實商品撞號） */
export const SIM_KEY = '__sim__';

export interface SimInput {
  spec: FuturesSpec;
  side: Side;
  /** 進場價（大台＝指數點數，ETF 期貨＝元） */
  entry: number;
  /** 保證金專戶現金（疊加既有部位時，就是帳戶目前的現金） */
  cash: number;
  /** 假想商品相對大盤的 beta；指數期貨＝1 */
  beta?: number;
  /** 假想部位的到期月份 'YYYYMM'；決定是否套遠月加收。省略＝近月（不加收） */
  month?: string;
  /** 判斷「最近月份」用的今天（'YYYY-MM-DD'）；省略＝台北時間今天。測試用。 */
  today?: string;
  /** 疊加在上面的既有真實部位；省略＝帳戶是空的，只算這一筆 */
  base?: { positions: FuturesPosition[]; products: Record<string, ProductPriceSpec> };
}

export interface SimRow {
  lots: number;
  /** 名目價值＝進場價 × 契約單位 × 口數 */
  notional: number;
  /** 帳戶合計的原始／維持保證金（有疊加真實部位時含真實部位） */
  initial: number;
  maintenance: number;
  /** 這筆假想部位自己佔的原始保證金 */
  sim_initial: number;
  /** 這筆來回手續費＋期交稅 */
  costs: number;
  /** 進場後權益數（現金＋含來回費用的未實現損益）、超額保證金、風險指標 */
  equity: number;
  excess: number;
  risk: number | null;
  status: AccountSummary['status'];
  leverage: number | null;
  /** 追繳價／斷頭價（用假想商品自己的價格表示）；進場當下就已觸發、或算不出來時 null */
  call_price: number | null;
  liq_price: number | null;
  /** 相對進場價的幅度（−0.12＝再跌 12% 觸發）；null 規則同上 */
  call_move: number | null;
  liq_move: number | null;
  /** 帳戶的原始保證金夠不夠開這個口數（損益兩平價進場、只付進場那一趟費用） */
  affordable: boolean;
}

const safe = (n: unknown, d = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : d);
/** beta 必須 > 0（0 代表商品不隨大盤動，這個模擬沒有意義），壞值一律當 1 */
const betaOf = (inp: SimInput): number => (safe(inp.beta, 1) > 0 ? safe(inp.beta, 1) : 1);

function build(inp: SimInput, lots: number) {
  const pos: FuturesPosition = {
    id: 'sim', product: SIM_KEY, month: inp.month ?? '', side: inp.side, lots, entry_price: inp.entry, entry_date: '',
  };
  const simProduct: ProductPriceSpec = {
    spec: inp.spec,
    price: inp.entry,
    beta: betaOf(inp),
    index_ref: 0,
  };
  return {
    pos,
    positions: [...(inp.base?.positions ?? []), pos],
    products: { ...(inp.base?.products ?? {}), [SIM_KEY]: simProduct },
  };
}

/** 假想部位開在這個口數時的帳戶狀況；口數 ≤ 0 或進場價無效時回 null */
export function simulateLots(inp: SimInput, lots: number): SimRow | null {
  const n = Math.floor(lots);
  const entry = safe(inp.entry);
  if (!(n > 0) || !(entry > 0)) return null;
  const { pos, positions, products } = build(inp, n);
  const s = summarizeAccountAll(positions, products, safe(inp.cash), [], inp.today);
  const pnl = positionPnl(pos, entry, inp.spec, inp.today);
  const beta = betaOf(inp);

  // 追繳／斷頭用「大盤同時變動 X%」表示；假想商品的價格變動 ＝ beta × X。
  // 進場當下權益就已經低於門檻時，那個方向的「距離」沒有意義（解出來是要往反方向走），不顯示。
  const callDone = s.status === 'call' || s.status === 'danger';
  const liqDone = s.status === 'danger';
  const mv = (m: number | null | undefined, done: boolean) => (m === null || m === undefined || done ? null : beta * m);
  const call_move = mv(s.margin_call_move, callDone);
  const liq_move = mv(s.liquidation_move, liqDone);
  const px = (m: number | null) => (m === null ? null : Math.max(0, entry * (1 + m)));

  const halfCosts = (pnl.fees + pnl.tax) / 2;
  return {
    lots: n,
    notional: pnl.contract_value,
    initial: s.required_initial,
    maintenance: s.required_maintenance,
    sim_initial: pnl.margin_required,
    costs: pnl.fees + pnl.tax,
    equity: s.equity,
    excess: s.excess,
    risk: s.risk_indicator,
    status: s.status,
    leverage: s.leverage,
    call_price: px(call_move),
    liq_price: px(liq_move),
    call_move,
    liq_move,
    affordable: s.excess + halfCosts >= 0,
  };
}

/** 帳戶資金最多開得起幾口（不含已疊加的真實部位佔用）；連 1 口都開不起回 0 */
export function maxAffordableLots(inp: SimInput, cap = 200): number {
  let best = 0;
  for (let n = 1; n <= cap; n++) {
    const r = simulateLots(inp, n);
    if (!r || !r.affordable) break;
    best = n;
  }
  return best;
}

export interface SimCell {
  /** 價格漲跌幅（+0.05＝漲 5%） */
  move: number;
  price: number;
  /** 這筆假想部位自己的損益（含來回費用） */
  pnl: number;
  /** 帳戶層級的未實現損益（含來回費用）：有疊加真實部位時＝假想部位＋真實部位；沒疊加時＝pnl */
  account_pnl: number;
  /** 帳戶層級：權益數、風險指標、狀態 */
  equity: number;
  risk: number | null;
  status: AccountSummary['status'];
}

/**
 * 口數 × 價格漲跌幅的情境矩陣。`moves` 是假想商品自己的價格漲跌（不是大盤）——
 * 有疊加真實部位時，真實部位照各自的 beta 隨「同一個大盤變動」一起動，所以帳戶層級
 * （權益、風險指標、狀態）會連真實部位一起算；`pnl` 只看假想的這一筆。
 */
export function simGrid(inp: SimInput, lotsList: number[], moves: number[]): SimCell[][] {
  const entry = safe(inp.entry);
  // 假想商品的價格變動 ＝ beta × 大盤變動，所以要讓它動 m，大盤要動 m / beta
  const unit = betaOf(inp);
  return lotsList.map((lots) => {
    const n = Math.floor(lots);
    if (!(n > 0) || !(entry > 0)) return moves.map((m) => ({ move: m, price: 0, pnl: 0, account_pnl: 0, equity: 0, risk: null, status: 'flat' as const }));
    const { pos, positions, products } = build(inp, n);
    const rows = stressTest(positions, products, safe(inp.cash), { drops: moves.map((m) => -m / unit), today: inp.today });
    const byDrop = new Map(rows.map((r) => [r.drop, r]));
    return moves.map((m) => {
      const r = byDrop.get(-m / unit);
      const price = Math.max(0, entry * (1 + m));
      return {
        move: m,
        price,
        pnl: positionPnl(pos, price, inp.spec, inp.today).net_pnl,
        account_pnl: r?.unrealized ?? 0,
        equity: r?.equity ?? 0,
        risk: r?.risk_indicator ?? null,
        status: r?.status ?? 'flat',
      };
    });
  });
}

/** 口數比較表要列哪幾列：1～10，再加上目前選的口數（超過 10 時）與資金上限 */
export function lotsToShow(selected: number, maxAfford: number): number[] {
  const set = new Set<number>();
  for (let i = 1; i <= 10; i++) set.add(i);
  if (selected > 0) set.add(Math.floor(selected));
  if (maxAfford > 0) set.add(maxAfford);
  return [...set].sort((a, b) => a - b);
}
