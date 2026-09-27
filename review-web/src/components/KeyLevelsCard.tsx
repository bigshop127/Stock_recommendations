import React from 'react';
import { Crosshair, BellPlus, Check } from 'lucide-react';
import { fmtLevel } from '../lib/keyLevels';
import type { KeyLevels, LevelZone } from '../lib/keyLevels';

export type LevelAlertCondition = 'price_above' | 'price_below';

interface KeyLevelsCardProps {
  levels: KeyLevels | null;
  loading: boolean;
  isAlertSet: (conditionType: LevelAlertCondition, price: number) => boolean;
  onAddAlert: (conditionType: LevelAlertCondition, price: number, note: string) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
}

const LABEL_TONE: Record<LevelZone['kind'], string> = {
  resistance: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
  support: 'bg-teal-500/10 text-teal-300 border-teal-500/30',
};

const fmtRange = (z: LevelZone) =>
  fmtLevel(z.low) === fmtLevel(z.high) ? fmtLevel(z.low) : `${fmtLevel(z.low)} ~ ${fmtLevel(z.high)}`;

const ZoneRow: React.FC<{
  zone: LevelZone;
  isAlertSet: KeyLevelsCardProps['isAlertSet'];
  onAddAlert: KeyLevelsCardProps['onAddAlert'];
}> = ({ zone, isAlertSet, onAddAlert }) => {
  const isRes = zone.kind === 'resistance';
  const cond: LevelAlertCondition = isRes ? 'price_above' : 'price_below';
  const done = isAlertSet(cond, zone.alertPrice);
  const actionText = isRes ? '突破提醒' : '跌破提醒';
  const tip = `收盤${isRes ? '高於' : '低於'} ${fmtLevel(zone.alertPrice)} 時寄 Email（收盤後檢查）`;
  const note = `關鍵價位 ${zone.label}（${zone.bases.join('、')}）`.slice(0, 100);
  const isGate = zone.label === '守門';

  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-lg border ${isGate ? 'border-teal-500/30 bg-teal-500/5' : 'border-border/40 bg-zinc-950/40'}`}>
      <span className={`shrink-0 w-14 text-center text-[11px] font-bold px-1.5 py-0.5 rounded border ${LABEL_TONE[zone.kind]}`}>
        {zone.label}
      </span>
      <span className="font-mono font-bold text-sm text-zinc-100 min-w-[7.5rem]">{fmtRange(zone)}</span>
      <span className="font-mono text-[11px] text-zinc-400 min-w-[6rem]">
        {zone.distancePct >= 0 ? '+' : ''}{zone.distancePct.toFixed(1)}%
        {zone.atrMultiple !== null && <span className="text-zinc-600">（{zone.atrMultiple.toFixed(1)}×ATR）</span>}
      </span>
      <span className={`text-[11px] flex-1 min-w-[4.5rem] sm:min-w-[8rem] ${zone.estimated ? 'text-amber-300/80' : 'text-zinc-500'}`}>
        {zone.bases.join('、')}
      </span>
      <button
        type="button"
        disabled={done}
        onClick={() => onAddAlert(cond, zone.alertPrice, note)}
        title={done ? `已設定：${tip}` : tip}
        className={`ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition ${
          done
            ? 'border-zinc-700 text-zinc-500 cursor-default'
            : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
        }`}
      >
        {done ? <Check className="w-3 h-3" /> : <BellPlus className="w-3 h-3" />}
        {done ? '已設提醒' : actionText}
      </button>
    </li>
  );
};

export const KeyLevelsCard: React.FC<KeyLevelsCardProps> = ({ levels, loading, isAlertSet, onAddAlert, saveStatus }) => {
  const header = (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3 mb-4 flex-wrap">
      <div className="flex items-center gap-2">
        <Crosshair className="w-5 h-5 text-primary" />
        <h3 className="font-semibold text-sm text-zinc-200">關鍵價位與波動</h3>
      </div>
      <span className="text-[10px] text-zinc-500">
        {saveStatus === 'saving' ? '警示儲存中…' : saveStatus === 'error' ? '警示儲存失敗，請重試' : levels ? `依還原日 K・收盤 ${levels.date}` : ''}
      </span>
    </div>
  );

  if (loading && !levels) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
        {header}
        <div className="text-xs text-zinc-500 animate-pulse text-center py-8">載入日 K 資料中...</div>
      </div>
    );
  }
  if (!levels) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
        {header}
        <div className="text-xs text-zinc-500 text-center py-8">日 K 資料不足 20 天，無法計算關鍵價位</div>
      </div>
    );
  }

  const resistances = levels.zones.filter((z) => z.kind === 'resistance');
  const supports = levels.zones.filter((z) => z.kind === 'support');
  const { atr, atrPct, close } = levels;

  return (
    <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
      {header}

      {/* 手機：ATR 與收盤價並排、波動範圍獨佔一列；桌機三格一列 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40">
          <div className="text-[11px] text-zinc-500">ATR（14 日平均真實波幅）</div>
          <div className="mt-1 font-mono text-lg font-bold text-zinc-100">
            {atr !== null ? fmtLevel(atr) : '—'}
            {atrPct !== null && <span className="ml-1.5 text-xs font-semibold text-amber-300">{atrPct.toFixed(1)}%</span>}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">這檔平常一天大約會動這麼多</div>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40 col-span-2 sm:col-span-1 order-last sm:order-none">
          <div className="text-[11px] text-zinc-500">正常波動範圍（收盤 ± 1 個 ATR）</div>
          <div className="mt-1 font-mono text-lg font-bold text-zinc-100">
            {atr !== null ? `${fmtLevel(close - atr)} ~ ${fmtLevel(close + atr)}` : '—'}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">超出這個範圍才算明顯異動</div>
        </div>
        <div className="p-3 rounded-xl bg-zinc-950/40 border border-border/40">
          <div className="text-[11px] text-zinc-500">收盤價</div>
          <div className="mt-1 font-mono text-lg font-bold text-zinc-100">{fmtLevel(close)}</div>
          <div className="text-[10px] mt-0.5 text-zinc-500">
            {levels.onPrice.length > 0 ? <span className="text-sky-300">正在測試：{levels.onPrice.join('、')}</span> : levels.date}
          </div>
        </div>
      </div>

      <ul className="space-y-2">
        {resistances.map((z) => (
          <ZoneRow key={z.label} zone={z} isAlertSet={isAlertSet} onAddAlert={onAddAlert} />
        ))}
        <li className="flex items-center gap-3 px-3 text-[11px] text-zinc-400">
          <span className="h-px flex-1 bg-zinc-700" />
          <span className="font-mono">現價 {fmtLevel(close)}</span>
          <span className="h-px flex-1 bg-zinc-700" />
        </li>
        {supports.map((z) => (
          <ZoneRow key={z.label} zone={z} isAlertSet={isAlertSet} onAddAlert={onAddAlert} />
        ))}
        {supports.length === 0 && (
          <li className="px-3 py-2 text-[11px] text-zinc-500">下方沒有可參考的支撐（股價在近期最低附近）</li>
        )}
        {levels.danger !== null && (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/5">
            <span className="shrink-0 w-14 text-center text-[11px] font-bold px-1.5 py-0.5 rounded border bg-red-500/10 text-red-300 border-red-500/30">
              危險
            </span>
            <span className="font-mono font-bold text-sm text-red-300">&lt; {fmtLevel(levels.danger)}</span>
            <span className="text-[11px] text-zinc-500">收盤跌破最後一道支撐，近期結構就破壞了</span>
          </li>
        )}
      </ul>

      <p className="mt-4 text-[10px] text-zinc-500 leading-relaxed">
        怎麼算：候選價位＝月線、季線、半年線、年線，以及近 20 日／60 日／一年的高低點；現價上方由近到遠取兩區當壓力、下方取三區當支撐，
        相距不到 0.5 個 ATR 的併成一個區間。上方沒有任何前高時，用收盤 + 1 個 ATR 推估。「突破／跌破提醒」會加進「基本資料」分頁的價格警示，
        壓力取區間上緣、支撐取區間下緣，收盤後檢查、達標寄 Email。規則式計算，非投資建議。
      </p>
    </div>
  );
};
