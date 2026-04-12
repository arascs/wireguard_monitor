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

// Ensure client keypair exists locally. The server only needs the public key.
function ensureClientKeypair() {
  let privateKey = '';
  if (fs.existsSync(CLIENT_PRIVATE_KEY_FILE)) {
    privateKey = fs.readFileSync(CLIENT_PRIVATE_KEY_FILE, 'utf8').trim();
  }

  if (!privateKey) {
    privateKey = run('wg genkey').trim();
    fs.writeFileSync(CLIENT_PRIVATE_KEY_FILE, privateKey, { mode: 0o600 });
  }

  const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();

  // Optional: persist public key for troubleshooting/inspection.
  try {
    fs.writeFileSync(CLIENT_PUBLIC_KEY_FILE, publicKey, { mode: 0o600 });
  } catch (e) {
    // ignore write errors; public key is still computed above
  }

  return { privateKey, publicKey };
}

// Helper to configure WireGuard interface from login response
function configureClientInterface({ allowedIPs, serverPublicKey, serverEndpoint, serverAllowedIPs }) {
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
AllowedIPs = ${serverAllowedIPs}
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

// Security check before connecting VPN
function runSecurityCheck() {
  const issues = [];

  // 1. Kernel version must be > 4
  try {
    const kernelVersion = run('uname -r').trim();
    const majorVersion = parseInt(kernelVersion.split('.')[0], 10);
    if (majorVersion <= 4) {
      issues.push(`Kernel version ${kernelVersion} is too old (must be > 4)`);
    }
  } catch (e) {
    issues.push('Cannot determine kernel version: ' + e.message);
  }

  // 2. SSH: PermitRootLogin yes (not commented)
  try {
    const sshdConfig = fs.readFileSync('/etc/ssh/sshd_config', 'utf8');
    const hasPermitRootLogin = sshdConfig.split('\n').some(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && /^PermitRootLogin\s+yes$/i.test(trimmed);
    });
    if (hasPermitRootLogin) {
      issues.push('SSH PermitRootLogin is set to yes');
    }
  } catch (e) {
    // File not readable or not present — skip
  }

  // 3. Firewall status
  try {
    run('which ufw');
    // ufw is available
    try {
      const ufwStatus = run('ufw status').trim();
      if (/^Status:\s*inactive/im.test(ufwStatus)) {
        issues.push('Firewall (ufw) is inactive');
      }
    } catch (e) {
      issues.push('Cannot check ufw status: ' + e.message);
    }
  } catch (_) {
    // ufw not found, fallback to iptables
    try {
      const iptablesOutput = run('iptables -L INPUT').trim();
      if (/Chain INPUT \(policy ACCEPT\)/i.test(iptablesOutput)) {
        issues.push('Firewall (iptables) INPUT policy is ACCEPT (no firewall rules)');
      }
    } catch (e) {
      issues.push('Cannot check iptables status: ' + e.message);
    }
  }

  return issues;
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

    // Read machine-id from local filesystem
    let machineId = '';
    try {
      machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch (e) {
      console.warn('Could not read /etc/machine-id:', e.message);
    }

    const { publicKey } = ensureClientKeypair();

    const enrollUrl = `http://${ip}:${port}/api/enroll-device`;
    const r = await fetch(enrollUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ username, deviceName, machineId, publicKey })
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

    // 7a. Security check
    const securityIssues = runSecurityCheck();
    if (securityIssues.length > 0) {
      return res.status(403).json({ success: false, error: 'Security check failed', issues: securityIssues });
    }

    // 7b. Check enrollment
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

    // 7c. Login and get config
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

    // 7d. Configure local interface
    configureClientInterface({
      allowedIPs: data.allowedIPs,
      serverPublicKey: data.serverPublicKey,
      serverEndpoint: data.serverEndpoint || `${ip}:51820`,
      serverAllowedIPs: data.serverAllowedIPs
    });

    // 7e. Save server public key to VPN_servers.json
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
    run("ip link delete wg_client");
    const data = await r.json();
    res.status(r.status).json(data);
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

// 10b. Get machine ID
app.get('/api/client/machine-id', (req, res) => {
  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    res.json({ success: true, machineId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, machineId: '' });
  }
});

// 11. Update peer key (called by server when server key changes)
app.post('/api/client/update-key', (req, res) => {
  try {
    const { oldPublicKey, newPublicKey } = req.body;
    if (!oldPublicKey || !newPublicKey) {
      return res.status(400).json({ success: false, error: 'Missing oldPublicKey or newPublicKey' });
    }

    const CLIENT_INTERFACE = 'wg_client';
    const CLIENT_CONFIG_FILE = path.join(CONFIG_DIR, `${CLIENT_INTERFACE}.conf`);

    if (!fs.existsSync(CLIENT_CONFIG_FILE)) {
      return res.status(404).json({ success: false, error: 'Client config file not found' });
    }

    let content = fs.readFileSync(CLIENT_CONFIG_FILE, 'utf8');
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const match = trimmed.match(/^PublicKey\s*=\s*(.+)$/i);
      if (match && match[1].trim() === oldPublicKey) {
        lines[i] = lines[i].replace(oldPublicKey, newPublicKey);
        updated = true;
        break;
      }
    }

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Peer with old public key not found' });
    }

    content = lines.join('\n');
    fs.writeFileSync(CLIENT_CONFIG_FILE, content, { mode: 0o600 });

    try {
      const status = run('wg show interfaces');
      if (status.includes(CLIENT_INTERFACE)) {
        run(`bash -c "wg syncconf ${CLIENT_INTERFACE} <(wg-quick strip ${CLIENT_INTERFACE})"`);
      }
    } catch (e) {
      console.error('Error syncing interface:', e.message);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Check WireGuard client connection status for each server based on public keys
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
        const publicKey = parts[0];        
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

// 14. Update peer key in client config
app.post('/api/client/update-peer-key', (req, res) => {
  try {
    const { serverIp, serverPort, newPublicKey } = req.body;
    if (!serverIp || !serverPort || !newPublicKey) {
      return res.status(400).json({ success: false, error: 'Missing serverIp, serverPort, or newPublicKey' });
    }

    const CLIENT_INTERFACE = 'wg_client';
    const CLIENT_CONFIG_FILE = path.join(CONFIG_DIR, `${CLIENT_INTERFACE}.conf`);

    if (!fs.existsSync(CLIENT_CONFIG_FILE)) {
      return res.status(404).json({ success: false, error: 'Client config file not found' });
    }

    // Get server public key from VPN_servers.json
    let serversData = { servers: [] };
    if (fs.existsSync(VPN_SERVERS_FILE)) {
      serversData = JSON.parse(fs.readFileSync(VPN_SERVERS_FILE, 'utf8'));
    }

    const server = serversData.servers.find(s => s.ip === serverIp && s.port === parseInt(serverPort));
    if (!server || !server.publicKey) {
      return res.status(404).json({ success: false, error: 'Server not found in VPN_servers.json' });
    }

    const oldPublicKey = server.publicKey;
    let content = fs.readFileSync(CLIENT_CONFIG_FILE, 'utf8');
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const match = trimmed.match(/^PublicKey\s*=\s*(.+)$/i);
      if (match && match[1].trim() === oldPublicKey) {
        lines[i] = lines[i].replace(oldPublicKey, newPublicKey);
        updated = true;
        break;
      }
    }

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Peer with server public key not found' });
    }

    content = lines.join('\n');
    fs.writeFileSync(CLIENT_CONFIG_FILE, content, { mode: 0o600 });

    // Update VPN_servers.json
    server.publicKey = newPublicKey;
    fs.writeFileSync(VPN_SERVERS_FILE, JSON.stringify(serversData, null, 2));

    try {
      const status = run('wg show interfaces');
      if (status.includes(CLIENT_INTERFACE)) {
        run(`bash -c "wg syncconf ${CLIENT_INTERFACE} <(wg-quick strip ${CLIENT_INTERFACE})"`);
      }
    } catch (e) {
      console.error('Error syncing interface:', e.message);
    }

    res.json({ success: true });
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