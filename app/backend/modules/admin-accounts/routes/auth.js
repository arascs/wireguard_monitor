const express = require('express');
const { loginLimiter } = require('../../../common/security');
const { isUserExpired } = require('../../../common/utils');

module.exports = function createAdminAuthRoutes({ mysql, dbConfig, bcrypt }) {
  const router = express.Router();

  router.post('/admin-login', loginLimiter('local-admin'), async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
        'SELECT id, username, password, role, status, expire_day FROM admins WHERE username = ?',
        [username]
      );
      if (!rows.length) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const admin = rows[0];
      if (parseInt(admin.status, 10) === 0) {
        return res.status(403).json({ success: false, error: 'Admin account disabled' });
      }
      if (admin.role !== 'superadmin' && isUserExpired(admin.expire_day)) {
        return res.status(403).json({ success: false, error: 'Admin account expired' });
      }
      if (!(await bcrypt.compare(password, admin.password))) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      req.session.adminId = admin.id;
      req.session.user = admin.username;
      req.session.role = admin.role;
      return res.json({ success: true });
    } catch (error) {
      console.error('Admin login failed:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  router.get('/me', async (req, res) => {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    return res.json({
      success: true,
      admin: {
        username: req.session.user,
        role: req.session.role
      }
    });
  });

  router.post('/change-password', async (req, res) => {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
        'SELECT password FROM admins WHERE id = ?',
        [req.session.adminId]
      );
      if (!rows.length) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      if (!(await bcrypt.compare(currentPassword, rows[0].password))) {
        return res.status(401).json({ success: false, error: 'Current password incorrect' });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await conn.execute('UPDATE admins SET password = ? WHERE id = ?', [newHash, req.session.adminId]);
      req.session.destroy(() => {
        res.json({ success: true });
      });
    } catch (error) {
      console.error('Change password failed:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  return router;
};
