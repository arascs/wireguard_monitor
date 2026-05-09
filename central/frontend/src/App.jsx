import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Overview from './pages/Overview';
import NodeExplorer from './pages/NodeExplorer';
import Logging from './pages/Logging';
import { markAuthenticated } from './auth';

function RequireAuth({ children }) {
  const loc = useLocation();
  const [state, setState] = useState('checking'); // checking | ok | denied

  useEffect(() => {
    let cancelled = false;
    fetch('/api/notifications/unread', { credentials: 'include' })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          markAuthenticated(true);
          setState('ok');
        } else {
          setState('denied');
        }
      })
      .catch(() => !cancelled && setState('denied'));
    return () => { cancelled = true; };
  }, []);

  if (state === 'checking') return null;
  if (state === 'denied') return <Navigate to="/login" replace state={{ from: loc }} />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Overview />} />
          <Route path="nodes" element={<NodeExplorer />} />
          <Route path="logging" element={<Logging />} />
          <Route path="alerts" element={<Navigate to="/logging" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
