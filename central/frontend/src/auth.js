export function getToken() {
  return localStorage.getItem('central_token');
}

export function setToken(t) {
  if (t) localStorage.setItem('central_token', t);
  else localStorage.removeItem('central_token');
}

export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function apiFetch(input, init = {}) {
  const r = await fetch(input, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) }
  });
  if (r.status === 401) {
    setToken(null);
    window.location.assign('/login');
    throw new Error('Unauthorized');
  }
  return r;
}
