import React from 'react';

export interface OverviewCardProps {
  id?: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  caption?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export const OverviewCard: React.FC<OverviewCardProps> = ({
  id,
  title,
  icon,
  caption,
  actions,
  children,
  footer,
  className = '',
  loading = false,
  error = null,
  onRetry,
}) => {
  return (
    <div
      id={id}
      className={`bg-card border border-border rounded-xl p-5 sm:p-6 flex flex-col justify-between ${className}`}
    >
      <div>
        <div className="flex items-center justify-between mb-3 border-b border-border/60 pb-3">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <div className="min-w-0">
              <h3 className="font-semibold text-sm text-zinc-200 tracking-tight truncate">{title}</h3>
              {caption && <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{caption}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0 ml-2">{actions}</div>}
        </div>

        {loading ? (
          <div className="h-48 flex items-center justify-center text-xs text-zinc-500 animate-pulse">
            載入資料中...
          </div>
        ) : error ? (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4 border border-red-500/20 bg-red-500/5 rounded-lg">
            <span className="text-xs text-red-400 font-semibold mb-2">無法載入資料</span>
            <span className="text-[10px] text-zinc-500 font-mono mb-3">{error}</span>
            {onRetry && (
              <button
                onClick={onRetry}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition"
              >
                重試
              </button>
            )}
          </div>
        ) : (
          children
        )}
      </div>

      {footer && (
        <div className="mt-4 pt-2 border-t border-border/20 text-[10px] text-zinc-500 font-mono flex items-center justify-between flex-wrap gap-1">
          {footer}
        </div>
      )}
    </div>
  );
};
