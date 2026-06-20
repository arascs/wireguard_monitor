const express = require('express');
const { logAction } = require('../../logging/auditLogger');
const { requireSuperAdmin } = require('../middleware');

module.exports = function createAdminsRoutes({ mysql, dbConfig, bcrypt, requireAuth }) {
  const router = express.Router();

  router.get('/admins', requireAuth, requireSuperAdmin, async (req, res) => {
    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
        `SELECT id, username, role, status, expire_day, create_day, created_by
         FROM admins WHERE role = 'admin' ORDER BY id DESC`
      );
      res.json({ success: true, admins: rows });
    } catch (error) {
      console.error('Error loading admins:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  router.post('/admins', requireAuth, requireSuperAdmin, async (req, res) => {
    const { username, password, expireDay } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let conn;
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const createEpoch = Math.floor(Date.now() / 1000);
      let expireEpoch = null;
      if (expireDay && !Number.isNaN(expireDay)) {
        const days = parseInt(expireDay, 10);
        if (days > 0) expireEpoch = createEpoch + (days * 24 * 60 * 60);
      }

      conn = await mysql.createConnection(dbConfig);
      const [result] = await conn.execute(
        `INSERT INTO admins (username, password, role, status, expire_day, create_day, created_by)
         VALUES (?, ?, 'admin', 1, ?, ?, ?)`,
        [username, passwordHash, expireEpoch, createEpoch, req.session.adminId]
      );

      try {
        logAction(req.session.user, 'create_admin', { username, expire_day: expireEpoch });
      } catch (e) { /* ignore */ }

      res.json({
        success: true,
        admin: {
          id: result.insertId,
          username,
          role: 'admin',
          expire_day: expireEpoch,
          create_day: createEpoch
        }
      });
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Username already exists' });
      }
      console.error('Error creating admin:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  router.post('/admins/:id/enable', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid admin id' });

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Cannot modify superadmin' });
      }

      await conn.execute('UPDATE admins SET status = 1 WHERE id = ?', [id]);
      try {
        logAction(req.session.user, 'enable_admin', { username: rows[0].username });
      } catch (e) { /* ignore */ }
      res.json({ success: true });
    } catch (error) {
      console.error('Error enabling admin:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  router.post('/admins/:id/disable', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid admin id' });
    if (id === req.session.adminId) {
      return res.status(403).json({ success: false, error: 'Cannot disable your own account' });
    }

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Cannot modify superadmin' });
      }

      await conn.execute('UPDATE admins SET status = 0 WHERE id = ?', [id]);
      try {
        logAction(req.session.user, 'disable_admin', { username: rows[0].username });
      } catch (e) { /* ignore */ }
      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling admin:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  router.delete('/admins/:id', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid admin id' });
    if (id === req.session.adminId) {
      return res.status(403).json({ success: false, error: 'Cannot delete your own account' });
    }

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Cannot delete superadmin' });
      }

      await conn.execute('DELETE FROM admins WHERE id = ?', [id]);
      try {
        logAction(req.session.user, 'delete_admin', { username: rows[0].username });
      } catch (e) { /* ignore */ }
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting admin:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (conn) await conn.end();
    }
  });

  return router;
};
