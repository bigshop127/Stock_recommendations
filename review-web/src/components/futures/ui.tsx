/**
 * 期貨頁的共用視覺元件。
 *
 * 抽出來的理由：FuturesPnl.tsx 已經接近三千行，八個分頁各自長出一套
 * 「灰底卡片 + 小標題 + 一堆 text-xs」的版型，資訊密度高但沒有層次——
 * 重要的數字（風險指標、追繳價）跟次要的說明字級只差一階，掃視時抓不到重點。
 * 這裡把版型收斂成幾個語意元件，各分頁只描述「這是什麼」，不再各自刻樣式。
 *
 * 配色語意（與 summarizeAccount 的 status 對齊，不要另創一套）：
 *   emerald 安全 / amber 低於原始保證金 / orange 追繳 / rose 斷頭 / sky 中性參考值
 * 注意台股慣例是「漲紅跌綠」，所以損益顏色一律走 text-bull / text-bear，
 * 不要拿 emerald / rose 去表示賺賠，會跟這裡的風險語意打架。
 */
import React from 'react';

export type Tone = 'emerald' | 'amber' | 'orange' | 'rose' | 'sky' | 'zinc' | 'primary';

/** 每個色調的完整樣式組，集中一處避免各分頁拼字串拼到不一致 */
export const TONE: Record<Tone, {
  text: string; border: string; bg: string; ring: string; bar: string; chip: string;
}> = {
  emerald: {
    text: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/10',
    ring: 'ring-emerald-500/20', bar: 'bg-emerald-500', chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  amber: {
    text: 'text-amber-400', border: 'border-amber-500/30', bg: 'bg-amber-500/10',
    ring: 'ring-amber-500/20', bar: 'bg-amber-500', chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  orange: {
    text: 'text-orange-400', border: 'border-orange-500/30', bg: 'bg-orange-500/10',
    ring: 'ring-orange-500/20', bar: 'bg-orange-500', chip: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  },
  rose: {
    text: 'text-rose-400', border: 'border-rose-500/30', bg: 'bg-rose-500/10',
    ring: 'ring-rose-500/20', bar: 'bg-rose-500', chip: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  },
  sky: {
    text: 'text-sky-300', border: 'border-sky-500/30', bg: 'bg-sky-500/10',
    ring: 'ring-sky-500/20', bar: 'bg-sky-500', chip: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
  },
  zinc: {
    text: 'text-zinc-400', border: 'border-zinc-600/40', bg: 'bg-zinc-500/5',
    ring: 'ring-zinc-500/10', bar: 'bg-zinc-600', chip: 'bg-zinc-500/15 text-zinc-300 border-zinc-600/40',
  },
  primary: {
    text: 'text-primary', border: 'border-primary/30', bg: 'bg-primary/10',
    ring: 'ring-primary/20', bar: 'bg-primary', chip: 'bg-primary/15 text-sky-300 border-primary/30',
  },
};

/** 小圓角標籤。用來表示狀態（安全／追繳中）或補充註記（資料日期）。 */
export const Chip: React.FC<{
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}> = ({ tone = 'zinc', children, title, className = '' }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-semibold whitespace-nowrap ${TONE[tone].chip} ${className}`}
  >
    {children}
  </span>
);

/**
 * 區塊卡片。標題左邊放一個著色的圖示方塊，右邊留一個 slot 給操作按鈕或狀態標籤，
 * 讓每個區塊在長頁面裡有固定的辨識點。
 */
export const Panel: React.FC<{
  title: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  right?: React.ReactNode;
  desc?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, icon, tone = 'primary', right, desc, children, className = '' }) => (
  <section className={`bg-card/70 border border-border rounded-2xl shadow-sm overflow-hidden ${className}`}>
    <header className="flex flex-wrap items-center gap-2 sm:gap-3 px-4 sm:px-5 pt-4 pb-3">
      {icon && (
        <span className={`shrink-0 w-7 h-7 rounded-lg border grid place-items-center ${TONE[tone].bg} ${TONE[tone].border} ${TONE[tone].text}`}>
          {icon}
        </span>
      )}
      <h2 className="text-sm font-bold text-zinc-100 tracking-wide">{title}</h2>
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </header>
    {desc && <p className="px-4 sm:px-5 -mt-1 pb-2 text-[11px] text-zinc-500">{desc}</p>}
    <div className="px-4 sm:px-5 pb-4 sm:pb-5">{children}</div>
  </section>
);

/**
 * 統計磚。預設左側一條色帶是唯一的視覺重量來源——四塊並排時靠色帶分群，
 * 比整塊染色不吵，數字也還讀得清楚。`tintBg` 是給像信用卡帳單那種「磚本身
 * 就代表一個分類（銀行/幣別）」的場景opt-in 用的，這時整塊染色反而是重點。
 */
export const StatTile: React.FC<{
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: Tone;
  /** 數值本身的顏色類別；損益要傳 text-bull / text-bear，不要用 tone 硬套 */
  valueCls?: string;
  hint?: string;
  icon?: React.ReactNode;
  /** true 時底色／邊框整塊套 tone（預設 false，維持原本深色底＋色帶的樣式） */
  tintBg?: boolean;
}> = ({ label, value, sub, tone = 'zinc', valueCls, hint, icon, tintBg = false }) => (
  <div
    title={hint}
    className={`relative rounded-xl pl-4 pr-3 py-3 shadow-sm overflow-hidden border ${
      tintBg ? `${TONE[tone].bg} ${TONE[tone].border}` : 'bg-card border-border'
    }`}
  >
    <span className={`absolute left-0 inset-y-0 w-1 ${TONE[tone].bar} opacity-70`} aria-hidden />
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 font-medium">
      {icon}
      {label}
    </div>
    {/* 手機一行只放得下兩塊，$1,504,000 這種七位數在 text-xl 會頂到邊，降一階 */}
    <div className={`text-lg sm:text-2xl font-bold font-mono mt-1 tabular-nums leading-tight ${valueCls ?? 'text-zinc-100'}`}>
      {value}
    </div>
    {sub && <div className="text-[11px] text-zinc-500 mt-1 leading-snug">{sub}</div>}
  </div>
);

/**
 * 風險指標量表。
 *
 * 尺規故意不是線性到無限大：真正需要分辨的區間是 0–200%（斷頭 25%、追繳 100%
 * 都落在裡面），400% 以上再多也只是「很安全」。所以 0–200% 佔前 75% 的寬度，
 * 200% 以上壓縮進剩下的 25%，兩條刻度線才不會全擠在最左邊變成沒有資訊量的裝飾。
 */
export const RiskMeter: React.FC<{
  /** 風險指標＝權益數 ÷ 所需**原始**保證金；無部位傳 null */
  value: number | null;
  tone: Tone;
  label?: string;
  liquidationRatio?: number;
  /**
   * 追繳線在這把尺上的位置＝維持保證金 ÷ 原始保證金（SRF 現值約 0.77）。
   *
   * 不是固定的 100%：追繳看的是「權益數 ＜ 維持保證金」，而這把尺的 100% 是
   * 「權益數 ＝ 原始保證金」。兩者只有在原始＝維持時才重合，而那不會發生。
   */
  marginCallRatio?: number | null;
}> = ({ value, tone, label = '當前風險指標（權益數 ÷ 原始保證金）', liquidationRatio = 0.25, marginCallRatio = null }) => {
  const scale = (v: number) => {
    const p = Math.max(0, v);
    return p <= 2 ? (p / 2) * 75 : 75 + Math.min(25, ((p - 2) / 6) * 25);
  };
  const width = value === null ? 0 : Math.min(100, scale(value));
  const callAt = marginCallRatio !== null && Number.isFinite(marginCallRatio) && marginCallRatio > 0
    ? marginCallRatio
    : null;
  // 追繳（≈77%）與原始（100%）在尺上只差 8% 寬度，兩個標籤同一行會疊在一起，
  // 所以追繳排到第二行。row 是「第幾行」不是裝飾。
  const marks = [
    { at: scale(liquidationRatio), label: `斷頭 ${(liquidationRatio * 100).toFixed(0)}%`, cls: 'bg-rose-500', row: 0 },
    ...(callAt !== null
      ? [{ at: scale(callAt), label: `追繳 ${(callAt * 100).toFixed(0)}%`, cls: 'bg-orange-400', row: 1 }]
      : []),
    { at: scale(1), label: '原始 100%', cls: 'bg-amber-400/70', row: 0 },
  ];

  return (
    <div className="bg-zinc-900/60 border border-border rounded-xl px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-zinc-400 font-medium">{label}</span>
        <span className={`text-lg font-bold font-mono tabular-nums ${TONE[tone].text}`}>
          {value === null ? '—' : `${(value * 100).toFixed(1)}%`}
        </span>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${TONE[tone].bar}`}
          style={{ width: `${width}%` }}
        />
        {marks.map((m) => (
          <span
            key={m.label}
            className={`absolute top-0 bottom-0 w-px ${m.cls} opacity-80`}
            style={{ left: `${m.at}%` }}
            aria-hidden
          />
        ))}
      </div>
      <div className="relative h-6 mt-1">
        {marks.map((m) => (
          <span
            key={m.label}
            className={`absolute text-[9px] text-zinc-600 -translate-x-1/2 whitespace-nowrap ${m.row === 0 ? 'top-0' : 'top-[11px]'}`}
            style={{ left: `${m.at}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>
    </div>
  );
};

/**
 * 警戒卡（黃牌追繳／紅牌斷頭）。整張染色是刻意的：這兩張要能在整頁灰卡片裡
 * 被餘光掃到，跟一般資訊區塊分開。
 */
export const ThreatCard: React.FC<{
  tone: Tone;
  title: string;
  tag?: string;
  rows: { label: string; value: string; sub?: string; strong?: boolean; hint?: string }[];
  footer?: React.ReactNode;
}> = ({ tone, title, tag, rows, footer }) => (
  <div className={`rounded-2xl border ${TONE[tone].border} ${TONE[tone].bg} p-4 shadow-sm`}>
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <span className={`w-2.5 h-2.5 rounded-sm ${TONE[tone].bar}`} aria-hidden />
      <h3 className={`text-sm font-bold ${TONE[tone].text}`}>{title}</h3>
      {tag && <span className="ml-auto text-[10px] text-zinc-500 font-medium">{tag}</span>}
    </div>
    <dl className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3" title={r.hint}>
          <dt className="text-xs text-zinc-400">{r.label}</dt>
          <dd className={`font-mono tabular-nums ${r.strong ? `text-base font-bold ${TONE[tone].text}` : 'text-sm font-medium text-zinc-200'}`}>
            {r.value}
            {r.sub && <span className="ml-1.5 text-[11px] font-normal text-zinc-500">{r.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
    {footer && <div className="text-[11px] text-zinc-500 mt-3 pt-2 border-t border-white/5">{footer}</div>}
  </div>
);

/** 關鍵價格防線用的價位卡：一個價格 + 相對現價的幅度。 */
export const LevelCard: React.FC<{
  tone: Tone;
  label: string;
  value: number | null;
  sub?: string;
  base: number;
  /** 標記「你現在在這」，用一圈 ring 而不是換色，免得跟風險語意混淆 */
  current?: boolean;
}> = ({ tone, label, value, sub, base, current }) => {
  const delta = value !== null && base > 0 ? (value - base) / base : null;
  return (
    <div
      className={`rounded-xl border p-3 text-center ${TONE[tone].bg} ${TONE[tone].border} ${
        current ? `ring-2 ${TONE[tone].ring}` : ''
      }`}
    >
      <div className={`text-[10px] font-semibold ${TONE[tone].text} opacity-90`}>{label}</div>
      <div className="text-xl font-bold font-mono tabular-nums mt-1 text-zinc-100">
        {value !== null ? value.toFixed(2) : '—'}
      </div>
      <div className="text-[10px] text-zinc-500 mt-0.5 h-3.5">
        {delta !== null && Math.abs(delta) > 1e-9 ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(2)}%` : ''}
        {sub ? <span className="ml-1.5">{sub}</span> : null}
      </div>
    </div>
  );
};

/** 標籤 / 數值的一行。長頁面裡大量重複，維持單一實作。 */
export const Row: React.FC<{
  label: React.ReactNode;
  value: string;
  cls?: string;
  hint?: string;
  sub?: string;
}> = ({ label, value, cls, hint, sub }) => (
  <div className="flex items-baseline justify-between gap-3" title={hint}>
    <dt className="text-zinc-500">{label}</dt>
    <dd className={`font-mono font-medium tabular-nums ${cls ?? 'text-zinc-300'}`}>
      {value}
      {sub ? <span className="text-zinc-600 font-normal ml-1.5">{sub}</span> : null}
    </dd>
  </div>
);
