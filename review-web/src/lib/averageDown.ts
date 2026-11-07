// 個股攤平計算機（再平衡計算機「個股攤平」分頁）的純計算邏輯。
//
// 三種算法：目標均價（要買多少才攤到 X）／手上預算（預算內最多買多少）／指定股數（買 N 股會變怎樣）。
// 全部含買進手續費；「損益平衡價」另含賣出時的手續費＋證交稅（跟玉山庫存的 price_evn 同一個算法，
// 2026-11-07 用台達電 2308 與欣興 3037 實帳戶驗算：1742.68、729.26 完全一致）。
//
// 台灣的費用規則：手續費＝成交金額×費率，無條件捨去；整股最低 20 元、零股最低 1 元。
// 證交稅（只有賣出收）：股票 0.3%、ETF 0.1%。

export type AssetKind = 'stock' | 'etf';
export type AvgMode = 'target' | 'budget' | 'shares';

/** 玉山電子下單手續費牌告 0.1425%（2026-11-07 比對使用者庫存成本，實際扣的是牌告原價） */
export const DEFAULT_FEE_RATE_PCT = 0.1425;
export const TAX_RATE: Record<AssetKind, number> = { stock: 0.003, etf: 0.001 };

/** 代號 00 開頭的是 ETF（0050、00878、00631L、00687B…），一般個股不會 00 開頭 */
export function kindOfCode(code: string): AssetKind {
  return /^00\d{2,4}[A-Z]?$/i.test(code.trim()) ? 'etf' : 'stock';
}

/** 解析輸入框文字；空白或非數字回 NaN */
export function parseNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const x = parseFloat(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(x) ? x : NaN;
}

export interface Holding {
  shares: number;
  /** 持有總成本（元，含買進手續費） */
  cost: number;
  price: number;
  kind: AssetKind;
}

export interface CalcEnv {
  /** 手續費率（小數，0.001425 = 0.1425%） */
  feeRate: number;
  /** 買進單位：1 = 零股、1000 = 整張 */
  unit: number;
}

export interface PlanInput {
  mode: AvgMode;
  /** 買進價格；NaN／≤0 = 用現價 */
  buyPrice: number;
  target: number;
  budget: number;
  buyShares: number;
}

export function feeOf(amount: number, env: CalcEnv): number {
  if (!(amount > 0)) return 0;
  const minFee = env.unit >= 1000 ? 20 : 1;
  return Math.max(minFee, Math.floor(amount * env.feeRate));
}

/** 損益平衡價：賣出時扣掉手續費與證交稅剛好不賠，無條件進位到分 */
export function breakEvenPrice(totalCost: number, shares: number, kind: AssetKind, feeRate: number): number {
  const p = totalCost / shares / (1 - feeRate - TAX_RATE[kind]);
  return Math.ceil(p * 100 - 1e-9) / 100;
}

export interface HoldingStats {
  avg: number;
  breakEven: number;
  /** 以現價賣出、扣完手續費與證交稅後的預估損益；沒現價時 NaN */
  pnl: number;
  pct: number;
}

export function holdingStats(h: Holding, env: CalcEnv): HoldingStats | null {
  if (!(h.shares > 0) || !(h.cost > 0)) return null;
  const avg = h.cost / h.shares;
  const breakEven = breakEvenPrice(h.cost, h.shares, h.kind, env.feeRate);
  let pnl = NaN;
  let pct = NaN;
  if (h.price > 0) {
    const mv = h.price * h.shares;
    pnl = mv - Math.floor(mv * env.feeRate) - Math.floor(mv * TAX_RATE[h.kind]) - h.cost;
    pct = pnl / h.cost;
  }
  return { avg, breakEven, pnl, pct };
}

export interface PlanOk {
  kind: 'ok';
  /** 要買幾股 */
  n: number;
  /** 實際用的買進價 */
  p: number;
  fee: number;
  /** 需準備金額（含手續費） */
  total: number;
  S0: number;
  A0: number;
  nS: number;
  nA: number;
  be0: number;
  be1: number;
  /** 現價離回本還差多少（>0 表示還要漲這麼多；≤0 已回本） */
  gap0: number;
  gap1: number;
  /** 買進價不低於目前均價 → 均價不會下降（指定股數／預算模式仍會算，但提醒使用者） */
  raisesAvg: boolean;
  /** 整張模式下輸入的股數被捨去時的說明 */
  note?: string;
}
export interface PlanMsg {
  /** bad＝輸入不完整或不合理；skip＝不需要攤平（買進價已不低於均價） */
  kind: 'bad' | 'skip';
  msg: string;
}
export type PlanResult = PlanOk | PlanMsg;

const fmt2 = (n: number) => n.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n: number) => Math.round(n).toLocaleString('zh-TW');

/** 預設的目標均價：目前均價與買進價（含手續費）的中點；買進價不低於均價時沒有意義，回空字串 */
export function defaultTarget(h: Holding, env: CalcEnv): string {
  const A0 = h.cost / h.shares;
  const pp = h.price * (1 + env.feeRate);
  if (!(A0 > 0) || !(pp > 0) || !(A0 > pp)) return '';
  return ((A0 + pp) / 2).toFixed(2);
}

// ───────────────────────── 「均價下降 %」滑軌 ─────────────────────────

export const DROP_STEP = 0.5;
/** 滑軌最多拉到均價下降 50%（再往下要買的股數會大到沒有參考價值） */
export const DROP_CAP = 50;

/** 目標均價 ＝ 目前均價 × (1 − 下降 %)；0% 代表「不攤平」，回空字串 */
export function targetForDrop(avg: number, pct: number): string {
  if (!(avg > 0) || !(pct > 0)) return '';
  return (avg * (1 - pct / 100)).toFixed(2);
}

/** 反算：目前的目標均價相當於均價下降幾 %；目標空白或不合理回 0 */
export function dropPctOf(avg: number, target: number): number {
  if (!(avg > 0) || !(target > 0) || !(target < avg)) return 0;
  return (1 - target / avg) * 100;
}

export interface DropMark {
  pct: number;
  /** 拉到這個 % 需準備的金額；0% 是 0；算不出來是 null */
  total: number | null;
}
export interface DropSlider {
  /** 滑軌右端（%），已對齊 DROP_STEP */
  max: number;
  /** 目前目標均價對應的下降 % */
  pct: number;
  marks: DropMark[];
}

/**
 * 滑軌的範圍與刻度。右端取「目標均價離買進價（含手續費）還有 5% 的空間」那一點——
 * 再往右買進股數趨近無限大；最多 {@link DROP_CAP}%。買進價已不低於均價、或空間不到一個
 * 刻度時回 null（這時不需要攤平，或請改用輸入框）。
 */
export function dropSlider(h: Holding, env: CalcEnv, buyPrice: number, target: number): DropSlider | null {
  if (!(h.shares > 0) || !(h.cost > 0)) return null;
  const p = buyPrice > 0 ? buyPrice : h.price;
  if (!(p > 0)) return null;
  const A0 = h.cost / h.shares;
  const pp = p * (1 + env.feeRate);
  if (!(A0 > pp)) return null;
  const reach = 0.95 * (1 - pp / A0) * 100;
  const max = Math.floor(Math.min(reach, DROP_CAP) / DROP_STEP) * DROP_STEP;
  if (!(max >= DROP_STEP)) return null;

  const gap = [1, 2, 5, 10, 20, 25].find((g) => max / g <= 5) ?? 25;
  const marks: DropMark[] = [];
  for (let pct = 0; pct <= max + 1e-9; pct += gap) {
    if (pct === 0) { marks.push({ pct, total: 0 }); continue; }
    const r = planAverageDown(h, env, {
      mode: 'target', buyPrice, target: parseFloat(targetForDrop(A0, pct)), budget: NaN, buyShares: NaN,
    });
    marks.push({ pct, total: r.kind === 'ok' ? r.total : null });
  }
  return { max, pct: Math.min(dropPctOf(A0, target), max), marks };
}

export function planAverageDown(h: Holding, env: CalcEnv, plan: PlanInput): PlanResult {
  const bad = (msg: string, kind: 'bad' | 'skip' = 'bad'): PlanMsg => ({ kind, msg });
  const f = env.feeRate;
  const unit = env.unit;
  const S0 = h.shares;
  const C0 = h.cost;
  const P = h.price;
  if (!(S0 > 0) || !(C0 > 0)) return bad('先填入持有股數與持有總成本。');
  const p = plan.buyPrice > 0 ? plan.buyPrice : P;
  if (!(p > 0)) return bad('先填入現價或買進價格。');

  const amt = (n: number) => Math.round(n * p);
  const cost = (n: number) => amt(n) + feeOf(amt(n), env);
  const A0 = C0 / S0;
  const pp = p * (1 + f); // 每股實際成本（含手續費，忽略最低手續費）
  let n: number;
  let note: string | undefined;

  if (plan.mode === 'target') {
    if (!(A0 > pp)) {
      return bad(`買進價格 ${fmt2(p)} 已不低於目前均價 ${fmt2(A0)}，買進不會讓均價下降，不需要攤平。`, 'skip');
    }
    const T = plan.target;
    if (!(T > 0)) return bad('輸入你想攤到的均價。');
    if (T >= A0) return bad(`目標均價要低於目前均價 ${fmt2(A0)}。`);
    if (T <= pp) return bad(`目標均價要高於買進價格 ${fmt2(pp)}（含手續費），否則買再多也攤不到。`);
    n = Math.ceil((S0 * (A0 - T)) / (T - pp) / unit) * unit;
    if (n > 1e8) return bad('目標均價太接近買進價格，需要買的股數過大。');
    // 最低手續費與四捨五入讓公式解差一點點，逐單位往上補到真的達標
    let g = 0;
    while ((C0 + cost(n)) / (S0 + n) > T && g++ < 200) n += unit;
  } else if (plan.mode === 'budget') {
    const B = plan.budget;
    if (!(B > 0)) return bad('輸入你手上的預算。');
    n = Math.floor(B / pp / unit) * unit;
    while (n > 0 && cost(n) > B) n -= unit;
    while (cost(n + unit) <= B) n += unit;
    if (n <= 0) return bad(`預算不足，買 ${unit === 1 ? '1 股' : '1 張'}至少要 ${fmt0(cost(unit))} 元。`);
  } else {
    const want = Math.floor(plan.buyShares);
    if (!(want > 0)) return bad('輸入要買進的股數。');
    n = Math.floor(want / unit) * unit;
    if (n <= 0) return bad('整張模式至少要買 1,000 股；零股請把「買進單位」切到零股。');
    if (n !== want) note = `整張模式只能買 1,000 股的倍數，${fmt0(want)} 股已捨去為 ${fmt0(n)} 股。`;
  }

  const a = amt(n);
  const fee = feeOf(a, env);
  const total = a + fee;
  const nS = S0 + n;
  const nC = C0 + total;
  const nA = nC / nS;
  const be0 = breakEvenPrice(C0, S0, h.kind, f);
  const be1 = breakEvenPrice(nC, nS, h.kind, f);
  const ref = P > 0 ? P : p;
  return {
    kind: 'ok', n, p, fee, total, S0, A0, nS, nA, be0, be1,
    gap0: be0 / ref - 1, gap1: be1 / ref - 1,
    raisesAvg: !(A0 > pp),
    note,
  };
}

// ───────────────────────── 真實持倉（玉山 full_inventory）轉成計算機的輸入 ─────────────────────────

export interface PositionLike {
  code: string;
  name?: string;
  shares: number;
  /** 不含手續費的均價 */
  avg_cost: number;
  market_price: number;
  /** 含買進手續費的總成本；舊快照沒有 */
  cost?: number;
}

/**
 * 同代號多列（整股＋零股）合併成一列：股數相加、均價用總價÷總股數重算、
 * 成本只在每一列都有時才相加（有缺就當整檔沒有，交給估算）。
 * 同步腳本已經先合併過，這裡是舊快照與日後改欄位的保險。
 */
export function mergePositions(list: PositionLike[]): PositionLike[] {
  const map = new Map<string, { p: PositionLike; priceSum: number; costSum: number; allCost: boolean }>();
  for (const x of list) {
    if (!x || !x.code || !(x.shares > 0)) continue;
    const cur = map.get(x.code);
    const hasCost = typeof x.cost === 'number' && x.cost > 0;
    if (!cur) {
      map.set(x.code, {
        p: { ...x },
        priceSum: x.avg_cost * x.shares,
        costSum: hasCost ? (x.cost as number) : 0,
        allCost: hasCost,
      });
    } else {
      cur.p.shares += x.shares;
      cur.priceSum += x.avg_cost * x.shares;
      if (hasCost) cur.costSum += x.cost as number;
      else cur.allCost = false;
      if (!cur.p.name && x.name) cur.p.name = x.name;
      if (x.market_price > 0) cur.p.market_price = x.market_price;
    }
  }
  return [...map.values()].map(({ p, priceSum, costSum, allCost }) => {
    const out: PositionLike = { ...p, avg_cost: p.shares > 0 ? priceSum / p.shares : 0 };
    if (allCost && costSum > 0) out.cost = costSum;
    else delete out.cost;
    return out;
  });
}

/** 舊快照沒有含費總成本時的估算：股數×均價＋買進手續費（多次買進各自捨去的零頭會差幾元） */
export function estimateCost(shares: number, avg: number, feeRate: number): number {
  const amount = Math.round(shares * avg);
  return amount + Math.floor(amount * feeRate);
}

/**
 * 同步時間字串→Date。VM 舊版腳本寫的是沒時區的 UTC 時間（VM 跑 UTC），
 * 不補 Z 瀏覽器會當成本地時間、早顯示 8 小時；新版已帶 +00:00。
 */
export function parseSyncTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
