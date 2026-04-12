import { NavLink, Outlet, useNavigate } from 'react-router-dom';

function navCls({ isActive }) {
  return `block px-4 py-2 text-sm rounded-r-md border-l-4 ${
    isActive
      ? 'border-primary bg-red-50 text-primary font-medium'
      : 'border-transparent text-zinc-700 hover:bg-zinc-50'
  }`;
}

export default function AppShell() {
  const nav = useNavigate();
  function logout() {
    localStorage.removeItem('central_token');
    nav('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-primary text-white shadow flex items-center justify-between px-4">
        <span className="font-semibold tracking-tight">WireGuard Central</span>
        <button
          type="button"
          onClick={logout}
          className="text-sm opacity-90 hover:opacity-100 underline-offset-2 hover:underline"
        >
          Logout
        </button>
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
