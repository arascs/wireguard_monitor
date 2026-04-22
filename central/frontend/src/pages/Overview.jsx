import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';
import { apiFetch } from '../auth';

const chartColors = {
  clientRx: 'rgba(134, 22, 24, 0.85)',
  clientTx: 'rgba(134, 22, 24, 0.45)',
  siteRx: 'rgba(80, 80, 90, 0.85)',
  siteTx: 'rgba(80, 80, 90, 0.45)'
};

export default function Overview() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await apiFetch('/api/dashboard');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!cancel) setData(j);
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

  if (err) {
    return (
      <p className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
        Failed to load dashboard: {err}
      </p>
    );
  }

  if (!data) {
    return <p className="text-zinc-600 text-sm">Loading…</p>;
  }

  const { totals, trafficSeries, nodes } = data;
  const chartData = Array.isArray(trafficSeries) ? trafficSeries.slice(-50) : [];
  const onlineNodes = (nodes || []).filter((n) => n.online);
  const nodeOrder = onlineNodes.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const size = 760;
  const center = size / 2;
  const radius = Math.max(120, center - 90);
  const nodePositions = new Map();
  nodeOrder.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, nodeOrder.length);
    nodePositions.set(n.id, {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle)
    });
  });
  const links = Array.isArray(data.siteLinks) ? data.siteLinks : [];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-zinc-500">Nodes</div>
          <div className="text-2xl font-semibold text-primary mt-1">{totals.nodes}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-zinc-500">Online</div>
          <div className="text-2xl font-semibold text-primary mt-1">{totals.online}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-zinc-500">Alerts (24h est.)</div>
          <div className="text-2xl font-semibold text-primary mt-1">{totals.alerts24h}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm min-w-0">
          <h2 className="text-base font-semibold text-zinc-800 mb-3">Site-to-site topology</h2>
          <div className="relative w-full h-[42vh] max-h-[460px] overflow-hidden rounded border border-zinc-100 bg-zinc-50 p-2">
            <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full">
              {links.map((link, idx) => {
                const a = nodePositions.get(link.source);
                const b = nodePositions.get(link.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={`${link.source}-${link.target}-${idx}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#9ca3af"
                    strokeWidth="2"
                  />
                );
              })}
              {nodeOrder.map((n) => {
                const p = nodePositions.get(n.id);
                if (!p) return null;
                return (
                  <g key={n.id}>
                    <circle cx={p.x} cy={p.y} r="22" fill="#861618" stroke="#ffffff" strokeWidth="2" />
                  </g>
                );
              })}
            </svg>
            {nodeOrder.map((n) => {
              const p = nodePositions.get(n.id);
              if (!p) return null;
              const hostLabel = n.name || n.id;
              const endpointLabel = n.publicIp || 'no-endpoint';
              const left = `${(p.x / size) * 100}%`;
              const top = `${(p.y / size) * 100}%`;
              return (
                <div
                  key={`label-${n.id}`}
                  className="absolute pointer-events-none text-center"
                  style={{ left, top, transform: 'translate(-50%, 20px)' }}
                >
                  <div className="text-[14px] leading-4 font-semibold text-zinc-900">{hostLabel}</div>
                  <div className="text-[12px] leading-4 font-medium text-zinc-700">({endpointLabel})</div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Edge is shown only when both nodes report each other as online site peers.
          </p>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm min-w-0">
          <h2 className="text-base font-semibold text-zinc-800 mb-1">Aggregate traffic</h2>
          <div className="h-[42vh] max-h-[460px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis
                  dataKey="t"
                  tickFormatter={(ts) => new Date(ts * 1000).toLocaleTimeString()}
                  fontSize={11}
                />
                <YAxis
                  tickFormatter={(v) =>
                    v >= 1e9 ? `${(v / 1e9).toFixed(1)}G` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}k`
                  }
                  fontSize={11}
                />
                <Tooltip
                  labelFormatter={(ts) => new Date(ts * 1000).toLocaleString()}
                  formatter={(value) => [`${Number(value).toLocaleString()} B`, '']}
                />
                <Legend />
                <Bar dataKey="clientRx" name="Client RX" stackId="tr" fill={chartColors.clientRx} />
                <Bar dataKey="clientTx" name="Client TX" stackId="tr" fill={chartColors.clientTx} />
                <Bar dataKey="siteRx" name="Site RX" stackId="tr" fill={chartColors.siteRx} />
                <Bar dataKey="siteTx" name="Site TX" stackId="tr" fill={chartColors.siteTx} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </div>
  );
}
