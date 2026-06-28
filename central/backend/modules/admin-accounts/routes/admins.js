const express = require('express');
const { getPool } = require('../../../mysqlLogs');
const { logAction } = require('../../../auditLogger');
const { requireSuperAdmin } = require('../middleware');

function sessionAdmin(req) {
  return (req.session && req.session.user) ? req.session.user : 'unknown';
}

module.exports = function createAdminsRoutes({ getAuthMiddleware, bcrypt }) {
  const router = express.Router();
  const guard = (req, res, next) => getAuthMiddleware()(req, res, next);

  router.get('/admins', guard, requireSuperAdmin, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'Database unavailable' });
    try {
      const [rows] = await pool.execute(
        `SELECT id, username, role, status, expire_day, create_day, created_by
         FROM admins WHERE role = 'admin' ORDER BY id DESC`
      );
      res.json({ ok: true, admins: rows });
    } catch (e) {
      console.error('[admins list]', e.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/admins', guard, requireSuperAdmin, async (req, res) => {
    const { username, password, expireDay } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const pool = getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'Database unavailable' });

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const createEpoch = Math.floor(Date.now() / 1000);
      let expireEpoch = null;
      if (expireDay && !Number.isNaN(expireDay)) {
        const days = parseInt(expireDay, 10);
        if (days > 0) expireEpoch = createEpoch + days * 24 * 60 * 60;
      }

      const [result] = await pool.execute(
        `INSERT INTO admins (username, password, role, status, expire_day, create_day, created_by)
         VALUES (?, ?, 'admin', 1, ?, ?, ?)`,
        [username, passwordHash, expireEpoch, createEpoch, req.session.adminId]
      );

      res.json({
        ok: true,
        admin: {
          id: result.insertId,
          username,
          role: 'admin',
          expire_day: expireEpoch,
          create_day: createEpoch
        }
      });
      logAction(sessionAdmin(req), 'create_admin', { username, expire_day: expireEpoch });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ ok: false, error: 'Username already exists' });
      }
      console.error('[admins create]', e.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/admins/:id/enable', guard, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid admin id' });

    const pool = getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'Database unavailable' });

    try {
      const [rows] = await pool.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Cannot modify superadmin' });
      }
      await pool.execute('UPDATE admins SET status = 1 WHERE id = ?', [id]);
      logAction(sessionAdmin(req), 'enable_admin', { username: rows[0].username });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admins enable]', e.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/admins/:id/disable', guard, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid admin id' });
    if (id === req.session.adminId) {
      return res.status(403).json({ ok: false, error: 'Cannot disable your own account' });
    }

    const pool = getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'Database unavailable' });

    try {
      const [rows] = await pool.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Cannot modify superadmin' });
      }
      await pool.execute('UPDATE admins SET status = 0 WHERE id = ?', [id]);
      logAction(sessionAdmin(req), 'disable_admin', { username: rows[0].username });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admins disable]', e.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.delete('/admins/:id', guard, requireSuperAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid admin id' });
    if (id === req.session.adminId) {
      return res.status(403).json({ ok: false, error: 'Cannot delete your own account' });
    }

    const pool = getPool();
    if (!pool) return res.status(503).json({ ok: false, error: 'Database unavailable' });

    try {
      const [rows] = await pool.execute('SELECT username, role FROM admins WHERE id = ?', [id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Admin not found' });
      if (rows[0].role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Cannot delete superadmin' });
      }
      await pool.execute('DELETE FROM admins WHERE id = ?', [id]);
      logAction(sessionAdmin(req), 'delete_admin', { username: rows[0].username });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admins delete]', e.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
};
