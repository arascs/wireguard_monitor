const express = require('express');
const fs = require('fs');
const path = require('path');
const { logAction } = require('../auditLogger');
const { notifyDeviceApproved, notifyDeviceRemoved } = require('../centralSync');
const { createDeviceHeartbeatManager, HEARTBEAT_TTL_SECONDS } = require('../deviceHeartbeat');

function createUserRoutes({ mysql, dbConfig, bcrypt, run, requireAuth, authenticateToken }) {
  const router = express.Router();
  const CONFIG_DIR = '/etc/wireguard/';
  let heartbeatManager;

  function getPeerLatestHandshakeEpochSeconds(interfaceName, publicKey) {
    if (!interfaceName || !publicKey) {
      return null;
    }

    let out = '';
    try {
      out = run(`wg show ${interfaceName} latest-handshakes`).trim();
    } catch (e) {
      return null;
    }

    if (!out) {
      return null;
    }
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) {
        continue;
      }
      const key = parts[0];
      const ts = parseInt(parts[1], 10);
      if (key === publicKey && !Number.isNaN(ts)) {
        return ts;
      }
    }
    return null;
  }

  function deletePeerByPublicKey(interfaceName, publicKey) {
    if (!interfaceName || !publicKey) {
      return { updated: false, reason: 'Missing interface or public key' };
    }

    const configFile = path.join(CONFIG_DIR, `${interfaceName}.conf`);
    if (!fs.existsSync(configFile)) {
      return { updated: false, reason: `${interfaceName}.conf not found` };
    }

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
    if (peerStarts.length === 0) {
      return { updated: false, reason: 'No peers in config' };
    }

    let updated = false;
    for (let s = peerStarts.length - 1; s >= 0; s--) {
      const start = peerStarts[s];
      const end = (s + 1 < peerStarts.length) ? (peerStarts[s + 1] - 1) : (lines.length - 1);

      let matches = false;
      for (let i = start; i <= end; i++) {
        const clean = lines[i].replace(/^\s*#\s*/, '').trim();
        const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
        if (m && m[1].trim() === publicKey) {
          matches = true;
          break;
        }
      }
      if (!matches) {
        continue;
      }

      // Delete all lines from start to end (peer section)
      let deleteEnd = end;
      while (deleteEnd < lines.length - 1 && lines[deleteEnd + 1].trim() === '') {
        deleteEnd++;
      }
      lines.splice(start, deleteEnd - start + 1);
      updated = true;
      break;
    }

    if (!updated) {
      return { updated: false, reason: 'Peer not found in config' };
    }

    fs.writeFileSync(configFile, lines.join('\n'), { mode: 0o600 });

    try {
      const interfaces = run('wg show interfaces').trim();
      if (interfaces.split(/\s+/).includes(interfaceName)) {
        run(`bash -c "wg syncconf ${interfaceName} <(wg-quick strip ${interfaceName})"`);
      }
    } catch (e) {
      // ignore sync errors; config file already updated
    }

    return { updated: true };
  }

  async function disconnectDeviceNow(username, deviceName) {
    if (!username || !deviceName) return { disconnected: false, reason: 'Missing username/deviceName' };
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT public_key, interface FROM devices WHERE device_name = ? AND username = ? ORDER BY id DESC LIMIT 1',
        [deviceName, username]
      );
      if (rows.length === 0 || !rows[0].public_key || !rows[0].interface) {
        return { disconnected: false, reason: 'Device not found' };
      }
      const result = deletePeerByPublicKey(rows[0].interface, rows[0].public_key);
      return { disconnected: !!result.updated, reason: result.reason || '' };
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  }

  async function initHeartbeat() {
    if (heartbeatManager) return;
    heartbeatManager = createDeviceHeartbeatManager({
      onExpiredDeviceKey: async (deviceKey) => {
        const idx = deviceKey.indexOf(':');
        if (idx < 1) return;
        const username = deviceKey.slice(0, idx);
        const deviceName = deviceKey.slice(idx + 1);
        if (!username || !deviceName) return;
        await disconnectDeviceNow(username, deviceName);
      }
    });
    await heartbeatManager.start();
  }

  initHeartbeat().catch((e) => {
    console.error('[heartbeat] init failed:', e.message);
  });

  function endpointHost(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (s.startsWith('[')) {
      const idx = s.indexOf(']');
      return idx > 1 ? s.slice(1, idx) : '';
    }
    const idx = s.lastIndexOf(':');
    if (idx > 0) return s.slice(0, idx);
    return s;
  }

  // Identity management
  router.get('/users', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, username, expire_day, create_day FROM users ORDER BY id DESC'
      );
      res.json({ success: true, users: rows });
    } catch (error) {
      console.error('Error loading users:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/users', requireAuth, async (req, res) => {
    const { username, password, expireDay } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const createEpoch = Math.floor(Date.now() / 1000);

      let expireEpoch = null;
      if (expireDay && !isNaN(expireDay)) {
        const days = parseInt(expireDay, 10);
        if (days > 0) {
          expireEpoch = createEpoch + (days * 24 * 60 * 60);
        }
      }

      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO users (username, password, expire_day, create_day) VALUES (?, ?, ?, ?)',
        [username, passwordHash, expireEpoch, createEpoch]
      );

      // audit log
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'create_user', { username });
      } catch (e) { }

      res.json({
        success: true,
        user: {
          username,
          expire_day: expireEpoch,
          create_day: createEpoch
        }
      });
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // Delete user
  router.delete('/users/:username', requireAuth, async (req, res) => {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ success: false, error: 'Missing username' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Get all devices for this user to get public keys
      const [devices] = await connection.execute(
        'SELECT public_key, interface FROM devices WHERE username = ?',
        [username]
      );

      // Delete peers from the device interface config for each device
      for (const device of devices) {
        if (device.public_key && device.interface) {
          deletePeerByPublicKey(device.interface, device.public_key);
        }
      }

      // Delete user from users table (devices will be deleted by foreign key cascade)
      await connection.execute(
        'DELETE FROM users WHERE username = ?',
        [username]
      );

      // audit
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'delete_user', { username });
      } catch (e) { }

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // Devices management
  router.get('/devices', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      // include status so frontend can know whether a device is enabled or disabled
      const [rows] = await connection.execute(
        'SELECT id, device_name, username, interface, allowed_ips, public_key, machine_id, expire_date, status FROM devices ORDER BY id DESC'
      );
      res.json({ success: true, devices: rows });
    } catch (error) {
      console.error('Error loading devices:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/devices/approve', requireAuth, async (req, res) => {
    const { id, interface: selectedInterface, allowedIPs, expireDate } = req.body || {};
    if (!id || !allowedIPs) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Get enrollment request info
      const [reqs] = await connection.execute(
        'SELECT device_name, username, machine_id, public_key FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

      if (reqs.length === 0) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }

      const reqItem = reqs[0];
      const deviceName = reqItem.device_name;
      const username = reqItem.username;
      const machineId = reqItem.machine_id;

      // Use the client's public key if provided
      let publicKey = reqItem.public_key;

      // Calculate expire epoch
      let expireEpoch = null;
      if (expireDate) {
        const expireDateObj = new Date(expireDate);
        if (!isNaN(expireDateObj.getTime())) {
          expireEpoch = Math.floor(expireDateObj.getTime() / 1000);
        }
      }

      // Insert into approved devices table
      await connection.execute(
        'INSERT INTO devices (device_name, username, interface, allowed_ips, public_key, machine_id, expire_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [deviceName, username, selectedInterface, allowedIPs, publicKey, machineId, expireEpoch, 1]
      );

      // audit
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'device_approve', {
          device_name: deviceName,
          user: username,
          interface: selectedInterface,
          allowed_ips: allowedIPs,
          public_key: publicKey,
          machine_id: machineId,
          expire_date: expireEpoch
        });
      } catch (e) { }

      // Remove enrollment request
      await connection.execute(
        'DELETE FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

      // Add peer to wg2 interface (disabled by default)
      const CONFIG_FILE = path.join(CONFIG_DIR, 'wg2.conf');
      if (fs.existsSync(CONFIG_FILE)) {
        let configContent = fs.readFileSync(CONFIG_FILE, 'utf8');

        const peerName = `${username}_${deviceName}`;
        const peerSection = `
# name = ${peerName}
# [Peer]
# PublicKey = ${publicKey}
# AllowedIPs = ${allowedIPs}
# PersistentKeepalive = 25
`;
        configContent += peerSection;
        fs.writeFileSync(CONFIG_FILE, configContent);
      }

      notifyDeviceApproved({
        machine_id: machineId,
        device_name: deviceName,
        public_key: publicKey,
        interface: selectedInterface
      });

      res.json({
        success: true,
        message: 'Device approved successfully'
      });
    } catch (error) {
      console.error('Error approving device:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // Delete device
  router.delete('/devices/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Get device info including public key
      const [devices] = await connection.execute(
        'SELECT public_key, interface, machine_id FROM devices WHERE id = ?',
        [id]
      );

      if (devices.length === 0) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }

      const device = devices[0];
      const machineId = device.machine_id;

      // Delete peer from interface config if public key exists
      if (device.public_key && device.interface) {
        const result = deletePeerByPublicKey(device.interface, device.public_key);
        if (!result.updated) {
          return res.status(500).json({ success: false, error: `Failed to update config: ${result.reason}` });
        }
      }

      // Delete device from database
      await connection.execute(
        'DELETE FROM devices WHERE id = ?',
        [id]
      );

      if (machineId) {
        notifyDeviceRemoved(machineId);
      }

      res.json({ success: true, message: 'Device deleted successfully' });
    } catch (error) {
      console.error('Error deleting device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.delete('/devices/by-machine/:machineId', async (req, res) => {
    const key = (req.header('x-register-key') || '').trim();
    if (!process.env.CENTRAL_REGISTER_SECRET || key !== process.env.CENTRAL_REGISTER_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const machineId = decodeURIComponent(req.params.machineId || '');
    if (!machineId) {
      return res.status(400).json({ success: false, error: 'machineId required' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, public_key, interface FROM devices WHERE machine_id = ?',
        [machineId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }
      for (const dev of rows) {
        if (dev.public_key && dev.interface) {
          deletePeerByPublicKey(dev.interface, dev.public_key);
        }
        await connection.execute('DELETE FROM devices WHERE id = ?', [dev.id]);
      }
      res.json({ success: true, message: 'Device removed' });
    } catch (error) {
      console.error('Error deleting device by machine:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.delete('/sites/by-endpoint', async (req, res) => {
    const key = (req.header('x-register-key') || '').trim();
    if (!process.env.CENTRAL_REGISTER_SECRET || key !== process.env.CENTRAL_REGISTER_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const endpoint = req.body && req.body.endpoint != null ? String(req.body.endpoint).trim() : '';
    const host = endpointHost(endpoint);
    if (!host) {
      return res.status(400).json({ success: false, error: 'endpoint required' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT site_pubkey, `interface`, site_endpoint FROM sites WHERE site_endpoint LIKE ?',
        [`${host}:%`]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Site not found' });
      }

      let removed = 0;
      for (const row of rows) {
        if (!row.site_pubkey || !row.interface) continue;
        const result = deletePeerByPublicKey(row.interface, row.site_pubkey);
        if (!result.updated) continue;
        await connection.execute('DELETE FROM sites WHERE site_pubkey = ?', [row.site_pubkey]);
        removed += 1;
      }

      res.json({ success: true, removed });
    } catch (error) {
      console.error('Error deleting site by endpoint:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // route for retrieving pending enrollment requests
  router.get('/enrollment-requests', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, device_name, username, status, machine_id, public_key FROM device_enrollment_requests ORDER BY id DESC'
      );
      res.json({ success: true, requests: rows });
    } catch (error) {
      console.error('Error loading enrollment requests:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/devices/decline', requireAuth, async (req, res) => {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing device id' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      // retrieve info to log
      const [reqs] = await connection.execute(
        'SELECT device_name, username FROM device_enrollment_requests WHERE id = ?',
        [id]
      );
      await connection.execute(
        'DELETE FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

      // audit
      if (reqs && reqs.length > 0) {
        try {
          const admin = req.session && req.session.user ? req.session.user : 'unknown';
          logAction(admin, 'device_decline', { device_name: reqs[0].device_name, user: reqs[0].username });
        } catch (e) { }
      }

      res.json({ success: true, message: 'Enrollment request declined' });
    } catch (error) {
      console.error('Error declining device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // Enroll device (client endpoint)
  router.post('/enroll-device', authenticateToken, async (req, res) => {
    const { deviceName, machineId, publicKey } = req.body || {};
    const username = req.user.username;
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Check if enrollment request already exists for this device and user
      const [existing] = await connection.execute(
        'SELECT id FROM device_enrollment_requests WHERE device_name = ? AND username = ?',
        [deviceName, username]
      );

      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: 'Enrollment request already exists for this device' });
      }

      // Create enrollment request in separate table
      await connection.execute(
        'INSERT INTO device_enrollment_requests (device_name, username, status, machine_id, public_key) VALUES (?, ?, "pending", ?, ?)',
        [deviceName, username, machineId || '', publicKey || null]
      );

      res.json({ success: true, message: 'Enrollment request submitted' });
    } catch (error) {
      console.error('Error enrolling device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  // Check user enroll status
  router.post('/check-device-enroll', authenticateToken, async (req, res) => {
    const { deviceName } = req.body || {};
    const username = req.user.username;
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Check if device is enrolled
      const [devices] = await connection.execute(
        'SELECT id FROM devices WHERE username = ? AND device_name = ?',
        [username, deviceName]
      );

      if (devices.length > 0) {
        res.json({ success: true, message: 'Device enrolled' });
      } else {
        res.json({ success: true, message: 'Device not enrolled' });
      }
    } catch (error) {
      console.error('Error checking enroll status:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/device-heartbeat', authenticateToken, async (req, res) => {
    const username = req.user.username;
    const { deviceName, jwtToken, securityInfo, hostname, machineId } = req.body || {};
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    const hasIdentity = !!(hostname && String(hostname).trim()) && !!(machineId && String(machineId).trim());
    const hasSecurity = !!securityInfo && securityInfo.sshRootLogin === false && securityInfo.firewallActive === true && securityInfo.kernelVersion !== null;
    const jwtOk = !!jwtToken && jwtToken === bearerToken;

    if (!jwtOk || !hasSecurity || !hasIdentity) {
      await disconnectDeviceNow(username, deviceName);
      if (heartbeatManager) {
        await heartbeatManager.clear(username, deviceName);
      }
      return res.status(403).json({ success: false, error: 'Heartbeat validation failed, device disconnected' });
    }

    await initHeartbeat();
    const touched = await heartbeatManager.touch(username, deviceName);
    res.json({ success: true, key: touched.key, ttl: touched.ttl });
  });

  router.post('/disable-device/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      // fetch info for log
      const [rows] = await connection.execute(
        'SELECT device_name, username FROM devices WHERE id = ?',
        [id]
      );
      await connection.execute(
        'UPDATE devices SET status = 0 WHERE id = ?',
        [id]
      );
      // audit
      if (rows && rows.length > 0) {
        try {
          const admin = req.session && req.session.user ? req.session.user : 'unknown';
          logAction(admin, 'disable_device', { device_name: rows[0].device_name, user: rows[0].username });
        } catch (e) { }
      }
      res.json({ success: true, message: 'Device disabled successfully' });
    } catch (error) {
      console.error('Error disabling device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/enable-device/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }
    let connection;
    try {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const newExpire = nowEpoch + 90 * 24 * 60 * 60; // 90 days from now

      connection = await mysql.createConnection(dbConfig);
      // fetch current expire_date in case it's still valid, also grab name/user for logging
      const [rows] = await connection.execute(
        'SELECT expire_date, device_name, username FROM devices WHERE id = ?',
        [id]
      );
      let expireEpoch = null;
      let deviceName = null;
      let deviceUser = null;
      if (rows.length > 0) {
        const cur = rows[0].expire_date;
        deviceName = rows[0].device_name;
        deviceUser = rows[0].username;
        if (!cur || cur < nowEpoch) {
          // reset only when missing or already expired
          expireEpoch = newExpire;
        } else {
          expireEpoch = cur; // leave existing
        }
      }

      if (expireEpoch !== null) {
        await connection.execute(
          'UPDATE devices SET status = 1, expire_date = ? WHERE id = ?',
          [expireEpoch, id]
        );
      } else {
        await connection.execute(
          'UPDATE devices SET status = 1 WHERE id = ?',
          [id]
        );
      }

      // audit
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'enable_device', { device_name: deviceName, user: deviceUser });
      } catch (e) { }

      res.json({ success: true, message: 'Device enabled successfully', expire_date: expireEpoch });
    } catch (error) {
      console.error('Error enabling device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });


  // edit expire date for a device (admin UI)
  router.post('/devices/:id/expire-date', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { expireDate } = req.body || {};
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }
    if (!expireDate || isNaN(expireDate)) {
      return res.status(400).json({ success: false, error: 'Invalid expire date' });
    }
    const expireEpoch = parseInt(expireDate, 10);

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'UPDATE devices SET expire_date = ? WHERE id = ?',
        [expireEpoch, id]
      );
      res.json({ success: true, expire_date: expireEpoch });
    } catch (error) {
      console.error('Error updating expire date:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/disconnect-vpn', authenticateToken, async (req, res) => {
    const deviceName = (req.body && (req.body.device_name || req.body.deviceName)) || '';
    const username = req.user.username;
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing device_name' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT public_key, interface FROM devices WHERE device_name = ? AND username = ? ORDER BY id DESC LIMIT 1',
        [deviceName, username]
      );

      if (rows.length === 0 || !rows[0].public_key || !rows[0].interface) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }

      const publicKey = rows[0].public_key;
      const iface = rows[0].interface;
      const latestHandshake = getPeerLatestHandshakeEpochSeconds(iface, publicKey);
      const isActive = latestHandshake !== null && latestHandshake > 0;

      if (!isActive) {
        return res.json({ success: true, active: false, disabled: false });
      }

      const result = deletePeerByPublicKey(iface, publicKey);
      if (!result.updated) {
        return res.status(404).json({ success: false, error: result.reason || 'Cannot disable peer' });
      }

      if (heartbeatManager) {
        await heartbeatManager.clear(username, deviceName);
      }

      res.json({ success: true, active: true, disabled: true });
    } catch (error) {
      console.error('Error disconnecting VPN:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  return router;
}

module.exports = createUserRoutes;

