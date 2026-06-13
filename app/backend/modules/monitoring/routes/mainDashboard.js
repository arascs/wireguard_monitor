const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  CONFIG_DIR,
  peerLogDir,
  disablePeerInConf,
  loadInterfaceConfig,
  findPeer
} = require('../../../common/wireguardConfig');

const TRAFFIC_FILE = '/etc/wireguard/logs/traffic_history.json';

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
      .filter((f) => f.endsWith('.conf'))
      .map((f) => path.basename(f, '.conf'));
  }

  function getHandshakeTimestamp(ifaceName, peerPublicKey) {
    const hsFile = path.join(peerLogDir(ifaceName, peerPublicKey), 'latest_handshake');
    try {
      if (!fs.existsSync(hsFile)) return null;
      const content = fs.readFileSync(hsFile, 'utf8').trim();
      const ts = parseInt(content.split(/\s+/)[0], 10);
      return Number.isNaN(ts) ? null : ts;
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

      parsed.peers.forEach((peer) => {
        if (!peer.enabled || !peer.publicKey) return;
        total++;
        const hs = getHandshakeTimestamp(ifaceName, peer.publicKey);
        if (hs && (nowSec - hs) < THREE_MIN) {
          active.push({
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

  router.get('/active-devices', async (req, res) => {
    try {
      const { active } = buildActivePeers('Client');
      const totalDevices = await getDeviceCount();
      res.json({ success: true, active, totalDevices });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/active-sites', async (req, res) => {
    try {
      const { active } = buildActivePeers('Site');
      const totalSites = await getSiteCount();
      res.json({ success: true, active, totalSites });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/disable-peer', (req, res) => {
    try {
      const { interfaceName, publicKey } = req.body;
      if (!interfaceName || !publicKey) {
        return res.status(400).json({ success: false, error: 'Missing interfaceName or publicKey' });
      }

      const parsed = loadInterfaceConfig(interfaceName);
      if (!findPeer(parsed, publicKey)) {
        return res.status(404).json({ success: false, error: 'Peer not found' });
      }

      const result = disablePeerInConf(interfaceName, publicKey);
      if (!result.updated) {
        return res.status(404).json({ success: false, error: result.reason || 'Peer not found' });
      }

      try {
        const { logAction } = require('../../logging/auditLogger');
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'disable_peer', { interface: interfaceName, publicKey });
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
