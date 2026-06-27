import { useEffect, useState } from 'react';
import { apiFetch } from '../auth';

function formatEpoch(epoch) {
  if (!epoch) return '';
  const n = parseInt(epoch, 10);
  if (Number.isNaN(n)) return '';
  const d = new Date(n * 1000);
  return `${d.toLocaleDateString('vi-VN')} ${d.toLocaleTimeString('vi-VN')}`;
}

export default function Admins() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', expireDay: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const r = await apiFetch('/api/admins');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setRows(j.admins || []);
      setErr(null);
    } catch (e) {
      if (e.message !== 'Unauthorized') setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createAdmin(e) {
    e.preventDefault();
    if (!form.username.trim() || !form.password) return;
    setSaving(true);
    try {
      const r = await apiFetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          expireDay: form.expireDay || undefined
        })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create failed');
      setOpen(false);
      setForm({ username: '', password: '', expireDay: '' });
      await load();
    } catch (e) {
      alert(e.message || 'Cannot create admin');
    } finally {
      setSaving(false);
    }
  }

  async function action(id, kind) {
    try {
      const r =
        kind === 'delete'
          ? await apiFetch(`/api/admins/${id}`, { method: 'DELETE' })
          : await apiFetch(`/api/admins/${id}/${kind}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'action failed');
      await load();
    } catch (e) {
      alert(e.message || 'Action failed');
    }
  }

  function deleteAdmin(id, username) {
    if (!confirm(`Delete admin "${username}"?`)) return;
    void action(id, 'delete');
  }

  if (err) {
    return (
      <p className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
        {err}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-800">Admins</h2>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-95"
        >
          Add admin
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-primary text-white text-left">
              <th className="px-3 py-2 font-medium">Username</th>
              <th className="px-3 py-2 font-medium">Create Day</th>
              <th className="px-3 py-2 font-medium">Expire Day</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((admin) => {
              const enabled = parseInt(admin.status, 10) !== 0;
              return (
                <tr key={admin.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-3 py-2">{admin.username}</td>
                  <td className="px-3 py-2">{formatEpoch(admin.create_day) || '—'}</td>
                  <td className="px-3 py-2">{formatEpoch(admin.expire_day) || 'Never'}</td>
                  <td className="px-3 py-2">{enabled ? 'Enabled' : 'Disabled'}</td>
                  <td className="px-3 py-2 space-x-2">
                    {enabled ? (
                      <button
                        type="button"
                        className="text-xs text-amber-700 hover:underline"
                        onClick={() => action(admin.id, 'disable')}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-xs text-green-700 hover:underline"
                        onClick={() => action(admin.id, 'enable')}
                      >
                        Enable
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-xs text-red-700 hover:underline"
                      onClick={() => deleteAdmin(admin.id, admin.username)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-zinc-500">
                  No admin accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <form
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onSubmit={createAdmin}
          >
            <h3 className="text-base font-semibold text-zinc-800 mb-4">Add admin</h3>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Username</label>
            <input
              className="mb-3 w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              required
            />
            <label className="block text-xs font-medium text-zinc-600 mb-1">Password</label>
            <input
              type="password"
              className="mb-3 w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              required
            />
            <label className="block text-xs font-medium text-zinc-600 mb-1">Expire days</label>
            <input
              type="number"
              min="1"
              placeholder="Empty = never"
              className="mb-4 w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              value={form.expireDay}
              onChange={(e) => setForm((f) => ({ ...f, expireDay: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-zinc-300 px-3 py-2 text-sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
