import { useEffect, useMemo, useState } from 'react';
import { formatBps } from '../util';
import { apiFetch } from '../auth';

function pct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}%`;
}

export default function NodeExplorer() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await apiFetch('/api/nodes');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!cancel) setRows(j.nodes || []);
      } catch (e) {
        if (!cancel && e.message !== 'Unauthorized') setErr(e.message);
      }
    }
    load();
    const id = setInterval(load, 10000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  const regions = useMemo(() => {
    const s = new Set();
    for (const n of rows) {
      if (n.region) s.add(n.region);
    }
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((n) => {
      if (region && n.region !== region) return false;
      if (!ql) return true;
      const name = (n.name || '').toLowerCase();
      const pip = (n.publicIp || '').toLowerCase();
      return name.includes(ql) || pip.includes(ql);
    });
  }, [rows, q, region]);

  if (err) {
    return (
      <p className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
        Failed to load nodes: {err}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900">Node Explorer</h1>
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-zinc-600 mb-1">Search</label>
          <input
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="Name or public IP"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="sm:w-56">
          <label className="block text-xs font-medium text-zinc-600 mb-1">Region</label>
          <select
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            <option value="">All</option>
            {regions.map((reg) => (
              <option key={reg} value={reg}>
                {reg}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-primary text-white text-left">
              <th className="px-3 py-2 font-medium">Node</th>
              <th className="px-3 py-2 font-medium">Public IP</th>
              <th className="px-3 py-2 font-medium">Region</th>
              <th className="px-3 py-2 font-medium">CPU</th>
              <th className="px-3 py-2 font-medium">RAM used</th>
              <th className="px-3 py-2 font-medium">Disk used</th>
              <th className="px-3 py-2 font-medium">Throughput</th>
              <th className="px-3 py-2 font-medium">Peers</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((n) => (
              <tr key={n.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-3 py-2 font-medium text-zinc-900">
                  <div>{n.name}</div>
                  {n.baseUrl && (
                    <div
                      className="text-[11px] text-zinc-400 font-normal mt-0.5 font-mono truncate max-w-[14rem]"
                      title={n.baseUrl}
                    >
                      Scrape: {n.baseUrl}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-700 font-mono text-xs">{n.publicIp || '—'}</td>
                <td className="px-3 py-2 text-zinc-700">{n.region || '—'}</td>
                <td className="px-3 py-2 text-zinc-700">
                  {n.cpuPct != null ? `${n.cpuPct.toFixed(1)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-zinc-700">{pct(n.memUsedPct)}</td>
                <td className="px-3 py-2 text-zinc-700">{pct(n.diskUsedPct)}</td>
                <td className="px-3 py-2 text-zinc-700">{formatBps(n.bandwidthBps)}</td>
                <td className="px-3 py-2 text-zinc-700">{n.peers != null ? n.peers : '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      n.online
                        ? 'inline-flex rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-medium'
                        : 'inline-flex rounded-full bg-zinc-200 text-zinc-700 px-2 py-0.5 text-xs font-medium'
                    }
                  >
                    {n.online ? 'Online' : 'Offline'}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
                  No nodes registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
