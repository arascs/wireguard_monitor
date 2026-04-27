const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');
const https = require('https');
const { loadNodes, saveNodes, loadNodeKeys, saveNodeKeys, nodeIdFor } = require('./state');
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
  insertWireguardLogs
} = require('./clickhouseLogs');
const {
  ensureCredentials,
  generateToken,
  verifyLogin,
  authMiddleware
} = require('./centralAuth');

ensureCredentials();

const options = {
  key: fs.readFileSync('/usr/local/share/ca-certificates/key.pem'),
  cert: fs.readFileSync('/usr/local/share/ca-certificates/cert.pem')
};

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
const ALERT_INGEST_KEY = process.env.ALERT_INGEST_KEY || '';
const BASHRC_FILE = path.join(process.env.HOME || '/root', '.bashrc');

let nodes = loadNodes();
let nodeKeys = loadNodeKeys();
const geoCache = new Map();
const latestByNode = new Map();
const lastHealthOkByNode = new Map();
const notifyCooldownKeys = new Map();
let trafficSeries = [];
let lastPollSec = Math.floor(Date.now() / 1000);

const NOTIFY_LABELS = {
  ingest: 'NEW ALERTS',
  node_offline: 'Node offline',
  high_resource: 'High resource usage',
  service_offline: 'Services offline',
  node_connection_error: 'Node connection error'
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.CENTRAL_NODE_TLS_INSECURE !== '1'
});

const notificationState = {
  items: [],
  lastReadTs: 0,
  maxItems: 500
};

function pushNotification(type, { nodeName = '', nodeId = '', detail = '' }) {
  const title = type === 'ingest' ? 'NEW ALERTS' : NOTIFY_LABELS[type] || type;
  const detailOut = type === 'ingest' ? '' : detail;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  notificationState.items.unshift({
    id,
    type,
    title,
    detail: detailOut,
    nodeName,
    nodeId,
    ts: Date.now()
  });
  if (notificationState.items.length > notificationState.maxItems) {
    notificationState.items.length = notificationState.maxItems;
  }
  if (
    type === 'node_offline' ||
    type === 'high_resource' ||
    type === 'service_offline' ||
    type === 'node_connection_error'
  ) {
    insertOperationLog({
      alertType: type,
      nodeId,
      nodeName,
      detail: detailOut
    });
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

function randomApiKey(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

function stripKeyMeta(row) {
  if (!row) return null;
  return {
    registerKey: row.registerKey || '',
    pushKey: row.pushKey || '',
    pullKey: row.pullKey || '',
    machineId: row.machineId || '',
    usedAt: row.usedAt || null,
    updatedAt: row.updatedAt || null
  };
}

function findNodeKeyByRegisterKey(key) {
  return nodeKeys.find((k) => k.registerKey === key) || null;
}

function findNodeKeyByPushKey(key) {
  return nodeKeys.find((k) => k.pushKey === key) || null;
}

function findNodeKeyByMachineId(machineId) {
  return nodeKeys.find((k) => k.machineId === machineId) || null;
}

function isValidRegisterKey(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  if (SHARED_SECRET && k === SHARED_SECRET) return true;
  const row = findNodeKeyByRegisterKey(k);
  return Boolean(row);
}

function upsertBashrcEnv(updates) {
  const old = fs.existsSync(BASHRC_FILE) ? fs.readFileSync(BASHRC_FILE, 'utf8') : '';
  let lines = old.split('\n');
  for (const [k, v] of Object.entries(updates)) {
    const esc = String(v || '').replace(/"/g, '\\"');
    const exportLine = `export ${k}="${esc}"`;
    const idx = lines.findIndex((ln) => new RegExp(`^\\s*export\\s+${k}=`).test(ln));
    if (idx >= 0) lines[idx] = exportLine;
    else lines.push(exportLine);
    process.env[k] = String(v || '');
  }
  fs.writeFileSync(BASHRC_FILE, lines.join('\n'), 'utf8');
}

function endpointHost(endpoint) {
  const s = String(endpoint || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    const idx = s.indexOf(']');
    return idx > 1 ? s.slice(1, idx) : '';
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0) return s.slice(0, idx);
  return s;
}

function ipOnly(value) {
  return endpointHost(value);
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
    if (p.hasAtoB && p.hasBtoA) {
      links.push({ source: p.source, target: p.target });
    }
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

function onSnapshot(results) {
  const now = Math.floor(Date.now() / 1000);
  const dt = Math.max(1, now - lastPollSec);
  lastPollSec = now;

  for (const r of results) {
    if (r.online) {
      lastHealthOkByNode.set(r.nodeId, now);
      clearNotifyKey(`offline:${r.nodeId}`);
    }
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

  const cooldownMs = 5 * 60 * 1000;
  for (const n of nodes) {
    const snap = latestByNode.get(n.id);
    if (!snap) continue;
    const name = n.name || n.id;
    const lastOk = lastHealthOkByNode.get(n.id);

    if (lastOk != null && now - lastOk > 300) {
      if (canNotify(`offline:${n.id}`, cooldownMs)) {
        pushNotification('node_offline', {
          nodeId: n.id,
          nodeName: name,
          detail: `No successful /health for over 5 minutes (last ok: ${new Date(lastOk * 1000).toISOString()})`
        });
      }
    }

    const m = snap.metrics;
    if (!m) continue;

    const { memUsedPct, diskUsedPct } = usageFromMetrics(m);
    const cpu = snap.cpuPct;
    const hi =
      (cpu != null && cpu >= 90) ||
      (memUsedPct != null && memUsedPct >= 90) ||
      (diskUsedPct != null && diskUsedPct >= 90);
    if (hi) {
      const parts = [];
      if (cpu != null && cpu >= 90) parts.push(`CPU ${cpu.toFixed(0)}%`);
      if (memUsedPct != null && memUsedPct >= 90) parts.push(`RAM ${memUsedPct.toFixed(0)}%`);
      if (diskUsedPct != null && diskUsedPct >= 90) parts.push(`Disk ${diskUsedPct.toFixed(0)}%`);
      if (canNotify(`hi:${n.id}`, cooldownMs)) {
        pushNotification('high_resource', {
          nodeId: n.id,
          nodeName: name,
          detail: parts.join(', ')
        });
      }
    } else {
      clearNotifyKey(`hi:${n.id}`);
    }

    if (snap.online) {
      const ps = m.peersSite;
      const os = m.peersOnlineSite;
      if (ps != null && ps > 0 && os != null && os < ps) {
        if (canNotify(`siteconn:${n.id}`, cooldownMs)) {
          pushNotification('node_connection_error', {
            nodeId: n.id,
            nodeName: name,
            detail: 'Site-to-site connection offline'
          });
        }
      } else {
        clearNotifyKey(`siteconn:${n.id}`);
      }
    } else {
      clearNotifyKey(`siteconn:${n.id}`);
    }

    const svcs = m.services || {};
    const bad = Object.keys(svcs).filter((k) => svcs[k] === 0);
    if (bad.length) {
      if (canNotify(`svc:${n.id}`, cooldownMs)) {
        pushNotification('service_offline', {
          nodeId: n.id,
          nodeName: name,
          detail: `Inactive: ${bad.join(', ')}`
        });
      }
    } else {
      clearNotifyKey(`svc:${n.id}`);
    }
  }
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
  const registerKey = String(req.body.registerKey || req.body.secret || '').trim();
  const machineId = String(req.body.machineId || req.body.nodeMachineId || '').trim();
  if (!registerKey || !machineId) {
    return res.status(400).json({ ok: false, error: 'registerKey and machineId required' });
  }
  const keyRow = findNodeKeyByRegisterKey(registerKey);
  if (!keyRow) {
    if (SHARED_SECRET && registerKey === SHARED_SECRET) {
      return res.status(409).json({
        ok: false,
        error:
          'Legacy CENTRAL_SHARED_SECRET is no longer accepted for new nodes. Create node keys from the Nodes tab.'
      });
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (keyRow.machineId && keyRow.machineId !== machineId) {
    return res.status(409).json({ ok: false, error: 'registerKey already used' });
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
    machineId,
    baseUrl,
    publicIp,
    region: geo ? geo.country : (idx >= 0 ? nodes[idx].region : '') || '',
    lat: geo ? geo.lat : (idx >= 0 ? nodes[idx].lat : null),
    lon: geo ? geo.lon : (idx >= 0 ? nodes[idx].lon : null)
  };
  if (idx >= 0) nodes[idx] = { ...nodes[idx], ...row };
  else nodes.push(row);
  keyRow.machineId = machineId;
  keyRow.usedAt = keyRow.usedAt || new Date().toISOString();
  keyRow.updatedAt = new Date().toISOString();
  saveNodes(nodes);
  saveNodeKeys(nodeKeys);
  res.json({ ok: true, id, apiKeys: stripKeyMeta(keyRow) });
});

app.post('/api/notifications/ingest', (req, res) => {
  const providedKey = (req.header('x-alert-key') || '').trim();
  if (ALERT_INGEST_KEY && providedKey !== ALERT_INGEST_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const count = countIncomingAlerts(req.body);
  if (count <= 0) {
    return res.status(400).json({ ok: false, error: 'empty payload' });
  }

  pushNotification('ingest', { detail: '' });
  res.json({ ok: true, added: count, unread: getUnreadCount() });
});

app.post('/api/logs/push', async (req, res) => {
  const providedKey = String(req.header('x-push-api-key') || req.header('x-api-key') || '').trim();
  if (!providedKey) {
    return res.status(401).json({ ok: false, error: 'missing push key' });
  }
  const keyRow = findNodeKeyByPushKey(providedKey);
  if (!keyRow || !keyRow.machineId) {
    return res.status(401).json({ ok: false, error: 'invalid push key' });
  }

  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const cleaned = incoming
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const nowIso = new Date().toISOString();
      const ts = raw.timestamp || raw.ingest_timestamp || nowIso;
      const eventType = String(raw.event_name || raw.event_type || 'general');
      const msg = String(raw.message || '');
      return {
        timestamp: String(ts).replace('T', ' ').replace('Z', ''),
        origin_host: String(raw.origin_host || keyRow.machineId || 'unknown'),
        event_type: eventType,
        message: msg,
        data: JSON.stringify(raw)
      };
    })
    .filter(Boolean);

  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty payload' });
  }
  try {
    await insertWireguardLogs(cleaned);
    pushNotification('ingest', { detail: '' });
    res.json({ ok: true, inserted: cleaned.length, unread: getUnreadCount() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable' });
  }
});

app.get('/api/notifications/unread', authMiddleware, (req, res) => {
  const unread = getUnreadCount();
  const items = notificationState.items.slice(0, 100);
  const byType = {};
  for (const i of notificationState.items) {
    if (i.ts > notificationState.lastReadTs) {
      byType[i.type] = (byType[i.type] || 0) + 1;
    }
  }
  res.json({
    ok: true,
    unread,
    items,
    byType
  });
});

app.post('/api/notifications/mark-read', authMiddleware, (req, res) => {
  notificationState.items = [];
  notificationState.lastReadTs = Date.now();
  res.json({ ok: true, unread: 0 });
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
    const lastOk = lastHealthOkByNode.get(n.id);
    const nodeKey = findNodeKeyByMachineId(n.machineId || n.name || '');
    enriched.push({
      id: n.id,
      name: n.name,
      machineId: n.machineId || '',
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
      apiKeys: stripKeyMeta(nodeKey)
    });
  }
  res.json({ nodes: enriched });
});

app.get('/api/node-keys', authMiddleware, (req, res) => {
  const rows = nodeKeys.map((row) => ({
    machineId: row.machineId || '',
    updatedAt: row.updatedAt || null,
    usedAt: row.usedAt || null,
    apiKeys: stripKeyMeta(row)
  }));
  res.json({ ok: true, rows });
});

app.post('/api/node-keys', authMiddleware, (req, res) => {
  const body = req.body || {};
  const registerKey =
    body.registerKey && String(body.registerKey).trim()
      ? String(body.registerKey).trim()
      : randomApiKey('reg');
  const pushKey =
    body.pushKey && String(body.pushKey).trim() ? String(body.pushKey).trim() : randomApiKey('push');
  const pullKey =
    body.pullKey && String(body.pullKey).trim() ? String(body.pullKey).trim() : randomApiKey('pull');
  const machineId = body.machineId ? String(body.machineId).trim() : '';
  const row = {
    registerKey,
    pushKey,
    pullKey,
    machineId,
    usedAt: machineId ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString()
  };
  const oldIdx = nodeKeys.findIndex((k) => k.registerKey === registerKey);
  if (oldIdx >= 0) {
    if (nodeKeys[oldIdx].machineId && nodeKeys[oldIdx].machineId !== machineId) {
      return res.status(409).json({ ok: false, error: 'registerKey already in use' });
    }
    nodeKeys[oldIdx] = row;
  } else {
    nodeKeys.unshift(row);
  }
  upsertBashrcEnv({
    CENTRAL_REGISTER_SECRET: row.registerKey,
    CENTRAL_PUSH_API_KEY: row.pushKey,
    CENTRAL_PULL_API_KEY: row.pullKey
  });
  saveNodeKeys(nodeKeys);
  res.json({ ok: true, row: stripKeyMeta(row) });
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
    const lastOk = lastHealthOkByNode.get(n.id);
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
  res.json({
    totals: {
      nodes: nodes.length,
      online,
      alerts24h
    },
    trafficSeries,
    nodes: list,
    siteLinks: buildSiteTopology(),
    pollIntervalSec: POLL_MS / 1000
  });
});

app.delete('/api/nodes/:id', authMiddleware, async (req, res) => {
  if (!SHARED_SECRET) {
    return res.status(503).json({ ok: false, error: 'CENTRAL_SHARED_SECRET not configured' });
  }
  const nodeId = String(req.params.id || '').trim();
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) {
    return res.status(404).json({ ok: false, error: 'Node not found' });
  }
  const targetNode = nodes[idx];
  const snap = latestByNode.get(nodeId);
  const siteEndpoints = Array.isArray(snap && snap.sites) ? snap.sites : [];
  const warnings = [];

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
        headers: {
          'Content-Type': 'application/json',
          'X-Register-Key': SHARED_SECRET
        },
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

  nodes.splice(idx, 1);
  saveNodes(nodes);
  latestByNode.delete(nodeId);
  lastHealthOkByNode.delete(nodeId);

  res.json({ ok: true, warnings });
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

app.get('/api/operation-logs', authMiddleware, async (req, res) => {
  try {
    const out = await fetchOperationLogs(req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'CH_DISABLED') {
      return res.status(503).json({ ok: false, error: e.message });
    }
    console.error('[api/operation-logs]', e.message);
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable.' });
  }
});

app.post('/api/devices/sync', async (req, res) => {
  const key = (req.header('x-register-key') || '').trim();
  if (!isValidRegisterKey(key)) {
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
    console.error('[api/devices/sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/devices/unsync', async (req, res) => {
  const key = (req.header('x-register-key') || '').trim();
  if (!isValidRegisterKey(key)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const machine_id = req.body && req.body.machine_id != null ? String(req.body.machine_id).trim() : '';
  const node_id = req.body && req.body.node_id != null ? String(req.body.node_id).trim() : '';
  if (!machine_id || !node_id) {
    return res.status(400).json({ ok: false, error: 'machine_id and node_id required' });
  }
  try {
    await deleteDeviceRow(machine_id, node_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[api/devices/unsync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/registry/devices', authMiddleware, async (req, res) => {
  try {
    const rows = await fetchDevicesAggregated();
    res.json({ ok: true, devices: rows });
  } catch (e) {
    if (e.code === 'CH_DISABLED') {
      return res.status(503).json({ ok: false, error: e.message });
    }
    console.error('[api/registry/devices]', e.message);
    res.status(503).json({ ok: false, error: e.message || 'ClickHouse unavailable.' });
  }
});

app.delete('/api/registry/devices/:machineId', authMiddleware, async (req, res) => {
  if (!SHARED_SECRET) {
    return res.status(503).json({ ok: false, error: 'CENTRAL_SHARED_SECRET not configured' });
  }
  const machineId = decodeURIComponent(String(req.params.machineId || '').trim());
  if (!machineId) {
    return res.status(400).json({ ok: false, error: 'machineId required' });
  }
  let bases = [];
  try {
    bases = await fetchDistinctBaseUrlsForMachine(machineId);
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  }
  const warnings = [];
  for (const base of bases) {
    const u = normalizeBaseUrl(base);
    if (!u) continue;
    const path = `/api/devices/by-machine/${encodeURIComponent(machineId)}`;
    try {
      const r = await fetch(`${u}${path}`, {
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
  try {
    await deleteAllDeviceRowsForMachine(machineId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true, warnings });
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

// app.listen(PORT, () => {
//   const ui = fs.existsSync(INDEX_HTML) ? ' + UI' : ' (API only — build frontend for UI)';
//   console.log(`Central http://127.0.0.1:${PORT}${ui}`);
// });

https.createServer(options, app).listen(PORT, () => {
  //const ui = fs.existsSync(INDEX_HTML) ? ' + UI' : ' (API only — build frontend for UI)';
  console.log('HTTPS Server đang chạy tại https://160.250.65.230:4000');
});