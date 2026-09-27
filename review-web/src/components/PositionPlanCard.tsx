import React, { useMemo, useState } from 'react';
import { ClipboardList, BellPlus, Check, RotateCcw } from 'lucide-react';
import { fmtLevel } from '../lib/keyLevels';
import type { KeyLevels } from '../lib/keyLevels';
import { computePlan, defaultBatches, fmtShares, loadPlanSettings, savePlanSettings } from '../lib/positionPlan';
import type { PlanBatchDraft, PlanSettings, StopMode } from '../lib/positionPlan';
import type { LevelAlertCondition } from './KeyLevelsCard';

const money = (v: number) => Math.round(v).toLocaleString();

const STOP_OPTIONS: { id: StopMode; label: string }[] = [
  { id: 'gate', label: '跌破守門' },
  { id: 'atr2', label: '2 倍 ATR' },
  { id: 'custom', label: '自訂' },
];

interface Props {
  levels: KeyLevels;
  isAlertSet: (conditionType: LevelAlertCondition, price: number) => boolean;
  onAddAlert: (conditionType: LevelAlertCondition, price: number, note: string) => void;
}

/** 換股時用 key 重新掛載，分批價位會回到預設 */
export const PositionPlanCard: React.FC<Props> = ({ levels, isAlertSet, onAddAlert }) => {
  const [settings, setSettings] = useState<PlanSettings>(loadPlanSettings);
  const [drafts, setDrafts] = useState<PlanBatchDraft[]>(() => defaultBatches(levels));
  const plan = useMemo(() => computePlan(levels, drafts, settings), [levels, drafts, settings]);

  const update = (patch: Partial<PlanSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      savePlanSettings(next);
      return next;
    });
  };
  const updateDraft = (i: number, patch: Partial<PlanBatchDraft>) =>
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  const num = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  const stopAlertSet = plan ? isAlertSet('price_below', plan.stop) : false;
  const inputCls = 'w-full px-2 py-1.5 rounded-lg text-xs font-mono bg-zinc-900 border border-border text-zinc-200 focus:outline-none focus:border-primary/60';

  return (
    <div className="bg-card border border-border rounded-xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-sm text-zinc-200">個股建倉計畫</h3>
        </div>
        <span className="text-[10px] text-zinc-500">依關鍵價位分批，用「最多願意虧多少」反推股數</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="space-y-1 min-w-0">
          <span className="text-[11px] text-zinc-500">可承受最大虧損（元）</span>
          <input type="number" min={0} step={1000} value={settings.maxLoss || ''} onChange={(e) => update({ maxLoss: num(e.target.value) })} className={inputCls} />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="text-[11px] text-zinc-500">資金上限（元，可不填）</span>
          <input type="number" min={0} step={10000} value={settings.capital ?? ''} placeholder="不限" onChange={(e) => update({ capital: e.target.value ? num(e.target.value) : null })} className={inputCls} />
        </label>
        <div className="space-y-1 min-w-0">
          <span className="text-[11px] text-zinc-500">停損</span>
          <div className="flex bg-zinc-950/60 p-0.5 rounded-lg border border-border/80 text-[11px]">
            {STOP_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => update({ stopMode: o.id })}
                className={`flex-1 px-1.5 py-1 rounded-md transition whitespace-nowrap ${settings.stopMode === o.id ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {settings.stopMode === 'custom' && (
            <input type="number" min={0} step={0.5} value={settings.customStop ?? ''} placeholder="停損價" onChange={(e) => update({ customStop: e.target.value ? num(e.target.value) : null })} className={inputCls} />
          )}
        </div>
        <div className="space-y-1 min-w-0">
          <span className="text-[11px] text-zinc-500">單位</span>
          <div className="flex bg-zinc-950/60 p-0.5 rounded-lg border border-border/80 text-[11px]">
            {(['lot', 'odd'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => update({ lotMode: m })}
                className={`flex-1 px-2 py-1 rounded-md transition ${settings.lotMode === m ? 'bg-primary text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {m === 'lot' ? '只買整張' : '可買零股'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!plan ? (
        <div className="text-xs text-zinc-500 text-center py-6">
          {settings.stopMode === 'custom' ? '請輸入停損價' : '請輸入可承受的最大虧損'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="bg-zinc-900/60 text-zinc-400 text-[11px] border-b border-border/60">
                <tr>
                  <th className="p-2.5 text-left">批次</th>
                  <th className="p-2.5 text-left">進場價</th>
                  <th className="p-2.5 text-left">比重 %</th>
                  <th className="p-2.5 text-right">股數</th>
                  <th className="p-2.5 text-right">金額</th>
                  <th className="p-2.5 text-left">依據</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {plan.batches.map((b, i) => (
                  <tr key={b.label} className={b.skipped ? 'opacity-50' : ''}>
                    <td className="p-2.5 font-semibold text-zinc-200">{b.label}</td>
                    <td className="p-2 w-28">
                      <input type="number" step={0.5} value={drafts[i].price || ''} onChange={(e) => updateDraft(i, { price: num(e.target.value) })} className={`${inputCls} min-w-[5.5rem]`} />
                    </td>
                    <td className="p-2 w-20">
                      <input type="number" step={5} min={0} value={drafts[i].weight || ''} onChange={(e) => updateDraft(i, { weight: num(e.target.value) })} className={`${inputCls} min-w-[3.75rem]`} />
                    </td>
                    <td className="p-2.5 text-right font-mono text-zinc-100">{b.skipped ? '略過' : fmtShares(b.shares)}</td>
                    <td className="p-2.5 text-right font-mono text-zinc-300">{b.skipped ? '—' : money(b.amount)}</td>
                    <td className="p-2.5 text-[11px] text-zinc-500">{b.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="p-3 rounded-xl bg-teal-500/5 border border-teal-500/30 space-y-1">
              <div className="text-[11px] text-zinc-500">停損價</div>
              <div className="text-lg font-bold font-mono text-teal-300">{fmtLevel(plan.stop)}</div>
              <div className="text-[10px] text-zinc-500">{plan.stopBasis}</div>
              <button
                type="button"
                disabled={stopAlertSet}
                onClick={() => onAddAlert('price_below', plan.stop, `建倉計畫停損（${plan.stopBasis}）`.slice(0, 100))}
                className={`mt-1 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition ${
                  stopAlertSet ? 'border-zinc-700 text-zinc-500 cursor-default' : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                }`}
              >
                {stopAlertSet ? <Check className="w-3 h-3" /> : <BellPlus className="w-3 h-3" />}
                {stopAlertSet ? '已設停損提醒' : '設停損 Email 提醒'}
              </button>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500">全部進場後</div>
              <div className="text-lg font-bold font-mono text-zinc-100">{fmtShares(plan.totalShares)}</div>
              <div className="text-[10px] text-zinc-500">平均成本 {plan.avgCost !== null ? fmtLevel(plan.avgCost) : '—'}</div>
            </div>
            <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40 space-y-1">
              <div className="text-[11px] text-zinc-500">投入金額</div>
              <div className="text-lg font-bold font-mono text-zinc-100">{money(plan.totalAmount)}</div>
              <div className="text-[10px] text-zinc-500">{settings.capital ? `資金上限 ${money(settings.capital)}` : '沒設資金上限'}</div>
            </div>
            <div className="p-3 rounded-xl bg-bear/5 border border-bear/30 space-y-1">
              <div className="text-[11px] text-zinc-500">觸發停損的虧損</div>
              <div className="text-lg font-bold font-mono text-bear">−{money(plan.lossAtStop)}</div>
              <div className="text-[10px] text-zinc-500">
                約投入的 {plan.lossPctOfAmount !== null ? plan.lossPctOfAmount.toFixed(1) : '—'}%・上限 {money(settings.maxLoss)}
              </div>
            </div>
          </div>

          {plan.targets.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {plan.targets.map((t) => (
                <div key={t.label} className="px-3 py-2 rounded-lg border border-orange-500/30 bg-orange-500/5 text-xs flex items-baseline gap-2">
                  <span className="text-orange-300 font-semibold">{t.label}</span>
                  <span className="font-mono text-zinc-100">{fmtLevel(t.price)}</span>
                  <span className={`font-mono ${t.gainPct >= 0 ? 'text-bull' : 'text-bear'}`}>{t.gainPct >= 0 ? '+' : ''}{t.gainPct.toFixed(1)}%</span>
                  {t.rMultiple !== null && (
                    <span className={`font-mono text-[11px] ${t.rMultiple >= 2 ? 'text-amber-300 font-semibold' : 'text-zinc-400'}`}>報酬風險比 {t.rMultiple.toFixed(1)}</span>
                  )}
                  {t.estimated && <span className="text-[10px] text-amber-300/80">（1 ATR 推估）</span>}
                </div>
              ))}
            </div>
          )}

          {plan.warnings.length > 0 && (
            <ul className="text-[11px] text-amber-300 space-y-0.5">
              {plan.warnings.map((w) => <li key={w}>・{w}</li>)}
            </ul>
          )}
        </>
      )}

      <div className="flex items-start justify-between gap-3 pt-3 border-t border-border/40">
        <p className="text-[10px] text-zinc-500 leading-relaxed">
          股數＝可承受虧損 ÷ 每股加權風險（各批進場價 − 停損價，按比重平均），整張或零股無條件捨去，所以全部進場後停損的虧損不會超過設定。
          報酬風險比＝（目標價 − 平均成本）÷（平均成本 − 停損價），2 以上較划算。未含手續費與證交稅；跳空跌破時實際虧損會比這裡大。
          可承受虧損與資金上限只存在這台瀏覽器。
        </p>
        <button
          type="button"
          onClick={() => setDrafts(defaultBatches(levels))}
          title="分批價位與比重回到預設"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-zinc-400 border border-border hover:text-zinc-200"
        >
          <RotateCcw className="w-3 h-3" />重設
        </button>
      </div>
    </div>
  );
};
