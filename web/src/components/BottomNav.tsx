import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/', label: '儀表板', icon: '📊', end: true },
  { to: '/daytrade', label: '當沖', icon: '⚡', end: false },
  { to: '/watchlist', label: '清單', icon: '⭐', end: false },
  { to: '/reports', label: '報告', icon: '📰', end: false },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-slate-900/95 backdrop-blur border-t border-slate-700 pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-screen-sm grid grid-cols-4">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center py-2 text-[11px] gap-0.5 ${
                isActive ? 'text-emerald-400' : 'text-slate-400'
              }`
            }
          >
            <span className="text-lg leading-none">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
