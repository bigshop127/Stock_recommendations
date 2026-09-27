// 財報補完（opt45）：財務分析分頁裡的季度損益表、資產負債、股利決議進度。
import React from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import type { BalanceSheetRow, DividendEvent, FinancialsRow } from '../lib/api';
import {
  fmtYi,
  fmtPct,
  hasIncomeAmounts,
  debtLevel,
  currentRatioLevel,
  dividendProgress,
  realDividends,
} from '../lib/financialStatements';
import type { DebtLevel } from '../lib/financialStatements';

const growthTone = (v: number | null | undefined) =>
  v === null || v === undefined ? 'text-zinc-500' : v >= 0 ? 'text-bull' : 'text-bear';

const LEVEL_TONE: Record<DebtLevel['tone'], string> = {
  good: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  mid: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  high: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
  na: 'text-zinc-400 bg-zinc-800 border-zinc-700',
};

/** 季度損益表：最近 8 季、新到舊，金額單位億元 */
export const QuarterlyIncomeTable: React.FC<{ rows: FinancialsRow[]; financial: boolean }> = ({ rows, financial }) => {
  if (!hasIncomeAmounts(rows)) return null;
  const list = [...rows].slice(-8).reverse();
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h4 className="text-xs font-semibold text-zinc-300">季度損益表</h4>
        <span className="text-[10px] text-zinc-500">單位：億元（EPS 為元）・單季數字・年增＝跟去年同一季比</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-xs text-right whitespace-nowrap">
          <thead className="bg-zinc-900/60 text-zinc-400 text-[11px] border-b border-border/60">
            <tr>
              <th className="p-2.5 text-left">季別</th>
              <th className="p-2.5">{financial ? '淨收益' : '營收'}</th>
              <th className="p-2.5">營收年增</th>
              {!financial && <th className="p-2.5">毛利</th>}
              {!financial && <th className="p-2.5">營業利益</th>}
              <th className="p-2.5">稅後淨利</th>
              <th className="p-2.5">淨利年增</th>
              <th className="p-2.5">EPS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30 font-mono">
            {list.map((r, i) => {
              const net = r.net_income_parent ?? r.net_income ?? null;
              return (
                <tr key={r.quarter} className={i === 0 ? 'bg-primary/5' : ''}>
                  <td className="p-2.5 text-left text-zinc-300 font-sans font-semibold">{r.quarter}</td>
                  <td className="p-2.5 text-zinc-100">{fmtYi(r.revenue)}</td>
                  <td className={`p-2.5 ${growthTone(r.revenue_yoy)}`}>{fmtPct(r.revenue_yoy, true)}</td>
                  {!financial && <td className="p-2.5 text-zinc-300">{fmtYi(r.gross_profit)}</td>}
                  {!financial && <td className={`p-2.5 ${(r.operating_income ?? 0) < 0 ? 'text-bear' : 'text-zinc-300'}`}>{fmtYi(r.operating_income)}</td>}
                  <td className={`p-2.5 ${(net ?? 0) < 0 ? 'text-bear' : 'text-zinc-100'}`}>{fmtYi(net)}</td>
                  <td className={`p-2.5 ${growthTone(r.net_income_yoy)}`}>{fmtPct(r.net_income_yoy, true)}</td>
                  <td className="p-2.5 text-blue-300">{r.eps !== null ? r.eps.toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-zinc-500">
        稅後淨利取歸屬母公司業主的部分；去年同季是虧損時不算年增率。
        {financial && ' 金融業報表沒有毛利、營業利益這兩項，營收欄是「淨收益」。'}
      </p>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; level?: DebtLevel; sub?: string; bar?: number | null }> = ({ label, value, level, sub, bar }) => (
  <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1 min-w-0">
    <div className="text-[11px] text-zinc-500 font-medium">{label}</div>
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-lg font-bold font-mono text-zinc-100">{value}</span>
      {level && level.tone !== 'na' && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_TONE[level.tone]}`}>{level.label}</span>
      )}
    </div>
    {bar !== undefined && bar !== null && (
      <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden" aria-hidden>
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${bar < 40 ? 'bg-emerald-500/70' : bar < 60 ? 'bg-amber-500/70' : 'bg-orange-500/70'}`}
          style={{ width: `${Math.min(100, Math.max(0, bar))}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-zinc-500" style={{ left: '40%' }} />
        <div className="absolute inset-y-0 w-px bg-zinc-500" style={{ left: '60%' }} />
      </div>
    )}
    {sub && <div className="text-[10px] text-zinc-500 leading-snug">{sub}</div>}
  </div>
);

/** 資產負債：最新一季四格＋最近 8 季趨勢表 */
export const BalanceSheetPanel: React.FC<{ rows: BalanceSheetRow[]; financial: boolean }> = ({ rows, financial }) => {
  if (!rows.length) {
    return <div className="text-xs text-zinc-500 text-center py-16">沒有資產負債表資料（ETF 或尚未申報）</div>;
  }
  const latest = rows[rows.length - 1];
  const prevYear = rows.length >= 5 ? rows[rows.length - 5] : null;
  const debt = debtLevel(latest.debt_ratio, financial);
  const cur = currentRatioLevel(latest.current_ratio);
  const cashPct = latest.cash !== null && latest.total_assets ? (latest.cash / latest.total_assets) * 100 : null;
  const bvpsGrowth = latest.bvps !== null && prevYear?.bvps ? (latest.bvps / prevYear.bvps - 1) * 100 : null;
  const list = [...rows].reverse();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Tile
          label={`負債比率（${latest.quarter}）`}
          value={fmtPct(latest.debt_ratio)}
          level={debt}
          bar={financial ? null : latest.debt_ratio}
          sub={financial ? '存款、保單都算負債，金融業負債比天生在 90% 上下' : '總負債 ÷ 總資產；刻度 40%／60%'}
        />
        <Tile
          label="流動比率"
          value={financial ? '不適用' : fmtPct(latest.current_ratio)}
          level={financial ? undefined : cur}
          sub={financial ? '金融業報表不分流動／非流動' : '流動資產 ÷ 流動負債，看一年內還債能力'}
        />
        <Tile
          label="每股淨值"
          value={latest.bvps !== null ? `${latest.bvps.toFixed(2)} 元` : '—'}
          sub={bvpsGrowth !== null ? `比一年前 ${bvpsGrowth >= 0 ? '+' : ''}${bvpsGrowth.toFixed(1)}%` : '歸屬母公司權益 ÷ 股數'}
        />
        <Tile
          label="現金占總資產"
          value={fmtPct(cashPct)}
          sub={`現金 ${fmtYi(latest.cash)} 億・總資產 ${fmtYi(latest.total_assets)} 億`}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-xs text-right whitespace-nowrap">
          <thead className="bg-zinc-900/60 text-zinc-400 text-[11px] border-b border-border/60">
            <tr>
              <th className="p-2.5 text-left">季末</th>
              <th className="p-2.5">總資產</th>
              <th className="p-2.5">總負債</th>
              <th className="p-2.5">股東權益</th>
              {!financial && <th className="p-2.5">存貨</th>}
              {!financial && <th className="p-2.5">應收帳款</th>}
              <th className="p-2.5">負債比</th>
              {!financial && <th className="p-2.5">流動比</th>}
              <th className="p-2.5">每股淨值</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30 font-mono">
            {list.map((r, i) => (
              <tr key={r.quarter} className={i === 0 ? 'bg-primary/5' : ''}>
                <td className="p-2.5 text-left text-zinc-300 font-sans font-semibold">{r.quarter}</td>
                <td className="p-2.5 text-zinc-100">{fmtYi(r.total_assets)}</td>
                <td className="p-2.5 text-zinc-300">{fmtYi(r.total_liabilities)}</td>
                <td className="p-2.5 text-zinc-300">{fmtYi(r.equity)}</td>
                {!financial && <td className="p-2.5 text-zinc-400">{fmtYi(r.inventories)}</td>}
                {!financial && <td className="p-2.5 text-zinc-400">{fmtYi(r.receivables)}</td>}
                <td className="p-2.5 text-zinc-200">{fmtPct(r.debt_ratio)}</td>
                {!financial && <td className="p-2.5 text-zinc-200">{fmtPct(r.current_ratio)}</td>}
                <td className="p-2.5 text-blue-300">{r.bvps !== null ? r.bvps.toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-zinc-500">
        金額單位億元；每股淨值＝歸屬母公司業主權益 ÷（股本 ÷ 面額）。資料來源 FinMind（公開資訊觀測站財報）。
      </p>
    </div>
  );
};

/** 股利常有 7.00000137 這種尾數：最多四位小數、去掉多餘的 0 */
const fmtDiv = (v: number | null) => (v === null ? '—' : String(Number(v.toFixed(4))));

const STATUS_TONE: Record<string, string> = {
  已公告: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  待除息: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  '已除息・待發放': 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  已除息: 'text-zinc-400 bg-zinc-800 border-zinc-700',
  已發放: 'text-zinc-400 bg-zinc-800 border-zinc-700',
  除權息日未定: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
};

/** 股利決議進度：最近幾次配發，每筆一條「公告 → 除息 → 發放」 */
export const DividendProgressList: React.FC<{ events: DividendEvent[]; today: string }> = ({ events, today }) => {
  const real = realDividends(events);
  if (!real.length) return null;
  const list = real.slice(0, 5).map((e) => dividendProgress(e, today));
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h4 className="text-xs font-semibold text-zinc-300">股利決議進度</h4>
        <span className="text-[10px] text-zinc-500">最近 {list.length} 次配發・公告 → 除權息 → 發放</span>
      </div>
      <ul className="space-y-2">
        {list.map((p, i) => (
          <li key={`${p.event.period}-${p.event.base_date}`} className={`p-3 rounded-lg border ${i === 0 && p.status !== '已發放' ? 'border-primary/30 bg-primary/5' : 'border-border/40 bg-zinc-950/40'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-zinc-200">{p.event.period}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[p.status]}`}>{p.status}</span>
              <span className="text-xs font-mono text-zinc-100 ml-auto">
                {(p.event.cash_dividend ?? 0) > 0 && <>現金 {fmtDiv(p.event.cash_dividend)} 元</>}
                {(p.event.stock_dividend ?? 0) > 0 && <span className="ml-2">股票 {fmtDiv(p.event.stock_dividend)} 元</span>}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-2 text-[11px] flex-wrap">
              {p.steps.map((s, idx) => (
                <React.Fragment key={s.key}>
                  {idx > 0 && <span className={`w-4 sm:w-8 h-px ${s.done ? 'bg-teal-500/60' : 'bg-zinc-700'}`} />}
                  <span className={`flex items-center gap-1 ${s.done ? 'text-teal-300' : 'text-zinc-500'}`}>
                    {s.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                    {s.label}
                    <span className="font-mono text-zinc-400">{s.date ? s.date.slice(5).replace('-', '/') : '未定'}</span>
                  </span>
                </React.Fragment>
              ))}
              {p.next && (
                <span className="ml-auto text-[11px] text-amber-300 font-semibold">
                  {p.next.daysLeft === 0 ? `今天${p.next.label}` : `${p.next.label}還有 ${p.next.daysLeft} 天`}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-zinc-500">
        現金股利含資本公積配發；除息日當天買進已經領不到。日期來自公司公告（FinMind），ETF 沒有公告日欄位。
      </p>
    </div>
  );
};
