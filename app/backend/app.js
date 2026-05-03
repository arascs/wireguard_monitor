#!/usr/bin/env node

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const https = require('https');
const dashboardRoutes = require('./routes/dashboard');
const createUserRoutes = require('./routes/users');
const createApplicationRoutes = require('./routes/applications');
const createAccessRuleRoutes = require('./routes/accessRules');
const createAuthRoutes = require('./routes/auth');
const createSessionLogRoutes = require('./routes/sessionLogs');
const createBackupRoutes = require('./routes/backups');
const createMainDashboardRoutes = require('./routes/main_dashboard');
const { HOSTNAME } = require('./config');
const mysql = require('mysql2/promise');
const { logAction, getLogs, getSecurityEvents } = require('./auditLogger');
const { touch: redisHeartbeatTouch } = require('./deviceHeartbeat');

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'wg_monitor'
};

const JWT_SECRET = process.env.JWT_SECRET || 'please_change_this_secret';
const ALERT_INGEST_KEY = process.env.ALERT_INGEST_KEY || '';
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
const PORT = 3000;
const EXPORTER_SCRIPT = "/usr/local/bin/exporter.sh";

app.use(cors());

const TLS_KEY_PATH = '/usr/local/share/ca-certificates/key.pem';
const TLS_CERT_PATH = '/usr/local/share/ca-certificates/cert.pem';

const POLL_API_KEY = process.env.POLL_API_KEY || '';
const BASHRC_FILE = path.join(process.env.HOME || '/root', '.bashrc');

function readEnvValue(name) {
  const val = process.env[name];
  return val == null ? '' : String(val);
}

function parseBashrcEnv(content) {
  const out = {};
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
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

// Prometheus-style metrics (no session auth; for central / monitoring)
app.get('/metrics', (req, res) => {
  try {
    if (POLL_API_KEY && req.headers['x-api-key'] !== POLL_API_KEY) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const out = execSync(`bash "${EXPORTER_SCRIPT}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000
    });
    res.type('text/plain; version=0.0.4').send(out);
  } catch (e) {
    res.status(500).type('text/plain').send(`# exporter error: ${e.message || e}\n`);
  }
});

// Local WireGuard availability (wg show)
app.get('/health', (req, res) => {
  try {
    const out = execSync('bash -c "wg show > /dev/null 2>&1 && echo ok || echo fail"', {
      encoding: 'utf8'
    }).trim();
    const ok = out === 'ok';
    res.status(ok ? 200 : 503).type('text/plain').send(ok ? 'ok' : 'fail');
  } catch {
    res.status(503).type('text/plain').send('fail');
  }
});

const CONFIG_DIR = '/etc/wireguard/';
let INTERFACE = 'wgA';
let CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
const FRONTEND_DIR = path.join(__dirname, '../frontend');
const CREDENTIALS_FILE = '/etc/wireguard/credentials.txt';

// backup directory for stored archives
const BACKUP_DIR = '/var/backups/wg_monitor';
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Global settings
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadGlobalSettings() {
  const defaultSettings = {
    keyExpiryDays: 90,
    peerDisableHours: 12,
    keyRenewalTime: "08:00",
    enforceKernelCheck: true,
    minKernelVersion: 4,
    enforceNoRootLogin: true,
    enforceFirewall: true
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Error loading settings:', e.message);
  }
  return defaultSettings;
}

let config = {
  interface: {
    privateKey: '',
    publicKey: '',
    address: '',
    dns: '',
    listenPort: '',
    table: '',
    mtu: '1420',
    preUp: '',
    postUp: '',
    preDown: '',
    postDown: '',
    keyCreationDate: null,
    keyExpiryDays: loadGlobalSettings().keyExpiryDays
  },
  peers: []
};


app.use(express.json());
app.use(session({
  secret: 'wireguard-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

// Check if key is expired
function isKeyExpired() {
  if (!config.interface.keyCreationDate) {
    return false; // No key created yet
  }

  const creationDate = new Date(config.interface.keyCreationDate);
  const expiryDate = new Date(creationDate);
  expiryDate.setDate(expiryDate.getDate() + config.interface.keyExpiryDays);

  return new Date() > expiryDate;
}

// Get remaining days
function getRemainingDays() {
  if (!config.interface.keyCreationDate) {
    return null;
  }

  const creationDate = new Date(config.interface.keyCreationDate);
  const expiryDate = new Date(creationDate);
  expiryDate.setDate(expiryDate.getDate() + config.interface.keyExpiryDays);

  const now = new Date();
  const diffTime = expiryDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays;
}

// Auto disconnect VPN if key expired
async function checkAndDisconnectIfExpired() {
  if (isKeyExpired()) {
    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        run(`wg-quick down ${INTERFACE}`);
        console.log(`[INFO] VPN ${INTERFACE} automatically disconnected due to expired key`);
      }
    } catch (e) {
      console.error('Error disconnecting VPN:', e.message);
    }
  }
}

// Share config with routes
function updateSharedConfig() {
  if (app) {
    app.set('config', config);
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
  // otherwise assume browser navigation
  res.redirect('/login');
}

// Load configuration from file
function loadConfigFromFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      // Reset config if file doesn't exist
      config = {
        interface: {
          privateKey: '',
          publicKey: '',
          address: '',
          dns: '',
          listenPort: '',
          table: '',
          mtu: '1420',
          preUp: '',
          postUp: '',
          preDown: '',
          postDown: '',
          keyCreationDate: null,
          keyExpiryDays: loadGlobalSettings().keyExpiryDays,
          type: ''
        },
        peers: []
      };
      updateSharedConfig();
      return false;
    }

    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    const lines = content.split('\n');
    let section = null;
    let currentPeer = null;
    let peerEnabled = true;
    let peerName = '';

    config = {
      interface: {
        privateKey: '',
        publicKey: '',
        address: '',
        dns: '',
        listenPort: '',
        table: '',
        mtu: '1420',
        preUp: '',
        postUp: '',
        preDown: '',
        postDown: '',
        keyCreationDate: null,
        keyExpiryDays: loadGlobalSettings().keyExpiryDays,
        type: ''
      },
      peers: []
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      // Check if line is commented
      const isCommented = trimmed.startsWith('#');
      const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;

      // Skip if cleanLine is empty after removing comment
      if (!cleanLine) {
        continue;
      }

      if (isCommented && cleanLine.toLowerCase().startsWith('name =')) {
        const parts = cleanLine.split('=');
        if (parts.length > 1) {
          peerName = parts.slice(1).join('=').trim();
        }
        continue;
      }

      if (cleanLine === '[Interface]') {
        section = 'interface';
        peerEnabled = true;
        peerName = '';
      } else if (cleanLine === '[Peer]') {
        section = 'peer';
        const pendingPeerName = peerName;
        currentPeer = {
          name: pendingPeerName || '',
          publicKey: '',
          presharedKey: '',
          endpoint: '',
          allowedIPs: '',
          persistentKeepalive: '',
          enabled: !isCommented
        };
        peerEnabled = !isCommented;
        peerName = '';
        config.peers.push(currentPeer);
      } else if (cleanLine.includes('=')) {
        const equalIndex = cleanLine.indexOf('=');
        const key = cleanLine.substring(0, equalIndex).trim();
        const value = cleanLine.substring(equalIndex + 1).trim();

        if (!key) {
          continue;
        }

        const lowerKey = key.toLowerCase();

        if (isCommented) {
          if (lowerKey === 'key creation' && section === 'interface') {
            config.interface.keyCreationDate = value;
            continue;
          }
          if (lowerKey === 'key expiry days' && section === 'interface') {
            config.interface.keyExpiryDays = parseInt(value) || loadGlobalSettings().keyExpiryDays;
            continue;
          }
          if (lowerKey === 'type' && (section === 'interface' || section === null)) {
            config.interface.type = value;
            continue;
          }
        }

        if (section === 'interface') {
          // Map lowercase keys to camelCase property names
          let propertyName = lowerKey;
          if (lowerKey === 'listenport') {
            propertyName = 'listenPort';
          } else if (lowerKey === 'preup') {
            propertyName = 'preUp';
          } else if (lowerKey === 'postup') {
            propertyName = 'postUp';
          } else if (lowerKey === 'predown') {
            propertyName = 'preDown';
          } else if (lowerKey === 'postdown') {
            propertyName = 'postDown';
          } else if (lowerKey === 'privatekey') {
            propertyName = 'privateKey';
          } else if (lowerKey === 'publickey') {
            propertyName = 'publicKey';
          }

          config.interface[propertyName] = value;
          if (lowerKey === 'privatekey') {
            try {
              const pubKey = run(`echo "${value}" | wg pubkey`).trim();
              config.interface.publicKey = pubKey;
            } catch (e) {
              console.error('Error generating public key:', e.message);
            }
          }
        } else if (section === 'peer' && currentPeer) {
          if (lowerKey === 'publickey') {
            currentPeer.publicKey = value;
          } else if (lowerKey === 'presharedkey') {
            currentPeer.presharedKey = value;
          } else if (lowerKey === 'endpoint') {
            currentPeer.endpoint = value;
          } else if (lowerKey === 'allowedips') {
            currentPeer.allowedIPs = value;
          } else if (lowerKey === 'persistentkeepalive') {
            currentPeer.persistentKeepalive = value;
          } else {
            currentPeer[lowerKey] = value;
          }
          // Update enabled status based on whether peer section was commented
          if (peerEnabled === false) {
            currentPeer.enabled = false;
          }
        }
      }
    }

    // Check and disconnect if expired
    checkAndDisconnectIfExpired();

    // Update shared config
    updateSharedConfig();

    return true;
  } catch (error) {
    console.error('Error loading config from file:', error.message);
    return false;
  }
}

function getActiveInterfaces() {
  try {
    const interfacesOutput = run('wg show interfaces').trim();
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
            summary.publicKey = run(`echo "${value}" | wg pubkey`).trim();
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

function buildConfigFileContent() {
  let content = '';

  let typeToWrite = config.interface.type;
  if (!typeToWrite && fs.existsSync(CONFIG_FILE)) {
    try {
      const currentContent = fs.readFileSync(CONFIG_FILE, 'utf8');
      const lines = currentContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('# type =')) {
          const parts = trimmed.split('=');
          if (parts.length > 1) {
            typeToWrite = parts.slice(1).join('=').trim();
            break;
          }
        }
      }
    } catch (e) {
      // Nếu có lỗi đọc file, tiếp tục mà không lưu type
    }
  }

  if (typeToWrite) {
    content += `# Type = ${typeToWrite}\n`;
  }

  content += '[Interface]\n';

  if (config.interface.keyCreationDate) {
    content += `# Key Creation = ${config.interface.keyCreationDate}\n`;
  }
  if (config.interface.keyExpiryDays) {
    content += `# Key Expiry Days = ${config.interface.keyExpiryDays}\n`;
  }

  content += `PrivateKey = ${config.interface.privateKey}\n`;
  content += `Address = ${config.interface.address}\n`;
  if (config.interface.dns) content += `DNS = ${config.interface.dns}\n`;
  if (config.interface.listenPort) content += `ListenPort = ${config.interface.listenPort}\n`;
  if (config.interface.mtu) content += `MTU = ${config.interface.mtu}\n`;
  if (config.interface.preUp) content += `PreUp = ${config.interface.preUp}\n`;
  if (config.interface.postUp) content += `PostUp = ${config.interface.postUp}\n`;
  if (config.interface.preDown) content += `PreDown = ${config.interface.preDown}\n`;
  if (config.interface.postDown) content += `PostDown = ${config.interface.postDown}\n`;

  config.peers.forEach(peer => {
    const isDisabled = peer.enabled === false;
    content += '\n';

    if (peer.name) {
      content += `# Name = ${peer.name}\n`;
    }

    content += isDisabled ? '# [Peer]\n' : '[Peer]\n';
    const prefix = isDisabled ? '# ' : '';
    content += `${prefix}PublicKey = ${peer.publicKey}\n`;
    if (peer.presharedKey) content += `${prefix}PresharedKey = ${peer.presharedKey}\n`;
    if (peer.endpoint) content += `${prefix}Endpoint = ${peer.endpoint}\n`;
    content += `${prefix}AllowedIPs = ${peer.allowedIPs}\n`;
    if (peer.persistentKeepalive) content += `${prefix}PersistentKeepalive = ${peer.persistentKeepalive}\n`;
  });

  return content;
}

function saveConfigToFile() {
  if (isKeyExpired()) {
    const err = new Error('Key has expired. Cannot save configuration.');
    err.statusCode = 403;
    throw err;
  }
  if (!config.interface.privateKey || !config.interface.address) {
    const err = new Error('Missing required fields (private key, address)');
    err.statusCode = 400;
    throw err;
  }

  const content = buildConfigFileContent();

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  fs.writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
  return content;
}

// Choose interface
app.post('/api/interface', (req, res) => {
  try {
    INTERFACE = req.body.interface || 'wg0';
    CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
    // Load config when interface changes
    loadConfigFromFile();
    res.json({ success: true, interface: INTERFACE, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current interface
app.get('/api/interface', (req, res) => {
  res.json({ interface: INTERFACE });
});

// Get last 50 log lines for a specific interface from /var/log/wg_systemd.log
app.get('/api/interface-log/:interfaceName', (req, res) => {
  try {
    const interfaceName = req.params.interfaceName.replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!interfaceName) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    const LOG_FILE = '/etc/wireguard/logs/wg_systemd.log';
    let lines;
    try {
      // grep lines matching the interface name, then take last 50
      lines = execSync(
        `grep -F "${interfaceName}" "${LOG_FILE}" | tail -n 50`,
        { encoding: 'utf8' }
      );
    } catch (e) {
      // grep returns exit code 1 if no matches — treat as empty
      lines = '';
    }
    res.json({ success: true, log: lines });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get key status
app.get('/api/key-status', (req, res) => {
  const expired = isKeyExpired();
  const remainingDays = getRemainingDays();

  res.json({
    success: true,
    expired,
    remainingDays,
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
    const { name, type, address, listenPort, dns, mtu, preUp, postUp, preDown, postDown } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Interface name is required' });
    }
    const interfaceType = (type === 'Site' || type === 'Client') ? type : 'Client';
    const confFile = path.join(CONFIG_DIR, `${name}.conf`);
    if (fs.existsSync(confFile)) {
      return res.status(409).json({ success: false, error: 'Interface already exists' });
    }

    // Generate keys
    const privateKey = run('wg genkey').trim();
    const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();

    // Build conf content — Type comment is the very first line
    let content = `# Type = ${interfaceType}\n`;
    content += '[Interface]\n';
    content += `# Key Creation = ${new Date().toISOString()}\n`;
    const settings = loadGlobalSettings();
    content += `# Key Expiry Days = ${settings.keyExpiryDays}\n`;
    content += `PrivateKey = ${privateKey}\n`;
    if (address) content += `Address = ${address}\n`;
    if (listenPort) content += `ListenPort = ${listenPort}\n`;
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
      logAction(admin, 'add_interface', { interface: name, type: interfaceType, publicKey, address });
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
      const status = run('wg show interfaces');
      if (status.includes(interfaceName)) {
        run(`wg-quick down ${interfaceName}`);
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

// Get global settings
app.get('/api/settings', (req, res) => {
  try {
    const settings = loadGlobalSettings();
    const bashrcEnv = parseBashrcEnv(fs.existsSync(BASHRC_FILE) ? fs.readFileSync(BASHRC_FILE, 'utf8') : '');
    settings.apiKeys = {
      registerKey: readEnvValue('CENTRAL_REGISTER_SECRET') || bashrcEnv.CENTRAL_REGISTER_SECRET || '',
      pushKey: readEnvValue('CENTRAL_PUSH_API_KEY') || bashrcEnv.CENTRAL_PUSH_API_KEY || '',
      pullKey: readEnvValue('CENTRAL_PULL_API_KEY') || bashrcEnv.CENTRAL_PULL_API_KEY || ''
    };
    return res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update global settings
app.post('/api/settings', (req, res) => {
  try {
    const currentSettings = loadGlobalSettings();
    const newSettings = {
      keyExpiryDays: req.body.keyExpiryDays ? parseInt(req.body.keyExpiryDays, 10) : currentSettings.keyExpiryDays,
      peerDisableHours: req.body.peerDisableHours ? parseInt(req.body.peerDisableHours, 10) : currentSettings.peerDisableHours,
      keyRenewalTime: req.body.keyRenewalTime || currentSettings.keyRenewalTime,
      enforceKernelCheck: req.body.enforceKernelCheck !== undefined ? req.body.enforceKernelCheck : currentSettings.enforceKernelCheck,
      minKernelVersion: req.body.minKernelVersion !== undefined ? parseInt(req.body.minKernelVersion, 10) : currentSettings.minKernelVersion,
      enforceNoRootLogin: req.body.enforceNoRootLogin !== undefined ? req.body.enforceNoRootLogin : currentSettings.enforceNoRootLogin,
      enforceFirewall: req.body.enforceFirewall !== undefined ? req.body.enforceFirewall : currentSettings.enforceFirewall
    };

    // Save to settings.json
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');

    // If time changed, rewrite timer and reload
    if (newSettings.keyRenewalTime !== currentSettings.keyRenewalTime) {
      const timerPath = '/etc/systemd/system/wg-key-renewal.timer';
      if (fs.existsSync(timerPath)) {
        let timerContent = fs.readFileSync(timerPath, 'utf8');
        // Replace OnCalendar line
        timerContent = timerContent.replace(/^OnCalendar=.*$/m, `OnCalendar=*-*-* ${newSettings.keyRenewalTime}:00`);
        fs.writeFileSync(timerPath, timerContent, 'utf8');
        try {
          run('systemctl daemon-reload');
          run('systemctl reenable wg-key-renewal.timer');
          run('systemctl restart wg-key-renewal.timer');
          console.log(`[INFO] wg-key-renewal.timer updated to ${newSettings.keyRenewalTime}`);
        } catch (e) {
          console.error('[ERROR] Failed to restart systemd timer:', e.message);
        }
      }
    }

    // Audit log
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'update_settings', newSettings);
    } catch (e) { }

    const apiKeys = req.body && req.body.apiKeys ? req.body.apiKeys : {};
    upsertBashrcEnv({
      CENTRAL_REGISTER_SECRET: apiKeys.registerKey || readEnvValue('CENTRAL_REGISTER_SECRET'),
      CENTRAL_PUSH_API_KEY: apiKeys.pushKey || readEnvValue('CENTRAL_PUSH_API_KEY'),
      CENTRAL_PULL_API_KEY: apiKeys.pullKey || readEnvValue('CENTRAL_PULL_API_KEY')
    });

    res.json({ success: true, settings: newSettings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate keys
app.post('/api/generate-keys', async (req, res) => {
  try {
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
    const newPrivateKey = run('wg genkey').trim();
    const newPublicKey = run(`echo "${newPrivateKey}" | wg pubkey`).trim();

    config.interface.privateKey = newPrivateKey;
    config.interface.publicKey = newPublicKey;
    config.interface.keyCreationDate = new Date().toISOString();

    // Use global default if not set
    if (!config.interface.keyExpiryDays) {
      const currentSettings = loadGlobalSettings();
      config.interface.keyExpiryDays = currentSettings.keyExpiryDays;
    }

    const content = buildConfigFileContent();
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, content, { mode: 0o600 });

    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        run(`bash -c "wg syncconf ${INTERFACE} <(wg-quick strip ${INTERFACE})"`);
      }
    } catch (e) {
      // Interface not running
    }

    updateSharedConfig();

    // audit log
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      if (!hasExistingKey) {
        logAction(admin, 'add_interface', {
          interface: INTERFACE,
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
          interface: INTERFACE,
          old_private_key: oldPrivateKey,
          new_private_key: newPrivateKey
        });
      }
    } catch (e) { }

    // Send new key to all peers
    const peers = config.peers.map(peer => ({
      publicKey: peer.publicKey,
      endpoint: peer.endpoint
    }));

    // Send update-key request to all peers with endpoints
    for (const peer of peers) {
      if (peer.endpoint) {
        const endpointParts = peer.endpoint.split(':');
        if (endpointParts.length === 2) {
          const peerIp = endpointParts[0];
          const peerPort = endpointParts[1];
          try {
            await fetch(`http://${peerIp}:${peerPort}/api/update-key`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                oldPublicKey: oldPublicKey,
                newPublicKey: newPublicKey
              })
            });
          } catch (e) {
            console.error(`Failed to notify peer ${peerIp}:${peerPort}:`, e.message);
          }
        }
      }
    }

    res.json({
      success: true,
      oldPublicKey: oldPublicKey,
      newPublicKey: newPublicKey,
      peers: peers
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Configure interface
app.post('/api/configure-interface', (req, res) => {
  try {
    const isNew = !fs.existsSync(CONFIG_FILE);
    // ✅ Bảo toàn type hiện tại (vì có thể đã load từ file trước đó)
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

    // ✅ Khôi phục type sau khi cập nhật các field khác
    if (existingType) {
      config.interface.type = existingType;
    }

    if (req.body.keyExpiryDays) {
      config.interface.keyExpiryDays = parseInt(req.body.keyExpiryDays) || 90;
    } else if (!config.interface.keyExpiryDays) {
      const currentSettings = loadGlobalSettings();
      config.interface.keyExpiryDays = currentSettings.keyExpiryDays;
    }

    let savedContent = null;
    if (req.body.saveToFile) {
      try {
        savedContent = saveConfigToFile();
      } catch (error) {
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, error: error.message });
      }
      if (!isNew) {
        // Audit log when editing existing interface
        try {
          const admin = req.session && req.session.user ? req.session.user : 'unknown';
          logAction(admin, 'edit_interface', {
            interface: INTERFACE,
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

    updateSharedConfig();
    res.json({ success: true, config, content: savedContent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add peer
app.post('/api/add-peer', async (req, res) => {
  try {
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Please generate new keys and reconfigure interface first.'
      });
    }

    if (!config.interface.privateKey || !config.interface.address) {
      return res.status(400).json({
        success: false,
        error: 'Interface not configured. Please configure interface first.'
      });
    }

    const ifaceType = config.interface.type || '';

    if (ifaceType === 'Client') {
      return res.status(400).json({
        success: false,
        error: 'Peer type Client can only be added by approving devices.'
      });
    }

    const peer = {
      name: req.body.name || '',
      publicKey: req.body.publicKey || '',
      presharedKey: req.body.presharedKey || '',
      endpoint: req.body.endpoint || '',
      allowedIPs: req.body.allowedIPs || '0.0.0.0/0',
      persistentKeepalive: req.body.persistentKeepalive || '25',
      enabled: true
    };

    if (req.body.generatePsk) {
      peer.presharedKey = run('wg genpsk').trim();
    }

    config.peers.push(peer);
    updateSharedConfig();

    try {
      saveConfigToFile();
    } catch (saveErr) {
      return res.status(saveErr.statusCode || 500).json({ success: false, error: saveErr.message });
    }

    if (ifaceType === 'Site') {
      try {
        const conn = await mysql.createConnection(dbConfig);
        await conn.execute(
          'INSERT INTO sites (site_name, site_endpoint, site_pubkey, site_allowedIPs, site_persistent_keepalive, `interface`) VALUES (?, ?, ?, ?, ?, ?)',
          [
            peer.name,
            peer.endpoint,
            peer.publicKey,
            peer.allowedIPs,
            peer.persistentKeepalive ? parseInt(peer.persistentKeepalive) : null,
            INTERFACE
          ]
        );
        await conn.end();
      } catch (dbErr) {
        console.error('Error saving site to DB:', dbErr.message);
      }
    }

    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        run(`bash -c "wg syncconf ${INTERFACE} <(wg-quick strip ${INTERFACE})"`);
      }
    } catch (e) {
      console.error('wg syncconf failed:', e.message);
    }

    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'create_peer', { peer });
    } catch (e) { }
    res.json({ success: true, peer, index: config.peers.length - 1 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Edit peer
app.put('/api/edit-peer/:index', (req, res) => {
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Please generate new keys first.'
      });
    }

    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      const peer = config.peers[idx];
      console.log(`Editing peer at index ${idx}:`, peer);
      const oldPeer = { ...peer };

      peer.name = req.body.name !== undefined ? req.body.name : peer.name;
      peer.publicKey = req.body.publicKey !== undefined ? req.body.publicKey : peer.publicKey;
      peer.endpoint = req.body.endpoint !== undefined ? req.body.endpoint : peer.endpoint;
      peer.allowedIPs = req.body.allowedIPs !== undefined ? req.body.allowedIPs : peer.allowedIPs;
      peer.persistentKeepalive = req.body.persistentKeepalive !== undefined ? req.body.persistentKeepalive : peer.persistentKeepalive;
      if (req.body.presharedKey !== undefined) {
        peer.presharedKey = req.body.presharedKey;
      }

      updateSharedConfig();

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'edit_peer', {
          oldConfig: oldPeer,
          newConfig: peer
        });
      } catch (e) {
        console.error('Audit log error:', e.message);
      }

      res.json({ success: true, peer });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete peer
app.delete('/api/delete-peer/:index', async (req, res) => {
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Please generate new keys first.'
      });
    }

    const ifaceType = config.interface.type || '';

    if (ifaceType === 'Client') {
      return res.status(400).json({
        success: false,
        error: 'Peer type Client can only be deleted by removing devices.'
      });
    }

    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      const peer = config.peers[idx];
      const publicKey = peer.publicKey;
      config.peers.splice(idx, 1);
      updateSharedConfig();

      if (publicKey) {
        try {
          const conn = await mysql.createConnection(dbConfig);
          await conn.execute('DELETE FROM sites WHERE site_pubkey = ?', [publicKey]);
          await conn.end();
        } catch (dbErr) {
          console.error('Error deleting site from DB:', dbErr.message);
        }
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'delete_peer', { peer });
      } catch (e) { }
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enable peer
app.post('/api/enable-peer/:index', async (req, res) => {
  let connection;
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Please generate new keys first.'
      });
    }

    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
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
      updateSharedConfig();
      // audit log
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'enable_peer', { peer: config.peers[idx] });
      } catch (e) { }
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) {
      try { await connection.end(); } catch (e) { }
    }
  }
});

// Disable peer
app.post('/api/disable-peer/:index', (req, res) => {
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Please generate new keys first.'
      });
    }

    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      config.peers[idx].enabled = false;
      updateSharedConfig();
      // audit log
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'disable_peer', { peer: config.peers[idx] });
      } catch (e) { }
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update peer key
app.post('/api/update-key', (req, res) => {
  try {
    const { oldPublicKey, newPublicKey } = req.body;
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
      const status = run('wg show interfaces');
      if (status.includes(foundInterface)) {
        run(`bash -c "wg syncconf ${foundInterface} <(wg-quick strip ${foundInterface})"`);
      }
    } catch (e) {
      // Interface not running
    }

    // audit log
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'update_key', {
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

// View configuration (in-memory state)
app.get('/api/config', (req, res) => {
  res.json({ success: true, config });
});

// Reload configuration from file on demand
app.get('/api/reload-config', (req, res) => {
  try {
    const loaded = loadConfigFromFile();
    res.json({ success: true, config, loaded });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save configuration
app.post('/api/save-config', (req, res) => {
  try {
    const content = saveConfigToFile();
    // Restart interface if running to apply new config
    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        run(`wg-quick down ${INTERFACE}`);
        run(`wg-quick up ${INTERFACE}`);
      }
    } catch (e) {
      // Interface not running, no need to restart
    }
    res.json({ success: true, content });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});


// Connect VPN
app.post('/api/connect', (req, res) => {
  try {
    // audit start interface
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'start_interface', { interface: INTERFACE });
    } catch (e) { }

    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({
        success: false,
        error: 'Key has expired. Cannot connect VPN. Please generate new keys first.'
      });
    }

    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        return res.status(400).json({
          success: false,
          error: 'VPN already connected'
        });
      }
    } catch (e) { }

    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(404).json({
        success: false,
        error: 'Config file not found. Save configuration first.'
      });
    }

    run(`wg-quick up ${INTERFACE}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect VPN
app.post('/api/disconnect', (req, res) => {
  try {
    // audit stop interface
    try {
      const admin = req.session && req.session.user ? req.session.user : 'unknown';
      logAction(admin, 'stop_interface', { interface: INTERFACE });
    } catch (e) { }

    run(`wg-quick down ${INTERFACE}`);
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

// Get VPN status
app.get('/api/vpn-status', (req, res) => {
  try {
    const status = run('wg show interfaces');
    const isConnected = status.includes(INTERFACE);
    res.json({ success: true, connected: isConnected });
  } catch (error) {
    // If command fails, VPN is likely not connected
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

app.post('/api/admin-login', async (req, res) => {
  const { username, password } = req.body;
  const creds = loadCredentials();
  if (username === creds.username && await bcrypt.compare(password, creds.passwordHash)) {
    req.session.user = username;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const creds = loadCredentials();
  if (await bcrypt.compare(currentPassword, creds.passwordHash)) {
    const newHash = await bcrypt.hash(newPassword, 10);
    fs.writeFileSync(CREDENTIALS_FILE, `${creds.username}:${newHash}`, { mode: 0o600 });
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Current password incorrect' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/notifications/ingest', (req, res) => {
  const providedKey = (req.header('x-alert-key') || '').trim();
  if (ALERT_INGEST_KEY && providedKey !== ALERT_INGEST_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

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

// Synchronize keys
app.post('/api/sync-keys', (req, res) => {
  try {
    run('python3 /usr/local/bin/wg-sync-key.py');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/connect-vpn', authenticateToken, async (req, res) => {
  const originalInterface = INTERFACE;
  const originalConfigFile = CONFIG_FILE;
  const originalConfigObj = JSON.parse(JSON.stringify(config));
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
      const issues = [];
      if (settings.enforceKernelCheck && securityInfo.kernelVersion !== null) {
        if (securityInfo.kernelVersion <= settings.minKernelVersion) {
          issues.push(`Kernel version ${securityInfo.rawKernel || securityInfo.kernelVersion} is too old (must be > ${settings.minKernelVersion})`);
        }
      }
      if (settings.enforceNoRootLogin && securityInfo.sshRootLogin === true) {
        issues.push('SSH PermitRootLogin is set to yes');
      }
      if (settings.enforceFirewall && securityInfo.firewallActive === false) {
        issues.push('Firewall is inactive or missing');
      }

      if (issues.length > 0) {
        return res.status(403).json({ success: false, error: 'Security policy violation', issues });
      }
    }

    connection = await mysql.createConnection(dbConfig);

    const [devices] = await connection.execute(
      'SELECT allowed_ips, public_key, status, expire_date, `interface` FROM devices WHERE username = ? AND device_name = ?',
      [username, deviceName]
    );

    await connection.execute(
      'UPDATE devices SET last_seen = ? WHERE username = ? AND device_name = ?',
      [Math.floor(Date.now() / 1000), username, deviceName]
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

    const now = Math.floor(Date.now() / 1000);
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

    INTERFACE = targetIface;
    CONFIG_FILE = path.join(CONFIG_DIR, `${targetIface}.conf`);

    if (!fs.existsSync(CONFIG_FILE)) {
      throw new Error(`Interface ${targetIface} config not found on server`);
    }

    loadConfigFromFile();

    // Find peer and enable it, or create if not exists
    let peer = config.peers.find(p => p.publicKey === publicKey);
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
        enabled: true
      });
      needSave = true;
      console.log(`[INFO] Created and enabled device ${deviceName} for user ${username} on ${targetIface}`);
    }

    if (needSave) {
      saveConfigToFile();
      try {
        const status = run('wg show interfaces');
        if (status.includes(targetIface)) {
          run(`bash -c "wg syncconf ${targetIface} <(wg-quick strip ${targetIface})"`);
        }
      } catch (e) {
        console.error(`Error syncing ${targetIface}:`, e.message);
      }

      // Schedule auto-disable after specified hours via systemd-run
      // If a timer unit already exists for this peer, stop and reset it first
      try {
        const currentSettings = loadGlobalSettings();
        const disableHours = currentSettings.peerDisableHours || 12;
        const unitName = `wg-peer-expire-${username}-${deviceName}`;
        const escapedKey = publicKey.replace(/"/g, '\\"');

        try { run(`systemctl stop ${unitName}.timer`); } catch (_) { /* unit may not exist */ }
        try { run(`systemctl stop ${unitName}.service`); } catch (_) { /* unit may not exist */ }
        try { run(`systemctl reset-failed ${unitName}.service`); } catch (_) { /* ignore */ }
        run(`systemd-run --on-active=${disableHours}h --unit=${unitName} /usr/local/bin/wg_disable_peer.sh "${targetIface}" "${escapedKey}"`);
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

    res.json({
      success: true,
      allowedIPs,
      serverPublicKey: config.interface.publicKey,
      serverEndpoint: '172.16.0.128:51001',
      serverAllowedIPs: '10.0.0.1/32, 192.168.220.0/24'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) await connection.end();
    INTERFACE = originalInterface;
    CONFIG_FILE = originalConfigFile;
    config = originalConfigObj;
    updateSharedConfig();
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
}, 60 * 60 * 1000);

function normalizeCentralUrl(u) {
  if (!u) return '';
  const t = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(t)) return t;
  return `http://${t}`;
}

function registerWithCentral() {
  const centralBase = process.env.CENTRAL_URL;
  const secret = process.env.CENTRAL_REGISTER_SECRET;
  if (!centralBase || !secret) {
    return Promise.reject(new Error('CENTRAL_URL hoặc CENTRAL_REGISTER_SECRET chưa set'));
  }
  const base = normalizeCentralUrl(centralBase);
  // baseUrl gửi lên central = URL mà central dùng để poll /metrics (thường là SSH tunnel, ví dụ http://127.0.0.1:4000)
  const pollBase =
    process.env.CENTRAL_POLL_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://127.0.0.1:${PORT}`;
  const body = {
    name: process.env.CENTRAL_NODE_NAME || HOSTNAME,
    machineId: HOSTNAME,
    baseUrl: pollBase.replace(/\/+$/, ''),
    publicIp: process.env.CENTRAL_PUBLIC_IP || '',
    registerKey: secret
  };
  return fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Register-Key': secret },
    body: JSON.stringify(body)
  }).then(async (r) => {
    let payload = null;
    try {
      payload = await r.json();
    } catch {
      /* ignore */
    }
    if (!r.ok) {
      const msg =
        (payload && (payload.error || payload.message)) ||
        `central trả ${r.status} ${r.statusText}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return payload;
  });
}

function allowCentralRegister(req, res, next) {
  const headerKey = req.header('x-register-key') || '';
  const bodySecret =
    req.body && typeof req.body.secret === 'string' ? req.body.secret : '';
  const provided = headerKey || bodySecret;
  const hook = process.env.LOCAL_REGISTER_HOOK_KEY;
  const regSecret = process.env.CENTRAL_REGISTER_SECRET;
  if (hook && provided && provided === hook) return next();
  if (regSecret && provided && provided === regSecret) return next();
  if (req.session && req.session.user) return next();
  return res.status(401).json({
    success: false,
    error: 'Authentication required',
    hint:
      'Không khớp secret hoặc process Node không có CENTRAL_REGISTER_SECRET trong env. ' +
      'Dừng app, rồi chạy lại cùng lúc với biến: CENTRAL_REGISTER_SECRET=... node app.js ' +
      'Hoặc gửi header X-Register-Key / JSON {"secret":"..."} đúng secret. Đặt CENTRAL_URL dạng http://host:port'
  });
}

app.post('/api/central-register', allowCentralRegister, (req, res) => {
  registerWithCentral()
    .then((payload) => res.json({ success: true, central: payload }))
    .catch((e) => {
      const code = e.status >= 400 && e.status < 500 ? e.status : 502;
      res.status(code).json({ success: false, error: e.message });
    });
});

const httpsOptions = {
  key: fs.readFileSync(TLS_KEY_PATH),
  cert: fs.readFileSync(TLS_CERT_PATH)
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  // Load config from file on startup
  loadConfigFromFile();
  // Initialize shared config
  updateSharedConfig();
  console.log(`WireGuard VPN Manager running on https://localhost:${PORT}`);
  registerWithCentral().catch((e) => {
    console.error('[central register lúc khởi động]', e.message);
  });
  const regMs = parseInt(process.env.CENTRAL_REGISTER_INTERVAL_MS || '300000', 10);
  if (regMs > 0) {
    setInterval(() => {
      registerWithCentral().catch((e) => console.error('[central register định kỳ]', e.message));
    }, regMs);
  }
});