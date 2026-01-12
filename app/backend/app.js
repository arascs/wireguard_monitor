#!/usr/bin/env node

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const dashboardRoutes = require('./routes/dashboard');
const { HOSTNAME } = require('./config');

const app = express();
const PORT = 3000;

const CONFIG_DIR = '/etc/wireguard/';
let INTERFACE = 'wgA';
let CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
const FRONTEND_DIR = path.join(__dirname, '../frontend');
const CREDENTIALS_FILE = '/etc/wireguard/credentials.txt';

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
    keyExpiryDays: 90
  },
  peers: []
};


app.use(express.json());
app.use(session({ secret: 'wireguard-secret-key', resave: false, saveUninitialized: false }));

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
function requireAuth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
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
          keyExpiryDays: 90
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
        keyExpiryDays: 90
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
            config.interface.keyExpiryDays = parseInt(value) || 90;
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
  const summary = { publicKey: '', address: '' };
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
      if (line.startsWith('#')) {
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
      status: activeSet.has(interfaceName) ? 'connected' : 'disconnected'
    };
  });
}

function buildConfigFileContent() {
  let content = '[Interface]\n';
  
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
    content += `${prefix}Endpoint = ${peer.endpoint}\n`;
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
  if (config.peers.length === 0) {
    const err = new Error('No peers configured');
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

// Generate keys
app.post('/api/generate-keys', (req, res) => {
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
  
    const oldPublicKey = config.interface.publicKey || '';
    const newPrivateKey = run('wg genkey').trim();
    const newPublicKey = run(`echo "${newPrivateKey}" | wg pubkey`).trim();
    
    config.interface.privateKey = newPrivateKey;
    config.interface.publicKey = newPublicKey;
    config.interface.keyCreationDate = new Date().toISOString();
    
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
    
    res.json({ 
      success: true, 
      oldPublicKey: oldPublicKey,
      newPublicKey: newPublicKey,
      peers: config.peers.map(peer => ({
        publicKey: peer.publicKey,
        endpoint: peer.endpoint
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Configure interface
app.post('/api/configure-interface', (req, res) => {
  try {
    config.interface.address = req.body.address || '';
    config.interface.listenPort = req.body.listenPort || '51820';
    config.interface.dns = req.body.dns || '';
    config.interface.table = req.body.table || '';
    config.interface.mtu = req.body.mtu || '1420';
    config.interface.preUp = req.body.preUp || '';
    config.interface.postUp = req.body.postUp || '';
    config.interface.preDown = req.body.preDown || '';
    config.interface.postDown = req.body.postDown || '';
    
    if (req.body.keyExpiryDays) {
      config.interface.keyExpiryDays = parseInt(req.body.keyExpiryDays) || 90;
    }
    
    let savedContent = null;
    if (req.body.saveToFile) {
      try {
        savedContent = saveConfigToFile();
      } catch (error) {
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, error: error.message });
      }
    }
    
    updateSharedConfig();
    res.json({ success: true, config, content: savedContent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add peer
app.post('/api/add-peer', (req, res) => {
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Key has expired. Please generate new keys and reconfigure interface first.' 
      });
    }
    
    // Check if interface is configured
    if (!config.interface.privateKey || !config.interface.address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Interface not configured. Please configure interface first.' 
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
      peer.name = req.body.name !== undefined ? req.body.name : peer.name;
      peer.publicKey = req.body.publicKey !== undefined ? req.body.publicKey : peer.publicKey;
      peer.endpoint = req.body.endpoint !== undefined ? req.body.endpoint : peer.endpoint;
      peer.allowedIPs = req.body.allowedIPs !== undefined ? req.body.allowedIPs : peer.allowedIPs;
      peer.persistentKeepalive = req.body.persistentKeepalive !== undefined ? req.body.persistentKeepalive : peer.persistentKeepalive;
      if (req.body.presharedKey !== undefined) {
        peer.presharedKey = req.body.presharedKey;
      }
      
      updateSharedConfig();
      res.json({ success: true, peer });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete peer
app.delete('/api/delete-peer/:index', (req, res) => {
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
      config.peers.splice(idx, 1);
      updateSharedConfig();
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enable peer
app.post('/api/enable-peer/:index', (req, res) => {
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
      config.peers[idx].enabled = true;
      updateSharedConfig();
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
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
    } catch (e) {}
    
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
    run(`wg-quick down ${INTERFACE}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restart VPN
app.post('/api/restart-vpn', (req, res) => {
  try {
    // Check if key is expired
    if (isKeyExpired()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Key has expired. Cannot restart VPN. Please generate new keys first.' 
      });
    }
    
    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(404).json({ 
        success: false, 
        error: 'Config file not found. Save configuration first.' 
      });
    }
    
    run(`wg-quick down ${INTERFACE}`);
    run(`wg-quick up ${INTERFACE}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

app.get('/login', (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'login.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace('{{HOSTNAME}}', HOSTNAME);
  res.send(html);
});

app.post('/api/login', async (req, res) => {
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

function renderHtmlWithHostname(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/\{\{HOSTNAME\}\}/g, HOSTNAME);
  return html;
}

app.get('/', requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'index.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.get(['/editInterface/:id', '/addInterface/:id'], requireAuth, (req, res) => {
  const htmlPath = path.join(FRONTEND_DIR, 'interface_config.html');
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

app.get('/dashboard/:id/peer/:peer_id', requireAuth, (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/peer_detail.html');
  res.send(renderHtmlWithHostname(htmlPath));
});

app.use('/api/dashboard', dashboardRoutes);

// Synchronize keys
app.post('/api/sync-keys', (req, res) => {
  try {
    run('python3 /usr/local/bin/wg-sync-key.py');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

app.listen(PORT, () => {
  // Load config from file on startup
  loadConfigFromFile();
  // Initialize shared config
  updateSharedConfig();
  console.log(`WireGuard VPN Manager running on http://localhost:${PORT}`);
});