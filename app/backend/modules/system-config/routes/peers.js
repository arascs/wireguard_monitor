const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const mysql = require('mysql2/promise');
const { run } = require('../../../common/runCmd');
const { dbConfig } = require('../../../common/db');
const { logAction } = require('../../logging/auditLogger');
const { secretStringsMatch } = require('../../../common/auth');
const { DEFAULT_KEY_EXPIRY_DAYS } = require('../../../common/paths');
const {
  CONFIG_DIR,
  loadInterfaceConfig,
  saveInterfaceConfig,
  isKeyExpired: isInterfaceKeyExpired,
  findPeerIndex,
  wgPubkey,
  wgSyncconf,
  wgSyncconfIfRunning,
  sanitizeInterfaceName
} = require('../../../common/wireguardConfig');
const { listInterfaces } = require('../services/interfaceList');
const { hydrateRotationKeysFromDb } = require('../services/rotationKeys');
const { loadGlobalSettings } = require('../../../common/settings');

module.exports = function createPeerRoutes() {
  const router = express.Router();

  router.post('/interfaces/:interface/generate-keys', async (req, res) => {
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
      } catch (e) { /* ignore */ }

      const peersSummary = config.peers.map((peer) => ({
        publicKey: peer.publicKey,
        endpoint: peer.endpoint
      }));

      const rotationTimeoutSec = loadGlobalSettings().keyRotationTimeoutSeconds || 60;
      const rotationTimeoutMs = rotationTimeoutSec * 1000;

      for (const peer of config.peers) {
        if (!peer.endpoint) continue;
        const endpointParts = peer.endpoint.split(':');
        if (endpointParts.length !== 2) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), rotationTimeoutMs);
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
            console.error(`[Key rotation] Timeout notifying peer ${peer.endpoint}: no success response within ${rotationTimeoutSec}s`);
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

  router.post('/interfaces/:interface/configure', (req, res) => {
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
          } catch (e) { /* ignore */ }
        }
      }

      res.json({ success: true, config, content: savedContent });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/interfaces/:interface/peers', async (req, res) => {
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
      } catch (e) { /* ignore */ }
      res.json({ success: true, peer });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.put('/interfaces/:interface/peers/:publicKey', async (req, res) => {
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

  router.delete('/interfaces/:interface/peers/:publicKey', async (req, res) => {
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
      } catch (e) { /* ignore */ }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/interfaces/:interface/peers/:publicKey/enable', async (req, res) => {
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
      } catch (e) { /* ignore */ }
      res.json({ success: true, peer: config.peers[idx] });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) {
        try { await connection.end(); } catch (e) { /* ignore */ }
      }
    }
  });

  router.post('/interfaces/:interface/peers/:publicKey/disable', (req, res) => {
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
      } catch (e) { /* ignore */ }
      res.json({ success: true, peer: config.peers[idx] });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/update-key', async (req, res) => {
    try {
      const { oldPublicKey, newPublicKey, rotationKey } = req.body || {};
      if (!oldPublicKey || !newPublicKey) {
        return res.status(400).json({ success: false, error: 'Missing oldPublicKey or newPublicKey' });
      }

      const interfaces = listInterfaces();
      let foundInterface = null;
      let foundConfigFile = null;
      let foundLines = null;
      let peerStartIndex = -1;
      let peerEndIndex = -1;

      for (const iface of interfaces) {
        const configFile = path.join(CONFIG_DIR, `${iface.name}.conf`);
        if (!fs.existsSync(configFile)) continue;

        const content = fs.readFileSync(configFile, 'utf8');
        const lines = content.split('\n');
        const peerStarts = [];

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i].trim();
          const clean = raw.replace(/^#\s*/, '').trim();
          if (clean === '[Peer]') {
            peerStarts.push(i);
          }
        }

        for (let s = 0; s < peerStarts.length; s++) {
          const start = peerStarts[s];
          const end = (s + 1 < peerStarts.length) ? (peerStarts[s + 1] - 1) : (lines.length - 1);

          for (let i = start; i <= end; i++) {
            const clean = lines[i].replace(/^\s*#\s*/, '').trim();
            const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
            if (m && m[1].trim() === oldPublicKey) {
              foundInterface = iface.name;
              foundConfigFile = configFile;
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

      for (let i = peerStartIndex; i <= peerEndIndex; i++) {
        const clean = foundLines[i].replace(/^\s*#\s*/, '').trim();
        const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
        if (m && m[1].trim() === oldPublicKey) {
          foundLines[i] = foundLines[i].replace(oldPublicKey, newPublicKey);
          break;
        }
      }

      fs.writeFileSync(foundConfigFile, foundLines.join('\n'), { mode: 0o600 });

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
      } catch (e) { /* ignore */ }

      res.json({ success: true, interface: foundInterface });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
};
