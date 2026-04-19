import { useEffect, useState } from 'react';
import { apiFetch } from '../auth';

export default function OperationLogs() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const emptyFilters = { alert_type: '', node_id: '', from: '', to: '', q: '' };
  const [draft, setDraft] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const p = new URLSearchParams();
        if (applied.alert_type.trim()) p.set('alert_type', applied.alert_type.trim());
        if (applied.node_id.trim()) p.set('node_id', applied.node_id.trim());
        if (applied.from.trim()) p.set('from', applied.from.trim());
        if (applied.to.trim()) p.set('to', applied.to.trim());
        if (applied.q.trim()) p.set('q', applied.q.trim());
        p.set('limit', String(limit));
        p.set('offset', String(offset));
        const r = await apiFetch(`/api/operation-logs?${p.toString()}`);
        const j = await r.json();
        if (!r.ok || !j.ok) {
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        if (cancelled) return;
        setRows(j.rows || []);
        setTotal(typeof j.total === 'number' ? j.total : 0);
      } catch (e) {
        if (cancelled || e.message === 'Unauthorized') return;
        setErr(e.message);
        setRows([]);
        setTotal(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applied, limit, offset]);

  const applyFilters = () => {
    setApplied({ ...draft });
    setOffset(0);
  };

  const nextPage = () => {
    if (offset + limit < total) setOffset((o) => o + limit);
  };
  const prevPage = () => {
    setOffset((o) => Math.max(0, o - limit));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">alert_type</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={draft.alert_type}
              onChange={(e) => setDraft((d) => ({ ...d, alert_type: e.target.value }))}
              placeholder="node_offline"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">node_id</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono"
              value={draft.node_id}
              onChange={(e) => setDraft((d) => ({ ...d, node_id: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">From (ISO)</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">To (ISO)</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-zinc-600 mb-1">detail / node name</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
            />
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Page size</label>
              <select
                className="rounded border border-zinc-300 px-2 py-1.5 text-sm bg-white"
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setOffset(0);
                }}
              >
                {[25, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="rounded bg-primary text-white px-4 py-1.5 text-sm font-medium hover:opacity-95"
              onClick={applyFilters}
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm">
          {err}
        </div>
      )}

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600">
        <span>
          Total <strong className="text-zinc-900">{total}</strong> — showing {rows.length} (offset {offset})
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-40"
            disabled={offset <= 0}
            onClick={prevPage}
          >
            Previous
          </button>
          <button
            type="button"
            className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-40"
            disabled={offset + limit >= total}
            onClick={nextPage}
          >
            Next
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-primary text-white text-left">
              <th className="px-3 py-2 font-medium">ts</th>
              <th className="px-3 py-2 font-medium">alert_type</th>
              <th className="px-3 py-2 font-medium">node_name</th>
              <th className="px-3 py-2 font-medium">node_id</th>
              <th className="px-3 py-2 font-medium">detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.ts}-${i}`} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-800 whitespace-nowrap">
                  {String(row.ts ?? '—')}
                </td>
                <td className="px-3 py-2 text-zinc-800 font-mono text-xs">{row.alert_type ?? '—'}</td>
                <td className="px-3 py-2 text-zinc-800">{row.node_name ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-600">{row.node_id ?? '—'}</td>
                <td className="px-3 py-2 text-zinc-700 whitespace-pre-wrap break-words max-w-md">
                  {row.detail ?? '—'}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && !err && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-zinc-500">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
