const express = require('express');
const fs = require('fs');
const path = require('path');

function createUserRoutes({ mysql, dbConfig, bcrypt, run, requireAuth }) {
  const router = express.Router();
  const CONFIG_DIR = '/etc/wireguard/';

  function getPeerLatestHandshakeEpochSeconds(publicKey) {
    const out = run('wg show wg2 latest-handshakes').trim();
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

  function disablePeerInWgCConfigByPublicKey(publicKey) {
    const configFile = path.join(CONFIG_DIR, 'wg2.conf');
    if (!fs.existsSync(configFile)) {
      return { updated: false, reason: 'wg2.conf not found' };
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
      if (interfaces.split(/\s+/).includes('wg2')) {
        run('bash -c "wg syncconf wg2 <(wg-quick strip wg2)"');
      }
    } catch (e) {
      // ignore sync errors; config file already updated
    }

    return { updated: true };
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
        'SELECT public_key FROM devices WHERE username = ?',
        [username]
      );

      // Delete/disable peers in wg2.conf for each device
      for (const device of devices) {
        if (device.public_key) {
          disablePeerInWgCConfigByPublicKey(device.public_key);
        }
      }

      // Delete user from users table (devices will be deleted by foreign key cascade)
      await connection.execute(
        'DELETE FROM users WHERE username = ?',
        [username]
      );

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
      const [rows] = await connection.execute(
        'SELECT id, device_name, username, allowed_ips, public_key FROM devices ORDER BY id DESC'
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
    const { id, allowedIPs } = req.body || {};
    if (!id || !allowedIPs) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Get enrollment request info
      const [reqs] = await connection.execute(
        'SELECT device_name, username FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

      if (reqs.length === 0) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }

      const reqItem = reqs[0];
      const deviceName = reqItem.device_name;
      const username = reqItem.username;

      // Generate key pair
      const privateKey = run('wg genkey').trim();
      const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
      const privateKeyHash = await bcrypt.hash(privateKey, 10);

      // Insert into approved devices table
      await connection.execute(
        'INSERT INTO devices (device_name, username, allowed_ips, private_key, public_key) VALUES (?, ?, ?, ?, ?)',
        [deviceName, username, allowedIPs, privateKeyHash, publicKey]
      );

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

      res.json({
        success: true,
        privateKey,
        message: 'Device approved successfully'
      });
    } catch (error) {
      console.error('Error approving device:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
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
        'SELECT id, device_name, username, status FROM device_enrollment_requests ORDER BY id DESC'
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
      await connection.execute(
        'DELETE FROM device_enrollment_requests WHERE id = ?',
        [id]
      );

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
  router.post('/enroll-device', async (req, res) => {
    const { username, password, deviceName } = req.body || {};
    if (!username || !password || !deviceName) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Check user credentials
      const [users] = await connection.execute(
        'SELECT password FROM users WHERE username = ?',
        [username]
      );

      if (users.length === 0) {
        return res.status(401).json({ success: false, error: 'Invalid username or password' });
      }

      const match = await bcrypt.compare(password, users[0].password);
      if (!match) {
        return res.status(401).json({ success: false, error: 'Invalid username or password' });
      }

      // Create enrollment request in separate table
      await connection.execute(
        'INSERT INTO device_enrollment_requests (device_name, username, status) VALUES (?, ?, "pending")',
        [deviceName, username]
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
  router.post('/check-device-enroll', async (req, res) => {
    const { username, password, deviceName } = req.body || {};
    if (!username || !password || !deviceName) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      // Check user credentials
      const [users] = await connection.execute(
        'SELECT password FROM users WHERE username = ?',
        [username]
      );

      if (users.length === 0) {
        return res.status(401).json({ success: false, error: 'Invalid username or password' });
      }

      const match = await bcrypt.compare(password, users[0].password);
      if (!match) {
        return res.status(401).json({ success: false, error: 'Invalid username or password' });
      }

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

  router.post('/disconnect-vpn', async (req, res) => {
    const deviceName = (req.body && (req.body.device_name || req.body.deviceName)) || '';
    if (!deviceName) {
      return res.status(400).json({ success: false, error: 'Missing device_name' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT public_key FROM devices WHERE device_name = ? ORDER BY id DESC LIMIT 1',
        [deviceName]
      );

      if (rows.length === 0 || !rows[0].public_key) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }

      const publicKey = rows[0].public_key;
      const latestHandshake = getPeerLatestHandshakeEpochSeconds(publicKey);
      const isActive = latestHandshake !== null && latestHandshake > 0;

      if (!isActive) {
        return res.json({ success: true, active: false, disabled: false });
      }

      const result = disablePeerInWgCConfigByPublicKey(publicKey);
      if (!result.updated) {
        return res.status(404).json({ success: false, error: result.reason || 'Cannot disable peer' });
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

