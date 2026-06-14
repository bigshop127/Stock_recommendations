import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-slate-800/60 border border-slate-700/60 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-300">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold text-white ${className}`}>
      {children}
    </span>
  );
}

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] bg-slate-700/70 text-slate-200 ${className}`}>
      {children}
    </span>
  );
}

export function Loading({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
      <span className="inline-block w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const isDown = api?.status === 503;
  return (
    <Card className="border-rose-700/50 bg-rose-950/30">
      <div className="text-rose-300 font-semibold text-sm mb-1">
        {isDown ? '⚙️ 引擎（engine）目前不可用' : '⚠️ 載入失敗'}
      </div>
      <div className="text-slate-300 text-sm break-words">{error.message}</div>
      {api?.code && <div className="text-slate-500 text-xs mt-1">code: {api.code}</div>}
      {isDown && (
        <div className="text-slate-400 text-xs mt-2">
          此頁需要 Python engine。報告頁不受影響、儀表板會自動進入降級模式。
        </div>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white"
        >
          重試
        </button>
      )}
    </Card>
  );
}
