import { useEffect, useMemo, useState } from 'react';
import { formatBps } from '../util';
import { apiFetch } from '../auth';
import NodeRegistry from './NodeRegistry';

function pct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}%`;
}

function formatLastSeen(ts) {
  if (ts == null || ts === undefined) return '—';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '—';
  }
}

const SERVICE_KEYS = ['endpoint_monitor', 'wg_handshake_monitor', 'services_monitor', 'mysql'];

function wgPairLabel(online, total) {
  if (online != null && total != null) return `${online} / ${total}`;
  if (total != null) return `— / ${total}`;
  return '—';
}

function NodeServicesModal({ node, onClose }) {
  if (!node) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 border border-zinc-200 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-2 mb-4">
          <h2 className="text-lg font-semibold text-primary">Node detail — {node.name}</h2>
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-800 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <p className="text-xs font-medium text-zinc-600 mb-2">Services</p>
        <div className="space-y-0 mb-6">
          {SERVICE_KEYS.map((k) => {
            const v = node.services && node.services[k];
            const active = v === 1;
            return (
              <div
                key={k}
                className="flex justify-between items-center text-sm py-2 border-b border-zinc-100 last:border-0"
              >
                <span className="font-mono text-xs text-zinc-800">{k}</span>
                <span
                  className={
                    active
                      ? 'text-emerald-700 font-medium text-xs'
                      : 'text-red-700 font-medium text-xs'
                  }
                >
                  {v === undefined || v === null ? '—' : active ? 'active' : 'inactive'}
                </span>
              </div>
            );
          })}
        </div>

        <p className="text-xs font-medium text-zinc-600 mb-1">WireGuard</p>
        <div className="space-y-0">
          <div className="flex justify-between items-center text-sm py-2 border-b border-zinc-100">
            <span className="text-zinc-800">Active clients</span>
            <span className="text-zinc-700 font-mono text-xs">
              {wgPairLabel(node.clientsOnline, node.clientsTotal)}
            </span>
          </div>
          <div className="flex justify-between items-center text-sm py-2 border-b border-zinc-100 last:border-0">
            <span className="text-zinc-800">Active sites</span>
            <span className="text-zinc-700 font-mono text-xs">
              {wgPairLabel(node.sitesOnline, node.sitesTotal)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NodeExplorer() {
  const [section, setSection] = useState('nodes');
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [err, setErr] = useState(null);
  const [detailNode, setDetailNode] = useState(null);

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

  function sitesLabel(n) {
    const on = n.sitesOnline;
    const tot = n.sitesTotal;
    if (on != null && tot != null) return `${on} / ${tot}`;
    if (tot != null) return `— / ${tot}`;
    return '—';
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900">Node Explorer</h1>

      <div className="flex flex-wrap gap-2 border-b border-zinc-200 pb-2">
        <button
          type="button"
          className={`px-4 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            section === 'nodes'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-zinc-600 hover:text-zinc-900'
          }`}
          onClick={() => setSection('nodes')}
        >
          Nodes
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            section === 'devices'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-zinc-600 hover:text-zinc-900'
          }`}
          onClick={() => setSection('devices')}
        >
          Devices
        </button>
      </div>

      {section === 'devices' && <NodeRegistry />}

      {section === 'nodes' && (
        <>
      {err && (
        <p className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
          Failed to load nodes: {err}
        </p>
      )}
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
              <th className="px-3 py-2 font-medium">Sites</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((n) => (
              <tr key={n.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-3 py-2 font-medium text-zinc-900">
                  <div>{n.name}</div>
                </td>
                <td className="px-3 py-2 text-zinc-700 font-mono text-xs">{n.publicIp || '—'}</td>
                <td className="px-3 py-2 text-zinc-700">{n.region || '—'}</td>
                <td className="px-3 py-2 text-zinc-700">
                  {n.cpuPct != null ? `${n.cpuPct.toFixed(1)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-zinc-700">{pct(n.memUsedPct)}</td>
                <td className="px-3 py-2 text-zinc-700">{pct(n.diskUsedPct)}</td>
                <td className="px-3 py-2 text-zinc-700">{formatBps(n.bandwidthBps)}</td>
                <td className="px-3 py-2 text-zinc-700 whitespace-nowrap">{sitesLabel(n)}</td>
                <td className="px-3 py-2 text-zinc-600 text-xs whitespace-nowrap" title="/health last OK">
                  {formatLastSeen(n.lastHealthOkAt)}
                </td>
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
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="text-primary text-xs font-medium hover:underline"
                    onClick={() => setDetailNode(n)}
                  >
                    View detail
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-zinc-500">
                  No nodes registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detailNode && <NodeServicesModal node={detailNode} onClose={() => setDetailNode(null)} />}
        </>
      )}
    </div>
  );
}
