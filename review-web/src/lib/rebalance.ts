export interface RebalanceInput {
  shares: number;        // 00631L 持有股數（≥0）
  price: number;         // 00631L 現價 TWD（手動，>0 才能算交易股數）
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
  note?: string;
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
  const cash = Math.max(0, safeNum(input?.cash, 0));
  const target_beta = safeNum(input?.target_beta, 1.3);
  const tolerance_mode: 'pct' | 'abs' = input?.tolerance_mode === 'pct' ? 'pct' : 'abs';
  const threshold_pct = Math.max(0, safeNum(input?.threshold_pct, 10));
  const threshold_abs = Math.max(0, safeNum(input?.threshold_abs, 0.1));
  const etf_beta = safeNum(input?.etf_beta, 2.0);

  const etf_value = shares * price;
  const total_value = etf_value + cash;

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
    note,
  };
}
