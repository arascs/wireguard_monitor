import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../auth';

function formatTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

function DetailModal({ entry, onClose }) {
  if (!entry) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 border border-zinc-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-2 mb-3">
          <h2 className="text-lg font-semibold text-primary">Audit details</h2>
          <button type="button" className="text-zinc-500 hover:text-zinc-800 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="text-xs font-mono bg-zinc-50 border border-zinc-200 rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">
          {JSON.stringify(entry.details || {}, null, 2)}
        </pre>
      </div>
    </div>
  );
}

export default function AuditLogs() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [adminQ, setAdminQ] = useState('');
  const [actionQ, setActionQ] = useState('');
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await apiFetch('/api/audit-logs');
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!cancelled) setRows(j.logs || []);
      } catch (e) {
        if (!cancelled && e.message !== 'Unauthorized') {
          setErr(e.message);
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const aq = adminQ.trim().toLowerCase();
    const act = actionQ.trim().toLowerCase();
    return rows.filter((e) => {
      if (aq && !(e.admin || '').toLowerCase().includes(aq)) return false;
      if (act && !(e.action || '').toLowerCase().includes(act)) return false;
      return true;
    });
  }, [rows, adminQ, actionQ]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Admin</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={adminQ}
              onChange={(e) => setAdminQ(e.target.value)}
              placeholder="Filter admin…"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Action</label>
            <input
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
              value={actionQ}
              onChange={(e) => setActionQ(e.target.value)}
              placeholder="add_node, delete_node…"
            />
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm">
          {err}
        </div>
      )}

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-primary text-white text-left">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Admin</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={`${e.timestamp}-${i}`} className="border-t border-zinc-100 hover:bg-zinc-50">
                <td className="px-3 py-2 text-zinc-700 whitespace-nowrap">{formatTs(e.timestamp)}</td>
                <td className="px-3 py-2 text-zinc-900">{e.admin || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-800">{e.action || '—'}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="text-primary text-xs font-medium hover:underline"
                    onClick={() => setDetail(e)}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                  No audit logs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && <DetailModal entry={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
