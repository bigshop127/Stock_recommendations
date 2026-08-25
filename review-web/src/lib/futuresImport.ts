/**
 * futuresImport.ts — 券商 App 截圖 →（辨識後的結構化列）→ 對帳成一份可預覽的異動計畫。
 *
 * 全部純函式、沒有 React 沒有 I/O。OCR 本身在 gateway（routes/futures_ocr.js）做完，
 * 這裡只吃「已經是結構化資料」的結果。分這一刀的理由：辨識會錯、模型會換，但
 * **「這些成交要怎麼變成部位與平倉紀錄」是會計問題不是辨識問題**，必須能單獨測。
 *
 * 三種截圖各自的定位（玉山期貨 App，其他券商欄位名大同小異）：
 *   ① 未平倉查詢 open   —— 券商當下的**快照**：每個月份/方向一列，含總口數與成交均價。
 *                           它是事實來源，但只有彙總、沒有分批明細。
 *   ② 平倉查詢   closed —— 已實現的**事件**：一列兩行（上行＝平倉腿、下行＝建倉腿），
 *                           含券商實收手續費與交易稅，是已實現損益最準的來源。
 *   ③ 成交回報   fills  —— 今天的**事件**：每筆成交一列，有「倉別＝新倉／平倉」。
 *
 * 匯入策略刻意是「先重放事件，再用快照驗收」：
 *   事件（②③）能保住分批進場的明細與日期，快照（①）保證最後的口數與均價跟券商一致。
 *   兩者對不起來時**不默默選一邊**，而是把差異攤在畫面上，讓使用者決定要不要以快照覆寫。
 *
 * 重複匯入是常態（同一天可能截好幾次圖），所以每一步都要能問「這筆我吃過了嗎」：
 *   優先比對 `ref`（成交時間＋委託書號組成的指紋），沒有 ref 才退回內容比對。
 */
import {
  closeLots, closedPnl, positionPnl, findPreset,
  type ClosedTrade, type FuturesPosition, type FuturesSpec, type Side,
} from './futures';

// ── gateway /api/futures/ocr 回傳的形狀 ─────────────────────────────────────

export type ScanKind = 'open' | 'closed' | 'fills' | 'account' | 'unknown';

/** ① 未平倉查詢的一列 */
export interface ScanOpenRow {
  product: string;
  month: string;              // 'YYYYMM'
  side: Side;                 // 買進＝多單、賣出＝空單
  lots: number;
  avg_price: number;          // 成交均價
  market_price: number | null;
  pnl: number | null;         // 未平倉損益（券商給的是毛額，未扣手續費）
}

/** ② 平倉查詢的一列（券商一列有兩行，這裡已經合併成一筆交易） */
export interface ScanClosedRow {
  product: string;
  month: string;
  side: Side;                 // 建倉方向（先買後賣＝多單）
  lots: number;
  entry_price: number;
  entry_date: string;         // 建倉腿的交易日期
  exit_price: number;
  exit_date: string;          // 平倉日期
  pnl: number | null;         // 平倉損益（毛）
  fee: number | null;         // 兩腿手續費合計
  tax: number | null;         // 兩腿交易稅合計
  net_pnl: number | null;     // 淨損益
  ref: string;
}

/** ③ 成交回報的一列 */
export interface ScanFillRow {
  product: string;
  month: string;
  direction: 'buy' | 'sell';  // 買賣別
  action: 'open' | 'close';   // 倉別：新倉／平倉
  lots: number;
  price: number;
  date: string;               // 'YYYY-MM-DD'
  time: string;               // 'HH:MM:SS'
  ref: string;
}

/** ④ 帳戶總覽／權益數查詢：沒有逐筆部位，只有整戶層級的單一數字（券商「期貨資產總覽」小卡或明細頁） */
export interface ScanAccountSummary {
  equity: number | null;             // 權益總值／權益數（毛額，含未平倉損益）
  unrealized_pnl: number | null;     // 未平倉損益／未沖銷期貨浮動損益（毛額）
  initial_margin: number | null;     // 原始保證金
  maintenance_margin: number | null; // 維持保證金／維持率保證金
  available_margin: number | null;   // 可動用（出金）保證金
  risk_ratio: number | null;         // 風險指標，單位百分比（304.31 代表 304.31%）
}

export interface ScanScreen {
  kind: ScanKind;
  title: string;
  open_rows: ScanOpenRow[];
  closed_rows: ScanClosedRow[];
  fill_rows: ScanFillRow[];
  /** 只有 kind === 'account' 才會有值——帳戶層級彙總，沒有部位可併帳，只拿來對帳現金 */
  account?: ScanAccountSummary | null;
  /** 截圖上自己寫的合計（估總損益／總損益／筆數），拿來驗收辨識有沒有漏列 */
  totals: { pnl: number | null; count: number | null };
  warnings: string[];
}

// ── 匯入計畫 ────────────────────────────────────────────────────────────────

/** 這份計畫會動到的設定切片（刻意不吃整包 FuturesConfig，才能單獨測） */
export interface ImportState {
  positions: FuturesPosition[];
  closed: ClosedTrade[];
  prices: Record<string, number>;
  stop_loss: Record<string, number>;
  cash: number;
  /**
   * 已經吃過的成交指紋。**去重不能只靠部位或平倉紀錄上還留著的 ref**：
   * 今天新倉的部位可能當天就被平掉（部位沒了）、或被未平倉快照合併改寫（ref 沒了），
   * 那時再匯一次同一張成交回報就會重開一次倉。這本帳跟資料在不在無關，才問得準。
   */
  imported_refs: string[];
}

/** 這本帳只留最近這麼多筆——一天頂多幾筆成交，這個量夠追溯好幾個月 */
export const MAX_IMPORTED_REFS = 300;

export type ImportOpKind =
  | 'closed_add'       // 新增一筆平倉紀錄
  | 'closed_skip'      // 這筆已經有了（去重）
  | 'closed_fee'       // 既有紀錄補上券商實收費用
  | 'position_add'     // 新倉成交 → 新增部位
  | 'position_reduce'  // 平倉 → 沖銷未平倉口數
  | 'position_rewrite' // 以未平倉快照覆寫某個月份/方向
  | 'price_update'     // 用截圖上的市價更新現價
  | 'cash_reconcile';  // 依帳戶總覽截圖的權益總值校正保證金專戶現金餘額

export interface ImportOp {
  kind: ImportOpKind;
  text: string;
  /** 對保證金專戶現金餘額的影響（已實現損益進出） */
  amount?: number;
  warn?: boolean;
}

/** 「截圖上寫的」vs「套用後這頁算出來的」逐項對帳 */
export interface ImportCheck {
  label: string;
  screen: string;
  computed: string;
  ok: boolean;
}

export interface ImportPlan {
  next: ImportState;
  ops: ImportOp[];
  checks: ImportCheck[];
  warnings: string[];
  cash_delta: number;
  changed: boolean;
}

export interface ImportOptions {
  today: string;
  /** 事件重放後仍與未平倉快照對不起來時，是否以快照覆寫（預設 true） */
  adoptSnapshot?: boolean;
  /** 是否用截圖上的「市價」更新各月份現價（預設 false——期交所報價通常比截圖新） */
  applyPrices?: boolean;
}

// ── 帳戶層級（多商品）匯入 ────────────────────────────────────────────────────

/** buildImportPlanForAccount 比對商品名稱／算損益需要的最小資訊 */
export interface ProductLookup {
  name: string;
  spec: FuturesSpec;
}

/** 帳戶層級的匯入狀態——涵蓋所有商品，靠 positions/closed 各自的 .product 分家 */
export interface AccountImportState {
  positions: FuturesPosition[];
  closed: ClosedTrade[];
  /** 商品代碼 → 該商品的月份報價表（各商品各自一份，SRF 跟個股期貨不能共用同一張） */
  product_prices: Record<string, Record<string, number>>;
  stop_loss: Record<string, number>;
  cash: number;
  imported_refs: string[];
}

export interface AccountImportPlan {
  next: AccountImportState;
  ops: ImportOp[];
  checks: ImportCheck[];
  warnings: string[];
  cash_delta: number;
  changed: boolean;
}

const EPS = 0.005;          // 價格比對容差（最小跳動 0.05 的十分之一）
const EPS_ENTRY = 0.011;    // 建倉價比對容差：抓得比報價鬆，因為券商是加權均價

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const px = (v: number) => v.toFixed(2);
const mLabel = (m: string) => (/^\d{6}$/.test(m) ? `${m.slice(0, 4)}/${m.slice(4)}` : m || '—');
const sLabel = (s: Side) => (s === 'long' ? '多單' : '空單');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 成交回報的「買賣別 × 倉別」→ 這筆講的是哪個方向的部位 */
export function fillSide(row: Pick<ScanFillRow, 'direction' | 'action'>): Side {
  if (row.action === 'open') return row.direction === 'buy' ? 'long' : 'short';
  // 平倉：賣出是把多單平掉、買進是把空單回補
  return row.direction === 'sell' ? 'long' : 'short';
}

/** 某個月份／方向目前的總口數與口數加權均價 */
export function aggregatePositions(positions: FuturesPosition[]): Map<string, { lots: number; avg: number }> {
  const acc = new Map<string, { lots: number; cost: number }>();
  for (const p of positions) {
    const lots = Math.max(0, num(p.lots));
    if (lots <= 0) continue;
    const k = `${p.month}:${p.side}`;
    const cur = acc.get(k) ?? { lots: 0, cost: 0 };
    cur.lots += lots;
    cur.cost += lots * Math.max(0, num(p.entry_price));
    acc.set(k, cur);
  }
  const out = new Map<string, { lots: number; avg: number }>();
  for (const [k, v] of acc) out.set(k, { lots: v.lots, avg: v.lots > 0 ? v.cost / v.lots : 0 });
  return out;
}

/** 兩筆平倉紀錄是不是同一件事（沒有 ref 可比時的退路） */
function sameClosed(
  a: ClosedTrade,
  b: Pick<ScanClosedRow, 'month' | 'side' | 'lots' | 'entry_price' | 'exit_price' | 'exit_date'>,
): boolean {
  return a.month === b.month
    && a.side === b.side
    && a.lots === b.lots
    && a.exit_date === b.exit_date
    && Math.abs(num(a.exit_price) - b.exit_price) < EPS
    && Math.abs(num(a.entry_price) - b.entry_price) < EPS_ENTRY;
}

/**
 * 把某月份／方向的未平倉口數沖銷掉 n 口（FIFO：先進場的先出場）。
 *
 * 這裡刻意**不產生平倉紀錄**——平倉紀錄由券商截圖那一列直接提供（含它自己配對到的
 * 建倉價與實收費用），比我們自己按 FIFO 猜的準。這一步只負責「未平倉那邊要少掉幾口」。
 */
function reduceFifo(
  positions: FuturesPosition[],
  month: string,
  side: Side,
  lots: number,
): { positions: FuturesPosition[]; used: number; short: number } {
  let left = lots;
  const out: FuturesPosition[] = [];
  const pool = positions
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.month === month && p.side === side && num(p.lots) > 0)
    .sort((a, b) => {
      const da = a.p.entry_date || '9999-12-31';
      const db = b.p.entry_date || '9999-12-31';
      return da < db ? -1 : da > db ? 1 : a.i - b.i;
    });
  const take = new Map<number, number>();
  for (const { p, i } of pool) {
    if (left <= 0) break;
    const t = Math.min(left, num(p.lots));
    take.set(i, t);
    left -= t;
  }
  positions.forEach((p, i) => {
    const t = take.get(i) ?? 0;
    if (t <= 0) { out.push(p); return; }
    const rest = num(p.lots) - t;
    if (rest > 0) out.push({ ...p, lots: rest });
  });
  return { positions: out, used: lots - left, short: left };
}

/**
 * 主流程：吃辨識結果與目前設定，產出「要做哪些事」與「做完長什麼樣」。
 *
 * 不直接改任何東西——呼叫端拿到 plan 之後由使用者確認才套用（與 opt25 保證金同步
 * 同一套兩段確認）。原因很實際：辨識錯一個數字就會動到真金白銀的現金餘額。
 *
 * ⚠️ **這支只認一個商品**：`state.positions`／`state.closed`／`state.prices` 必須是
 * 呼叫端已經篩過、只屬於 `product` 這個商品的子集（多商品帳戶時，月份代碼在不同
 * 商品間會撞號，混在一起會配對錯）。帳戶層級的多商品截圖匯入請走
 * `buildImportPlanForAccount()`——它負責把截圖依 OCR 認出的商品名稱拆開，
 * 對每個商品各呼叫一次這支再把結果併回去。
 */
export function buildImportPlan(
  state: ImportState,
  screens: ScanScreen[],
  spec: FuturesSpec,
  product: string,
  opts: ImportOptions,
): ImportPlan {
  const adoptSnapshot = opts.adoptSnapshot !== false;
  const applyPrices = opts.applyPrices === true;
  const ops: ImportOp[] = [];
  const checks: ImportCheck[] = [];
  const warnings: string[] = [];

  let positions = state.positions.map((p) => ({ ...p }));
  const closed = state.closed.map((t) => ({ ...t }));
  const prices = { ...state.prices };
  const stop_loss = { ...state.stop_loss };
  let cash = num(state.cash);
  let cashDelta = 0;
  let seq = 0;
  const nid = (prefix: string) => `${prefix}_imp${opts.today.replace(/-/g, '')}_${++seq}`;

  for (const s of screens) warnings.push(...s.warnings);

  const refsInUse = new Set<string>(Array.isArray(state.imported_refs) ? state.imported_refs : []);
  for (const p of positions) if (p.ref) refsInUse.add(p.ref);
  for (const t of closed) if (t.ref) refsInUse.add(t.ref);
  const consumed = new Set<string>();

  // ── ② 平倉查詢：已實現的事件，最準的一份 ────────────────────────────────
  const closedRows = screens
    .filter((s) => s.kind === 'closed')
    .flatMap((s) => s.closed_rows)
    .slice()
    .sort((a, b) => (a.exit_date < b.exit_date ? -1 : a.exit_date > b.exit_date ? 1 : 0));

  const matchedExisting = new Set<string>();
  for (const r of closedRows) {
    const label = `${mLabel(r.month)} ${sLabel(r.side)} ${r.lots} 口 ${px(r.entry_price)} → ${px(r.exit_price)}（${r.exit_date}）`;

    if (r.ref && refsInUse.has(r.ref)) {
      ops.push({ kind: 'closed_skip', text: `已匯入過，略過：${label}` });
      continue;
    }
    const hit = closed.find((t) => !matchedExisting.has(t.id) && sameClosed(t, r));
    if (hit) {
      matchedExisting.add(hit.id);
      ops.push({ kind: 'closed_skip', text: `已有相同紀錄，略過：${label}` });
      // 既有紀錄若是手動輸入的，費用是用設定值推估的；截圖有券商實收金額就補上，
      // 並把差額同步反映到現金餘額——否則「帳戶現金」會跟券商對帳單差一筆手續費。
      if (!Number.isFinite(hit.fee as number) && r.fee !== null && r.tax !== null) {
        const before = closedPnl(hit, spec);
        hit.fee = r.fee;
        hit.tax = r.tax;
        if (r.ref) { hit.ref = r.ref; refsInUse.add(r.ref); consumed.add(r.ref); }
        const diff = closedPnl(hit, spec) - before;
        if (Math.abs(diff) >= 0.5) {
          cash += diff;
          cashDelta += diff;
          ops.push({
            kind: 'closed_fee',
            text: `補上券商實收費用（手續費 ${money(r.fee)}、交易稅 ${money(r.tax)}）：${label}`,
            amount: diff,
          });
        }
      } else if (r.ref) {
        if (!hit.ref) hit.ref = r.ref;
        refsInUse.add(r.ref);
        consumed.add(r.ref);
      }
      continue;
    }

    const t: ClosedTrade = {
      id: nid('c'),
      product,
      month: r.month,
      side: r.side,
      lots: r.lots,
      entry_price: r.entry_price,
      exit_price: r.exit_price,
      exit_date: r.exit_date,
      ...(r.entry_date ? { entry_date: r.entry_date } : {}),
      ...(r.fee !== null ? { fee: r.fee } : {}),
      ...(r.tax !== null ? { tax: r.tax } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
    };
    closed.push(t);
    if (r.ref) { refsInUse.add(r.ref); consumed.add(r.ref); }
    const pnl = closedPnl(t, spec);
    cash += pnl;
    cashDelta += pnl;
    ops.push({ kind: 'closed_add', text: `新增平倉紀錄：${label}`, amount: pnl });

    const red = reduceFifo(positions, r.month, r.side, r.lots);
    positions = red.positions;
    if (red.used > 0) {
      ops.push({ kind: 'position_reduce', text: `沖銷未平倉：${mLabel(r.month)} ${sLabel(r.side)} −${red.used} 口` });
    }
    if (red.short > 0) {
      ops.push({
        kind: 'position_reduce',
        warn: true,
        text: `${mLabel(r.month)} ${sLabel(r.side)} 平掉 ${r.lots} 口，但這頁只記錄了 ${red.used} 口未平倉，差 ${red.short} 口沒東西可沖銷`,
      });
    }
  }

  // ── ③ 成交回報：今天的事件，補上快照沒有的分批明細與日期 ────────────────
  const fillRows = screens
    .filter((s) => s.kind === 'fills')
    .flatMap((s) => s.fill_rows)
    .slice()
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

  // 平倉成交與「平倉查詢」講的是同一件事。同一天同價位已經有平倉紀錄的口數要先扣掉，
  // 否則兩張截圖一起匯入會把同一筆平倉算兩次（現金餘額直接多一份損益）。
  const coverKey = (month: string, side: Side, date: string, price: number) =>
    `${month}:${side}:${date}:${price.toFixed(2)}`;
  const covered = new Map<string, number>();
  for (const t of closed) {
    const k = coverKey(t.month, t.side, t.exit_date, num(t.exit_price));
    covered.set(k, (covered.get(k) ?? 0) + num(t.lots));
  }

  for (const r of fillRows) {
    const side = fillSide(r);
    const label = `${mLabel(r.month)} ${r.direction === 'buy' ? '買進' : '賣出'} ${r.lots} 口 @${px(r.price)}（${r.time || r.date}）`;

    if (r.ref && refsInUse.has(r.ref)) {
      ops.push({ kind: 'closed_skip', text: `已匯入過，略過：${label}` });
      continue;
    }

    if (r.action === 'open') {
      const dup = positions.find(
        (p) => p.month === r.month && p.side === side && p.lots === r.lots
          && Math.abs(num(p.entry_price) - r.price) < EPS && p.entry_date === r.date,
      );
      if (dup) {
        ops.push({ kind: 'closed_skip', text: `已有相同部位，略過：${label}` });
        continue;
      }
      positions.push({
        id: nid('f'),
        product,
        month: r.month,
        side,
        lots: r.lots,
        entry_price: r.price,
        entry_date: r.date,
        ...(r.ref ? { ref: r.ref } : {}),
      });
      if (r.ref) { refsInUse.add(r.ref); consumed.add(r.ref); }
      ops.push({
        kind: 'position_add',
        text: `新倉成交 → 新增部位：${mLabel(r.month)} ${sLabel(side)} ${r.lots} 口 @${px(r.price)}`,
      });
      continue;
    }

    // 平倉成交
    const k = coverKey(r.month, side, r.date, r.price);
    const have = covered.get(k) ?? 0;
    covered.set(k, Math.max(0, have - r.lots));
    const residual = r.lots - have;
    if (residual <= 0) {
      ops.push({ kind: 'closed_skip', text: `平倉查詢已含這筆，略過：${label}` });
      continue;
    }

    let left = residual;
    let guard = 0;
    while (left > 0 && guard < 50) {
      guard += 1;
      const target = positions
        .filter((p) => p.month === r.month && p.side === side && num(p.lots) > 0)
        .sort((a, b) => ((a.entry_date || '9999-12-31') < (b.entry_date || '9999-12-31') ? -1 : 1))[0];
      if (!target) break;
      const take = Math.min(left, num(target.lots));
      const res = closeLots(target, take, r.price, r.date, {
        id: nid('c'),
        ...(r.ref ? { ref: `${r.ref}#${guard}` } : {}),
      });
      if (!res) break;
      closed.push(res.closed);
      positions = positions
        .map((p) => (p.id === target.id ? res.remaining : p))
        .filter((p): p is FuturesPosition => p !== null);
      const pnl = closedPnl(res.closed, spec);
      cash += pnl;
      cashDelta += pnl;
      ops.push({
        kind: 'closed_add',
        text: `平倉成交 → 新增平倉紀錄：${mLabel(r.month)} ${sLabel(side)} ${take} 口 ${px(res.closed.entry_price)} → ${px(r.price)}`,
        amount: pnl,
      });
      left -= take;
    }
    if (r.ref) { refsInUse.add(r.ref); consumed.add(r.ref); }
    if (left > 0) {
      ops.push({
        kind: 'position_reduce',
        warn: true,
        text: `${label}：這頁沒有足夠的未平倉口數可沖銷，還差 ${left} 口`,
      });
    }
  }

  // ── ① 未平倉查詢：快照驗收，對不起來才覆寫 ──────────────────────────────
  const openScreens = screens.filter((s) => s.kind === 'open');
  const openRows = openScreens.flatMap((s) => s.open_rows);
  // 「留倉筆數」對得上才敢用快照刪東西：辨識漏一列就等於謊報「這個月份已經沒部位」
  const snapComplete = openScreens.length > 0
    && openScreens.every((s) => s.totals.count === null || s.totals.count === s.open_rows.length);
  if (openScreens.length > 0 && !snapComplete) {
    warnings.push('未平倉截圖上的「留倉筆數」與辨識到的列數不一致，可能有列沒認出來——這次不會用它刪掉任何月份的部位。');
  }

  if (openRows.length > 0) {
    const snap = new Map<string, ScanOpenRow>();
    for (const r of openRows) {
      const k = `${r.month}:${r.side}`;
      const cur = snap.get(k);
      // 同一月份同方向理論上只有一列；真的有兩列就合併（口數加權）
      if (cur) {
        const lots = cur.lots + r.lots;
        snap.set(k, { ...cur, lots, avg_price: (cur.avg_price * cur.lots + r.avg_price * r.lots) / lots });
      } else {
        snap.set(k, { ...r });
      }
    }

    // 先決定要不要覆寫、覆寫完再對帳。順序反過來的話，對帳欄會顯示「重放事件後」
    // 的中間狀態，跟標題講的「套用後」是兩回事，看的人會以為套用完還是對不起來。
    const replayed = aggregatePositions(positions);
    const keys = [...new Set([...snap.keys(), ...replayed.keys()])].sort();
    for (const k of keys) {
      const [month, sideRaw] = k.split(':');
      const side = sideRaw as Side;
      const want = snap.get(k);
      const got = replayed.get(k);
      const gotLots = got?.lots ?? 0;
      const gotAvg = got?.avg ?? 0;
      const wantLots = want?.lots ?? 0;
      const wantAvg = want?.avg_price ?? 0;
      const match = wantLots === gotLots && (wantLots === 0 || Math.abs(wantAvg - gotAvg) < EPS);
      if (match) continue;

      // 快照上沒有、但這頁還有 → 早就平掉了沒記到。只有在確信快照完整時才敢刪。
      if (!want && !snapComplete) {
        warnings.push(`${mLabel(month)} ${sLabel(side)} 在未平倉截圖上找不到，但截圖列數對不起來，保留現有 ${gotLots} 口不動。`);
        continue;
      }
      if (!adoptSnapshot) {
        warnings.push(`${mLabel(month)} ${sLabel(side)} 與截圖不一致（截圖 ${wantLots} 口 / 這頁 ${gotLots} 口），未勾選「以截圖為準」故維持原樣。`);
        continue;
      }

      const olds = positions.filter((p) => p.month === month && p.side === side);
      // 停損價掛在部位 id 上，合併後沿用口數最大那筆的設定，不然減碼一次停損就沒了
      const biggest = olds.slice().sort((a, b) => num(b.lots) - num(a.lots))[0];
      const keepStop = biggest ? stop_loss[biggest.id] : undefined;
      for (const p of olds) delete stop_loss[p.id];
      positions = positions.filter((p) => !(p.month === month && p.side === side));

      if (!want || wantLots <= 0) {
        ops.push({
          kind: 'position_rewrite',
          warn: true,
          text: `未平倉截圖沒有 ${mLabel(month)} ${sLabel(side)}，刪掉這頁殘留的 ${gotLots} 口（若確實已平倉但沒記錄，已實現損益不會自動補上）`,
        });
        continue;
      }
      const earliest = olds.map((p) => p.entry_date).filter(Boolean).sort()[0] || opts.today;
      const merged: FuturesPosition = {
        id: nid('f'),
        product,
        month,
        side,
        lots: wantLots,
        entry_price: wantAvg,
        entry_date: earliest,
      };
      positions.push(merged);
      if (keepStop && keepStop > 0) stop_loss[merged.id] = keepStop;
      ops.push({
        kind: 'position_rewrite',
        warn: true,
        text: olds.length > 0
          ? `以截圖為準改寫 ${mLabel(month)} ${sLabel(side)}：${gotLots} 口 @${gotAvg.toFixed(4)} → ${wantLots} 口 @${wantAvg.toFixed(4)}`
            + (olds.length > 1 ? `（原本 ${olds.length} 筆分批紀錄會合併成 1 筆，進場日取最早的 ${earliest}）` : '')
          : `依截圖新增 ${mLabel(month)} ${sLabel(side)} ${wantLots} 口 @${wantAvg.toFixed(4)}`,
      });
    }

    // 逐月份／方向對帳：拿最終狀態跟截圖比
    const final = aggregatePositions(positions);
    for (const k of [...new Set([...snap.keys(), ...final.keys()])].sort()) {
      const [month, sideRaw] = k.split(':');
      const side = sideRaw as Side;
      const want = snap.get(k);
      const got = final.get(k);
      const wantLots = want?.lots ?? 0;
      const gotLots = got?.lots ?? 0;
      checks.push({
        label: `${mLabel(month)} ${sLabel(side)}`,
        screen: want ? `${wantLots} 口 @${(want.avg_price ?? 0).toFixed(4)}` : '無部位',
        computed: got ? `${gotLots} 口 @${got.avg.toFixed(4)}` : '無部位',
        ok: wantLots === gotLots && (wantLots === 0 || Math.abs((want?.avg_price ?? 0) - (got?.avg ?? 0)) < EPS),
      });
    }

    // 未平倉損益對帳：券商給的是毛額（未扣手續費），所以這裡也用毛額比，才比得動
    const hasPnl = openRows.some((r) => r.pnl !== null);
    const hasMkt = openRows.every((r) => (r.market_price ?? 0) > 0);
    if (hasPnl && hasMkt) {
      const snapPnl = openRows.reduce((s, r) => s + (r.pnl ?? 0), 0);
      const unit = Math.max(1, num(spec.contract_size) || 1000);
      const calc = openRows.reduce((s, r) => {
        const sgn = r.side === 'long' ? 1 : -1;
        return s + sgn * ((r.market_price ?? 0) - r.avg_price) * unit * r.lots;
      }, 0);
      checks.push({
        label: '未平倉損益（毛額）',
        screen: money(snapPnl),
        computed: money(calc),
        ok: Math.abs(snapPnl - calc) <= Math.max(50, Math.abs(snapPnl) * 0.002),
      });
    }

    if (applyPrices) {
      for (const r of openRows) {
        const mp = r.market_price ?? 0;
        if (!(mp > 0)) continue;
        if (Math.abs((prices[r.month] ?? 0) - mp) < EPS) continue;
        ops.push({
          kind: 'price_update',
          text: `更新 ${mLabel(r.month)} 現價：${prices[r.month] ? px(prices[r.month]) : '未設'} → ${px(mp)}（截圖上的市價）`,
        });
        prices[r.month] = mp;
      }
    }
  }

  // 平倉查詢自己的合計，用來確認有沒有漏列
  for (const s of screens) {
    if (s.kind !== 'closed' || s.totals.pnl === null) continue;
    const sum = s.closed_rows.reduce((acc, r) => acc + (r.net_pnl ?? r.pnl ?? 0), 0);
    checks.push({
      label: '平倉查詢總損益（截圖自己的合計）',
      screen: money(s.totals.pnl),
      computed: money(sum),
      ok: Math.abs(s.totals.pnl - sum) <= 2,
    });
  }

  // 這一輪吃掉的指紋併進帳本（保留原順序、只留最近 MAX_IMPORTED_REFS 筆）
  const imported_refs = [...new Set([
    ...(Array.isArray(state.imported_refs) ? state.imported_refs : []),
    ...consumed,
  ])].slice(-MAX_IMPORTED_REFS);

  const changed = ops.some((o) => o.kind !== 'closed_skip');
  return {
    next: { positions, closed, prices, stop_loss, cash, imported_refs },
    ops,
    checks,
    warnings,
    cash_delta: cashDelta,
    changed,
  };
}

// ── 帳戶層級（多商品）匯入 ────────────────────────────────────────────────────

/**
 * 拉近「券商 App 顯示的名字」跟「帳戶設定裡存的名字」的常見落差，好讓下面的子字串
 * 比對配得到：全形/半形空白不一定同一邊有、「臺」「台」兩種寫法混用、結尾「期貨」
 * 有些券商會省成「期」。不處理商品全名裡的其他差異（例如發行商簡稱有沒有列出來）
 * ——那種差異留給 matchProduct() 用「帳戶存的名字」與「內建預設的官方名字」雙重比對解決。
 */
function normalizeProductName(s: string): string {
  return String(s || '')
    .replace(/臺/g, '台')
    .replace(/\s+/g, '')
    .replace(/期(貨)?$/, '')
    .trim();
}

/**
 * 從 OCR「商品名稱原文」（例如「聯電期202609」）配對到帳戶已設定的商品代碼。
 * 先把結尾的到期月份數字剝掉（跟 gateway 那份 monthOf() 撈月份的邏輯對稱），
 * 剩下的文字跟每個已設定商品的 `name` 做子字串比對——配不到回 null，**不要猜**：
 * 誤配到別的商品會把不相干的成交記進錯的帳，比「這批資料先不套用」危險得多。
 *
 * 內建商品（SRF/NYF…）除了比對帳戶存的 `name`，也一併比對 SYMBOL_PRESETS 目前的
 * 官方名字：帳戶那份是**新增當下**複製過去的快照，改了預設名字不會回頭更新舊帳戶，
 * 沒有這條路的話，早期用舊預設名字新增的帳戶會一直配不到（例如 SRF 舊預設是「小型
 * 臺灣50 ETF 期貨」，但券商 App 實際顯示「小型元大台灣50ETF期」，兩者連正規化後都對
 * 不起來——差在「元大」這個發行商簡稱）。
 */
export function matchProduct(rawProduct: string, products: Record<string, ProductLookup>): string | null {
  const stripped = String(rawProduct || '').replace(/20\d{2}(?:0[1-9]|1[0-2])\s*$/, '').trim();
  if (!stripped) return null;
  const strippedNorm = normalizeProductName(stripped);
  if (!strippedNorm) return null;
  for (const [code, p] of Object.entries(products)) {
    const candidates = new Set([p.name, findPreset(code)?.name].filter((n): n is string => !!n && !!n.trim()));
    for (const name of candidates) {
      if (stripped === name || stripped.includes(name) || name.includes(stripped)) return code;
      const nameNorm = normalizeProductName(name);
      if (nameNorm && (strippedNorm === nameNorm || strippedNorm.includes(nameNorm) || nameNorm.includes(strippedNorm))) return code;
    }
  }
  return null;
}

/**
 * 把一張截圖依每一列 OCR 認出的商品名稱拆成「每個商品各自一份 ScanScreen」。
 * 同一張未平倉查詢截圖常常同時列多個商品（玉山 App 的「期貨資產總覽」就是這樣，
 * 聯電期跟小型元大台灣50ETF期同一張表），不能整張截圖只認一個商品。
 *
 * `totals.count` 是 buildImportPlan 用來判斷「這個商品的未平倉快照有沒有認全」的
 * 安全閥——拆開後不能沿用原始截圖的合計數（那是全部商品加總），所以這裡重算：
 * 原始截圖本來就辨識完整時，直接給拆出來的列數（必然吻合，安全閥照常放行）；
 * 原始截圖本來就不完整（辨識到的列數對不上截圖自己寫的合計）時，刻意給一個
 * 對不上的數字，讓每個商品都繼續保守地拒絕用快照刪部位——不能因為拆開了
 * 就把「可能有列沒認出來」的不確定性洗掉。
 */
function splitScreenByProduct(
  screen: ScanScreen,
  products: Record<string, ProductLookup>,
  unmatched: Set<string>,
): Map<string, ScanScreen> {
  const originalTotal = screen.open_rows.length + screen.closed_rows.length + screen.fill_rows.length;
  const originalComplete = screen.totals.count === null || screen.totals.count === originalTotal;
  const out = new Map<string, ScanScreen>();
  const bucket = (code: string): ScanScreen => {
    let s = out.get(code);
    if (!s) {
      s = { kind: screen.kind, title: screen.title, open_rows: [], closed_rows: [], fill_rows: [], totals: { pnl: null, count: null }, warnings: [] };
      out.set(code, s);
    }
    return s;
  };
  for (const r of screen.open_rows) {
    const code = matchProduct(r.product, products);
    if (!code) { unmatched.add(r.product); continue; }
    bucket(code).open_rows.push(r);
  }
  for (const r of screen.closed_rows) {
    const code = matchProduct(r.product, products);
    if (!code) { unmatched.add(r.product); continue; }
    bucket(code).closed_rows.push(r);
  }
  for (const r of screen.fill_rows) {
    const code = matchProduct(r.product, products);
    if (!code) { unmatched.add(r.product); continue; }
    bucket(code).fill_rows.push(r);
  }
  for (const s of out.values()) {
    const n = s.open_rows.length + s.closed_rows.length + s.fill_rows.length;
    s.totals = { pnl: null, count: originalComplete ? n : n + 1 };
  }
  return out;
}

/**
 * 帳戶層級的多商品截圖匯入：先把每張截圖拆成各商品自己的一份（見
 * splitScreenByProduct），對每個商品各呼叫一次 buildImportPlan()（單商品版，
 * 內部的月份/方向配對邏輯完全不用改——因為進去的資料已經先篩過只剩一個商品），
 * 再把結果併回帳戶層級的陣列。現金／停損／匯入指紋是帳戶共用的，逐商品依序
 * 傳遞下去（後一個商品的計算要看到前一個商品已經進出的現金），部位／已平倉
 * 紀錄／月份報價則是「先拿掉這個商品原本那份，換成算出來的新的」。
 *
 * 認不出對應商品的列（帳戶還沒設定過這檔）**不會用猜的**：進 warnings 提醒
 * 使用者先去設定頁新增這個商品，那批資料完全不套用——比誤配到別的商品安全。
 */
export function buildImportPlanForAccount(
  state: AccountImportState,
  screens: ScanScreen[],
  products: Record<string, ProductLookup>,
  opts: ImportOptions,
): AccountImportPlan {
  const unmatched = new Set<string>();
  const byProduct = new Map<string, ScanScreen[]>();
  for (const screen of screens) {
    const split = splitScreenByProduct(screen, products, unmatched);
    for (const [code, s] of split) {
      const list = byProduct.get(code) ?? [];
      list.push(s);
      byProduct.set(code, list);
    }
  }

  let positions = state.positions.map((p) => ({ ...p }));
  let closed = state.closed.map((t) => ({ ...t }));
  const product_prices: Record<string, Record<string, number>> = {};
  for (const [code, m] of Object.entries(state.product_prices || {})) product_prices[code] = { ...m };
  let stop_loss = { ...state.stop_loss };
  let cash = state.cash;
  let imported_refs = [...state.imported_refs];

  const ops: ImportOp[] = [];
  const checks: ImportCheck[] = [];
  const warnings: string[] = [];
  // 每張原始截圖自己的警告（讀不完整、認不出畫面種類…）——分商品的 buildImportPlan()
  // 只看得到拆過的子畫面（warnings 一律是空的，見 splitScreenByProduct 的 bucket()），
  // 不在這裡收一次的話，這些警告會被靜靜吞掉，使用者只會覺得「傳了截圖但什麼都沒發生」。
  for (const s of screens) warnings.push(...s.warnings);
  let cashDelta = 0;
  const multi = byProduct.size > 1;

  for (const code of [...byProduct.keys()].sort()) {
    const lookup = products[code];
    if (!lookup) { warnings.push(`商品代碼 ${code} 目前帳戶沒有設定，已略過這批資料。`); continue; }
    const group = byProduct.get(code) as ScanScreen[];
    const sub: ImportState = {
      positions: positions.filter((p) => p.product === code),
      closed: closed.filter((t) => t.product === code),
      prices: product_prices[code] ?? {},
      stop_loss,
      cash,
      imported_refs,
    };
    const plan = buildImportPlan(sub, group, lookup.spec, code, opts);
    positions = positions.filter((p) => p.product !== code).concat(plan.next.positions);
    closed = closed.filter((t) => t.product !== code).concat(plan.next.closed);
    product_prices[code] = plan.next.prices;
    stop_loss = plan.next.stop_loss;
    cash = plan.next.cash;
    imported_refs = plan.next.imported_refs;
    cashDelta += plan.cash_delta;
    const prefix = multi ? `[${lookup.name}] ` : '';
    ops.push(...plan.ops.map((o) => ({ ...o, text: prefix + o.text })));
    checks.push(...plan.checks.map((c) => ({ ...c, label: prefix + c.label })));
    warnings.push(...plan.warnings.map((w) => prefix + w));
  }

  for (const raw of unmatched) {
    const label = raw.replace(/20\d{2}(?:0[1-9]|1[0-2])\s*$/, '').trim() || raw;
    warnings.push(`認出商品「${label}」，但帳戶還沒設定這個商品，這批資料未套用——請先到設定頁新增後再重新產生匯入計畫。`);
  }

  // ── ④ 帳戶總覽／權益數查詢：沒有部位列可併帳，只拿它的權益總值反推現金餘額 ──
  // 跟頁面上「跟期貨商對帳」同一套公式：期貨商的權益總值是毛額（未扣出場那趟還沒
  // 發生的手續費與期交稅），所以要用毛未平倉損益反推，不能用本頁預設顯示的淨額。
  const acctScreens = screens.filter(
    (s): s is ScanScreen & { account: ScanAccountSummary } => s.kind === 'account' && !!s.account && s.account.equity !== null,
  );
  if (acctScreens.length > 0) {
    // 同一時刻可能截了不只一張（例如首頁小卡＋權益數查詢明細頁），取欄位認出最多的那張
    const completeness = (s: ScanScreen & { account: ScanAccountSummary }) =>
      Object.values(s.account).filter((v) => v !== null).length;
    const best = acctScreens.reduce((a, b) => (completeness(b) > completeness(a) ? b : a));
    const equityScreen = best.account.equity as number;

    const equities = acctScreens.map((s) => s.account.equity as number);
    if (Math.max(...equities) - Math.min(...equities) > 5) {
      warnings.push(`帳戶總覽截圖不只一張，權益總值認出的數字不完全一致（${equities.map((e) => money(e)).join('、')}），採用資訊最完整的一張。`);
    }

    let unrealizedGross = 0;
    let missingPrice = false;
    for (const pos of positions) {
      const lots = Math.max(0, num(pos.lots));
      if (lots <= 0) continue;
      const lookup = products[pos.product];
      if (!lookup) continue;
      const price = (product_prices[pos.product] || {})[pos.month];
      if (!(price > 0)) { missingPrice = true; continue; }
      unrealizedGross += positionPnl(pos, price, lookup.spec).gross_pnl;
    }

    if (missingPrice) {
      warnings.push('帳戶總覽截圖已認出權益總值，但有部位缺現價、無法精準反推毛未平倉損益，這次不會校正現金餘額——請先確認各商品現價再重新產生匯入計畫。');
    } else {
      const currentBroker = cash + unrealizedGross;
      const diff = equityScreen - currentBroker;
      checks.push({
        label: '帳戶權益總值（帳戶總覽截圖）',
        screen: money(equityScreen),
        computed: money(currentBroker),
        ok: Math.abs(diff) < 1,
      });
      if (Math.abs(diff) >= 1) {
        cash += diff;
        cashDelta += diff;
        ops.push({
          kind: 'cash_reconcile',
          text: '依帳戶總覽截圖校正保證金專戶現金餘額（手續費尾差、利息、忘記記的入出金都會在這裡現形；差額很大時請先確認有沒有漏記入出金或平倉再套用）',
          amount: diff,
          warn: Math.abs(diff) >= 500,
        });
      }
    }
  }

  const changed = ops.some((o) => o.kind !== 'closed_skip');
  return {
    next: { positions, closed, product_prices, stop_loss, cash, imported_refs },
    ops,
    checks,
    warnings,
    cash_delta: cashDelta,
    changed,
  };
}
