// engine 不可用時的全域降級橫幅（由 /api/health 驅動）。
export function DegradedBanner({ engineDown }: { engineDown: boolean }) {
  if (!engineDown) return null;
  return (
    <div className="bg-amber-900/70 border-b border-amber-700 text-amber-100 text-xs px-4 py-2 text-center">
      ⚠️ 量化引擎離線（降級模式）：儀表板僅顯示老王水位/情緒快取，個股/觀察清單/回測暫不可用；老王每日報告照常。
    </div>
  );
}
