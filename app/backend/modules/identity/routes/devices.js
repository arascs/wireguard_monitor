const express = require('express');
const fs = require('fs');
const path = require('path');
const { logAction } = require('../../logging/auditLogger');
const { deletePeerFromConf } = require('../../../common/wireguardConfig');
const { registerExpireHandler, touch: heartbeatTouch, clear: heartbeatClear } = require('../services/deviceHeartbeat');
const {
  collectSecurityPolicyIssues,
  formatIssues,
  normalizeSettings
} = require('../../../common/securityChecks');

function createDeviceRoutes({ mysql, dbConfig, run, requireAuth, authenticateToken }) {
  const router = express.Router();
  const CONFIG_DIR = '/etc/wireguard/';
  const SETTINGS_FILE = require('../../../common/paths').SETTINGS_FILE;

  function loadSecuritySettings() {
    const defaults = {
      enforceKernelCheck: true,
      minKernelVersionLinux: 4,
      minKernelVersionWindows: 10,
      enforceFirewallLinux: true,
      enforceFirewallWindows: true,
      enforcePasswordRequiredLinux: true,
      enforcePasswordRequiredWindows: true
    };
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return defaults;
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return normalizeSettings({ ...defaults, ...JSON.parse(raw) });
    } catch (_) {
      return defaults;
    }
  }

  function normalizeDeviceOs(os) {
    const v = String(os || '').trim().toLowerCase();
    return v === 'linux' || v === 'windows' ? v : '';
  }

  function getPeerLatestHandshakeEpochSeconds(interfaceName, publicKey) {
    if (!interfaceName || !publicKey) {
      return null;
    }

    let out = '';
    try {
      out = run('wg', ['show', interfaceName, 'latest-handshakes']).trim();
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
      const result = deletePeerFromConf(rows[0].interface, rows[0].public_key);
      return { disconnected: !!result.updated, reason: result.reason || '' };
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  }

  registerExpireHandler(async (deviceKey) => {
    const idx = deviceKey.indexOf(':');
    if (idx < 1) return;
    const username = deviceKey.slice(0, idx);
    const deviceName = deviceKey.slice(idx + 1);
    if (!username || !deviceName) return;
    await disconnectDeviceNow(username, deviceName);
  });

  router.get('/devices', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, device_name, username, interface, allowed_ips, public_key, machine_id, os, expire_date, status, last_seen FROM devices ORDER BY id DESC'
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

      const [reqs] = await connection.execute(
        'SELECT device_name, username, machine_id, public_key, os FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

      if (reqs.length === 0) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }

      const reqItem = reqs[0];
      const deviceName = reqItem.device_name;
      const username = reqItem.username;
      const machineId = reqItem.machine_id;
      const deviceOs = normalizeDeviceOs(reqItem.os);

      let publicKey = reqItem.public_key;

      let expireEpoch = null;
      if (expireDate) {
        const expireDateObj = new Date(expireDate);
        if (!isNaN(expireDateObj.getTime())) {
          expireEpoch = Math.floor(expireDateObj.getTime() / 1000);
        }
      }

      await connection.execute(
        'INSERT INTO devices (device_name, username, interface, allowed_ips, public_key, machine_id, os, expire_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [deviceName, username, selectedInterface, allowedIPs, publicKey, machineId, deviceOs || null, expireEpoch, 1]
      );

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

      await connection.execute(
        'DELETE FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

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

  router.delete('/devices/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      const [devices] = await connection.execute(
        'SELECT public_key, interface, machine_id FROM devices WHERE id = ?',
        [id]
      );

      if (devices.length === 0) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }

      const device = devices[0];

      if (device.public_key && device.interface) {
        const result = deletePeerFromConf(device.interface, device.public_key);
        if (!result.updated) {
          if (result.reason === 'Peer not found in config' || result.reason === 'No peers in config') {
            console.log(`[INFO] Ignored config error when deleting device ${id}: ${result.reason}`);
          } else {
            return res.status(500).json({ success: false, error: `Failed to update config: ${result.reason}` });
          }
        }
      }

      await connection.execute(
        'DELETE FROM devices WHERE id = ?',
        [id]
      );

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
          deletePeerFromConf(dev.interface, dev.public_key);
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

  router.get('/enrollment-requests', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, device_name, username, status, machine_id, public_key, os FROM device_enrollment_requests ORDER BY id DESC'
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
      const [reqs] = await connection.execute(
        'SELECT device_name, username FROM device_enrollment_requests WHERE id = ?',
        [id]
      );
      await connection.execute(
        'DELETE FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

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

  router.post('/enroll-device', authenticateToken, async (req, res) => {
    const { deviceName, machineId, publicKey, os } = req.body || {};
    const username = req.user.username;
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }
    const deviceOs = normalizeDeviceOs(os);
    if (!deviceOs) {
      return res.status(400).json({ success: false, error: 'Missing or invalid os (linux or windows)' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      const [existing] = await connection.execute(
        'SELECT id FROM device_enrollment_requests WHERE device_name = ? AND username = ?',
        [deviceName, username]
      );

      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: 'Enrollment request already exists for this device' });
      }

      await connection.execute(
        'INSERT INTO device_enrollment_requests (device_name, username, status, machine_id, public_key, os) VALUES (?, ?, "pending", ?, ?, ?)',
        [deviceName, username, machineId || '', publicKey || null, deviceOs]
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

  router.post('/check-device-enroll', authenticateToken, async (req, res) => {
    const { deviceName } = req.body || {};
    const username = req.user.username;
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

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
    const { deviceName, securityInfo, machineId } = req.body || {};

    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing deviceName' });
    }

    let connection;
    try {
      const settings = loadSecuritySettings();
      const issues = collectSecurityPolicyIssues(securityInfo, settings);

      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT machine_id FROM devices WHERE username = ? AND device_name = ? ORDER BY id DESC LIMIT 1',
        [username, deviceName]
      );
      if (rows.length === 0) {
        issues.push('Device not found');
      } else {
        const dbMachineId = String(rows[0].machine_id || '').trim();
        const providedMachineId = String(machineId || '').trim();
        if (!dbMachineId || !providedMachineId || dbMachineId !== providedMachineId) {
          issues.push('Machine ID mismatch');
        }
      }

      if (issues.length > 0) {
        await disconnectDeviceNow(username, deviceName);
        await heartbeatClear(username, deviceName);
        return res.status(403).json({
          success: false,
          error: `Validation failed: ${formatIssues(issues)}`,
          issues
        });
      }

      const touched = await heartbeatTouch(username, deviceName);
      res.json({ success: true, key: touched.key, ttl: touched.ttl });
    } catch (error) {
      console.error('Heartbeat error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/disable-device/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT device_name, username FROM devices WHERE id = ?',
        [id]
      );
      await connection.execute(
        'UPDATE devices SET status = 0 WHERE id = ?',
        [id]
      );
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
      const newExpire = nowEpoch + 90 * 24 * 60 * 60;

      connection = await mysql.createConnection(dbConfig);
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
          expireEpoch = newExpire;
        } else {
          expireEpoch = cur;
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

      const result = deletePeerFromConf(iface, publicKey);
      if (!result.updated) {
        return res.status(404).json({ success: false, error: result.reason || 'Cannot disable peer' });
      }

      await heartbeatClear(username, deviceName);

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

module.exports = createDeviceRoutes;
