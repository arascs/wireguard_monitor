const express = require('express');
const { logAction } = require('../../logging/auditLogger');
const { deletePeerFromConf } = require('../../../common/wireguardConfig');

function createUserRoutes({ mysql, dbConfig, bcrypt, requireAuth }) {
  const router = express.Router();

  router.get('/users', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, username, expire_day, create_day, status FROM users ORDER BY id DESC'
      );
      res.json({ success: true, users: rows });
    } catch (error) {
      console.error('Error loading users:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
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
        'INSERT INTO users (username, password, expire_day, create_day, status) VALUES (?, ?, ?, ?, 1)',
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
      if (connection) await connection.end();
    }
  });

  router.put('/users/:username', requireAuth, async (req, res) => {
    const { username } = req.params;
    const { expireDate } = req.body || {};
    if (!username) {
      return res.status(400).json({ success: false, error: 'Missing username' });
    }
    if (expireDate === undefined) {
      return res.status(400).json({ success: false, error: 'Missing expire date' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);

      const [rows] = await connection.execute('SELECT id FROM users WHERE username = ?', [username]);
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      let expireEpoch = null;
      if (expireDate) {
        expireEpoch = Math.floor(new Date(`${expireDate}T23:59:59`).getTime() / 1000);
        if (Number.isNaN(expireEpoch)) {
          return res.status(400).json({ success: false, error: 'Invalid expire date' });
        }
      }

      await connection.execute(
        'UPDATE users SET expire_day = ? WHERE username = ?',
        [expireEpoch, username]
      );

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_user', { username, expire_day: expireEpoch });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/users/:username/enable', requireAuth, async (req, res) => {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ success: false, error: 'Missing username' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'UPDATE users SET status = 1 WHERE username = ?',
        [username]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      const nowEpoch = Math.floor(Date.now() / 1000);
      const defaultExpire = nowEpoch + 90 * 24 * 60 * 60;
      const [devices] = await connection.execute(
        'SELECT id, expire_date FROM devices WHERE username = ?',
        [username]
      );
      for (const device of devices) {
        const cur = device.expire_date ? parseInt(device.expire_date, 10) : null;
        const expireEpoch = (!cur || cur < nowEpoch) ? defaultExpire : cur;
        await connection.execute(
          'UPDATE devices SET status = 1, expire_date = ? WHERE id = ?',
          [expireEpoch, device.id]
        );
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'enable_user', { username });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error enabling user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/users/:username/disable', requireAuth, async (req, res) => {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ success: false, error: 'Missing username' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'UPDATE users SET status = 0 WHERE username = ?',
        [username]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

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
        'UPDATE devices SET status = 0 WHERE username = ?',
        [username]
      );

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'disable_user', { username });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
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
      if (connection) await connection.end();
    }
  });

  return router;
}

module.exports = createUserRoutes;
