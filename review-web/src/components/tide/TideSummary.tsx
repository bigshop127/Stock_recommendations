import React from 'react';
import { ChevronDown } from 'lucide-react';
import { fmtMd, fmtYi, weekdayOf, WINDOW, type DuoRow, type ForeignVsTrust, type KeyFlows, type UnitValue } from '../../lib/capitalFlow';

/** 三大法人當日與前一日買賣超（億）。official＝證交所公布的金額；false＝用個股估算加總（不含 ETF） */
export interface InstTotals {
  official: boolean;
  foreign: [number, number | null];
  trust: [number, number | null];
  dealer: [number, number | null];
}

const tone = (v: number | null) => (v === null || v === 0 ? 'text-zinc-300' : v > 0 ? 'text-bull' : 'text-bear');

const Tile: React.FC<{ label: string; children: React.ReactNode; foot: React.ReactNode }> = ({ label, children, foot }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
    <div className="text-[11px] text-zinc-500">{label}</div>
    <div className="mt-0.5 font-mono text-xl font-bold leading-tight sm:text-2xl">{children}</div>
    <div className="mt-0.5 text-[11px] text-zinc-500">{foot}</div>
  </div>
);

const InstTile: React.FC<{ label: string; pair: [number, number | null] }> = ({ label, pair }) => (
  <Tile label={label} foot={<>前一日 <span className="font-mono">{pair[1] === null ? '—' : `${fmtYi(pair[1])} 億`}</span></>}>
    <span className={tone(pair[0])}>{fmtYi(pair[0])}</span>
    <span className={`ml-1 text-xs font-semibold ${tone(pair[0])}`}>億</span>
  </Tile>
);

const Fold: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <details className="group border-t border-zinc-800">
    <summary className="flex cursor-pointer list-none items-center justify-between py-2.5 [&::-webkit-details-marker]:hidden">
      <span className="rounded bg-amber-400/15 px-2 py-0.5 text-xs font-bold text-amber-300">{title}</span>
      <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
    </summary>
    <div className="space-y-2 pb-3 text-xs leading-relaxed text-zinc-300">{children}</div>
  </details>
);

/** 一行「標題：族群 金額、族群 金額…」；族群名可以點，點了就在泡泡圖上選它 */
function Line<T extends { unit: number; name: string }>({
  title,
  rows,
  render,
  onPick,
}: {
  title: string;
  rows: T[];
  render: (r: T) => React.ReactNode;
  onPick: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="shrink-0 text-zinc-500 sm:w-28">{title}</span>
      {rows.length === 0 ? (
        <span className="text-zinc-600">沒有</span>
      ) : (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {rows.map((r) => (
            <span key={r.unit} className="whitespace-nowrap">
              <button
                type="button"
                onClick={() => onPick(r.name)}
                className="font-semibold text-zinc-100 underline decoration-zinc-600 underline-offset-2 hover:text-primary"
              >
                {r.name}
              </button>{' '}
              {render(r)}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

const amount = (v: number, unit = '億') => <span className={`font-mono ${tone(v)}`}>{fmtYi(v)} {unit}</span>;
const flowRow = (r: UnitValue) => amount(r.value);
const speedRow = (r: UnitValue) => amount(r.value, '億/天');
const duoRow = (r: DuoRow) => (
  <span className="font-mono text-zinc-500">
    （外資 <span className={tone(r.foreign)}>{fmtYi(r.foreign)}</span>／投信 <span className={tone(r.trust)}>{fmtYi(r.trust)}</span>）
  </span>
);

export const TideSummary: React.FC<{
  date: string;
  conclusion: string;
  counts: { up: number; down: number; total: number };
  totals: InstTotals;
  flows: KeyFlows;
  duo: ForeignVsTrust;
  /** 點族群名 → 在泡泡圖選它 */
  onPick: (name: string) => void;
}> = ({ date, conclusion, counts, totals, flows, duo, onPick }) => (
  <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
    <h3 className="text-base font-bold leading-snug text-zinc-100 sm:text-lg">
      {fmtMd(date)}（{weekdayOf(date)}）盤後結論{conclusion ? `：${conclusion}` : ''}
    </h3>

    <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <Tile label="類股漲跌" foot={`共 ${counts.total} 個族群`}>
        <span className="text-bull">{counts.up}</span>
        <span className="mx-1 text-xs font-semibold text-bull">漲</span>
        <span className="text-zinc-600">/</span>
        <span className="ml-1 text-bear">{counts.down}</span>
        <span className="ml-1 text-xs font-semibold text-bear">跌</span>
      </Tile>
      <InstTile label="外資買賣超" pair={totals.foreign} />
      <InstTile label="投信買賣超" pair={totals.trust} />
      <InstTile label="自營商買賣超" pair={totals.dealer} />
    </div>
    {!totals.official && (
      <p className="mt-1.5 text-[10px] text-zinc-600">
        三大法人金額暫時用個股估算加總（上市普通股、不含 ETF），跟證交所公布的全市場數字會有落差。
      </p>
    )}

    <div className="mt-3">
      <Fold title="關鍵流向">
        <p className="text-[11px] text-zinc-500">全體法人、細分族群、近 {WINDOW} 日；點族群名可以在下面的泡泡圖選它。</p>
        <Line title="流入最多" rows={flows.inflow} render={flowRow} onPick={onPick} />
        <Line title="流出最多" rows={flows.outflow} render={flowRow} onPick={onPick} />
        <Line title="買盤加速最快" rows={flows.speedUp} render={speedRow} onPick={onPick} />
        <Line title="降溫最快" rows={flows.slowDown} render={speedRow} onPick={onPick} />
        <Line title="由賣轉買" rows={flows.turnedBuy} render={flowRow} onPick={onPick} />
        <Line title="由買轉賣" rows={flows.turnedSell} render={flowRow} onPick={onPick} />
      </Fold>
      <Fold title="土洋操作">
        <p className="text-[11px] text-zinc-500">外資與投信近 {WINDOW} 日在同一個族群是站同一邊還是對作（單位 億；任一方不到 0.5 億的不列）。</p>
        <Line title="土洋同買" rows={duo.bothBuy} render={duoRow} onPick={onPick} />
        <Line title="土洋同賣" rows={duo.bothSell} render={duoRow} onPick={onPick} />
        <Line title="外資買、投信賣" rows={duo.foreignBuyTrustSell} render={duoRow} onPick={onPick} />
        <Line title="投信買、外資賣" rows={duo.trustBuyForeignSell} render={duoRow} onPick={onPick} />
      </Fold>
    </div>
  </section>
);
