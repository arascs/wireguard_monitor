import { useEffect, useState } from 'react';
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker
} from 'react-simple-maps';
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

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

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
  const chartData = trafficSeries || [];

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

      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-zinc-800 mb-3">Node map</h2>
        <div className="w-full overflow-hidden rounded border border-zinc-100 bg-zinc-50">
          <ComposableMap
            projectionConfig={{ scale: 120, center: [0, 20] }}
            width={800}
            height={360}
            style={{ width: '100%', height: 'auto' }}
          >
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill="#e4e4e7"
                    stroke="#d4d4d8"
                    style={{
                      default: { outline: 'none' },
                      hover: { outline: 'none', fill: '#ddd' },
                      pressed: { outline: 'none' }
                    }}
                  />
                ))
              }
            </Geographies>
            {(nodes || []).map(
              (n) =>
                n.lat != null &&
                n.lon != null && (
                  <Marker key={n.id} coordinates={[n.lon, n.lat]}>
                    <circle r={5} fill="rgba(134, 22, 24, 1)" stroke="#fff" strokeWidth={1} />
                    <title>
                      {n.name}
                      {n.publicIp ? ` — ${n.publicIp}` : ''}
                    </title>
                  </Marker>
                )
            )}
          </ComposableMap>
        </div>
        <p className="text-xs text-zinc-500 mt-2">Geolocation from registered public IP.</p>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-zinc-800 mb-1">Aggregate traffic (per scrape)</h2>
        <p className="text-xs text-zinc-500 mb-3">Stacked: client/site × RX/TX, all nodes.</p>
        <div className="h-80 w-full">
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
  );
}
