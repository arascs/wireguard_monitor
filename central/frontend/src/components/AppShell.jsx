import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { apiFetch } from '../auth';

function navCls({ isActive }) {
  return `block px-4 py-2 text-sm rounded-r-md border-l-4 ${
    isActive
      ? 'border-primary bg-red-50 text-primary font-medium'
      : 'border-transparent text-zinc-700 hover:bg-zinc-50'
  }`;
}

const TYPE_ORDER = [
  'ingest',
  'node_offline',
  'node_connection_error',
  'high_resource',
  'service_offline'
];

export default function AppShell() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [openBell, setOpenBell] = useState(false);
  const [notifItems, setNotifItems] = useState([]);

  async function loadUnread() {
    try {
      const r = await apiFetch('/api/notifications/unread');
      const j = await r.json();
      if (j && j.ok) {
        setUnread(Math.max(0, Number(j.unread) || 0));
        setNotifItems(Array.isArray(j.items) ? j.items : []);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 5000);
    return () => clearInterval(t);
  }, []);

  async function markNotificationsRead() {
    try {
      await apiFetch('/api/notifications/mark-read', { method: 'POST' });
      setUnread(0);
      await loadUnread();
    } catch {
      /* ignore */
    }
  }

  function closeBellPanel() {
    setOpenBell(false);
    void markNotificationsRead();
  }

  function toggleBell() {
    if (openBell) closeBellPanel();
    else setOpenBell(true);
  }

  function logout() {
    localStorage.removeItem('central_token');
    nav('/login', { replace: true });
  }

  const grouped = useMemo(() => {
    const by = {};
    for (const it of notifItems) {
      if (!by[it.type]) by[it.type] = [];
      by[it.type].push(it);
    }
    const keys = [...TYPE_ORDER.filter((t) => by[t]?.length), ...Object.keys(by).filter((k) => !TYPE_ORDER.includes(k))];
    return keys.map((type) => ({ type, items: by[type] || [] })).filter((g) => g.items.length > 0);
  }, [notifItems]);

  return (
    <div className="min-h-screen bg-zinc-100">
      <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-primary text-white shadow flex items-center justify-between px-4">
        <span className="font-semibold tracking-tight">WireGuard Central</span>
        <div className="flex items-center gap-3 relative">
          <button
            type="button"
            onClick={toggleBell}
            className="relative h-9 w-9 rounded-full border border-white/30 hover:bg-white/10 flex items-center justify-center"
            title="Notifications"
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
            {unread > 0 && (
              <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-red-500" />
            )}
          </button>
          {openBell && (
            <div className="absolute top-11 right-0 w-[min(100vw-2rem,22rem)] max-h-[70vh] flex flex-col rounded-md border border-zinc-200 bg-white text-zinc-800 shadow-lg z-[60]">
              <div className="px-3 py-2 border-b border-zinc-100 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-700">Notifications</span>
                <button
                  type="button"
                  className="text-xs text-zinc-600 hover:text-zinc-900 underline-offset-2 hover:underline"
                  onClick={closeBellPanel}
                >
                  Close
                </button>
              </div>
              <div className="overflow-y-auto flex-1 p-2 space-y-2 max-h-[60vh]">
                {grouped.length === 0 && (
                  <p className="text-sm text-zinc-500 px-1 py-2">No notifications yet.</p>
                )}
                {grouped.map((g) => (
                  <div key={g.type} className="rounded-md border border-zinc-200 bg-zinc-50/80 p-2">
                    <div className="text-xs font-semibold text-primary uppercase tracking-wide mb-1.5">
                      {g.items[0]?.title || g.type}
                    </div>
                    <div className="space-y-2">
                      {g.items.map((it) => (
                        <div
                          key={it.id}
                          className="rounded border border-zinc-100 bg-white px-2 py-1.5 text-xs text-zinc-700"
                        >
                          {it.nodeName ? (
                            <div className="font-medium text-zinc-900 mb-0.5">{it.nodeName}</div>
                          ) : null}
                          {it.type === 'ingest' ? null : it.detail ? (
                            <div className="text-zinc-600 whitespace-pre-wrap break-words">{it.detail}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-2 py-2 border-t border-zinc-100">
                <button
                  type="button"
                  className="text-sm text-primary hover:underline w-full text-left"
                  onClick={() => {
                    setOpenBell(false);
                    void markNotificationsRead();
                    nav('/logging');
                  }}
                >
                  Open logging
                </button>
              </div>
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
          <NavLink to="/logging" className={navCls}>
            Logging
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
