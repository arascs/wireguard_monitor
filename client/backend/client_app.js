#!/usr/bin/env node

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 5000;

const CONFIG_DIR = '/etc/wireguard/';
const CLIENT_PRIVATE_KEY_FILE = path.join(CONFIG_DIR, 'wg_client.key');
const CLIENT_PUBLIC_KEY_FILE = path.join(CONFIG_DIR, 'wg_client.pub');
const VPN_SERVERS_FILE = path.join(__dirname, 'VPN_servers.json');

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

// Helper to configure WireGuard interface from login response
function configureClientInterface({ allowedIPs, serverPublicKey, serverEndpoint }) {
  const CLIENT_INTERFACE = 'wg_client';
  const CLIENT_CONFIG_FILE = path.join(CONFIG_DIR, `${CLIENT_INTERFACE}.conf`);
  const privateKey = fs.readFileSync(CLIENT_PRIVATE_KEY_FILE, 'utf8').trim();

  const endpoint = serverEndpoint || '127.0.0.1:51820';
  const configContent = `[Interface]
PrivateKey = ${privateKey}
Address = ${allowedIPs}
ListenPort = 51000

[Peer]
PublicKey = ${serverPublicKey}
AllowedIPs = 0.0.0.0/0
Endpoint = ${endpoint}
PersistentKeepalive = 25
`;

  fs.writeFileSync(CLIENT_CONFIG_FILE, configContent, { mode: 0o600 });
  try {
    const status = run('wg show interfaces');
    if (status.includes(CLIENT_INTERFACE)) {
      run(`wg-quick down ${CLIENT_INTERFACE}`);
      run(`wg-quick up ${CLIENT_INTERFACE}`);
    } else {
      run(`wg-quick up ${CLIENT_INTERFACE}`);
    }
  } catch (e) {
    throw new Error('Start VPN failed: ' + e.message);
  }
}

// 1. Get VPN servers list
app.get('/api/client/servers', (req, res) => {
  if (!fs.existsSync(VPN_SERVERS_FILE)) {
    return res.json({ servers: [] });
  }
  const data = fs.readFileSync(VPN_SERVERS_FILE, 'utf8');
  res.json(JSON.parse(data));
});

// 2. Add VPN server
app.post('/api/client/servers', (req, res) => {
  try {
    const { name, ip, port } = req.body;
    if (!name || !ip || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let servers = [];
    if (fs.existsSync(VPN_SERVERS_FILE)) {
      const data = fs.readFileSync(VPN_SERVERS_FILE, 'utf8');
      servers = JSON.parse(data).servers || [];
    }

    // Check if server already exists
    if (servers.some(s => s.ip === ip && s.port === port)) {
      return res.status(409).json({ success: false, error: 'Server already exists' });
    }

    servers.push({ name, ip, port });
    fs.writeFileSync(VPN_SERVERS_FILE, JSON.stringify({ servers }, null, 2));
    res.json({ success: true, message: 'Server added' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Delete VPN server
app.delete('/api/client/servers/:ip/:port', (req, res) => {
  try {
    const { ip, port } = req.params;
    if (!ip || !port) {
      return res.status(400).json({ success: false, error: 'Missing ip or port' });
    }

    if (!fs.existsSync(VPN_SERVERS_FILE)) {
      return res.status(404).json({ success: false, error: 'Servers file not found' });
    }

    const data = fs.readFileSync(VPN_SERVERS_FILE, 'utf8');
    let { servers } = JSON.parse(data);
    
    servers = servers.filter(s => !(s.ip === ip && s.port === parseInt(port)));
    fs.writeFileSync(VPN_SERVERS_FILE, JSON.stringify({ servers }, null, 2));
    
    res.json({ success: true, message: 'Server deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Proxy login to VPN server
app.post('/api/client/login/:ip/:port', async (req, res) => {
  try {
    const { ip, port } = req.params;
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const loginUrl = `http://${ip}:${port}/api/login`;
    const r = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Proxy enroll-device (with JWT from client)
app.post('/api/client/enroll/:ip/:port', async (req, res) => {
  try {
    const { ip, port } = req.params;
    const { username, deviceName } = req.body;
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Missing Authorization header' });
    }

    const enrollUrl = `http://${ip}:${port}/api/enroll-device`;
    const r = await fetch(enrollUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ username, deviceName })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Proxy check-device-enroll (with JWT from client)
app.post('/api/client/check-enrollment/:ip/:port', async (req, res) => {
  try {
    const { ip, port } = req.params;
    const { username, deviceName } = req.body;
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Missing Authorization header' });
    }

    const checkUrl = `http://${ip}:${port}/api/check-device-enroll`;
    const r = await fetch(checkUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ username, deviceName })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Proxy user-login/connect (with JWT from client)
app.post('/api/client/connect/:ip/:port', async (req, res) => {
  try {
    const { ip, port } = req.params;
    const { username, deviceName } = req.body;
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Missing Authorization header' });
    }

    // 7a. Check enrollment
    const checkUrl = `http://${ip}:${port}/api/check-device-enroll`;
    let r = await fetch(checkUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ username, deviceName })
    });
    let data = await r.json();
    if (!data.success || data.message === 'Device not enrolled') {
      return res.status(400).json({ success: false, error: 'Device not enrolled' });
    }

    // 7b. Login and get config
    const loginUrl = `http://${ip}:${port}/api/connect-vpn`;
    r = await fetch(loginUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ username, deviceName })
    });
    data = await r.json();
    if (!data.success) return res.status(r.status).json(data);

    // 7c. Configure local interface
    configureClientInterface({
      allowedIPs: data.allowedIPs,
      serverPublicKey: data.serverPublicKey,
      serverEndpoint: data.serverEndpoint || `${ip}:51820`
    });

    // 7d. Save server public key to VPN_servers.json
    try {
      const serversData = JSON.parse(fs.readFileSync(VPN_SERVERS_FILE, 'utf8'));
      const server = serversData.servers.find(s => s.ip === ip && s.port === parseInt(port));
      if (server) {
        server.publicKey = data.serverPublicKey;
        fs.writeFileSync(VPN_SERVERS_FILE, JSON.stringify(serversData, null, 2));
      }
    } catch (saveError) {
      console.error('Error saving public key:', saveError);
    }

    res.json({ success: true, allowedIPs: data.allowedIPs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Proxy disconnect (with JWT from client)
app.post('/api/client/disconnect/:ip/:port', async (req, res) => {
  try {
    const { ip, port } = req.params;
    const { deviceName } = req.body;
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Missing Authorization header' });
    }

    const disconnectUrl = `http://${ip}:${port}/api/disconnect-vpn`;
    const r = await fetch(disconnectUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ deviceName })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Get client identity
app.get('/api/client/identity', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (!fs.existsSync(CLIENT_PRIVATE_KEY_FILE)) {
      const privateKey = run('wg genkey').trim();
      fs.writeFileSync(CLIENT_PRIVATE_KEY_FILE, privateKey, { mode: 0o600 });
      const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
      fs.writeFileSync(CLIENT_PUBLIC_KEY_FILE, publicKey, { mode: 0o644 });
    }

    if (!fs.existsSync(CLIENT_PUBLIC_KEY_FILE)) {
      const privateKey = fs.readFileSync(CLIENT_PRIVATE_KEY_FILE, 'utf8').trim();
      const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
      fs.writeFileSync(CLIENT_PUBLIC_KEY_FILE, publicKey, { mode: 0o644 });
    }

    const publicKey = fs.readFileSync(CLIENT_PUBLIC_KEY_FILE, 'utf8').trim();
    res.json({ success: true, publicKey });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Get device name
app.get('/api/client/device-name', (req, res) => {
  try {
    const hostname = fs.readFileSync('/etc/hostname', 'utf8').trim();
    res.json({ success: true, deviceName: hostname });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, deviceName: 'device' });
  }
});

// 11. Check WireGuard client connection status for each server based on public keys
app.get('/api/client/connection-status', (req, res) => {
  try {
    const serversData = JSON.parse(fs.readFileSync(VPN_SERVERS_FILE, 'utf8'));
    const servers = serversData.servers || [];

    const output = run('wg show wg_client dump').trim();
    const lines = output ? output.split('\n') : [];

    const peerMap = {};

    // Bỏ dòng interface
    const peerLines = lines.slice(1);

    for (const line of peerLines) {
      const parts = line.trim().split(/\s+/);

      if (parts.length >= 8) {
        const publicKey = parts[0];          // ✔ đúng field
        const handshake = parseInt(parts[4], 10);

        if (!isNaN(handshake)) {
          peerMap[publicKey] = handshake;
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);

    const status = servers.map(server => {
      const handshake = peerMap[server.publicKey] || 0;

      let connected = false;

      if (handshake > 0) {
        const age = now - handshake;
        connected = age <= 180;
      }

      return {
        ip: server.ip,
        port: server.port,
        connected,
        lastHandshake: handshake
      };
    });

    res.json({ servers: status });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check root
if (process.getuid && process.getuid() !== 0) {
  console.error('Error: Must run as root');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Client UI running at http://localhost:${PORT}`);
});