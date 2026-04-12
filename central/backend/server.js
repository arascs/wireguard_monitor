const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');
const { loadNodes, saveNodes, nodeIdFor } = require('./state');
const { createPoller } = require('./poller');
const { fetchLogs } = require('./clickhouseLogs');
const {
  ensureCredentials,
  generateToken,
  verifyLogin,
  authMiddleware
} = require('./centralAuth');

ensureCredentials();

function usageFromMetrics(m) {
  let memUsedPct = null;
  let diskUsedPct = null;
  if (m && m.memTotal > 0 && m.memAvail != null) {
    memUsedPct = ((m.memTotal - m.memAvail) / m.memTotal) * 100;
  }
  if (m && m.fsSizeRoot > 0 && m.fsAvailRoot != null) {
    diskUsedPct = ((m.fsSizeRoot - m.fsAvailRoot) / m.fsSizeRoot) * 100;
  }
  return { memUsedPct, diskUsedPct };
}

const PORT = process.env.PORT || 4001;
const SHARED_SECRET = process.env.CENTRAL_SHARED_SECRET || '';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const GEO_DISABLED = process.env.GEO_LOOKUP === '0';

let nodes = loadNodes();
const geoCache = new Map();
const latestByNode = new Map();
let trafficSeries = [];
let lastPollSec = Math.floor(Date.now() / 1000);

function normalizeBaseUrl(u) {
  return u.replace(/\/+$/, '');
}

async function geoForIp(ip) {
  if (!ip || GEO_DISABLED) return null;
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,lat,lon`,
      { timeout: 5000 }
    );
    const j = await r.json();
    if (j.status === 'success') {
      const g = { country: j.country, countryCode: j.countryCode, lat: j.lat, lon: j.lon };
      geoCache.set(ip, g);
      return g;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function onSnapshot(results) {
  const now = Math.floor(Date.now() / 1000);
  const dt = Math.max(1, now - lastPollSec);
  lastPollSec = now;

  for (const r of results) {
    latestByNode.set(r.nodeId, { ...r, polledAt: now, pollDt: dt });
  }

  let clientRx = 0;
  let clientTx = 0;
  let siteRx = 0;
  let siteTx = 0;
  for (const r of results) {
    if (r.traffic) {
      clientRx += r.traffic.clientRx;
      clientTx += r.traffic.clientTx;
      siteRx += r.traffic.siteRx;
      siteTx += r.traffic.siteTx;
    }
  }
  trafficSeries.push({ t: now, clientRx, clientTx, siteRx, siteTx });
  if (trafficSeries.length > 200) trafficSeries.shift();
}

const poller = createPoller({
  getNodes: () => nodes,
  onSnapshot
});

const DIST = path.join(__dirname, '../frontend/dist');
const INDEX_HTML = path.join(DIST, 'index.html');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.post('/api/login', async (req, res) => {
  try {
    const ok = await verifyLogin(req.body && req.body.username, req.body && req.body.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken(req.body.username);
    res.json({ token, expiresIn: 3600 });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/register', async (req, res) => {
  if (!SHARED_SECRET) {
    return res.status(503).json({ ok: false, error: 'CENTRAL_SHARED_SECRET not configured' });
  }
  if (req.body.secret !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const name = String(req.body.name || '').trim() || 'node';
  const baseUrl = normalizeBaseUrl(String(req.body.baseUrl || '').trim());
  if (!baseUrl) {
    return res.status(400).json({ ok: false, error: 'baseUrl required' });
  }
  const id = nodeIdFor(baseUrl);
  const idx = nodes.findIndex((n) => n.id === id);
  const bodyIp = req.body.publicIp !== undefined && req.body.publicIp !== null
    ? String(req.body.publicIp).trim()
    : '';
  const publicIp = bodyIp || (idx >= 0 && nodes[idx].publicIp) || null;
  let geo = null;
  if (publicIp) geo = await geoForIp(publicIp);
  const row = {
    id,
    name,
    baseUrl,
    publicIp,
    region: geo ? geo.country : (idx >= 0 ? nodes[idx].region : '') || '',
    lat: geo ? geo.lat : (idx >= 0 ? nodes[idx].lat : null),
    lon: geo ? geo.lon : (idx >= 0 ? nodes[idx].lon : null)
  };
  if (idx >= 0) nodes[idx] = { ...nodes[idx], ...row };
  else nodes.push(row);
  saveNodes(nodes);
  res.json({ ok: true, id });
});

app.get('/api/nodes', authMiddleware, async (req, res) => {
  const enriched = [];
  for (const n of nodes) {
    let geo = null;
    if (n.publicIp) geo = await geoForIp(n.publicIp);
    const lat = n.lat != null ? n.lat : geo && geo.lat;
    const lon = n.lon != null ? n.lon : geo && geo.lon;
    const region = n.region || (geo && geo.country) || '';
    const snap = latestByNode.get(n.id);
    const m = snap && snap.metrics;
    const dt = (snap && snap.pollDt) || POLL_MS / 1000;
    const bps = snap ? snap.bandwidthDelta / dt : 0;
    const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
    enriched.push({
      id: n.id,
      name: n.name,
      baseUrl: n.baseUrl,
      publicIp: n.publicIp,
      region,
      lat,
      lon,
      online: snap ? snap.online : false,
      cpuPct: snap && snap.cpuPct != null ? snap.cpuPct : null,
      memUsedPct,
      diskUsedPct,
      bandwidthBps: bps,
      peers: snap ? snap.peers : null,
      memTotal: m && m.memTotal,
      memAvail: m && m.memAvail
    });
  }
  res.json({ nodes: enriched });
});

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const list = [];
  let online = 0;
  let alerts24h = 0;
  for (const n of nodes) {
    let geo = null;
    if (n.publicIp) geo = await geoForIp(n.publicIp);
    const lat = n.lat != null ? n.lat : geo && geo.lat;
    const lon = n.lon != null ? n.lon : geo && geo.lon;
    const region = n.region || (geo && geo.country) || '';
    const snap = latestByNode.get(n.id);
    const m = snap && snap.metrics;
    const dt = (snap && snap.pollDt) || POLL_MS / 1000;
    const bps = snap ? snap.bandwidthDelta / dt : 0;
    if (snap && snap.online) online += 1;
    if (snap && snap.alerts24h != null) alerts24h += snap.alerts24h;
    const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
    list.push({
      id: n.id,
      name: n.name,
      baseUrl: n.baseUrl,
      publicIp: n.publicIp,
      region,
      lat,
      lon,
      online: snap ? snap.online : false,
      cpuPct: snap && snap.cpuPct != null ? snap.cpuPct : null,
      memUsedPct,
      diskUsedPct,
      bandwidthBps: bps,
      peers: snap ? snap.peers : null,
      memTotal: m && m.memTotal,
      memAvail: m && m.memAvail
    });
  }
  res.json({
    totals: {
      nodes: nodes.length,
      online,
      alerts24h
    },
    trafficSeries,
    nodes: list,
    pollIntervalSec: POLL_MS / 1000
  });
});

app.get('/api/alerts', authMiddleware, async (req, res) => {
  try {
    const out = await fetchLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'CH_DISABLED') {
      return res.status(503).json({ ok: false, error: e.message });
    }
    console.error('[api/alerts]', e.message);
    res.status(503).json({
      ok: false,
      error: e.message || 'ClickHouse unavailable. Check CLICKHOUSE_URL (HTTP port 8123) and service status.'
    });
  }
});

if (fs.existsSync(INDEX_HTML)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(INDEX_HTML);
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(503)
      .type('html')
      .send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Central</title></head><body style="font-family:sans-serif;padding:1.5rem">' +
          '<p><strong>UI not built.</strong></p>' +
          '<p>Run:</p>' +
          '<pre style="background:#f4f4f5;padding:12px;border-radius:8px">cd central/frontend && npm install && npm run build</pre>' +
          '<p>Restart the backend. APIs remain at <code>/api/*</code>.</p>' +
          '</body></html>'
      );
  });
}

setInterval(() => {
  poller.tick().catch(() => {});
}, POLL_MS);

poller.tick().catch(() => {});

app.listen(PORT, () => {
  const ui = fs.existsSync(INDEX_HTML) ? ' + UI' : ' (API only — build frontend for UI)';
  console.log(`Central http://127.0.0.1:${PORT}${ui}`);
});
