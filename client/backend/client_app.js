#!/usr/bin/env node

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 5000;

// Cấu hình đường dẫn
const CONFIG_DIR = '/etc/wireguard/';
const CLIENT_PRIVATE_KEY_FILE = path.join(CONFIG_DIR, 'wg_client.key');
const CLIENT_PUBLIC_KEY_FILE = path.join(CONFIG_DIR, 'wg_client.pub');
const VPN_SERVERS_FILE = path.join(__dirname, 'VPN_servers.json');

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend'))); // Phục vụ file frontend

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

// 1. API: Lấy danh sách VPN Servers
app.get('/api/servers', (req, res) => {
  if (!fs.existsSync(VPN_SERVERS_FILE)) {
    return res.json({ servers: [] });
  }
  const data = fs.readFileSync(VPN_SERVERS_FILE, 'utf8');
  res.json(JSON.parse(data));
});

// 2. API: Lấy Public Key (Tự tạo nếu chưa có)
app.get('/api/client-identity', (req, res) => {
  try {
    // Tạo thư mục nếu chưa có
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Nếu chưa có Private Key -> Tạo mới
    if (!fs.existsSync(CLIENT_PRIVATE_KEY_FILE)) {
      const privateKey = run('wg genkey').trim();
      fs.writeFileSync(CLIENT_PRIVATE_KEY_FILE, privateKey, { mode: 0o600 });
      
      // Tạo luôn Public Key từ Private Key vừa tạo
      const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
      fs.writeFileSync(CLIENT_PUBLIC_KEY_FILE, publicKey, { mode: 0o644 });
    }

    // Đảm bảo file Public Key tồn tại (trường hợp có key private nhưng mất key public)
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

// 3. API: Xử lý response từ server login (Code cũ của bạn)
app.post('/api/handle-login-response', (req, res) => {
  try {
    const { allowedIPs, serverPublicKey, serverEndpoint } = req.body; // Thêm serverEndpoint nếu server trả về

    if (!allowedIPs || !serverPublicKey) {
      return res.status(400).json({ success: false, error: 'Missing config data' });
    }

    // Endpoint mặc định nếu server không trả về (lấy từ logic frontend gửi xuống hoặc fix cứng)
    // Ở bài trước server login trả về serverEndpoint
    const endpoint = serverEndpoint || '172.16.0.128:51820'; 

    const CLIENT_INTERFACE = 'wg_client';
    const CLIENT_CONFIG_FILE = path.join(CONFIG_DIR, `${CLIENT_INTERFACE}.conf`);

    const privateKey = fs.readFileSync(CLIENT_PRIVATE_KEY_FILE, 'utf8').trim();

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
        return res.status(500).json({ success: false, error: 'Start VPN failed: ' + e.message });
    }

    res.json({ success: true, message: 'Connected successfully!' });
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