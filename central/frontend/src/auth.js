// Session is stored in an httpOnly cookie set by the server. The browser sends
// it automatically; we just need credentials: 'include' on every fetch.
let isAuthenticated = false;

export function markAuthenticated(v) {
  isAuthenticated = !!v;
}

export function getToken() {
  return isAuthenticated ? 'cookie' : null;
}

export async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  } catch {
    /* ignore */
  }
  isAuthenticated = false;
}

export async function apiFetch(input, init = {}) {
  const r = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers || {}) }
  });
  if (r.status === 401) {
    isAuthenticated = false;
    window.location.assign('/login');
    throw new Error('Unauthorized');
  }
  return r;
}
