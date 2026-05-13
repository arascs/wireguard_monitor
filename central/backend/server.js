require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const https = require('https');

const {
  loadNodes,
  saveNodes,
  nodeIdFor,
  generateApiKey
} = require('./state');
const { createPoller } = require('./poller');
const {
  fetchLogs,
  insertOperationLog,
  fetchOperationLogs,
  upsertDeviceRow,
  deleteDeviceRow,
  deleteAllDeviceRowsForMachine,
  fetchDistinctBaseUrlsForMachine,
  fetchDevicesAggregated,
  insertWireguardLogs,
  countAlertsLast24h
} = require('./clickhouseLogs');
const {
  ensureCredentials,
  SESSION_SECRET,
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME,
  verifyLogin,
  authMiddleware
} = require('./centralAuth');
const { parseMetrics } = require('./parseMetrics');
const { adminIpGuard, corsMiddleware, loginLimiter } = require('./security');

ensureCredentials();

const PORT = parseInt(process.env.PORT || '4001', 10);
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const GEO_DISABLED = process.env.GEO_LOOKUP === '0';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '/usr/local/share/ca-certificates/key.pem';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '/usr/local/share/ca-certificates/cert.pem';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let nodes = loadNodes();
const geoCache = new Map();
const latestByNode = new Map();
const lastHealthOkByNode = new Map();
const notifyCooldownKeys = new Map();
let trafficSeries = [];
let lastPollSec = Math.floor(Date.now() / 1000);

const ALERTS_CACHE_TTL_MS = 60 * 1000;
const alerts24hCache = { value: 0, at: 0 };

async function getAlerts24h() {
  const now = Date.now();
  if (now - alerts24hCache.at < ALERTS_CACHE_TTL_MS) return alerts24hCache.value;
  try {
    const v = await countAlertsLast24h();
    alerts24hCache.value = v;
    alerts24hCache.at = now;
    return v;
  } catch (e) {
    console.error('[alerts24h]', e.message);
    return alerts24hCache.value;
  }
}
const prevMetrics = new Map();

const NOTIFY_LABELS = {
  ingest: 'NEW ALERTS',
  node_offline: 'Node offline',
  high_resource: 'High resource usage',
  service_offline: 'Services offline',
  node_connection_error: 'Node connection error'
};

const notificationState = { items: [], lastReadTs: 0, maxItems: 500 };

// ── helpers ──────────────────────────────────────────────────────────

function pushNotification(type, { nodeName = '', nodeId = '', detail = '' }) {
  const title = type === 'ingest' ? 'NEW ALERTS' : NOTIFY_LABELS[type] || type;
  const detailOut = type === 'ingest' ? '' : detail;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  notificationState.items.unshift({ id, type, title, detail: detailOut, nodeName, nodeId, ts: Date.now() });
  if (notificationState.items.length > notificationState.maxItems) {
    notificationState.items.length = notificationState.maxItems;
  }
  if (['node_offline', 'high_resource', 'service_offline', 'node_connection_error'].includes(type)) {
    insertOperationLog({ alertType: type, nodeId, nodeName, detail: detailOut });
  }
}

function canNotify(key, minMs) {
  const now = Date.now();
  const last = notifyCooldownKeys.get(key) || 0;
  if (now - last < minMs) return false;
  notifyCooldownKeys.set(key, now);
  return true;
}

function clearNotifyKey(key) {
  notifyCooldownKeys.delete(key);
}

function getUnreadCount() {
  return notificationState.items.filter((i) => i.ts > notificationState.lastReadTs).length;
}

function normalizeBaseUrl(u) {
  const trimmed = String(u || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
  return `https://${trimmed}`;
}

function endpointHost(endpoint) {
  const s = String(endpoint || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    const idx = s.indexOf(']');
    return idx > 1 ? s.slice(1, idx) : '';
  }
  const idx = s.lastIndexOf(':');
  return idx > 0 ? s.slice(0, idx) : s;
}

const ipOnly = endpointHost;

function publicNode(row) {
  return {
    name: row.name || '',
    machineId: row.machineId || '',
    baseUrl: row.baseUrl || '',
    createdAt: row.createdAt || null,
    lastSeenAt: row.lastSeenAt || null
  };
}

function findNodeByApiKey(plain) {
  if (!plain) return null;
  return nodes.find((n) => n.apiKey === plain) || null;
}

function apiKeyAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || '';
  if (!provided) return res.status(401).json({ ok: false, error: 'missing api key' });
  const row = findNodeByApiKey(provided);
  if (!row) return res.status(401).json({ ok: false, error: 'invalid api key' });
  req.nodeKey = row;
  next();
}

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

function buildSiteTopology() {
  const ipToNode = new Map();
  for (const n of nodes) {
    const ip = ipOnly(n.publicIp);
    if (ip) ipToNode.set(ip, n);
  }
  const pairs = new Map();
  for (const n of nodes) {
    const snap = latestByNode.get(n.id);
    if (!snap || !snap.online) continue;
    const onlineSites = Array.isArray(snap.onlineSites) ? snap.onlineSites : [];
    for (const endpoint of onlineSites) {
      const remoteHost = endpointHost(endpoint);
      if (!remoteHost) continue;
      const remoteNode = ipToNode.get(remoteHost);
      if (!remoteNode || remoteNode.id === n.id) continue;
      const key = [n.id, remoteNode.id].sort().join('__');
      let pair = pairs.get(key);
      if (!pair) {
        pair = { source: n.id, target: remoteNode.id, hasAtoB: false, hasBtoA: false };
        pairs.set(key, pair);
      }
      if (pair.source === n.id) pair.hasAtoB = true;
      else pair.hasBtoA = true;
    }
  }
  const links = [];
  for (const p of pairs.values()) {
    if (p.hasAtoB && p.hasBtoA) links.push({ source: p.source, target: p.target });
  }
  return links;
}

function countIncomingAlerts(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.events)) return payload.events.length;
  if (payload && payload.event) return 1;
  if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) return 1;
  return 0;
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

/** Compute traffic delta + threshold notifications from a fresh metrics push. */
function applyMetricsSnapshot(nodeId, m) {
  const now = Math.floor(Date.now() / 1000);
  const dt = Math.max(1, now - lastPollSec);
  lastPollSec = now;

  const p = prevMetrics.get(nodeId) || {};
  const d = (a, b) => (a !== undefined && b !== undefined ? Math.max(0, a - b) : 0);

  const traffic = {
    clientRx: d(m.trafficRxClient, p.trafficRxClient),
    clientTx: d(m.trafficTxClient, p.trafficTxClient),
    siteRx: d(m.trafficRxSite, p.trafficRxSite),
    siteTx: d(m.trafficTxSite, p.trafficTxSite)
  };

  let cpuPct;
  const modes = ['user', 'nice', 'system', 'idle'];
  let sumD = 0;
  let busyD = 0;
  for (const mode of modes) {
    const cur = m.cpu && m.cpu[mode];
    const pr = p.cpu && p.cpu[mode];
    if (cur !== undefined && pr !== undefined) {
      const delta = cur - pr;
      sumD += delta;
      if (mode !== 'idle') busyD += delta;
    }
  }
  if (sumD > 0) cpuPct = (busyD / sumD) * 100;

  const clientsTotal = m.peersClient ?? null;
  const sitesTotal = m.peersSite ?? null;
  const clientsOnline = m.peersOnlineClient ?? null;
  const sitesOnline = m.peersOnlineSite ?? null;
  const peersTotal =
    clientsTotal != null || sitesTotal != null
      ? (clientsTotal || 0) + (sitesTotal || 0)
      : null;
  const peersOnline =
    m.peersOnlineTotal != null
      ? m.peersOnlineTotal
      : clientsOnline != null && sitesOnline != null
        ? clientsOnline + sitesOnline
        : null;
  const bandwidthDelta = traffic.clientRx + traffic.clientTx + traffic.siteRx + traffic.siteTx;

  prevMetrics.set(nodeId, {
    trafficRxClient: m.trafficRxClient,
    trafficTxClient: m.trafficTxClient,
    trafficRxSite: m.trafficRxSite,
    trafficTxSite: m.trafficTxSite,
    cpu: m.cpu ? { ...m.cpu } : {}
  });

  const snap = {
    nodeId,
    online: lastHealthOkByNode.has(nodeId),
    metrics: m,
    cpuPct,
    peers: peersTotal,
    peersOnline,
    peersTotal,
    clientsOnline,
    clientsTotal,
    sitesOnline,
    sitesTotal,
    sites: Array.isArray(m.sites) ? m.sites : [],
    onlineSites: Array.isArray(m.onlineSites) ? m.onlineSites : [],
    services: m.services || {},
    bandwidthDelta,
    traffic,
    pushedAt: now,
    pollDt: dt
  };
  latestByNode.set(nodeId, snap);

  trafficSeries.push({
    t: now,
    clientRx: traffic.clientRx,
    clientTx: traffic.clientTx,
    siteRx: traffic.siteRx,
    siteTx: traffic.siteTx
  });
  if (trafficSeries.length > 200) trafficSeries.shift();

  // resource / service threshold checks
  const cooldownMs = 5 * 60 * 1000;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const name = node.name || node.id;
  const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
  const hi =
    (cpuPct != null && cpuPct >= 90) ||
    (memUsedPct != null && memUsedPct >= 90) ||
    (diskUsedPct != null && diskUsedPct >= 90);
  if (hi) {
    const parts = [];
    if (cpuPct != null && cpuPct >= 90) parts.push(`CPU ${cpuPct.toFixed(0)}%`);
    if (memUsedPct != null && memUsedPct >= 90) parts.push(`RAM ${memUsedPct.toFixed(0)}%`);
    if (diskUsedPct != null && diskUsedPct >= 90) parts.push(`Disk ${diskUsedPct.toFixed(0)}%`);
    if (canNotify(`hi:${node.id}`, cooldownMs)) {
      pushNotification('high_resource', { nodeId: node.id, nodeName: name, detail: parts.join(', ') });
    }
  } else {
    clearNotifyKey(`hi:${node.id}`);
  }

  if (snap.online) {
    const ps = m.peersSite;
    const os = m.peersOnlineSite;
    if (ps != null && ps > 0 && os != null && os < ps) {
      if (canNotify(`siteconn:${node.id}`, cooldownMs)) {
        pushNotification('node_connection_error', {
          nodeId: node.id,
          nodeName: name,
          detail: 'Site-to-site connection offline'
        });
      }
    } else {
      clearNotifyKey(`siteconn:${node.id}`);
    }
  } else {
    clearNotifyKey(`siteconn:${node.id}`);
  }

  const svcs = m.services || {};
  const bad = Object.keys(svcs).filter((k) => svcs[k] === 0);
  if (bad.length) {
    if (canNotify(`svc:${node.id}`, cooldownMs)) {
      pushNotification('service_offline', { nodeId: node.id, nodeName: name, detail: `Inactive: ${bad.join(', ')}` });
    }
  } else {
    clearNotifyKey(`svc:${node.id}`);
  }
}

/** Health-only callback from the poller. */
function onHealthResults(results) {
  const now = Math.floor(Date.now() / 1000);
  for (const r of results) {
    const snap = latestByNode.get(r.nodeId) || { nodeId: r.nodeId };
    snap.online = r.online;
    latestByNode.set(r.nodeId, snap);
    if (r.online) {
      lastHealthOkByNode.set(r.nodeId, now);
      clearNotifyKey(`offline:${r.nodeId}`);
    }
  }

  const cooldownMs = 5 * 60 * 1000;
  for (const n of nodes) {
    const lastOk = lastHealthOkByNode.get(n.id);
    if (lastOk != null && now - lastOk > 300) {
      if (canNotify(`offline:${n.id}`, cooldownMs)) {
        pushNotification('node_offline', {
          nodeId: n.id,
          nodeName: n.name || n.id,
          detail: `No successful /health for over 5 minutes (last ok: ${new Date(lastOk * 1000).toISOString()})`
        });
      }
    }
  }
}

const poller = createPoller({ getNodes: () => nodes, onHealth: onHealthResults });

// ── express app ──────────────────────────────────────────────────────

const DIST = path.join(__dirname, '../frontend/dist');
const INDEX_HTML = path.join(DIST, 'index.html');

const app = express();
app.set('trust proxy', true);
app.use(corsMiddleware());
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '512kb' }));
app.use(session({
  name: COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS
  }
}));

// ── auth ─────────────────────────────────────────────────────────────

app.post('/api/login', loginLimiter('central'), async (req, res) => {
  try {
    const ok = await verifyLogin(req.body && req.body.username, req.body && req.body.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.user = req.body.username;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });
});

// ── node-facing endpoints (single API key) ───────────────────────────

app.post('/api/register', apiKeyAuth, async (req, res) => {
  const machineId = String(req.body.machineId || req.body.nodeMachineId || '').trim();
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });

  const node = req.nodeKey;
  if (node.machineId && node.machineId !== machineId) {
    return res.status(409).json({ ok: false, error: 'api key already bound to another machine' });
  }

  const name = String(req.body.name || node.name || '').trim() || 'node';
  const baseUrl = normalizeBaseUrl(String(req.body.baseUrl || '').trim());
  if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl required' });

  const id = nodeIdFor(baseUrl);
  const bodyIp = req.body.publicIp != null ? String(req.body.publicIp).trim() : '';
  const publicIp = bodyIp || node.publicIp || null;
  let geo = null;
  if (publicIp) geo = await geoForIp(publicIp);

  node.id = id;
  node.name = name;
  node.machineId = machineId;
  node.baseUrl = baseUrl;
  node.publicIp = publicIp;
  node.region = geo ? geo.country : node.region || '';
  node.lat = geo ? geo.lat : node.lat || null;
  node.lon = geo ? geo.lon : node.lon || null;
  node.lastSeenAt = new Date().toISOString();

  saveNodes(nodes);
  res.json({ ok: true, id });
});

app.post('/api/metrics/push', apiKeyAuth, (req, res) => {
  const node = req.nodeKey;
  if (!node.machineId) return res.status(409).json({ ok: false, error: 'node not registered yet' });
  if (!node.id) return res.status(404).json({ ok: false, error: 'node not found' });

  let m;
  if (typeof req.body === 'string') {
    m = parseMetrics(req.body);
  } else if (req.body && typeof req.body === 'object') {
    m = req.body.metrics ? req.body.metrics : req.body;
  } else {
    return res.status(400).json({ ok: false, error: 'empty payload' });
  }
  if (!m || typeof m !== 'object') return res.status(400).json({ ok: false, error: 'invalid metrics' });
  applyMetricsSnapshot(node.id, m);
  node.lastSeenAt = new Date().toISOString();
  saveNodes(nodes);
  res.json({ ok: true });
});

app.post('/api/notifications/ingest', apiKeyAuth, (req, res) => {
  const count = countIncomingAlerts(req.body);
  if (count <= 0) return res.status(400).json({ ok: false, error: 'empty payload' });
  pushNotification('ingest', { detail: '' });
  res.json({ ok: true, added: count, unread: getUnreadCount() });
});

app.post('/api/logs/push', apiKeyAuth, async (req, res) => {
  const node = req.nodeKey;
  if (!node.machineId) return res.status(409).json({ ok: false, error: 'node not registered yet' });
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const cleaned = incoming
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const ts = raw.timestamp || raw.ingest_timestamp || new Date().toISOString();
      return {
        timestamp: String(ts).replace('T', ' ').replace('Z', ''),
        origin_host: String(raw.origin_host || node.machineId || 'unknown'),
        event_type: String(raw.event_name || raw.event_type || 'general'),
        message: String(raw.message || ''),
        data: JSON.stringify(raw)
      };
    })
    .filter(Boolean);
  if (cleaned.length === 0) return res.status(400).json({ ok: false, error: 'empty payload' });
  try {
    await insertWireguardLogs(cleaned);
    pushNotification('ingest', { detail: '' });
    res.json({ ok: true, inserted: cleaned.length, unread: getUnreadCount() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable' });
  }
});

const admin = [adminIpGuard, authMiddleware];

app.get('/api/notifications/unread', admin, (req, res) => {
  const unread = getUnreadCount();
  const items = notificationState.items.slice(0, 100);
  const byType = {};
  for (const i of notificationState.items) {
    if (i.ts > notificationState.lastReadTs) byType[i.type] = (byType[i.type] || 0) + 1;
  }
  res.json({ ok: true, unread, items, byType });
});

app.post('/api/notifications/mark-read', admin, (req, res) => {
  notificationState.items = [];
  notificationState.lastReadTs = Date.now();
  res.json({ ok: true, unread: 0 });
});

app.get('/api/nodes', admin, async (req, res) => {
  const enriched = [];
  for (const n of nodes) {
    if (!n.id) continue;
    let geo = null;
    if (n.publicIp) geo = await geoForIp(n.publicIp);
    const lat = n.lat != null ? n.lat : geo && geo.lat;
    const lon = n.lon != null ? n.lon : geo && geo.lon;
    const region = n.region || (geo && geo.country) || '';
    const snap = latestByNode.get(n.id);
    const m = snap && snap.metrics;
    const dt = (snap && snap.pollDt) || POLL_MS / 1000;
    const bps = snap && snap.bandwidthDelta != null ? snap.bandwidthDelta / dt : 0;
    const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
    const lastOk = lastHealthOkByNode.get(n.id);
    enriched.push({
      id: n.id,
      name: n.name,
      machineId: n.machineId || '',
      baseUrl: n.baseUrl,
      publicIp: n.publicIp,
      region,
      lat,
      lon,
      online: snap ? !!snap.online : false,
      cpuPct: snap && snap.cpuPct != null ? snap.cpuPct : null,
      memUsedPct,
      diskUsedPct,
      bandwidthBps: bps,
      peers: snap ? snap.peers : null,
      peersOnline: snap && snap.peersOnline != null ? snap.peersOnline : null,
      peersTotal: snap && snap.peersTotal != null ? snap.peersTotal : snap ? snap.peers : null,
      clientsOnline: snap && snap.clientsOnline != null ? snap.clientsOnline : null,
      clientsTotal: snap && snap.clientsTotal != null ? snap.clientsTotal : null,
      sitesOnline: snap && snap.sitesOnline != null ? snap.sitesOnline : null,
      sitesTotal: snap && snap.sitesTotal != null ? snap.sitesTotal : null,
      sites: snap && Array.isArray(snap.sites) ? snap.sites : [],
      onlineSites: snap && Array.isArray(snap.onlineSites) ? snap.onlineSites : [],
      services: snap && snap.services ? snap.services : {},
      lastHealthOkAt: lastOk != null ? lastOk : null,
      memTotal: m && m.memTotal,
      memAvail: m && m.memAvail,
      hasApiKey: !!n.apiKey
    });
  }
  res.json({ nodes: enriched });
});

app.get('/api/node-keys', admin, (req, res) => {
  res.json({ ok: true, rows: nodes.filter((n) => !n.id).map(publicNode) });
});

app.post('/api/node-keys', admin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || 'node';
  const apiKey = generateApiKey();
  const row = {
    name,
    apiKey,
    machineId: '',
    baseUrl: '',
    createdAt: new Date().toISOString(),
    lastSeenAt: null
  };
  nodes.unshift(row);
  saveNodes(nodes);
  res.json({ ok: true, row: publicNode(row), apiKey });
});

app.post('/api/nodes/:id/rotate', admin, (req, res) => {
  const node = nodes.find((n) => n.id === req.params.id);
  if (!node) return res.status(404).json({ ok: false, error: 'not found' });
  const apiKey = generateApiKey();
  node.apiKey = apiKey;
  saveNodes(nodes);
  res.json({ ok: true, apiKey });
});

app.delete('/api/node-keys/:name', admin, (req, res) => {
  const idx = nodes.findIndex((n) => !n.id && n.name === req.params.name);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });
  nodes.splice(idx, 1);
  saveNodes(nodes);
  res.json({ ok: true });
});

app.get('/api/dashboard', admin, async (req, res) => {
  const list = [];
  let online = 0;
  for (const n of nodes) {
    let geo = null;
    if (n.publicIp) geo = await geoForIp(n.publicIp);
    const lat = n.lat != null ? n.lat : geo && geo.lat;
    const lon = n.lon != null ? n.lon : geo && geo.lon;
    const region = n.region || (geo && geo.country) || '';
    const snap = latestByNode.get(n.id);
    const m = snap && snap.metrics;
    const dt = (snap && snap.pollDt) || POLL_MS / 1000;
    const bps = snap && snap.bandwidthDelta != null ? snap.bandwidthDelta / dt : 0;
    if (snap && snap.online) online += 1;
    const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
    const lastOk = lastHealthOkByNode.get(n.id);
    list.push({
      id: n.id,
      name: n.name,
      baseUrl: n.baseUrl,
      publicIp: n.publicIp,
      region,
      lat,
      lon,
      online: snap ? !!snap.online : false,
      cpuPct: snap && snap.cpuPct != null ? snap.cpuPct : null,
      memUsedPct,
      diskUsedPct,
      bandwidthBps: bps,
      peers: snap ? snap.peers : null,
      peersOnline: snap && snap.peersOnline != null ? snap.peersOnline : null,
      peersTotal: snap && snap.peersTotal != null ? snap.peersTotal : snap ? snap.peers : null,
      clientsOnline: snap && snap.clientsOnline != null ? snap.clientsOnline : null,
      clientsTotal: snap && snap.clientsTotal != null ? snap.clientsTotal : null,
      sitesOnline: snap && snap.sitesOnline != null ? snap.sitesOnline : null,
      sitesTotal: snap && snap.sitesTotal != null ? snap.sitesTotal : null,
      sites: snap && Array.isArray(snap.sites) ? snap.sites : [],
      onlineSites: snap && Array.isArray(snap.onlineSites) ? snap.onlineSites : [],
      services: snap && snap.services ? snap.services : {},
      lastHealthOkAt: lastOk != null ? lastOk : null,
      memTotal: m && m.memTotal,
      memAvail: m && m.memAvail
    });
  }
  const alerts24h = await getAlerts24h();
  res.json({
    totals: { nodes: nodes.length, online, alerts24h },
    trafficSeries,
    nodes: list,
    siteLinks: buildSiteTopology(),
    pollIntervalSec: POLL_MS / 1000
  });
});

app.delete('/api/nodes/:id', admin, async (req, res) => {
  const nodeId = String(req.params.id || '').trim();
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Node not found' });

  const targetNode = nodes[idx];
  const snap = latestByNode.get(nodeId);
  const siteEndpoints = Array.isArray(snap && snap.sites) ? snap.sites : [];
  const warnings = [];

  // Site cleanup callback: still uses legacy CENTRAL_SHARED_SECRET for now.
  const SHARED_SECRET = process.env.CENTRAL_SHARED_SECRET || '';
  if (SHARED_SECRET) {
    const peerBases = new Set();
    for (const endpoint of siteEndpoints) {
      const host = ipOnly(endpoint);
      if (!host) continue;
      const peerNode = nodes.find((n) => ipOnly(n.publicIp) === host);
      if (!peerNode || !peerNode.baseUrl || peerNode.id === nodeId) continue;
      peerBases.add(normalizeBaseUrl(peerNode.baseUrl));
    }
    for (const base of peerBases) {
      try {
        const r = await fetch(`${base}/api/sites/by-endpoint`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Register-Key': SHARED_SECRET },
          body: JSON.stringify({ endpoint: targetNode.publicIp }),
          agent: base.startsWith('https') ? httpsAgent : undefined
        });
        if (!r.ok) {
          const txt = await r.text();
          warnings.push(`${base}: ${r.status} ${txt.slice(0, 120)}`);
        }
      } catch (e) {
        warnings.push(`${base}: ${e.message}`);
      }
    }
  }

  nodes.splice(idx, 1);
  saveNodes(nodes);
  latestByNode.delete(nodeId);
  lastHealthOkByNode.delete(nodeId);
  prevMetrics.delete(nodeId);
  res.json({ ok: true, warnings });
});

app.get('/api/alerts', admin, async (req, res) => {
  try {
    const out = await fetchLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'CH_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable.' });
  }
});

app.get('/api/operation-logs', admin, async (req, res) => {
  try {
    const out = await fetchOperationLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'CH_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable.' });
  }
});

// Device registry sync (still uses legacy CENTRAL_SHARED_SECRET for now).
app.post('/api/devices/sync', async (req, res) => {
  const SHARED_SECRET = process.env.CENTRAL_SHARED_SECRET || '';
  const key = (req.header('x-register-key') || '').trim();
  if (!SHARED_SECRET || key !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const b = req.body || {};
  const required = ['machine_id', 'device_name', 'public_key', 'interface', 'node_id', 'node_name', 'base_url'];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || String(b[k]).trim() === '') {
      return res.status(400).json({ ok: false, error: `missing ${k}` });
    }
  }
  try {
    await upsertDeviceRow({
      machine_id: String(b.machine_id).trim(),
      device_name: String(b.device_name).trim(),
      public_key: String(b.public_key).trim(),
      interface: String(b.interface).trim(),
      node_id: String(b.node_id).trim(),
      node_name: String(b.node_name).trim(),
      base_url: normalizeBaseUrl(String(b.base_url).trim())
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/devices/unsync', async (req, res) => {
  const SHARED_SECRET = process.env.CENTRAL_SHARED_SECRET || '';
  const key = (req.header('x-register-key') || '').trim();
  if (!SHARED_SECRET || key !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const machine_id = req.body && req.body.machine_id != null ? String(req.body.machine_id).trim() : '';
  const node_id = req.body && req.body.node_id != null ? String(req.body.node_id).trim() : '';
  if (!machine_id || !node_id) return res.status(400).json({ ok: false, error: 'machine_id and node_id required' });
  try {
    await deleteDeviceRow(machine_id, node_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/registry/devices', admin, async (req, res) => {
  try {
    const rows = await fetchDevicesAggregated();
    res.json({ ok: true, devices: rows });
  } catch (e) {
    if (e.code === 'CH_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable.' });
  }
});

app.delete('/api/registry/devices/:machineId', admin, async (req, res) => {
  const SHARED_SECRET = process.env.CENTRAL_SHARED_SECRET || '';
  const machineId = decodeURIComponent(String(req.params.machineId || '').trim());
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
  let bases = [];
  try {
    bases = await fetchDistinctBaseUrlsForMachine(machineId);
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  }
  const warnings = [];
  if (SHARED_SECRET) {
    for (const base of bases) {
      const u = normalizeBaseUrl(base);
      if (!u) continue;
      const p = `/api/devices/by-machine/${encodeURIComponent(machineId)}`;
      try {
        const r = await fetch(`${u}${p}`, {
          method: 'DELETE',
          headers: { 'X-Register-Key': SHARED_SECRET },
          agent: u.startsWith('https') ? httpsAgent : undefined
        });
        if (!r.ok) {
          const txt = await r.text();
          warnings.push(`${u}: ${r.status} ${txt.slice(0, 120)}`);
        }
      } catch (e) {
        warnings.push(`${u}: ${e.message}`);
      }
    }
  }
  try {
    await deleteAllDeviceRowsForMachine(machineId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true, warnings });
});

// ── static UI ────────────────────────────────────────────────────────

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
        '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1.5rem">' +
          '<p><strong>UI not built.</strong></p>' +
          '<pre>cd central/frontend && npm install && npm run build</pre>' +
          '</body></html>'
      );
  });
}

setInterval(() => {
  poller.tick().catch(() => {});
}, POLL_MS);
poller.tick().catch(() => {});

const httpsOptions = {
  key: fs.readFileSync(TLS_KEY_PATH),
  cert: fs.readFileSync(TLS_CERT_PATH)
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`Central HTTPS server listening on :${PORT}`);
});
