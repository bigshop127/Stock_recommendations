// 顯示層格式化與配色。
// ⚠️ 量化 action 用「直覺 UI 語意」配色（買進=綠/good、賣出=紅/caution）。
// 老王報告的 emoji（🔴看多/🟢看空）語意相反 → 報告原文以 rehype-raw 原樣渲染（作者自有配色），
// 我們不另外幫老王訊號上紅綠色，避免反向誤導；見 EMOJI_SEMANTICS。

export const EMOJI_SEMANTICS = '🔴=看多 / 🟢=看空 / 🟠=中性觀望（老王報告色碼與股市紅漲綠跌相反）';

interface Meta {
  label: string;
  cls: string;
}

const ACTION: Record<string, Meta> = {
  buy: { label: '買進', cls: 'bg-emerald-600' },
  add: { label: '加碼', cls: 'bg-emerald-600' },
  hold: { label: '續抱', cls: 'bg-sky-600' },
  watch: { label: '觀察', cls: 'bg-amber-600' },
  reduce: { label: '減碼', cls: 'bg-rose-600' },
  sell: { label: '賣出', cls: 'bg-rose-700' },
};

export function actionMeta(a?: string | null): Meta {
  return ACTION[(a || '').toLowerCase()] || { label: a || '—', cls: 'bg-slate-600' };
}

const REGIME: Record<string, Meta> = {
  risk_on: { label: '順風 risk_on', cls: 'text-emerald-400' },
  neutral: { label: '中性 neutral', cls: 'text-amber-400' },
  risk_off: { label: '逆風 risk_off', cls: 'text-rose-400' },
};

export function regimeMeta(l?: string | null): Meta {
  return REGIME[(l || '').toLowerCase()] || { label: l || '—', cls: 'text-slate-300' };
}

export function pct(n?: number | null, digits = 0): string {
  return n == null ? '—' : `${(n * 100).toFixed(digits)}%`;
}

export function num(n?: number | null, digits = 0): string {
  return n == null ? '—' : Number(n).toFixed(digits);
}

// 分數 0~100 → tailwind 文字色
export function scoreColor(s?: number | null): string {
  if (s == null) return 'text-slate-400';
  if (s >= 70) return 'text-emerald-400';
  if (s >= 50) return 'text-amber-400';
  return 'text-rose-400';
}
