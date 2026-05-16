require('dotenv').config();
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const {
  sanitizeInterfaceName,
  loadInterfaceConfig,
  findPeer,
  peerLogDir
} = require('../lib/wireguardConfig');

const dbConfig = {
  host: process.env.WG_DB_HOST || 'localhost',
  user: process.env.WG_DB_USER || 'root',
  password: process.env.WG_DB_PASSWORD || 'root',
  database: process.env.WG_DB_NAME || 'wg_monitor'
};

async function getSiteRotationKey(iface, sitePubkey) {
  if (!sitePubkey) return '';
  try {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
      'SELECT site_rotation_key FROM sites WHERE site_pubkey = ? AND `interface` = ? LIMIT 1',
      [sitePubkey, iface]
    );
    await conn.end();
    if (!rows.length || rows[0].site_rotation_key == null) return '';
    return String(rows[0].site_rotation_key);
  } catch (e) {
    return '';
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getLatestValueFromLog(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.trim().split('\n').filter((line) => line.trim());
    if (lines.length === 0) return 0;
    const entry = JSON.parse(lines[lines.length - 1]);
    return entry.value || 0;
  } catch (e) {
    return 0;
  }
}

function getLatestHandshake(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const timestamp = parseInt(content.split('root')[0], 10);
    return Number.isNaN(timestamp) ? null : timestamp;
  } catch (e) {
    return null;
  }
}

function resolveIface(req, res) {
  const raw = req.query.interface || req.params.interface;
  if (!raw) {
    res.status(400).json({ error: 'Missing interface parameter' });
    return null;
  }
  const iface = sanitizeInterfaceName(decodeURIComponent(raw));
  if (!iface) {
    res.status(400).json({ error: 'Invalid interface name' });
    return null;
  }
  return iface;
}

router.get('/peers', async (req, res) => {
  const ifaceName = resolveIface(req, res);
  if (!ifaceName) return;

  try {
    const config = loadInterfaceConfig(ifaceName);
    const combinedPeers = config.peers.map((peer) => {
      const logDir = peer.publicKey ? peerLogDir(ifaceName, peer.publicKey) : null;
      const rxBytesFile = logDir ? path.join(logDir, 'rx_bytes.json') : '';
      const txBytesFile = logDir ? path.join(logDir, 'tx_bytes.json') : '';
      const handshakeFile = logDir ? path.join(logDir, 'latest_handshake') : '';

      const receivedBytes = getLatestValueFromLog(rxBytesFile);
      const sentBytes = getLatestValueFromLog(txBytesFile);
      const handshakeTime = getLatestHandshake(handshakeFile);

      return {
        publicKey: peer.publicKey || '',
        name: peer.name || '',
        isDisabled: peer.enabled === false,
        receivedBytes,
        sentBytes,
        totalBytes: receivedBytes + sentBytes,
        handshake: handshakeTime,
        endpoint: peer.endpoint || '',
        allowedIPs: peer.allowedIPs || '',
        persistentKeepalive: peer.persistentKeepalive || ''
      };
    });

    res.json(combinedPeers);
  } catch (error) {
    console.error('Error loading peers:', error);
    res.status(500).json({ error: 'Failed to load peers' });
  }
});

router.get('/:interface/peers/:publicKey', async (req, res) => {
  const ifaceName = sanitizeInterfaceName(req.params.interface);
  const publicKey = decodeURIComponent(req.params.publicKey || '');
  if (!ifaceName || !publicKey) {
    return res.status(400).json({ error: 'Invalid interface or public key' });
  }

  try {
    const config = loadInterfaceConfig(ifaceName);
    const peer = findPeer(config, publicKey);
    if (!peer) {
      return res.status(404).json({ error: 'Peer not found' });
    }

    const logDir = peerLogDir(ifaceName, publicKey);
    const receivedBytes = getLatestValueFromLog(path.join(logDir, 'rx_bytes.json'));
    const sentBytes = getLatestValueFromLog(path.join(logDir, 'tx_bytes.json'));
    const handshakeTimestamp = getLatestHandshake(path.join(logDir, 'latest_handshake'));

    const nowSec = Math.floor(Date.now() / 1000);
    let status = 'inactive';
    if (peer.enabled === false) {
      status = 'disabled';
    } else if (handshakeTimestamp && (nowSec - handshakeTimestamp) < 180) {
      status = 'active';
    }

    const rotationKey = await getSiteRotationKey(ifaceName, peer.publicKey || '');

    res.json({
      name: peer.name || '',
      publicKey: peer.publicKey || '',
      status,
      received: formatBytes(receivedBytes),
      sent: formatBytes(sentBytes),
      receivedBytes,
      sentBytes,
      totalBytes: receivedBytes + sentBytes,
      handshake: handshakeTimestamp,
      endpoint: peer.endpoint || '',
      allowedIPs: peer.allowedIPs || '',
      persistentKeepalive: peer.persistentKeepalive || '',
      presharedKey: peer.presharedKey || '',
      rotationKey
    });
  } catch (error) {
    console.error('Error in peer details API:', error);
    res.status(500).json({ error: 'Failed to load peer details' });
  }
});

router.get('/:id/stats', (req, res) => {
  const iface = sanitizeInterfaceName(req.params.id);
  if (!iface) {
    return res.status(400).json({ error: 'Invalid interface' });
  }
  const logDir = path.join('/etc/wireguard/logs', iface);

  const startTs = req.query.start ? parseInt(req.query.start, 10) * 1000 : null;
  const endTs = req.query.end ? parseInt(req.query.end, 10) * 1000 : null;
  const metrics = ['rx_bytes', 'tx_bytes', 'rx_dropped', 'tx_dropped'];
  const dataMap = new Map();

  try {
    metrics.forEach((metric) => {
      const filePath = path.join(logDir, `${metric}.json`);
      if (!fs.existsSync(filePath)) return;
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          const tsMs = entry.timestamp * 1000;
          if (!dataMap.has(tsMs)) dataMap.set(tsMs, { timestamp: tsMs });
          dataMap.get(tsMs)[metric] = entry.value;
        } catch (e) {
          console.error(`Error parsing line in ${metric}:`, line);
        }
      });
    });

    let result = Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    if (startTs !== null) result = result.filter((item) => item.timestamp >= startTs);
    if (endTs !== null) result = result.filter((item) => item.timestamp <= endTs);

    res.json(result.map((item) => ({
      timestamp: item.timestamp,
      rx_bytes: item.rx_bytes || 0,
      tx_bytes: item.tx_bytes || 0,
      rx_dropped: item.rx_dropped || 0,
      tx_dropped: item.tx_dropped || 0,
      iface
    })));
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs' });
  }
});

router.get('/:interface/peers/:publicKey/stats', (req, res) => {
  const ifaceName = sanitizeInterfaceName(req.params.interface);
  const publicKey = decodeURIComponent(req.params.publicKey || '');
  if (!ifaceName || !publicKey) {
    return res.status(400).json({ error: 'Invalid interface or public key' });
  }

  const logDir = peerLogDir(ifaceName, publicKey);
  const startTs = req.query.start ? parseInt(req.query.start, 10) * 1000 : null;
  const endTs = req.query.end ? parseInt(req.query.end, 10) * 1000 : null;
  const metrics = ['rx_bytes', 'tx_bytes'];
  const dataMap = new Map();

  try {
    metrics.forEach((metric) => {
      const filePath = path.join(logDir, `${metric}.json`);
      if (!fs.existsSync(filePath)) return;
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          const tsMs = entry.timestamp * 1000;
          if (!dataMap.has(tsMs)) dataMap.set(tsMs, { timestamp: tsMs });
          dataMap.get(tsMs)[metric] = entry.value;
        } catch (e) {
          console.error(`Error parsing line in ${metric}:`, line);
        }
      });
    });

    let result = Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    if (startTs !== null) result = result.filter((item) => item.timestamp >= startTs);
    if (endTs !== null) result = result.filter((item) => item.timestamp <= endTs);

    res.json(result.map((item) => ({
      timestamp: item.timestamp,
      rx_bytes: item.rx_bytes || 0,
      tx_bytes: item.tx_bytes || 0
    })));
  } catch (error) {
    console.error('Error reading peer logs:', error);
    res.status(500).json({ error: 'Failed to read peer logs' });
  }
});

router.get('/:interface/peer/:peerName/connections', (req, res) => {
  const interfaceName = sanitizeInterfaceName(req.params.interface);
  const peerName = req.params.peerName;
  const STATUS_FILE = '/dev/shm/vpn_live_status.json';

  try {
    if (!interfaceName) {
      return res.status(400).json({ error: 'Invalid interface' });
    }
    if (!fs.existsSync(STATUS_FILE)) {
      return res.json({
        last_updated: null,
        active_connections_count: 0,
        sessions: []
      });
    }

    const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    const filteredSessions = data.sessions.filter(
      (session) => session.interface === interfaceName && session.peer_name === peerName
    );

    res.json({
      last_updated: data.last_updated,
      active_connections_count: filteredSessions.length,
      sessions: filteredSessions
    });
  } catch (error) {
    console.error('Error reading connections file:', error);
    res.status(500).json({ error: 'Failed to read connections' });
  }
});

module.exports = router;
