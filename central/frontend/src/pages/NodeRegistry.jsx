import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../auth';

function zipNodes(names, urls) {
  const a = Array.isArray(names) ? names : [];
  const b = Array.isArray(urls) ? urls : [];
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    out.push({ name: a[i] || '—', url: b[i] || '—' });
  }
  return out;
}

export default function NodeRegistry() {
  const [rows, setRows] = useState([]);
  const [filterQ, setFilterQ] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const r = await apiFetch('/api/registry/devices');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setRows(j.devices || []);
      setErr(null);
    } catch (e) {
      if (e.message !== 'Unauthorized') setErr(e.message);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const filteredRows = useMemo(() => {
    const ql = filterQ.trim().toLowerCase();
    if (!ql) return rows;
    return rows.filter((d) => {
      const mid = (d.machine_id || '').toLowerCase();
      const dn = (d.device_name || '').toLowerCase();
      const nn = Array.isArray(d.node_names) ? d.node_names.join(' ').toLowerCase() : '';
      const bu = Array.isArray(d.base_urls) ? d.base_urls.join(' ').toLowerCase() : '';
      const hay = `${mid} ${dn} ${nn} ${bu}`;
      return hay.includes(ql);
    });
  }, [rows, filterQ]);

  async function remove(machineId) {
    if (!machineId) return;
    if (!window.confirm(`Delete device ${machineId} from central and all VPN nodes?`)) return;
    setBusy(machineId);
    try {
      const r = await apiFetch(
        `/api/registry/devices/${encodeURIComponent(machineId)}`,
        { method: 'DELETE' }
      );
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.warnings && j.warnings.length) {
        window.alert(`Done with warnings:\n${j.warnings.join('\n')}`);
      }
      await load();
    } catch (e) {
      window.alert(e.message || 'Delete failed');
    } finally {
      setBusy(null);
    }
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
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end max-w-xl">
        <div className="flex-1">
          <label className="block text-xs font-medium text-zinc-600 mb-1">Search</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="machine_id, hostname, node name, or base URL"
            value={filterQ}
            onChange={(e) => setFilterQ(e.target.value)}
          />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-primary text-white text-left">
            <th className="px-3 py-2 font-medium">machine_id</th>
            <th className="px-3 py-2 font-medium">Hostname (device)</th>
            <th className="px-3 py-2 font-medium">VPN nodes enrolled</th>
            <th className="px-3 py-2 font-medium w-28"> </th>
          </tr>
        </thead>
        <tbody>
          {filteredRows.map((d) => {
            const pairs = zipNodes(d.node_names, d.base_urls);
            return (
              <tr key={d.machine_id} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-3 py-2 font-mono text-xs text-zinc-800 align-top">{d.machine_id}</td>
                <td className="px-3 py-2 text-zinc-800 align-top">{d.device_name || '—'}</td>
                <td className="px-3 py-2 text-zinc-700 align-top">
                  {pairs.length === 0 ? (
                    '—'
                  ) : (
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      {pairs.map((p, i) => (
                        <li key={i}>
                          <span className="font-medium">{p.name}</span>
                          <span className="text-zinc-500"> — </span>
                          <span className="font-mono text-zinc-600 break-all">{p.url}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    disabled={busy === d.machine_id}
                    className="text-red-700 text-xs font-medium hover:underline disabled:opacity-50"
                    onClick={() => remove(d.machine_id)}
                  >
                    {busy === d.machine_id ? '…' : 'Delete'}
                  </button>
                </td>
              </tr>
            );
          })}
          {filteredRows.length === 0 && rows.length > 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-zinc-500">
                No devices match your search.
              </td>
            </tr>
          )}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-zinc-500">
                No devices in registry.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
