#!/usr/bin/env node

require('dotenv').config();

const { accessLogStream } = require('./lib/logging');

const express = require('express');
const morgan = require('morgan');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const session = require('express-session');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const dashboardRoutes = require('./routes/dashboard');
const createUserRoutes = require('./routes/users');
const createDeviceRoutes = require('./routes/devices');
const createApplicationRoutes = require('./routes/applications');
const createAccessRuleRoutes = require('./routes/accessRules');
const createAuthRoutes = require('./routes/auth');
const createSessionLogRoutes = require('./routes/sessionLogs');
const createBackupRoutes = require('./routes/backups');
const createMainDashboardRoutes = require('./routes/main_dashboard');
const { HOSTNAME } = require('./config');
const mysql = require('mysql2/promise');
const { logAction, logSecurityEvent, getLogs, getSecurityEvents } = require('./auditLogger');
const { touch: redisHeartbeatTouch } = require('./deviceHeartbeat');
const { run, tryRun } = require('./runCmd');
const {
  collectSecurityPolicyIssues,
  formatIssues,
  normalizeSettings,
  isUserExpired
} = require('./lib/securityChecks');
const {
  CONFIG_DIR,
  loadInterfaceConfig,
  saveInterfaceConfig,
  isKeyExpired: isInterfaceKeyExpired,
  findPeer,
  findPeerIndex,
  wgSyncconfIfRunning,
  sanitizeInterfaceName,
  buildClientVpnRouteAllowedIPs
} = require('./lib/wireguardConfig');
const {
  corsMiddleware,
  loginLimiter,
  isAdminIp,
  clientIp
} = require('./security');
const { getApiKey, authHeaders, httpsAgent: centralAgent, pushDevicesToCentral } = require('./centralSync');

const dbConfig = {
  host: process.env.WG_DB_HOST || 'localhost',
  user: process.env.WG_DB_USER || 'root',
  password: process.env.WG_DB_PASSWORD || 'root',
  database: process.env.WG_DB_NAME || 'wg_monitor'
};

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required (set it in .env)');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('[FATAL] SESSION_SECRET is required (set it in .env)');
  process.exit(1);
}

function apiKeyAuth(req, res, next) {
  const expected = (process.env.NODE_API_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ success: false, error: 'node not provisioned' });
  }
  const auth = req.header('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || '';
  if (!provided) {
    return res.status(401).json({ success: false, error: 'missing api key' });
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'invalid api key' });
  }
  next();
}

const notificationState = {
  total: 0,
  readTotal: 0,
  latestAt: null
};

function countIncomingAlerts(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.events)) return payload.events.length;
  if (payload && payload.event) return 1;
  if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) return 1;
  return 0;
}

function getUnreadAlerts() {
  return Math.max(0, notificationState.total - notificationState.readTotal);
}

// helper to verify token and attach user info
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ success: false, error: 'Malformed Authorization header' });
  }
  const token = parts[1];
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    req.user = payload;
    next();
  });
}

const app = express();
app.set('trust proxy', true);
const PORT = parseInt(process.env.PORT || '3000', 10);
const EXPORTER_SCRIPT = '/usr/local/bin/exporter.sh';

app.use(corsMiddleware());

const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '/usr/local/share/ca-certificates/key.pem';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '/usr/local/share/ca-certificates/cert.pem';

/** Run a binary via execFile with stdin (used for `wg pubkey`). */
function wgPubkey(privateKey) {
  const r = spawnSync('wg', ['pubkey'], { input: privateKey, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'wg pubkey failed');
  return r.stdout.trim();
}

/** `wg syncconf <iface> <(wg-quick strip <iface>)` without invoking a shell. */
function wgSyncconf(iface) {
  let stripOutput;
  try {
    stripOutput = execFileSync('wg-quick', ['strip', iface], { encoding: 'utf8' });
  } catch (e) {
    console.error(`[wgSyncconf] wg-quick strip error for ${iface}:`, e.stderr || e.message);
    throw new Error(e.stderr || e.message || `wg-quick strip ${iface} failed`);
  }

  const tmpFile = path.join('/etc/wireguard/', `.tmp-sync-${iface}.conf`);

  fs.writeFileSync(tmpFile, stripOutput, {
    mode: 0o600
  });

  try {
    execFileSync('wg', ['syncconf', iface, tmpFile], { encoding: 'utf8' });
  } catch (e) {
    console.error(`[wgSyncconf] wg syncconf error for ${iface} using file ${tmpFile}:`, e.stderr || e.message);
    throw new Error(e.stderr || e.message || `wg syncconf ${iface} failed`);
  } finally {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  }
}

app.get('/metrics', (req, res) => {
  if (!isAdminIp(req)) {
    return res.status(403).type('text/plain').send('forbidden');
  }
  try {
    const out = run('bash', [EXPORTER_SCRIPT], { timeout: 120000 });
    res.type('text/plain; version=0.0.4').send(out);
  } catch (e) {
    res.status(500).type('text/plain').send(`# exporter error: ${e.message || e}\n`);
  }
});

// Local WireGuard availability (wg show). Returns "ok" if wg responds.
app.get('/health', (req, res) => {
  const r = tryRun('wg', ['show']);
  const ok = r.status === 0;
  res.status(ok ? 200 : 503).type('text/plain').send(ok ? 'ok' : 'fail');
});

app.use(morgan('combined', { stream: accessLogStream() }));

const FRONTEND_DIR = path.join(__dirname, '../frontend');
const CREDENTIALS_FILE = '/etc/wireguard/credentials.txt';

// backup directory for stored archives
const BACKUP_DIR = '/var/backups/wg_monitor';
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const DEFAULT_KEY_EXPIRY_DAYS = 90;

// Global settings
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadGlobalSettings() {
  const defaultSettings = {
    peerDisableHours: 12,
    physicalInterface: '',
    enforceKernelCheck: true,
    minKernelVersionLinux: 4,
    minKernelVersionWindows: 10,
    enforceFirewallLinux: true,
    enforceFirewallWindows: true,
    enforcePasswordRequiredLinux: true,
    enforcePasswordRequiredWindows: true
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return normalizeSettings({ ...defaultSettings, ...JSON.parse(data) });
    }
  } catch (e) {
    console.error('Error loading settings:', e.message);
  }
  return defaultSettings;
}

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 3600000
  }
}));

const ADMIN_BYPASS_PATHS = new Set([
  '/api/admin-login',
  '/api/login',
  '/api/logout',
  '/api/connect-vpn',
  '/api/disconnect-vpn',
  '/api/device-heartbeat',
  '/api/check-device-enroll',
  '/api/enroll-device',
  '/api/update-key',
  '/api/notifications/ingest',
  '/api/sites/by-endpoint',
  '/api/hostname'
]);

function pathAllowsBypass(p) {
  if (ADMIN_BYPASS_PATHS.has(p)) return true;
  if (p.startsWith('/api/devices/by-machine/')) return true;
  return false;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (pathAllowsBypass(req.path)) return next();
  if (!isAdminIp(req)) {
    return res.status(403).json({ success: false, error: 'forbidden network' });
  }
  if (req.session && req.session.user) return next();
  return res.status(401).json({ success: false, error: 'Authentication required' });
});

function getRemainingDays(config) {
  if (!config.interface.keyCreationDate) return null;
  const creationDate = new Date(config.interface.keyCreationDate);
  const expiryDate = new Date(creationDate);
  expiryDate.setDate(expiryDate.getDate() + config.interface.keyExpiryDays);
  const diffTime = expiryDate - new Date();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

async function checkAndDisconnectIfExpired() {
  for (const iface of listInterfaces()) {
    const config = loadInterfaceConfig(iface.name, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    const remaining = getRemainingDays(config);
    if (remaining !== null && remaining <= 3) {
      logSecurityEvent({
        event_name: 'interface_expire',
        interface: iface.name,
        remaining_days: remaining
      });
    }
    if (!isInterfaceKeyExpired(config)) continue;
    try {
      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(iface.name)) {
        run('wg-quick', ['down', iface.name]);
        console.log(`[INFO] VPN ${iface.name} disconnected due to expired key`);
      }
    } catch (e) {
      console.error('Error disconnecting VPN:', e.message);
    }
  }
}

function secretStringsMatch(stored, presented) {
  const a = String(stored || '');
  const b = String(presented || '');
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function hydrateRotationKeysFromDb(iface, config) {
  for (const p of config.peers) {
    p.rotationKey = '';
  }
  try {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
      'SELECT site_pubkey, site_rotation_key FROM sites WHERE `interface` = ?',
      [iface]
    );
    await conn.end();
    const map = new Map(rows.map((r) => [r.site_pubkey, r.site_rotation_key != null ? String(r.site_rotation_key) : '']));
    for (const p of config.peers) {
      if (p.publicKey && map.has(p.publicKey)) {
        p.rotationKey = map.get(p.publicKey);
      }
    }
  } catch (e) {
    console.error('hydrateRotationKeysFromDb:', e.message);
  }
}

// Load credentials from file
function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    const hash = bcrypt.hashSync('admin', 10);
    fs.writeFileSync(CREDENTIALS_FILE, `admin:${hash}`, { mode: 0o600 });
  }
  const content = fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim();
  const [user, pass] = content.split(':');
  return { username: user, passwordHash: pass };
}

// Middleware to require authentication
// for page requests, redirect to login; for API endpoints, return 401 JSON
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  res.redirect('/login');
}

function getActiveInterfaces() {
  try {
    const interfacesOutput = run('wg', ['show', 'interfaces']).trim();
    if (!interfacesOutput) {
      return [];
    }
    return interfacesOutput.split(/\s+/).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function parseInterfaceSummary(filePath) {
  const summary = { publicKey: '', address: '', type: '' };
  try {
    if (!fs.existsSync(filePath)) {
      return summary;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let section = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      // Parse # Type = ... comment
      if (line.startsWith('#')) {
        const commentContent = line.substring(1).trim();
        if (commentContent.toLowerCase().startsWith('type =')) {
          const eqIdx = commentContent.indexOf('=');
          summary.type = commentContent.substring(eqIdx + 1).trim();
        }
        continue;
      }
      if (line === '[Interface]') {
        section = 'interface';
        continue;
      }
      if (line === '[Peer]') {
        break;
      }
      if (section === 'interface' && line.includes('=')) {
        const equalIndex = line.indexOf('=');
        const key = line.substring(0, equalIndex).trim().toLowerCase();
        const value = line.substring(equalIndex + 1).trim();
        if (key === 'address') {
          summary.address = value;
        } else if (key === 'publickey') {
          summary.publicKey = value;
        } else if (key === 'privatekey' && !summary.publicKey) {
          try {
            summary.publicKey = wgPubkey(value);
          } catch (error) {
            // ignore pubkey calculation errors
          }
        }
      }
    }
  } catch (error) {
    console.error('Error parsing interface summary:', error.message);
  }
  return summary;
}

function listInterfaces() {
  if (!fs.existsSync(CONFIG_DIR)) {
    return [];
  }
  const files = fs.readdirSync(CONFIG_DIR)
    .filter(file => file.endsWith('.conf'))
    .sort();
  const activeSet = new Set(getActiveInterfaces());
  return files.map(file => {
    const interfaceName = path.basename(file, '.conf');
    const summary = parseInterfaceSummary(path.join(CONFIG_DIR, file));
    return {
      name: interfaceName,
      publicKey: summary.publicKey,
      address: summary.address,
      type: summary.type || '',
      status: activeSet.has(interfaceName) ? 'connected' : 'disconnected'
    };
  });
}

// Get last 50 log lines for a specific interface from /var/log/wg_systemd.log
app.get('/api/interface-log/:interfaceName', (req, res) => {
  try {
    const interfaceName = req.params.interfaceName.replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!interfaceName) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    const LOG_FILE = '/etc/wireguard/logs/wg_systemd.log';
    let lines = '';
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const matched = content.split('\n').filter((l) => l.includes(interfaceName));
      lines = matched.slice(-50).join('\n');
    } catch (e) {
      lines = '';
    }
    res.json({ success: true, log: lines });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/interfaces/:interface/key-status', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
  res.json({
    success: true,
    expired: isInterfaceKeyExpired(config),
    remainingDays: getRemainingDays(config),
    keyCreationDate: config.interface.keyCreationDate,
    keyExpiryDays: config.interface.keyExpiryDays
  });
});

// List all interfaces found in config directory
app.get('/api/interfaces', (req, res) => {
  try {
    const interfaces = listInterfaces();
    res.json({ success: true, interfaces });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List only Client-type interfaces (for device approve dropdown)
app.get('/api/interfaces/client', (req, res) => {
  try {
    const interfaces = listInterfaces().filter(i => i.type === 'Client');
    res.json({ success: true, interfaces });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add a new interface (create conf file with Type comment + generate keys)
app.post('/api/add-interface', async (req, res) => {
  try {
    const { name, type, address, listenPort, dns, mtu, preUp, postUp, preDown, postDown, keyExpiryDays } = req.body;
    if (!String(name || '').trim()) {
      return res.status(400).json({ success: false, error: 'Interface name is required' });
    }
    if (!String(address || '').trim()) {
      return res.status(400).json({ success: false, error: 'Address is required' });
    }
    if (!String(listenPort || '').trim()) {
      return res.status(400).json({ success: false, error: 'Listen port is required' });
    }
    const interfaceType = (type === 'Site' || type === 'Client') ? type : 'Client';
    const confFile = path.join(CONFIG_DIR, `${name}.conf`);
    if (fs.existsSync(confFile)) {
      return res.status(409).json({ success: false, error: 'Interface already exists' });
    }

    // Generate keys
    const privateKey = run('wg', ['genkey']).trim();
    const publicKey = wgPubkey(privateKey);

    // Build conf content — Type comment is the very first line
    let content = `# Type = ${interfaceType}\n`;
    content += '[Interface]\n';
    content += `# Key Creation = ${new Date().toISOString()}\n`;
    const expiryDays = parseInt(keyExpiryDays, 10) || DEFAULT_KEY_EXPIRY_DAYS;
    content += `# Key Expiry Days = ${expiryDays}\n`;
    content += `PrivateKey = ${privateKey}\n`;
    content += `Address = ${String(address).trim()}\n`;
    content += `ListenPort = ${String(listenPort).trim()}\n`;
    if (dns) content += `DNS = ${dns}\n`;
    if (mtu) content += `MTU = ${mtu}\n`;
    if (preUp) content += `PreUp = ${preUp}\n`;
    if (postUp) content += `PostUp = ${postUp}\n`;
    if (preDown) content += `PreDown = ${preDown}\n`;
    if (postDown) content += `PostDown = ${postDown}\n`;

    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(confFile, content, { mode: 0o600 });

    // Audit log
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'add_interface', { interface: name, type: interfaceType, publicKey, address, keyExpiryDays: expiryDays });
    } catch (e) { }

    res.json({ success: true, name, type: interfaceType, publicKey });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete interface
app.delete('/api/delete-interface/:name', (req, res) => {
  try {
    const interfaceName = decodeURIComponent(req.params.name);
    const configFile = path.join(CONFIG_DIR, `${interfaceName}.conf`);

    if (!fs.existsSync(configFile)) {
      return res.status(404).json({ success: false, error: 'Interface config file not found' });
    }

    // Read interface info for audit log before deleting
    const ifaceSummary = parseInterfaceSummary(configFile);

    // Disconnect interface if running
    try {
      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(interfaceName)) {
        run('wg-quick', ['down', interfaceName]);
      }
    } catch (e) {
      // Interface not running, continue
    }

    // Delete config file
    fs.unlinkSync(configFile);

    // Audit log
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'delete_interface', {
        interface: interfaceName,
        publicKey: ifaceSummary.publicKey,
        address: ifaceSummary.address
      });
    } catch (e) { }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API key persistence: stored in a private file, mirrored into process.env so
// the rest of the app and outbound calls (centralSync) pick it up immediately.
const NODE_KEY_FILE = path.join(__dirname, 'node_api_key.txt');

function loadNodeApiKeyFromDisk() {
  try {
    if (fs.existsSync(NODE_KEY_FILE)) {
      const k = fs.readFileSync(NODE_KEY_FILE, 'utf8').trim();
      if (k) process.env.NODE_API_KEY = k;
    }
  } catch (e) {
    /* ignore */
  }
}

function saveNodeApiKey(plain) {
  fs.writeFileSync(NODE_KEY_FILE, String(plain || ''), { mode: 0o600 });
  process.env.NODE_API_KEY = String(plain || '');
}

loadNodeApiKeyFromDisk();

app.get('/api/settings', (req, res) => {
  try {
    const settings = loadGlobalSettings();
    settings.apiKey = process.env.NODE_API_KEY || '';
    return res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const currentSettings = loadGlobalSettings();
    const physicalInterface = req.body.physicalInterface !== undefined
      ? String(req.body.physicalInterface || '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
      : currentSettings.physicalInterface;
    const newSettings = {
      peerDisableHours: req.body.peerDisableHours ? parseInt(req.body.peerDisableHours, 10) : currentSettings.peerDisableHours,
      physicalInterface,
      enforceKernelCheck: req.body.enforceKernelCheck !== undefined ? req.body.enforceKernelCheck : currentSettings.enforceKernelCheck,
      minKernelVersionLinux: req.body.minKernelVersionLinux !== undefined
        ? parseInt(req.body.minKernelVersionLinux, 10) : currentSettings.minKernelVersionLinux,
      minKernelVersionWindows: req.body.minKernelVersionWindows !== undefined
        ? parseInt(req.body.minKernelVersionWindows, 10) : currentSettings.minKernelVersionWindows,
      enforceFirewallLinux: req.body.enforceFirewallLinux !== undefined
        ? req.body.enforceFirewallLinux : currentSettings.enforceFirewallLinux,
      enforceFirewallWindows: req.body.enforceFirewallWindows !== undefined
        ? req.body.enforceFirewallWindows : currentSettings.enforceFirewallWindows,
      enforcePasswordRequiredLinux: req.body.enforcePasswordRequiredLinux !== undefined
        ? req.body.enforcePasswordRequiredLinux : currentSettings.enforcePasswordRequiredLinux,
      enforcePasswordRequiredWindows: req.body.enforcePasswordRequiredWindows !== undefined
        ? req.body.enforcePasswordRequiredWindows : currentSettings.enforcePasswordRequiredWindows
    };

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');

    if (req.body && typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) {
      saveNodeApiKey(req.body.apiKey.trim());
    }

    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'update_settings', { ...newSettings, apiKey: '***' });
    } catch (e) { }

    res.json({
      success: true,
      settings: { ...newSettings, apiKey: process.env.NODE_API_KEY || '' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/generate-keys', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    const hasExistingKey = config.interface.privateKey && config.interface.privateKey.length > 0;
    const forceGenerate = req.body.force === true;

    if (hasExistingKey && !forceGenerate) {
      return res.json({
        success: false,
        needConfirmation: true,
        message: 'Private key đã được cấu hình, bạn có chắc bạn muốn đổi key?'
      });
    }

    const oldPrivateKey = config.interface.privateKey || '';
    const oldPublicKey = config.interface.publicKey || '';
    const newPrivateKey = run('wg', ['genkey']).trim();
    const newPublicKey = wgPubkey(newPrivateKey);

    config.interface.privateKey = newPrivateKey;
    config.interface.publicKey = newPublicKey;
    config.interface.keyCreationDate = new Date().toISOString();
    if (!config.interface.keyExpiryDays) {
      config.interface.keyExpiryDays = DEFAULT_KEY_EXPIRY_DAYS;
    }

    saveInterfaceConfig(iface, config);
    wgSyncconfIfRunning(iface);
    await hydrateRotationKeysFromDb(iface, config);

    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      if (!hasExistingKey) {
        logAction(admin, 'add_interface', {
          interface: iface,
          publicKey: newPublicKey,
          address: config.interface.address,
          listenPort: config.interface.listenPort,
          dns: config.interface.dns,
          mtu: config.interface.mtu,
          table: config.interface.table,
          preUp: config.interface.preUp,
          postUp: config.interface.postUp,
          preDown: config.interface.preDown,
          postDown: config.interface.postDown,
          keyExpiryDays: config.interface.keyExpiryDays
        });
      } else {
        logAction(admin, 'change_key_pair', {
          interface: iface,
          old_public_key: oldPublicKey,
          new_public_key: newPublicKey
        });
      }
    } catch (e) { }

    const peersSummary = config.peers.map((peer) => ({
      publicKey: peer.publicKey,
      endpoint: peer.endpoint
    }));

    for (const peer of config.peers) {
      if (!peer.endpoint) continue;
      const endpointParts = peer.endpoint.split(':');
      if (endpointParts.length !== 2) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch(`https://${endpointParts[0]}:3000/api/update-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldPublicKey,
            newPublicKey,
            rotationKey: peer.rotationKey || ''
          }),
          signal: controller.signal
        });
        let data = {};
        try {
          data = await response.json();
        } catch (_) { /* ignore */ }
        if (response.ok && data.success) {
          console.log(`[Key rotation] Successfully notified peer ${peer.endpoint}`);
        } else {
          console.error(`[Key rotation] Failed to notify peer ${peer.endpoint}:`, data.error || response.status);
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          console.error(`[Key rotation] Timeout notifying peer ${peer.endpoint}: no success response within 60s`);
        } else {
          console.error(`[Key rotation] Failed to notify peer ${peer.endpoint}:`, e.message);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    res.json({ success: true, oldPublicKey, newPublicKey, peers: peersSummary });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/configure', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    const isNew = !fs.existsSync(path.join(CONFIG_DIR, `${iface}.conf`));
    const existingType = config.interface.type;

    config.interface.address = req.body.address || '';
    config.interface.listenPort = req.body.listenPort || '51820';
    config.interface.dns = req.body.dns || '';
    config.interface.table = req.body.table || '';
    config.interface.mtu = req.body.mtu || '1420';
    config.interface.preUp = req.body.preUp || '';
    config.interface.postUp = req.body.postUp || '';
    config.interface.preDown = req.body.preDown || '';
    config.interface.postDown = req.body.postDown || '';
    if (existingType) config.interface.type = existingType;
    if (req.body.keyExpiryDays) {
      config.interface.keyExpiryDays = parseInt(req.body.keyExpiryDays, 10) || DEFAULT_KEY_EXPIRY_DAYS;
    } else if (!config.interface.keyExpiryDays) {
      config.interface.keyExpiryDays = DEFAULT_KEY_EXPIRY_DAYS;
    }

    let savedContent = null;
    if (req.body.saveToFile) {
      try {
        savedContent = saveInterfaceConfig(iface, config);
      } catch (error) {
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, error: error.message });
      }
      if (!isNew) {
        try {
          const admin = req.session && req.session.user ? req.session.user : 'unknown';
          logAction(admin, 'edit_interface', {
            interface: iface,
            publicKey: config.interface.publicKey,
            address: config.interface.address,
            listenPort: config.interface.listenPort,
            dns: config.interface.dns,
            mtu: config.interface.mtu,
            table: config.interface.table,
            preUp: config.interface.preUp,
            postUp: config.interface.postUp,
            preDown: config.interface.preDown,
            postDown: config.interface.postDown,
            keyExpiryDays: config.interface.keyExpiryDays
          });
        } catch (e) { }
      }
    }

    res.json({ success: true, config, content: savedContent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/peers', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Please generate new keys and reconfigure interface first.' });
    }
    if (!config.interface.privateKey || !config.interface.address) {
      return res.status(400).json({ success: false, error: 'Interface not configured. Please configure interface first.' });
    }
    const ifaceType = config.interface.type || '';
    if (ifaceType === 'Client') {
      return res.status(400).json({ success: false, error: 'Peer type Client can only be added by approving devices.' });
    }

    const peerName = String(req.body.name || '').trim();
    const peerPublicKey = String(req.body.publicKey || '').trim();
    const peerEndpoint = String(req.body.endpoint || '').trim();
    const peerAllowedIPs = String(req.body.allowedIPs || '').trim();
    const peerRotationKey = typeof req.body.rotationKey === 'string' ? req.body.rotationKey.trim() : '';
    if (!peerName) {
      return res.status(400).json({ success: false, error: 'Peer name is required' });
    }
    if (!peerPublicKey) {
      return res.status(400).json({ success: false, error: 'Public key is required' });
    }
    if (!peerEndpoint) {
      return res.status(400).json({ success: false, error: 'Endpoint is required' });
    }
    if (!peerAllowedIPs) {
      return res.status(400).json({ success: false, error: 'Allowed IPs is required' });
    }
    if (!peerRotationKey) {
      return res.status(400).json({ success: false, error: 'Key rotation API key is required' });
    }
    const peer = {
      name: peerName,
      publicKey: peerPublicKey,
      presharedKey: req.body.presharedKey || '',
      endpoint: peerEndpoint,
      allowedIPs: peerAllowedIPs,
      persistentKeepalive: String(req.body.persistentKeepalive || '').trim() || '25',
      rotationKey: peerRotationKey,
      enabled: true
    };
    if (req.body.generatePsk) peer.presharedKey = run('wg', ['genpsk']).trim();

    config.peers.push(peer);
    try {
      saveInterfaceConfig(iface, config);
    } catch (saveErr) {
      return res.status(saveErr.statusCode || 500).json({ success: false, error: saveErr.message });
    }

    if (ifaceType === 'Site') {
      try {
        const conn = await mysql.createConnection(dbConfig);
        await conn.execute(
          'INSERT INTO sites (site_name, site_endpoint, site_pubkey, site_allowedIPs, site_persistent_keepalive, site_rotation_key, `interface`) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            peer.name,
            peer.endpoint,
            peer.publicKey,
            peer.allowedIPs,
            peer.persistentKeepalive ? parseInt(peer.persistentKeepalive, 10) : null,
            peer.rotationKey || null,
            iface
          ]
        );
        await conn.end();
      } catch (dbErr) {
        console.error('Error saving site to DB:', dbErr.message);
      }
    }

    wgSyncconfIfRunning(iface);
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'create_peer', { peer });
    } catch (e) { }
    res.json({ success: true, peer });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/interfaces/:interface/peers/:publicKey', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  const paramKey = decodeURIComponent(req.params.publicKey || '');
  if (!iface || !paramKey) {
    return res.status(400).json({ success: false, error: 'Invalid interface or public key' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Please generate new keys first.' });
    }
    const idx = findPeerIndex(config, paramKey);
    if (idx < 0) {
      return res.status(404).json({ success: false, error: 'Peer not found' });
    }

    const peer = config.peers[idx];
    const oldPeer = { ...peer };
    peer.name = req.body.name !== undefined ? req.body.name : peer.name;
    peer.publicKey = req.body.publicKey !== undefined ? req.body.publicKey : peer.publicKey;
    peer.endpoint = req.body.endpoint !== undefined ? req.body.endpoint : peer.endpoint;
    peer.allowedIPs = req.body.allowedIPs !== undefined ? req.body.allowedIPs : peer.allowedIPs;
    peer.persistentKeepalive = req.body.persistentKeepalive !== undefined ? req.body.persistentKeepalive : peer.persistentKeepalive;
    if (req.body.rotationKey !== undefined) {
      peer.rotationKey = typeof req.body.rotationKey === 'string' ? req.body.rotationKey : '';
    }
    if (req.body.presharedKey !== undefined) peer.presharedKey = req.body.presharedKey;

    const ifaceType = config.interface.type || '';
    if (ifaceType === 'Site' && oldPeer.publicKey) {
      try {
        const conn = await mysql.createConnection(dbConfig);
        await conn.execute(
          'UPDATE sites SET site_name = ?, site_endpoint = ?, site_pubkey = ?, site_allowedIPs = ?, site_persistent_keepalive = ?, site_rotation_key = ? WHERE site_pubkey = ? AND `interface` = ?',
          [
            peer.name,
            peer.endpoint,
            peer.publicKey,
            peer.allowedIPs,
            peer.persistentKeepalive ? parseInt(peer.persistentKeepalive, 10) : null,
            peer.rotationKey || null,
            oldPeer.publicKey,
            iface
          ]
        );
        await conn.end();
      } catch (dbErr) {
        console.error('Error updating site in DB:', dbErr.message);
      }
    }

    saveInterfaceConfig(iface, config);
    wgSyncconfIfRunning(iface);

    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'edit_peer', { oldConfig: oldPeer, newConfig: peer });
    } catch (e) {
      console.error('Audit log error:', e.message);
    }

    res.json({ success: true, peer });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/interfaces/:interface/peers/:publicKey', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  const publicKey = decodeURIComponent(req.params.publicKey || '');
  if (!iface || !publicKey) {
    return res.status(400).json({ success: false, error: 'Invalid interface or public key' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Please generate new keys first.' });
    }
    if ((config.interface.type || '') === 'Client') {
      return res.status(400).json({ success: false, error: 'Peer type Client can only be deleted by removing devices.' });
    }
    const idx = findPeerIndex(config, publicKey);
    if (idx < 0) {
      return res.status(404).json({ success: false, error: 'Peer not found' });
    }
    const peer = config.peers[idx];
    config.peers.splice(idx, 1);
    saveInterfaceConfig(iface, config);

    try {
      const conn = await mysql.createConnection(dbConfig);
      await conn.execute('DELETE FROM sites WHERE site_pubkey = ?', [publicKey]);
      await conn.end();
    } catch (dbErr) {
      console.error('Error deleting site from DB:', dbErr.message);
    }

    wgSyncconfIfRunning(iface);
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'delete_peer', { peer });
    } catch (e) { }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/peers/:publicKey/enable', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  const publicKey = decodeURIComponent(req.params.publicKey || '');
  if (!iface || !publicKey) {
    return res.status(400).json({ success: false, error: 'Invalid interface or public key' });
  }
  let connection;
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Please generate new keys first.' });
    }
    const idx = findPeerIndex(config, publicKey);
    if (idx < 0) {
      return res.status(404).json({ success: false, error: 'Peer not found' });
    }
    const peer = config.peers[idx];
    if (config.interface.type && config.interface.type.toLowerCase() === 'client' && peer.publicKey) {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT status FROM devices WHERE public_key = ? LIMIT 1',
        [peer.publicKey]
      );
      if (rows.length > 0 && parseInt(rows[0].status, 10) === 0) {
        return res.status(403).json({ success: false, error: 'Device disabled' });
      }
    }
    config.peers[idx].enabled = true;
    saveInterfaceConfig(iface, config);
    wgSyncconfIfRunning(iface);
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'enable_peer', { peer: config.peers[idx] });
    } catch (e) { }
    res.json({ success: true, peer: config.peers[idx] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) {
      try { await connection.end(); } catch (e) { }
    }
  }
});

app.post('/api/interfaces/:interface/peers/:publicKey/disable', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  const publicKey = decodeURIComponent(req.params.publicKey || '');
  if (!iface || !publicKey) {
    return res.status(400).json({ success: false, error: 'Invalid interface or public key' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Please generate new keys first.' });
    }
    const idx = findPeerIndex(config, publicKey);
    if (idx < 0) {
      return res.status(404).json({ success: false, error: 'Peer not found' });
    }
    config.peers[idx].enabled = false;
    saveInterfaceConfig(iface, config);
    wgSyncconfIfRunning(iface);
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'disable_peer', { peer: config.peers[idx] });
    } catch (e) { }
    res.json({ success: true, peer: config.peers[idx] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update peer key
app.post('/api/update-key', async (req, res) => {
  try {
    const { oldPublicKey, newPublicKey, rotationKey } = req.body || {};
    if (!oldPublicKey || !newPublicKey) {
      return res.status(400).json({ success: false, error: 'Missing oldPublicKey or newPublicKey' });
    }

    // Search for peer in all interface config files
    const interfaces = listInterfaces();
    let foundInterface = null;
    let foundConfigFile = null;
    let foundContent = null;
    let foundLines = null;
    let peerStartIndex = -1;
    let peerEndIndex = -1;

    for (const iface of interfaces) {
      const configFile = path.join(CONFIG_DIR, `${iface.name}.conf`);
      if (!fs.existsSync(configFile)) continue;

      const content = fs.readFileSync(configFile, 'utf8');
      const lines = content.split('\n');
      const peerStarts = [];

      // Find all peer sections
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        const clean = raw.replace(/^#\s*/, '').trim();
        if (clean === '[Peer]') {
          peerStarts.push(i);
        }
      }

      // Check each peer section for matching public key
      for (let s = 0; s < peerStarts.length; s++) {
        const start = peerStarts[s];
        const end = (s + 1 < peerStarts.length) ? (peerStarts[s + 1] - 1) : (lines.length - 1);

        for (let i = start; i <= end; i++) {
          const clean = lines[i].replace(/^\s*#\s*/, '').trim();
          const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
          if (m && m[1].trim() === oldPublicKey) {
            foundInterface = iface.name;
            foundConfigFile = configFile;
            foundContent = content;
            foundLines = lines;
            peerStartIndex = start;
            peerEndIndex = end;
            break;
          }
        }
        if (foundInterface) break;
      }
      if (foundInterface) break;
    }

    if (!foundInterface) {
      return res.status(404).json({ success: false, error: 'Peer not found in any interface' });
    }

    let expectedRotation = '';
    try {
      const conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
        'SELECT site_rotation_key FROM sites WHERE site_pubkey = ? AND `interface` = ? LIMIT 1',
        [oldPublicKey, foundInterface]
      );
      await conn.end();
      if (rows.length && rows[0].site_rotation_key != null) {
        expectedRotation = String(rows[0].site_rotation_key);
      }
    } catch (dbErr) {
      console.error('update-key rotation lookup:', dbErr.message);
    }
    if (!secretStringsMatch(expectedRotation, rotationKey)) {
      return res.status(403).json({ success: false, error: 'Invalid rotation key' });
    }

    // Update public key in the found peer section
    for (let i = peerStartIndex; i <= peerEndIndex; i++) {
      const clean = foundLines[i].replace(/^\s*#\s*/, '').trim();
      const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
      if (m && m[1].trim() === oldPublicKey) {
        foundLines[i] = foundLines[i].replace(oldPublicKey, newPublicKey);
        break;
      }
    }

    // Write updated config back to file
    fs.writeFileSync(foundConfigFile, foundLines.join('\n'), { mode: 0o600 });

    // Sync interface if running
    try {
      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(foundInterface)) {
        wgSyncconf(foundInterface);
      }
    } catch (e) {
      // Interface not running
    }

    try {
      const conn = await mysql.createConnection(dbConfig);
      await conn.execute(
        'UPDATE sites SET site_pubkey = ? WHERE site_pubkey = ? AND `interface` = ?',
        [newPublicKey, oldPublicKey, foundInterface]
      );
      await conn.end();
    } catch (dbErr) {
      console.error('Error updating site pubkey in DB:', dbErr.message);
    }

    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'update_key_from_peer', {
        interface: foundInterface,
        old_public_key: oldPublicKey,
        new_public_key: newPublicKey
      });
    } catch (e) { }

    res.json({ success: true, interface: foundInterface });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/interfaces/:interface/config', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    await hydrateRotationKeysFromDb(iface, config);
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/interfaces/:interface/reload', async (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    await hydrateRotationKeysFromDb(iface, config);
    const loaded = fs.existsSync(path.join(CONFIG_DIR, `${iface}.conf`));
    res.json({ success: true, config, loaded });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/save', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    const content = saveInterfaceConfig(iface, config);
    try {
      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(iface)) {
        run('wg-quick', ['down', iface]);
        run('wg-quick', ['up', iface]);
      }
    } catch (e) { /* not running */ }
    res.json({ success: true, content });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/connect', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'start_interface', { interface: iface });
    } catch (e) { }

    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    if (isInterfaceKeyExpired(config)) {
      return res.status(403).json({ success: false, error: 'Key has expired. Cannot connect VPN. Please generate new keys first.' });
    }

    const status = run('wg', ['show', 'interfaces']);
    if (status.includes(iface)) {
      return res.status(400).json({ success: false, error: 'VPN already connected' });
    }

    const confFile = path.join(CONFIG_DIR, `${iface}.conf`);
    if (!fs.existsSync(confFile)) {
      return res.status(404).json({ success: false, error: 'Config file not found. Save configuration first.' });
    }

    run('wg-quick', ['up', iface]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/interfaces/:interface/disconnect', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'stop_interface', { interface: iface });
    } catch (e) { }
    run('wg-quick', ['down', iface]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// audit logs retrieval
app.get('/api/audit-logs', requireAuth, (req, res) => {
  try {
    const logs = getLogs();
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: 'cannot read audit logs' });
  }
});

// security events retrieval
app.get('/api/security-events', requireAuth, (req, res) => {
  try {
    const events = getSecurityEvents();
    res.json({ success: true, events });
  } catch (e) {
    res.status(500).json({ success: false, error: 'cannot read security events' });
  }
});

// session history retrieval (sessions log)
const HISTORY_DIR = '/etc/wireguard/logs/vpn_history';
app.use('/api', createSessionLogRoutes({ requireAuth, HISTORY_DIR }));

// backup APIs
app.use('/api', createBackupRoutes({ requireAuth, BACKUP_DIR, CONFIG_DIR, dbConfig }));

// Get hostname API for frontend navbar
app.get('/api/hostname', (req, res) => res.json({ success: true, hostname: HOSTNAME }));

app.get('/api/interfaces/:interface/vpn-status', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.interface);
  if (!iface) {
    return res.status(400).json({ success: false, error: 'Invalid interface name' });
  }
  try {
    const status = run('wg', ['show', 'interfaces']);
    res.json({ success: true, connected: status.includes(iface) });
  } catch (error) {
    res.json({ success: true, connected: false });
  }
});

// audit log page
app.get('/audit-log', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'audit.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

// backup/restore page
app.get('/backup', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'backup.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/login', (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'login.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace('{{HOSTNAME}}', HOSTNAME);
  res.send(html);
});

app.post('/api/admin-login', loginLimiter('local-admin'), async (req, res) => {
  const { username, password } = req.body || {};
  const creds = loadCredentials();
  if (username === creds.username && await bcrypt.compare(password, creds.passwordHash)) {
    req.session.user = username;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const creds = loadCredentials();
  if (await bcrypt.compare(currentPassword, creds.passwordHash)) {
    const newHash = await bcrypt.hash(newPassword, 10);
    fs.writeFileSync(CREDENTIALS_FILE, `${creds.username}:${newHash}`, { mode: 0o600 });
    req.session.destroy(() => {});
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Current password incorrect' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/notifications/ingest', apiKeyAuth, (req, res) => {
  const count = countIncomingAlerts(req.body);
  if (count <= 0) {
    return res.status(400).json({ success: false, error: 'Empty payload' });
  }

  notificationState.total += count;
  notificationState.latestAt = new Date().toISOString();
  res.json({ success: true, added: count, unread: getUnreadAlerts() });
});

app.get('/api/notifications/unread', requireAuth, (req, res) => {
  res.json({
    success: true,
    unread: getUnreadAlerts(),
    total: notificationState.total,
    latestAt: notificationState.latestAt
  });
});

app.post('/api/notifications/mark-read', requireAuth, (req, res) => {
  notificationState.readTotal = notificationState.total;
  res.json({ success: true, unread: 0 });
});

function renderHtmlWithHostname(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/\{\{HOSTNAME\}\}/g, HOSTNAME);
  return html;
}

app.get('/', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'index.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/interfaces', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/interfaces.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/dashboard', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/dashboard.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/dashboard/:id', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/dashboard.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/dashboard/peer/:id', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/peer_detail.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/settings', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/settings.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/dashboard/:id/peer/:peer_id', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/peer_detail.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/users', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'users.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/devices', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'devices.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/applications', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'applications.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get('/access-rules', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'access_rules.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/main-dashboard', createMainDashboardRoutes({ mysql, dbConfig }));

app.use('/api', createAuthRoutes({ jwt, JWT_SECRET, mysql, dbConfig }));

app.use(
  '/api',
  createUserRoutes({
    mysql,
    dbConfig,
    bcrypt,
    requireAuth
  })
);

app.use(
  '/api',
  createDeviceRoutes({
    mysql,
    dbConfig,
    run,
    requireAuth,
    authenticateToken
  })
);

app.use(
  '/api',
  createApplicationRoutes({
    mysql,
    dbConfig,
    requireAuth
  })
);

app.use(
  '/api',
  createAccessRuleRoutes({
    mysql,
    dbConfig,
    run,
    requireAuth
  })
);

app.post('/api/connect-vpn', authenticateToken, async (req, res) => {
  let connection;

  try {
    const { deviceName, securityInfo } = req.body;
    const username = req.user.username;

    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    // Security Policies Check
    const settings = loadGlobalSettings();
    if (securityInfo) {
      const issues = collectSecurityPolicyIssues(securityInfo, settings);
      if (issues.length > 0) {
        return res.status(403).json({
          success: false,
          error: `Security policy violation: ${formatIssues(issues)}`,
          issues
        });
      }
    }

    connection = await mysql.createConnection(dbConfig);
    const now = Math.floor(Date.now() / 1000);

    const [userRows] = await connection.execute(
      'SELECT expire_day FROM users WHERE username = ?',
      [username]
    );
    if (userRows.length === 0) {
      await connection.end();
      return res.status(403).json({ success: false, error: 'User not found' });
    }
    if (isUserExpired(userRows[0].expire_day)) {
      await connection.end();
      return res.status(403).json({ success: false, error: 'User account expired' });
    }

    const [devices] = await connection.execute(
      'SELECT allowed_ips, public_key, status, expire_date, `interface` FROM devices WHERE username = ? AND device_name = ?',
      [username, deviceName]
    );

    await connection.execute(
      'UPDATE devices SET last_seen = ? WHERE username = ? AND device_name = ?',
      [now, username, deviceName]
    );
    await connection.end();

    if (devices.length === 0) {
      return res.status(403).json({ success: false, error: 'Device not enrolled' });
    }

    const deviceRow = devices[0];
    const deviceStatus = parseInt(deviceRow.status, 10);
    if (deviceStatus === 0) {
      return res.status(403).json({ success: false, error: 'Device disabled' });
    }

    const expireDate = deviceRow.expire_date ? parseInt(deviceRow.expire_date, 10) : null;
    if (expireDate !== null && expireDate < now) {
      const c2 = await mysql.createConnection(dbConfig);
      await c2.execute(
        'UPDATE devices SET status = 0 WHERE username = ? AND device_name = ?',
        [username, deviceName]
      );
      await c2.end();
      return res.status(403).json({ success: false, error: 'Device expired' });
    }

    const device = devices[0];
    const allowedIPs = device.allowed_ips;
    const publicKey = device.public_key;
    const targetIface = device.interface || 'wg2';
    const confFile = path.join(CONFIG_DIR, `${targetIface}.conf`);

    if (!fs.existsSync(confFile)) {
      throw new Error(`Interface ${targetIface} config not found on server`);
    }

    const config = loadInterfaceConfig(targetIface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    await hydrateRotationKeysFromDb(targetIface, config);

    let peer = config.peers.find((p) => p.publicKey === publicKey);
    let needSave = false;

    if (peer) {
      if (peer.enabled === false) {
        peer.enabled = true;
        peer.name = `${username}_${deviceName}`;
        needSave = true;
        console.log(`[INFO] Enabled device ${deviceName} for user ${username} on ${targetIface}`);
      }
    } else {
      config.peers.push({
        name: `${username}_${deviceName}`,
        publicKey,
        presharedKey: '',
        endpoint: '',
        allowedIPs,
        persistentKeepalive: '25',
        rotationKey: '',
        enabled: true
      });
      needSave = true;
      console.log(`[INFO] Created and enabled device ${deviceName} for user ${username} on ${targetIface}`);
    }

    if (needSave) {
      saveInterfaceConfig(targetIface, config);
      wgSyncconfIfRunning(targetIface);

      // Schedule auto-disable after specified hours via systemd-run
      try {
        const currentSettings = loadGlobalSettings();
        const disableHours = currentSettings.peerDisableHours || 12;
        const unitName = `wg-peer-expire-${username}-${deviceName}`;

        tryRun('systemctl', ['stop', `${unitName}.timer`]);
        tryRun('systemctl', ['stop', `${unitName}.service`]);
        tryRun('systemctl', ['reset-failed', `${unitName}.service`]);
        run('systemd-run', [
          `--on-active=${disableHours}h`,
          `--unit=${unitName}`,
          '/usr/local/bin/wg_disable_peer.sh',
          targetIface,
          publicKey
        ]);
        console.log(`[INFO] Scheduled peer disable in ${disableHours}h for ${username}/${deviceName} on ${targetIface}`);
      } catch (e) {
        console.error('systemd-run schedule error:', e.message);
      }
    }

    try {
      await redisHeartbeatTouch(username, deviceName);
    } catch (e) {
      console.error('[heartbeat] connect-vpn touch:', e.message);
    }

    const listenPort = String(config.interface.listenPort || '').trim();
    const serverAllowedIPs = buildClientVpnRouteAllowedIPs(config.interface.address);
    if (!listenPort) {
      return res.status(500).json({ success: false, error: `Interface ${targetIface} missing ListenPort` });
    }
    if (!serverAllowedIPs) {
      return res.status(500).json({ success: false, error: `Interface ${targetIface} missing Address` });
    }

    const vpnPublicHost = process.env.VPN_PUBLIC_ENDPOINT_HOST || process.env.TLS_PUBLIC_BIND || '172.16.0.128';
    res.json({
      success: true,
      allowedIPs,
      serverPublicKey: config.interface.publicKey,
      serverEndpoint: `${vpnPublicHost}:${listenPort}`,
      serverAllowedIPs
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) await connection.end();
  }
});

app.use(express.static(FRONTEND_DIR));

// Check root
if (process.getuid && process.getuid() !== 0) {
  console.error('[ERROR] This program requires root privileges');
  process.exit(1);
}

// Periodic check for expired keys (every hour)
setInterval(() => {
  checkAndDisconnectIfExpired();
}, 60 * 1000);

function normalizeCentralUrl(u) {
  if (!u) return '';
  const t = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function getCentralBase() {
  const central = process.env.CENTRAL_URL;
  return central ? normalizeCentralUrl(central) : '';
}

function registerWithCentral() {
  const base = getCentralBase();
  const apiKey = getApiKey();
  if (!base || !apiKey) {
    return Promise.reject(new Error('CENTRAL_URL or NODE_API_KEY not set'));
  }
  const pollBase =
    process.env.CENTRAL_POLL_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `https://127.0.0.1:${PORT}`;
  const body = {
    name: process.env.CENTRAL_NODE_NAME || HOSTNAME,
    machineId: HOSTNAME,
    baseUrl: pollBase.replace(/\/+$/, ''),
    publicIp: process.env.CENTRAL_PUBLIC_IP || ''
  };
  return fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    agent: base.startsWith('https') ? centralAgent : undefined
  }).then(async (r) => {
    let payload = null;
    try { payload = await r.json(); } catch { /* ignore */ }
    if (!r.ok) {
      const msg = (payload && (payload.error || payload.message)) || `central returned ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return payload;
  });
}

// Trigger a register from the admin UI (already gated by global auth guard).
app.post('/api/central-register', (req, res) => {
  registerWithCentral()
    .then((payload) => res.json({ success: true, central: payload }))
    .catch((e) => {
      const code = e.status >= 400 && e.status < 500 ? e.status : 502;
      res.status(code).json({ success: false, error: e.message });
    });
});

async function pushMetricsToCentral() {
  const base = getCentralBase();
  if (!base || !getApiKey()) return;
  let body;
  try {
    body = run('bash', [EXPORTER_SCRIPT], { timeout: 60000 });
  } catch (e) {
    console.error('[metrics push] exporter failed:', e.message);
    return;
  }
  try {
    const r = await fetch(`${base}/api/metrics/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...authHeaders() },
      body,
      agent: base.startsWith('https') ? centralAgent : undefined
    });
    if (!r.ok) {
      console.error('[metrics push] central responded', r.status);
    }
  } catch (e) {
    console.error('[metrics push] network error:', e.message);
  }
}

function tlsPair(keyPath, certPath) {
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

const internalTls = tlsPair(
  process.env.TLS_INTERNAL_KEY_PATH || TLS_KEY_PATH,
  process.env.TLS_INTERNAL_CERT_PATH || TLS_CERT_PATH
);
const publicTls = tlsPair(
  process.env.TLS_PUBLIC_KEY_PATH || TLS_KEY_PATH,
  process.env.TLS_PUBLIC_CERT_PATH || TLS_CERT_PATH
);

const hLan = process.env.TLS_INTERNAL_BIND || '192.168.178.128';
const hPub = process.env.TLS_PUBLIC_BIND || '172.16.0.128';
const hLo = process.env.TLS_LOOPBACK_BIND || '127.0.0.1';

const listeners = [
  [internalTls, hLan],
  [publicTls, hPub],
  [internalTls, hLo]
];

let bootOnce = false;
function afterListen(host) {
  console.log(`HTTPS https://${host}:${PORT}`);
  if (bootOnce) return;
  bootOnce = true;
  const onRegisterFail = (e) => console.error('[central register]', e.message);
  registerWithCentral()
    .then(() => pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message)))
    .catch(onRegisterFail);
  const regMs = parseInt(process.env.CENTRAL_REGISTER_INTERVAL_MS || '300000', 10);
  if (regMs > 0) {
    setInterval(() => {
      registerWithCentral().catch(onRegisterFail);
    }, regMs);
  }
  const pushMs = parseInt(process.env.METRICS_PUSH_INTERVAL_MS || '30000', 10);
  if (pushMs > 0) {
    setInterval(() => { pushMetricsToCentral(); }, pushMs);
    pushMetricsToCentral();
  }
  const deviceSyncMs = parseInt(process.env.DEVICE_SYNC_INTERVAL_MS || '3600000', 10);
  if (deviceSyncMs > 0) {
    setInterval(() => {
      pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message));
    }, deviceSyncMs);
  }
}

for (const [opts, host] of listeners) {
  https.createServer(opts, app).listen(PORT, host, () => afterListen(host));
}