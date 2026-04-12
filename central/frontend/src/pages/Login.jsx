import { useState } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { setToken, getToken } from '../auth';

export default function Login() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const from = loc.state?.from?.pathname || '/';

  if (getToken()) {
    return <Navigate to="/" replace />;
  }

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || 'Authentication failed');
      }
      setToken(j.token);
      nav(from, { replace: true });
    } catch (e) {
      setErr(e.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-100 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-primary mb-1">WireGuard Central</h1>
        <p className="text-xs text-zinc-500 mb-4">Sign in</p>
        {err && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </div>
        )}
        <label className="block text-xs font-medium text-zinc-600 mb-1">Username</label>
        <input
          className="mb-3 w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <label className="block text-xs font-medium text-zinc-600 mb-1">Password</label>
        <input
          type="password"
          className="mb-4 w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-primary py-2 text-sm font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
