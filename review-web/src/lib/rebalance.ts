// ── 買賣報價單（交易紀錄）與部位累算 ──────────────────────────────
export interface Trade {
  id: string;            // 唯一鍵（前端產生；lib 不生成以保持純淨）
  date: string;          // 交易日 YYYY-MM-DD（排序用）
  side: 'buy' | 'sell';  // 買進 / 賣出
  shares: number;        // 股數（≥0）
  price: number;         // 成交價 TWD（≥0）
}

export interface PositionAgg {
  shares: number;        // 期末總股數（期初 + 所有交易後）
  avg_cost: number;      // 加權平均成本（0＝無成本資訊或已清空）
  realized_pnl: number;  // 累計已實現損益（賣出時 (賣價−均價)×賣出股數）
  invalid_sells: number; // 超賣（賣超過持有）被 clamp 的筆數，供 UI 提示
}

/**
 * 由「期初部位」＋依日期排序的交易紀錄，累算期末總股數與加權平均成本。
 *   - 買進：成本基礎 += 股數×價格，均價＝成本基礎/總股數。
 *   - 賣出：只減股數（標準加權平均法，均價不變）；已實現損益＝(賣價−均價)×賣出股數；
 *           超賣（賣超過持有）clamp 到持有量並計入 invalid_sells。股數歸零時均價與成本歸零。
 * 純函式、全路徑防 NaN；不依賴 Date/crypto。
 */
export function aggregatePosition(
  opening: { shares?: number; avg_cost?: number } | null | undefined,
  trades: Trade[] | null | undefined,
): PositionAgg {
  let shares = Math.max(0, safeNum(opening?.shares, 0));
  let avg_cost = Math.max(0, safeNum(opening?.avg_cost, 0));
  let cost_basis = shares * avg_cost;
  let realized_pnl = 0;
  let invalid_sells = 0;

  const list = Array.isArray(trades) ? [...trades] : [];
  // 依日期升冪穩定排序（同日保留輸入順序）
  list.sort((a, b) => {
    const da = typeof a?.date === 'string' ? a.date : '';
    const db = typeof b?.date === 'string' ? b.date : '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const t of list) {
    const tShares = Math.max(0, safeNum(t?.shares, 0));
    const tPrice = Math.max(0, safeNum(t?.price, 0));
    if (tShares <= 0) continue;
    if (t?.side === 'sell') {
      const sold = Math.min(tShares, shares);
      if (tShares > shares) invalid_sells += 1;
      if (sold > 0) {
        realized_pnl += (tPrice - avg_cost) * sold;
        cost_basis -= avg_cost * sold;
        shares -= sold;
        if (shares <= 0) {
          shares = 0;
          cost_basis = 0;
          avg_cost = 0;
        }
      }
    } else {
      // 預設 / 'buy'
      cost_basis += tShares * tPrice;
      shares += tShares;
      avg_cost = shares > 0 ? cost_basis / shares : 0;
    }
  }

  return {
    shares: Number.isFinite(shares) ? shares : 0,
    avg_cost: Number.isFinite(avg_cost) ? avg_cost : 0,
    realized_pnl: Number.isFinite(realized_pnl) ? realized_pnl : 0,
    invalid_sells,
  };
}

export interface RebalanceInput {
  shares: number;        // 00631L 持有股數（≥0）
  price: number;         // 00631L 現價 TWD（手動或自動抓取；>0 才能算交易股數）
  avg_cost?: number;     // 00631L 每股平均成本 TWD（選填，≥0；純顯示未實現損益、不影響再平衡計算）
  cash: number;          // 現金 TWD（≥0）
  target_beta: number;   // 目標投組 β（滑桿，預設 1.3）
  tolerance_mode: 'pct' | 'abs'; // 容忍口徑：百分比 / 絕對 β（預設 'abs'）
  threshold_pct: number; // 容忍區間 %（pct 模式用；預設 10 = ±10%）
  threshold_abs: number; // 容忍區間 絕對 β（abs 模式用；預設 0.1 = ±0.1）
  etf_beta: number;      // 00631L 標的 β（預設 2.0；進階可調）
}

export interface RebalanceResult {
  etf_value: number;            // shares × price
  total_value: number;          // etf_value + cash
  // 未實現損益（純顯示；avg_cost≤0 或 shares≤0 → null）
  cost_basis: number | null;        // shares × avg_cost
  unrealized_pnl: number | null;    // etf_value − cost_basis（+獲利 −虧損）
  unrealized_pnl_pct: number | null; // unrealized_pnl / cost_basis
  etf_weight: number | null;    // etf_value / total_value；total≤0 → null
  cash_weight: number | null;
  current_beta: number | null;  // etf_weight × etf_beta；total≤0 → null
  target_beta: number;
  target_etf_weight: number | null;   // clamp(target_beta / etf_beta, 0, 1)；etf_beta≤0 → null
  target_cash_weight: number | null;
  upper_band: number;           // abs: target+abs ; pct: target×(1+pct/100)
  lower_band: number;           // 下限一律 clamp ≥ 0
  deviation_abs: number | null; // current_beta − target_beta
  deviation_pct: number | null; // (current_beta − target)/target；target=0 → null
  status: 'empty' | 'sell' | 'buy' | 'normal';
  action_label: string;         // §2.3
  // 精確達標（保持總資產不變，在 00631L↔現金 間搬錢使 β=target）
  target_etf_value: number | null;
  etf_value_delta: number | null; // target_etf_value − etf_value（+買 −賣）；不可解→null
  cash_delta: number | null;      // = −etf_value_delta
  trade_shares: number | null;    // round(etf_value_delta / price)；price≤0→null
  // 依整股成交後的實況
  post_shares: number | null;
  post_etf_value: number | null;
  post_cash: number | null;
  post_etf_weight: number | null;
  post_cash_weight: number | null;
  post_beta: number | null;
  // 觸發價位（持倉股數與現金固定，反解 00631L 價格）：
  //   價格↑→ETF權重↑→β↑，漲到 sell_trigger_price 時 β 觸上限→該賣；
  //   跌到 buy_trigger_price 時 β 觸下限→該買。無解（如現金=0、上限≥etf_beta）→null。
  sell_trigger_price: number | null;
  buy_trigger_price: number | null;
  note?: string;
}

/**
 * 反解：在持倉股數 shares 與現金 cash 固定下，使投組 β 恰好等於 targetBeta 的 00631L 價格。
 *   β = etf_beta × (shares×P)/(shares×P + cash)  ⇒  P = targetBeta×cash / (shares×(etf_beta − targetBeta))
 * 僅在 shares>0、cash>0、0<targetBeta<etf_beta 時有解；否則（如現金=0 時 β 恆為 etf_beta 與價格無關、
 * 或目標 β 已達/超過滿槓桿 etf_beta）回 null。
 */
export function triggerPriceForBeta(
  targetBeta: number,
  shares: number,
  cash: number,
  etf_beta: number,
): number | null {
  const s = safeNum(shares, 0);
  const c = safeNum(cash, 0);
  const eb = safeNum(etf_beta, 2);
  const b = safeNum(targetBeta, 0);
  if (!(s > 0) || !(c > 0) || !(eb > 0)) return null;
  if (!(b > 0) || b >= eb) return null;
  const p = (b * c) / (s * (eb - b));
  return Number.isFinite(p) && p > 0 ? p : null;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function safeNum(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function computeRebalance(input: RebalanceInput): RebalanceResult {
  const shares = Math.max(0, safeNum(input?.shares, 0));
  const price = Math.max(0, safeNum(input?.price, 0));
  const avg_cost = Math.max(0, safeNum(input?.avg_cost, 0));
  const cash = Math.max(0, safeNum(input?.cash, 0));
  const target_beta = safeNum(input?.target_beta, 1.3);
  const tolerance_mode: 'pct' | 'abs' = input?.tolerance_mode === 'pct' ? 'pct' : 'abs';
  const threshold_pct = Math.max(0, safeNum(input?.threshold_pct, 10));
  const threshold_abs = Math.max(0, safeNum(input?.threshold_abs, 0.1));
  const etf_beta = safeNum(input?.etf_beta, 2.0);

  const etf_value = shares * price;
  const total_value = etf_value + cash;

  // 未實現損益（純顯示，不參與再平衡計算）：有股數且有成本才算
  let cost_basis: number | null = null;
  let unrealized_pnl: number | null = null;
  let unrealized_pnl_pct: number | null = null;
  if (shares > 0 && avg_cost > 0) {
    cost_basis = shares * avg_cost;
    unrealized_pnl = etf_value - cost_basis;
    unrealized_pnl_pct = cost_basis > 0 ? unrealized_pnl / cost_basis : null;
  }

  // 算 target配比
  let target_etf_weight: number | null = null;
  let target_cash_weight: number | null = null;
  if (etf_beta > 0) {
    target_etf_weight = clamp(target_beta / etf_beta, 0, 1);
    target_cash_weight = 1 - target_etf_weight;
  }

  // 【增修A】容忍區間依模式：絕對 ±β（target±abs）或 百分比（target×(1±%)）；下限 clamp ≥ 0
  const upper_band =
    tolerance_mode === 'abs' ? target_beta + threshold_abs : target_beta * (1 + threshold_pct / 100);
  const lower_band = Math.max(
    tolerance_mode === 'abs' ? target_beta - threshold_abs : target_beta * (1 - threshold_pct / 100),
    0,
  );

  if (total_value <= 0) {
    return {
      etf_value: 0,
      total_value: 0,
      cost_basis,
      unrealized_pnl,
      unrealized_pnl_pct,
      etf_weight: null,
      cash_weight: null,
      current_beta: null,
      target_beta,
      target_etf_weight,
      target_cash_weight,
      upper_band,
      lower_band,
      deviation_abs: null,
      deviation_pct: null,
      status: 'empty',
      action_label: '尚未輸入持倉',
      target_etf_value: null,
      etf_value_delta: null,
      cash_delta: null,
      trade_shares: null,
      post_shares: null,
      post_etf_value: null,
      post_cash: null,
      post_etf_weight: null,
      post_cash_weight: null,
      post_beta: null,
      sell_trigger_price: null,
      buy_trigger_price: null,
      note: '尚未輸入持倉',
    };
  }

  const etf_weight = etf_value / total_value;
  const cash_weight = cash / total_value;
  const current_beta = etf_weight * etf_beta;

  const deviation_abs = current_beta - target_beta;
  const deviation_pct = target_beta !== 0 ? (current_beta - target_beta) / target_beta : null;

  let status: 'sell' | 'buy' | 'normal' = 'normal';
  if (current_beta > upper_band) {
    status = 'sell';
  } else if (current_beta < lower_band) {
    status = 'buy';
  }

  let target_etf_value: number | null = null;
  let etf_value_delta: number | null = null;
  let cash_delta: number | null = null;
  let trade_shares: number | null = null;

  if (target_etf_weight !== null) {
    target_etf_value = target_etf_weight * total_value;
    etf_value_delta = target_etf_value - etf_value;
    cash_delta = -etf_value_delta;
  }

  let note: string | undefined = undefined;
  if (price <= 0) {
    trade_shares = null;
    note = '填入現價才能換算交易股數';
  } else if (etf_value_delta !== null) {
    trade_shares = Math.round(etf_value_delta / price);
  }

  let post_shares: number | null = null;
  let post_etf_value: number | null = null;
  let post_cash: number | null = null;
  let post_etf_weight: number | null = null;
  let post_cash_weight: number | null = null;
  let post_beta: number | null = null;

  if (trade_shares !== null && price > 0) {
    post_shares = shares + trade_shares;
    post_etf_value = post_shares * price;
    post_cash = cash - trade_shares * price;
    const post_total = post_etf_value + post_cash;
    post_etf_weight = post_total > 0 ? post_etf_value / post_total : 0;
    post_cash_weight = post_total > 0 ? post_cash / post_total : 0;
    post_beta = post_etf_weight * etf_beta;
  }

  // 觸發價位：持倉/現金固定，反解讓 β 觸上/下限的 00631L 價格
  const sell_trigger_price = triggerPriceForBeta(upper_band, shares, cash, etf_beta);
  const buy_trigger_price = triggerPriceForBeta(lower_band, shares, cash, etf_beta);

  let action_label = '';
  if (status === 'normal') {
    if (tolerance_mode === 'abs') {
      const devStr = deviation_abs !== null ? Math.abs(deviation_abs).toFixed(2) : '0.00';
      action_label = `✅ 正常範圍（偏離 ${devStr} β，未超過 ±${threshold_abs} β）`;
    } else {
      const devStr = deviation_pct !== null ? (Math.abs(deviation_pct) * 100).toFixed(1) : '0.0';
      action_label = `✅ 正常範圍（偏離 ${devStr}%，未超過 ±${threshold_pct}%）`;
    }
  } else if (status === 'sell') {
    const absDeltaStr = etf_value_delta !== null ? Math.round(Math.abs(etf_value_delta)).toLocaleString() : '0';
    const absSharesStr = trade_shares !== null ? Math.abs(trade_shares).toLocaleString() : '—';
    action_label = `⚠ 已破上限 ${upper_band.toFixed(2)} → 建議賣出 00631L 約 $${absDeltaStr}（約 ${absSharesStr} 股）換現金`;
  } else if (status === 'buy') {
    const absDeltaStr = etf_value_delta !== null ? Math.round(Math.abs(etf_value_delta)).toLocaleString() : '0';
    const absSharesStr = trade_shares !== null ? Math.abs(trade_shares).toLocaleString() : '—';
    action_label = `⚠ 已破下限 ${lower_band.toFixed(2)} → 建議買進 00631L 約 $${absDeltaStr}（約 ${absSharesStr} 股）`;
  }

  return {
    etf_value,
    total_value,
    cost_basis,
    unrealized_pnl,
    unrealized_pnl_pct,
    etf_weight,
    cash_weight,
    current_beta,
    target_beta,
    target_etf_weight,
    target_cash_weight,
    upper_band,
    lower_band,
    deviation_abs,
    deviation_pct,
    status,
    action_label,
    target_etf_value,
    etf_value_delta,
    cash_delta,
    trade_shares,
    post_shares,
    post_etf_value,
    post_cash,
    post_etf_weight,
    post_cash_weight,
    post_beta,
    sell_trigger_price,
    buy_trigger_price,
    note,
  };
}
