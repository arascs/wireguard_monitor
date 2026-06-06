const express = require('express');
const { logAction } = require('../auditLogger');
const { deletePeerFromConf } = require('../lib/wireguardConfig');

function createUserRoutes({ mysql, dbConfig, bcrypt, requireAuth }) {
  const router = express.Router();

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

  router.delete('/users/:username', requireAuth, async (req, res) => {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ success: false, error: 'Missing username' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      const [devices] = await connection.execute(
        'SELECT public_key, interface FROM devices WHERE username = ?',
        [username]
      );

      for (const device of devices) {
        if (device.public_key && device.interface) {
          deletePeerFromConf(device.interface, device.public_key);
        }
      }

      await connection.execute(
        'DELETE FROM users WHERE username = ?',
        [username]
      );

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
        const result = deletePeerFromConf(row.interface, row.site_pubkey);
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

  return router;
}

module.exports = createUserRoutes;
