import { useEffect, useState } from 'react';
import { apiFetch } from '../auth';

function parseDataField(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { _raw: String(raw) };
  }
}

function JsonBlock({ label, value, depth = 0 }) {
  const pad = { paddingLeft: depth * 12 };
  if (value === null || value === undefined) {
    return (
      <div style={pad} className="text-sm">
        <span className="text-zinc-500">{label ? `${label}: ` : ''}</span>
        <span className="text-zinc-400">null</span>
      </div>
    );
  }
  if (typeof value !== 'object') {
    return (
      <div style={pad} className="text-sm break-all">
        <span className="font-medium text-primary">{label ? `${label}: ` : ''}</span>
        <span className="text-zinc-800">{String(value)}</span>
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div style={pad} className="text-sm">
        <div className="font-medium text-primary mb-1">{label || '[]'}</div>
        {value.map((item, i) => (
          <JsonBlock key={i} label={`[${i}]`} value={item} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return (
    <div style={pad} className="text-sm border-l border-zinc-200 pl-2 my-1">
      {label && <div className="font-semibold text-zinc-700 mb-1">{label}</div>}
      {Object.entries(value).map(([k, v]) => (
        <JsonBlock key={k} label={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

function DetailModal({ row, onClose }) {
  if (!row) return null;
  const parsed = parseDataField(row.data);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 border border-zinc-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-4 mb-4">
          <h2 className="text-lg font-semibold text-primary">Log detail</h2>
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-800 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm mb-4">
          <div>
            <dt className="text-zinc-500">timestamp</dt>
            <dd className="font-mono text-zinc-900">{String(row.timestamp)}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">origin_host</dt>
            <dd className="font-mono text-zinc-900">{row.origin_host ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">event_type</dt>
            <dd className="font-mono text-zinc-900">{row.event_type ?? '—'}</dd>
          </div>
          {row.message != null && String(row.message).trim() !== '' && (
            <div>
              <dt className="text-zinc-500">message</dt>
              <dd className="text-zinc-900 whitespace-pre-wrap break-words">{String(row.message)}</dd>
            </div>
          )}
        </dl>
        <div>
          <div className="text-zinc-500 text-sm mb-2">data</div>
          <div className="bg-zinc-50 rounded border border-zinc-100 p-3 overflow-x-auto">
            {parsed && typeof parsed === 'object' ? (
              <JsonBlock value={parsed} depth={0} />
            ) : (
              <span className="text-zinc-500">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Alerts() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [detail, setDetail] = useState(null);

  const emptyFilters = { origin_host: '', event_type: '', from: '', to: '', q: '' };
  const [draft, setDraft] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const p = new URLSearchParams();
        if (applied.origin_host.trim()) p.set('origin_host', applied.origin_host.trim());
        if (applied.event_type.trim()) p.set('event_type', applied.event_type.trim());
        if (applied.from.trim()) p.set('from', applied.from.trim());
        if (applied.to.trim()) p.set('to', applied.to.trim());
        if (applied.q.trim()) p.set('q', applied.q.trim());
        p.set('limit', String(limit));
        p.set('offset', String(offset));
        const r = await apiFetch(`/api/alerts?${p.toString()}`);
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
      <h1 className="text-xl font-semibold text-zinc-900">Alerts</h1>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">origin_host</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={draft.origin_host}
              onChange={(e) => setDraft((d) => ({ ...d, origin_host: e.target.value }))}
              placeholder="peerA"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">event_type</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={draft.event_type}
              onChange={(e) => setDraft((d) => ({ ...d, event_type: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">From (ISO)</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              placeholder="2026-04-12T00:00:00Z"
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
            <label className="block text-xs font-medium text-zinc-600 mb-1">
              Message / data contains
            </label>
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
              <th className="px-3 py-2 font-medium">timestamp</th>
              <th className="px-3 py-2 font-medium">origin_host</th>
              <th className="px-3 py-2 font-medium">event_type</th>
              <th className="px-3 py-2 font-medium w-32"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.timestamp}-${row.origin_host}-${i}`} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-800 whitespace-nowrap">
                  {String(row.timestamp)}
                </td>
                <td className="px-3 py-2 text-zinc-800">{row.origin_host ?? '—'}</td>
                <td className="px-3 py-2 text-zinc-800">{row.event_type ?? '—'}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="text-primary text-sm font-medium underline hover:opacity-80"
                    onClick={() => setDetail(row)}
                  >
                    View detail
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && !err && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-zinc-500">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && <DetailModal row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
