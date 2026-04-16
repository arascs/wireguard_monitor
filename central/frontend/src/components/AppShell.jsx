import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { apiFetch } from '../auth';

function navCls({ isActive }) {
  return `block px-4 py-2 text-sm rounded-r-md border-l-4 ${
    isActive
      ? 'border-primary bg-red-50 text-primary font-medium'
      : 'border-transparent text-zinc-700 hover:bg-zinc-50'
  }`;
}

export default function AppShell() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [openBell, setOpenBell] = useState(false);
  const [openedCount, setOpenedCount] = useState(0);

  async function loadUnread() {
    try {
      const r = await apiFetch('/api/notifications/unread');
      const j = await r.json();
      if (j && j.ok) {
        setUnread(Math.max(0, Number(j.unread) || 0));
      }
    } catch {
      // ignore notification poll errors
    }
  }

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 5000);
    return () => clearInterval(t);
  }, []);

  async function openNotifications() {
    setOpenedCount(unread);
    setOpenBell((v) => !v);
    try {
      await apiFetch('/api/notifications/mark-read', { method: 'POST' });
      setUnread(0);
    } catch {
      // ignore mark read errors
    }
  }

  function logout() {
    localStorage.removeItem('central_token');
    nav('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-primary text-white shadow flex items-center justify-between px-4">
        <span className="font-semibold tracking-tight">WireGuard Central</span>
        <div className="flex items-center gap-3 relative">
          <button
            type="button"
            onClick={openNotifications}
            className="relative h-9 w-9 rounded-full border border-white/30 hover:bg-white/10 flex items-center justify-center"
            title={`${unread} new alerts`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
              <path d="M9 17a3 3 0 0 0 6 0" />
            </svg>
            {unread > 0 && <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-red-500" />}
          </button>
          {openBell && (
            <div className="absolute top-11 right-12 rounded-md border border-zinc-200 bg-white text-zinc-800 shadow-lg px-3 py-2 text-sm min-w-44">
              <div className="font-medium">{openedCount} new alerts</div>
              <button
                type="button"
                className="mt-2 text-primary hover:underline"
                onClick={() => {
                  setOpenBell(false);
                  nav('/alerts');
                }}
              >
                View alerts
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={logout}
            className="text-sm opacity-90 hover:opacity-100 underline-offset-2 hover:underline"
          >
            Logout
          </button>
        </div>
      </header>

      <aside className="fixed top-14 left-0 bottom-0 z-40 w-56 bg-white border-r border-zinc-200 pt-3 pb-6 overflow-y-auto">
        <nav className="flex flex-col gap-0.5">
          <NavLink to="/" end className={navCls}>
            Overview
          </NavLink>
          <NavLink to="/nodes" className={navCls}>
            Node Explorer
          </NavLink>
          <NavLink to="/alerts" className={navCls}>
            Alerts
          </NavLink>
        </nav>
      </aside>

      <main className="pt-14 pl-56 min-h-screen">
        <div className="h-[calc(100vh-3.5rem)] overflow-y-auto p-6 max-w-[1600px] mx-auto w-full">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
