require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const https = require('https');

const { generateApiKey } = require('./state');
const {
  fetchAllNodes,
  insertNode,
  updateNodeMetadata,
  deleteNodeByMachineId,
  hashApiKey,
  verifyApiKey,
} = require('./mysqlNodes');
const {
  fetchLogs,
  insertOperationLog,
  fetchOperationLogs,
  syncDevicesForNode,
  fetchDevicesAggregated,
  insertWireguardLogs,
  countAlertsLast24h
} = require('./mysqlLogs');
const {
  SESSION_SECRET,
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME
} = require('./centralAuth');
const { setup: setupAdminAccounts, authWrapper, mountAdminsRoutes, authenticateAdmin } = require('./modules/admin-accounts');
const bcrypt = require('bcrypt');
const { parseMetrics } = require('./parseMetrics');
const { adminIpGuard, corsMiddleware, loginLimiter } = require('./security');
const { logAction, getLogs } = require('./auditLogger');

const PORT = parseInt(process.env.PORT || '4001', 10);
const OFFLINE_CHECK_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const OFFLINE_AFTER_SEC = 300;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '/usr/local/share/ca-certificates/key.pem';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '/usr/local/share/ca-certificates/cert.pem';

let nodes = [];
const latestByNode = new Map();
const lastPushAtByNode = new Map();
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

function sessionAdmin(req) {
  return (req.session && req.session.user) ? req.session.user : 'unknown';
}

function touchNodePush(machineId) {
  const now = Math.floor(Date.now() / 1000);
  lastPushAtByNode.set(machineId, now);
  clearNotifyKey(`offline:${machineId}`);
}

function isNodeOnline(machineId) {
  const last = lastPushAtByNode.get(machineId);
  if (!last) return false;
  return Math.floor(Date.now() / 1000) - last <= OFFLINE_AFTER_SEC;
}

function checkOfflineNodes() {
  const now = Math.floor(Date.now() / 1000);
  const cooldownMs = 5 * 60 * 1000;
  for (const n of nodes) {
    const last = lastPushAtByNode.get(n.machineId);
    if (last == null || now - last > OFFLINE_AFTER_SEC) {
      if (last != null && canNotify(`offline:${n.machineId}`, cooldownMs)) {
        pushNotification('node_offline', {
          nodeId: n.machineId,
          nodeName: n.name || n.machineId,
          detail: `No push received for over 5 minutes (last: ${new Date(last * 1000).toISOString()})`
        });
      }
    }
  }
}

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
    createdAt: row.createdAt || null
  };
}

function requestNodeUuid(req) {
  const fromHeader = String(req.header('x-node-uuid') || '').trim();
  const fromBody = String(req.body?.machineId || req.body?.nodeMachineId || '').trim();
  const raw = fromHeader || fromBody;
  return raw ? raw.toLowerCase() : '';
}

async function apiKeyAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return res.status(401).json({ ok: false, error: 'missing api key' });

  const uuid = requestNodeUuid(req);
  if (!uuid) return res.status(401).json({ ok: false, error: 'missing node uuid' });

  const row = nodes.find((n) => n.machineId === uuid);
  if (!row) return res.status(401).json({ ok: false, error: 'invalid api key' });

  try {
    const ok = await verifyApiKey(bearer, row.apiKeyHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid api key' });
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid api key' });
  }

  req.nodeKey = row;
  next();
}

async function applyNodeMetadataFromRequest(req) {
  const node = req.nodeKey;
  if (!node) return;

  const publicIp = String(
    req.header('x-node-public-ip') ||
    req.body?.publicIp ||
    req.body?.public_ip ||
    ''
  ).trim();
  const baseUrlRaw = String(
    req.header('x-node-base-url') ||
    req.body?.baseUrl ||
    req.body?.base_url ||
    ''
  ).trim();
  const baseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : '';

  if (!publicIp && !baseUrl) return;

  try {
    const updated = await updateNodeMetadata(node.machineId, {
      ...(publicIp ? { publicIp } : {}),
      ...(baseUrl ? { baseUrl } : {})
    });
    if (updated) {
      node.publicIp = updated.publicIp;
      node.baseUrl = updated.baseUrl;
    }
  } catch (e) {
    console.error('[node metadata]', e.message);
  }
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
    if (!isNodeOnline(n.machineId)) continue;
    const snap = latestByNode.get(n.machineId);
    if (!snap) continue;
    const onlineSites = Array.isArray(snap.onlineSites) ? snap.onlineSites : [];
    for (const endpoint of onlineSites) {
      const remoteHost = endpointHost(endpoint);
      if (!remoteHost) continue;
      const remoteNode = ipToNode.get(remoteHost);
      if (!remoteNode || remoteNode.machineId === n.machineId) continue;
      const key = [n.machineId, remoteNode.machineId].sort().join('__');
      let pair = pairs.get(key);
      if (!pair) {
        pair = { source: n.machineId, target: remoteNode.machineId, hasAtoB: false, hasBtoA: false };
        pairs.set(key, pair);
      }
      if (pair.source === n.machineId) pair.hasAtoB = true;
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
  const node = nodes.find((n) => n.machineId === nodeId);
  if (!node) return;
  const name = node.name || node.machineId;
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
    if (canNotify(`hi:${node.machineId}`, cooldownMs)) {
      pushNotification('high_resource', { nodeId: node.machineId, nodeName: name, detail: parts.join(', ') });
    }
  } else {
    clearNotifyKey(`hi:${node.machineId}`);
  }

  if (isNodeOnline(nodeId)) {
    const ps = m.peersSite;
    const os = m.peersOnlineSite;
    if (ps != null && ps > 0 && os != null && os < ps) {
      if (canNotify(`siteconn:${node.machineId}`, cooldownMs)) {
        pushNotification('node_connection_error', {
          nodeId: node.machineId,
          nodeName: name,
          detail: 'Site-to-site connection offline'
        });
      }
    } else {
      clearNotifyKey(`siteconn:${node.machineId}`);
    }
  } else {
    clearNotifyKey(`siteconn:${node.machineId}`);
  }

  const svcs = m.services || {};
  const bad = Object.keys(svcs).filter((k) => svcs[k] === 0);
  if (bad.length) {
    if (canNotify(`svc:${node.machineId}`, cooldownMs)) {
      pushNotification('service_offline', { nodeId: node.machineId, nodeName: name, detail: `Inactive: ${bad.join(', ')}` });
    }
  } else {
    clearNotifyKey(`svc:${node.machineId}`);
  }
}

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
    const username = req.body && req.body.username;
    const password = req.body && req.body.password;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await authenticateAdmin(username, password, bcrypt);
    if (result.error) {
      return res.status(result.status || 401).json({ error: result.error });
    }
    req.session.adminId = result.admin.id;
    req.session.user = result.admin.username;
    req.session.role = result.admin.role;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Login failed' });
  }
});

app.get('/api/me', authWrapper, (req, res) => {
  res.json({
    ok: true,
    admin: {
      username: req.session.user,
      role: req.session.role
    }
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });
});

// ── node-facing endpoints (single API key) ───────────────────────────

app.post('/api/metrics/push', apiKeyAuth, async (req, res) => {
  const node = req.nodeKey;
  await applyNodeMetadataFromRequest(req);
  let m;
  if (typeof req.body === 'string') {
    m = parseMetrics(req.body);
  } else if (req.body && typeof req.body === 'object') {
    m = req.body.metrics ? req.body.metrics : req.body;
  } else {
    return res.status(400).json({ ok: false, error: 'empty payload' });
  }
  if (!m || typeof m !== 'object') return res.status(400).json({ ok: false, error: 'invalid metrics' });
  touchNodePush(node.machineId);
  applyMetricsSnapshot(node.machineId, m);
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
  await applyNodeMetadataFromRequest(req);
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
    touchNodePush(node.machineId);
    pushNotification('ingest', { detail: '' });
    res.json({ ok: true, inserted: cleaned.length, unread: getUnreadCount() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable' });
  }
});

const admin = [adminIpGuard, authWrapper];

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

function enrichNodeRow(n) {
  const snap = latestByNode.get(n.machineId);
  const m = snap && snap.metrics;
  const dt = (snap && snap.pollDt) || OFFLINE_CHECK_MS / 1000;
  const bps = snap && snap.bandwidthDelta != null ? snap.bandwidthDelta / dt : 0;
  const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
  const lastSeen = lastPushAtByNode.get(n.machineId);
  const online = isNodeOnline(n.machineId);
  return {
    machineId: n.machineId,
    name: n.name,
    baseUrl: n.baseUrl,
    publicIp: n.publicIp,
    online,
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
    lastSeenAt: lastSeen != null ? lastSeen : null,
    memTotal: m && m.memTotal,
    memAvail: m && m.memAvail
  };
}

app.get('/api/nodes', admin, (req, res) => {
  res.json({ nodes: nodes.map(enrichNodeRow) });
});

app.post('/api/node-keys', admin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const machineId = String((req.body && req.body.machineId) || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
    if (nodes.some((n) => n.machineId === machineId)) {
      return res.status(409).json({ ok: false, error: 'machineId already used' });
    }
    const apiKey = generateApiKey();
    const apiKeyHash = await hashApiKey(apiKey);
    const row = await insertNode({ name, machineId, apiKeyHash });
    nodes.unshift(row);
    logAction(sessionAdmin(req), 'add_node', { name, machineId });
    res.json({ ok: true, row: publicNode(row), apiKey });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable' });
  }
});

app.delete('/api/nodes/:machineId', admin, async (req, res) => {
  try {
    const machineId = String(req.params.machineId || '').trim().toLowerCase();
    const idx = nodes.findIndex((n) => n.machineId === machineId);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });
    const removed = nodes[idx];
    await deleteNodeByMachineId(machineId);
    nodes.splice(idx, 1);
    latestByNode.delete(machineId);
    lastPushAtByNode.delete(machineId);
    logAction(sessionAdmin(req), 'delete_node', {
      name: removed.name,
      machineId: removed.machineId
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable' });
  }
});

app.get('/api/dashboard', admin, async (req, res) => {
  const list = nodes.map(enrichNodeRow);
  let online = 0;
  for (const n of list) {
    if (n.online) online += 1;
  }
  const alerts24h = await getAlerts24h();
  res.json({
    totals: { nodes: nodes.length, online, alerts24h },
    trafficSeries,
    nodes: list,
    siteLinks: buildSiteTopology()
  });
});

app.get('/api/alerts', admin, async (req, res) => {
  try {
    const out = await fetchLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'DB_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable.' });
  }
});

app.get('/api/operation-logs', admin, async (req, res) => {
  try {
    const out = await fetchOperationLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'DB_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable.' });
  }
});

app.get('/api/audit-logs', admin, (req, res) => {
  try {
    const logs = getLogs().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ ok: true, logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'cannot read audit logs' });
  }
});

app.post('/api/devices/sync-batch', apiKeyAuth, async (req, res) => {
  const node = req.nodeKey;
  await applyNodeMetadataFromRequest(req);

  const b = req.body || {};
  const node_id = String(b.node_id || b.machine_id || '').trim().toLowerCase();
  if (!node_id) return res.status(400).json({ ok: false, error: 'missing node_id' });
  if (node_id !== node.machineId) {
    return res.status(400).json({ ok: false, error: 'node_id mismatch' });
  }

  const node_name = String(b.node_name || node.name || '').trim();
  const base_url = normalizeBaseUrl(String(b.base_url || node.baseUrl || '').trim());
  if (!base_url) return res.status(400).json({ ok: false, error: 'missing base_url' });

  const devices = Array.isArray(b.devices) ? b.devices : [];
  try {
    const synced = await syncDevicesForNode(
      { node_id, node_name, base_url },
      devices
    );
    res.json({ ok: true, synced });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/registry/devices', admin, async (req, res) => {
  try {
    const rows = await fetchDevicesAggregated();
    res.json({ ok: true, devices: rows });
  } catch (e) {
    if (e.code === 'DB_DISABLED') return res.status(503).json({ ok: false, error: e.message });
    res.status(503).json({ ok: false, error: e.message || 'Database unavailable.' });
  }
});

mountAdminsRoutes(app);

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

setInterval(checkOfflineNodes, OFFLINE_CHECK_MS);

const httpsOptions = {
  key: fs.readFileSync(TLS_KEY_PATH),
  cert: fs.readFileSync(TLS_CERT_PATH)
};

setupAdminAccounts()
  .then(() => fetchAllNodes())
  .then((rows) => {
    nodes = rows;
    https.createServer(httpsOptions, app).listen(PORT, () => {
      console.log(`Central HTTPS server listening on :${PORT}`);
    });
  })
  .catch((e) => {
    console.error('[startup]', e);
    process.exit(1);
  });
