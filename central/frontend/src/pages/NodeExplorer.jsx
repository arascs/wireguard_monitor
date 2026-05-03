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

function listSitesText(sites) {
  if (!Array.isArray(sites) || sites.length === 0) return '—';
  return sites.join(', ');
}

function MaskedKeyInput({ label, value, reveal, setReveal, onChange }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-600">{label}</label>
      <div className="flex items-center gap-2">
        <input
          className="flex-1 rounded border border-zinc-300 px-2 py-1.5 text-xs font-mono"
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={onChange}
        />
        <button type="button" className="text-zinc-600 hover:text-zinc-900" onClick={() => setReveal(!reveal)}>
          {reveal ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );
}

function NodeServicesModal({ node, onClose }) {
  const [keys, setKeys] = useState({
    registerKey: node?.apiKeys?.registerKey || '',
    pushKey: node?.apiKeys?.pushKey || '',
    pullKey: node?.apiKeys?.pullKey || ''
  });
  const [reveal, setReveal] = useState({ reg: false, push: false, pull: false });
  const [saving, setSaving] = useState(false);
  if (!node) return null;
  async function saveKeys() {
    setSaving(true);
    try {
      const r = await apiFetch('/api/node-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: node.machineId || node.name || '',
          registerKey: keys.registerKey,
          pushKey: keys.pushKey,
          pullKey: keys.pullKey
        })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      window.alert('Saved API keys');
      onClose();
    } catch (e) {
      window.alert(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }
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

        <p className="text-xs font-medium text-zinc-600 mt-6 mb-1">Sites</p>
        <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 break-all">
          {listSitesText(node.sites)}
        </div>
        <div className="mt-6 space-y-3">
          <p className="text-xs font-medium text-zinc-600">API Keys</p>
          <MaskedKeyInput
            label="Register key"
            value={keys.registerKey}
            reveal={reveal.reg}
            setReveal={(v) => setReveal((p) => ({ ...p, reg: v }))}
            onChange={(e) => setKeys((p) => ({ ...p, registerKey: e.target.value }))}
          />
          <MaskedKeyInput
            label="Push key"
            value={keys.pushKey}
            reveal={reveal.push}
            setReveal={(v) => setReveal((p) => ({ ...p, push: v }))}
            onChange={(e) => setKeys((p) => ({ ...p, pushKey: e.target.value }))}
          />
          <MaskedKeyInput
            label="Pull key"
            value={keys.pullKey}
            reveal={reveal.pull}
            setReveal={(v) => setReveal((p) => ({ ...p, pull: v }))}
            onChange={(e) => setKeys((p) => ({ ...p, pullKey: e.target.value }))}
          />
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-primary text-white text-xs disabled:opacity-60"
            onClick={saveKeys}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save keys'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddNodeModal({ onClose, onCreated }) {
  const [row, setRow] = useState({ registerKey: '', pushKey: '', pullKey: '' });
  const [loading, setLoading] = useState(false);
  async function generate() {
    setLoading(true);
    try {
      const r = await apiFetch('/api/node-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRow(j.row || {});
      onCreated && onCreated();
    } catch (e) {
      window.alert(e.message || 'Generate failed');
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 border border-zinc-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start gap-2 mb-4">
          <h2 className="text-lg font-semibold text-primary">Add node</h2>
          <button type="button" className="text-zinc-500 hover:text-zinc-800 text-sm" onClick={onClose}>Close</button>
        </div>
        <p className="text-xs text-zinc-600 mb-3">Generate API keys and copy them to local node settings.</p>
        <button type="button" className="px-3 py-1.5 rounded bg-primary text-white text-xs" onClick={generate} disabled={loading}>
          {loading ? 'Generating…' : 'Generate API keys'}
        </button>
        {!!row.registerKey && (
          <div className="mt-4 space-y-2 text-xs">
            <div><span className="font-medium">Register:</span> <span className="font-mono break-all">{row.registerKey}</span></div>
            <div><span className="font-medium">Push:</span> <span className="font-mono break-all">{row.pushKey}</span></div>
            <div><span className="font-medium">Pull:</span> <span className="font-mono break-all">{row.pullKey}</span></div>
          </div>
        )}
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
  const [deletingNodeId, setDeletingNodeId] = useState(null);
  const [showAddNode, setShowAddNode] = useState(false);

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

  async function handleDeleteNode(node) {
    if (!node || !node.id) return;
    const ok = window.confirm(`Delete node "${node.name}"? This also requests peer cleanup on connected sites.`);
    if (!ok) return;
    setDeletingNodeId(node.id);
    try {
      const r = await apiFetch(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${r.status}`);
      }
      setRows((prev) => prev.filter((it) => it.id !== node.id));
      if (detailNode && detailNode.id === node.id) setDetailNode(null);
      if (payload.warnings && payload.warnings.length) {
        window.alert(`Node removed with warnings:\n${payload.warnings.join('\n')}`);
      }
    } catch (e) {
      window.alert(`Delete failed: ${e.message}`);
    } finally {
      setDeletingNodeId(null);
    }
  }

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

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 pb-2">
        <div className="flex flex-wrap gap-2">
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
        {section === 'nodes' && (
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-primary text-white text-xs shrink-0"
            onClick={() => setShowAddNode(true)}
          >
            Add node
          </button>
        )}
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
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-primary text-xs font-medium hover:underline"
                      onClick={() => setDetailNode(n)}
                    >
                      View detail
                    </button>
                    <button
                      type="button"
                      className="text-red-700 text-xs font-medium hover:underline disabled:text-zinc-400"
                      disabled={deletingNodeId === n.id}
                      onClick={() => handleDeleteNode(n)}
                    >
                      {deletingNodeId === n.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
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
      {showAddNode && <AddNodeModal onClose={() => setShowAddNode(false)} onCreated={() => {}} />}
        </>
      )}
    </div>
  );
}
