const express = require('express');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = '/etc/wireguard/';
const TRAFFIC_FILE = path.join(__dirname, '../../traffic_history.json');

function createMainDashboardRoutes({ mysql, dbConfig }) {
  const router = express.Router();

  async function getDeviceCount() {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute('SELECT COUNT(*) AS total FROM devices');
      return rows[0] && rows[0].total ? parseInt(rows[0].total, 10) : 0;
    } finally {
      if (connection) await connection.end();
    }
  }

  async function getSiteCount() {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute('SELECT COUNT(*) AS total FROM sites');
      return rows[0] && rows[0].total ? parseInt(rows[0].total, 10) : 0;
    } finally {
      if (connection) await connection.end();
    }
  }

// ── helpers ──────────────────────────────────────────────────────────────────

function parseInterfaceFile(filePath) {
    const result = { type: '', peers: [] };
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let section = null;
    let currentPeer = null;
    let peerName = '';
    let peerEnabled = true;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const isCommented = trimmed.startsWith('#');
        const clean = isCommented ? trimmed.substring(1).trim() : trimmed;
        if (!clean) continue;

        if (isCommented && clean.toLowerCase().startsWith('type =')) {
            result.type = clean.split('=').slice(1).join('=').trim();
            continue;
        }
        if (isCommented && clean.toLowerCase().startsWith('name =')) {
            peerName = clean.split('=').slice(1).join('=').trim();
            continue;
        }
        if (clean === '[Interface]') { section = 'interface'; continue; }
        if (clean === '[Peer]') {
            section = 'peer';
            currentPeer = { name: peerName, publicKey: '', enabled: !isCommented };
            peerEnabled = !isCommented;
            peerName = '';
            result.peers.push(currentPeer);
            continue;
        }
        if (section === 'peer' && currentPeer && clean.includes('=')) {
            const eqIdx = clean.indexOf('=');
            const key = clean.substring(0, eqIdx).trim().toLowerCase();
            const val = clean.substring(eqIdx + 1).trim();
            if (key === 'publickey') currentPeer.publicKey = val;
            if (!peerEnabled) currentPeer.enabled = false;
        }
    }
    return result;
}

function listConfInterfaces() {
    if (!fs.existsSync(CONFIG_DIR)) return [];
    return fs.readdirSync(CONFIG_DIR)
        .filter(f => f.endsWith('.conf'))
        .map(f => path.basename(f, '.conf'));
}

function getHandshakeTimestamp(ifaceName, peerPublicKey) {
    // Read from log files: /etc/wireguard/logs/<iface>/<peerIdx>/latest_handshake
    // We need to match by public key, so first find the peer index in the config
    const confPath = path.join(CONFIG_DIR, `${ifaceName}.conf`);
    const parsed = parseInterfaceFile(confPath);
    const peerIdx = parsed.peers.findIndex(p => p.publicKey === peerPublicKey);
    if (peerIdx < 0) return null;

    const hsFile = `/etc/wireguard/logs/${ifaceName}/${peerIdx}/latest_handshake`;
    try {
        if (!fs.existsSync(hsFile)) return null;
        const content = fs.readFileSync(hsFile, 'utf8').trim();
        const ts = parseInt(content.split(/\s+/)[0]);
        return isNaN(ts) ? null : ts;
    } catch (e) {
        return null;
    }
}

function buildActivePeers(type) {
    const nowSec = Math.floor(Date.now() / 1000);
    const THREE_MIN = 180;
    const ifaces = listConfInterfaces();
    const active = [];
    let total = 0;

    for (const ifaceName of ifaces) {
        const confPath = path.join(CONFIG_DIR, `${ifaceName}.conf`);
        const parsed = parseInterfaceFile(confPath);
        if (parsed.type !== type) continue;

        parsed.peers.forEach((peer, idx) => {
            if (!peer.enabled) return;
            total++;
            const hs = getHandshakeTimestamp(ifaceName, peer.publicKey);
            if (hs && (nowSec - hs) < THREE_MIN) {
                active.push({
                    peerIndex: idx,
                    interfaceName: ifaceName,
                    name: peer.name || peer.publicKey.substring(0, 12) + '…',
                    publicKey: peer.publicKey,
                    lastHandshake: hs
                });
            }
        });
    }
    return { active, total };
}

// ── Traffic read ──────────────────────────────────────────────────────────────

// GET /api/main-dashboard/traffic – return last 7 days
router.get('/traffic', (req, res) => {
    try {
        let records = [];
        if (fs.existsSync(TRAFFIC_FILE)) {
            try { records = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8')); } catch { records = []; }
        }
        res.json({ success: true, data: records.slice(-7) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/main-dashboard/active-devices
router.get('/active-devices', async (req, res) => {
    try {
        const { active } = buildActivePeers('Client');
        const totalDevices = await getDeviceCount();
        res.json({ success: true, active, totalDevices });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/main-dashboard/active-sites
router.get('/active-sites', async (req, res) => {
    try {
        const { active } = buildActivePeers('Site');
        const totalSites = await getSiteCount();
        res.json({ success: true, active, totalSites });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/main-dashboard/disable-peer
// Body: { interfaceName, peerIndex }
router.post('/disable-peer', (req, res) => {
    try {
        const { interfaceName, peerIndex } = req.body;
        if (!interfaceName || peerIndex === undefined) {
            return res.status(400).json({ success: false, error: 'Missing interfaceName or peerIndex' });
        }

        const confPath = path.join(CONFIG_DIR, `${interfaceName}.conf`);
        if (!fs.existsSync(confPath)) {
            return res.status(404).json({ success: false, error: 'Interface config not found' });
        }

        const lines = fs.readFileSync(confPath, 'utf8').split('\n');
        // Find the N-th [Peer] section (counting only non-commented occurrences by peer discovery order)
        // We replicate parseInterfaceFile logic to locate the correct peer's start line
        let peerCount = -1;
        let peerStart = -1;
        let peerEnd = -1;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            const isCommented = trimmed.startsWith('#');
            const clean = isCommented ? trimmed.substring(1).trim() : trimmed;
            if (clean === '[Peer]') {
                peerCount++;
                if (peerCount === parseInt(peerIndex)) {
                    peerStart = i;
                } else if (peerStart >= 0 && peerCount > parseInt(peerIndex)) {
                    peerEnd = i - 1;
                    break;
                }
            }
        }
        if (peerStart < 0) {
            return res.status(404).json({ success: false, error: 'Peer not found' });
        }
        if (peerEnd < 0) peerEnd = lines.length - 1;

        // Comment out all lines in the peer block (skip already-commented lines)
        for (let i = peerStart; i <= peerEnd; i++) {
            const l = lines[i];
            const trimmed = l.trim();
            if (!trimmed) continue;
            if (!trimmed.startsWith('#')) {
                lines[i] = '# ' + l;
            }
        }

        fs.writeFileSync(confPath, lines.join('\n'), { mode: 0o600 });

        // Sync if running
        try {
            const { execSync } = require('child_process');
            const running = execSync('wg show interfaces', { encoding: 'utf8' }).trim();
            if (running.split(/\s+/).includes(interfaceName)) {
                execSync(`bash -c "wg syncconf ${interfaceName} <(wg-quick strip ${interfaceName})"`);
            }
        } catch (_) { /* ignore sync errors */ }

        // Audit log
        try {
            const { logAction } = require('../auditLogger');
            const admin = req.session && req.session.user ? req.session.user : 'unknown';
            logAction(admin, 'disable_peer', { interface: interfaceName, peerIndex });
        } catch (e) {
            console.error('main-dashboard disable-peer audit error:', e.message);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('disable-peer error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

  return router;
}

module.exports = createMainDashboardRoutes;
