const express = require('express');
const { logAction } = require('../../logging/auditLogger');

function createApplicationRoutes({ mysql, dbConfig, requireAuth }) {
  const router = express.Router();

  router.get('/applications', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, name, type, IP, port, status FROM applications ORDER BY id DESC'
      );
      res.json({ success: true, applications: rows });
    } catch (error) {
      console.error('Error loading applications:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/applications', requireAuth, async (req, res) => {
    const { name, type, IP, port } = req.body || {};
    if (!name || !type || !IP || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO applications (name, type, IP, port, status) VALUES (?, ?, ?, ?, 1)',
        [name, type, IP, port]
      );

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'create_application', { name, type, IP, port });
      } catch (e) { }

      res.json({ success: true, application: { name, type, IP, port } });
    } catch (error) {
      console.error('Error creating application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.put('/applications/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, type, IP, port } = req.body || {};
    if (!id || !name || !type || !IP || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'UPDATE applications SET name = ?, type = ?, IP = ?, port = ? WHERE id = ?',
        [name, type, IP, port, id]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Application not found' });
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_application', { id, name, type, IP, port });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.delete('/applications/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, error: 'Invalid application ID' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute('SELECT name FROM applications WHERE id = ?', [id]);
      const [result] = await connection.execute('DELETE FROM applications WHERE id = ?', [id]);
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Application not found' });
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'delete_application', { id, name: rows[0] && rows[0].name });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/applications/:id/enable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid application ID' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute('SELECT name FROM applications WHERE id = ?', [id]);
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Application not found' });
      }
      await connection.execute('UPDATE applications SET status = 1 WHERE id = ?', [id]);

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'enable_application', { id, name: rows[0].name });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error enabling application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/applications/:id/disable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid application ID' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute('SELECT name FROM applications WHERE id = ?', [id]);
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Application not found' });
      }
      await connection.execute('UPDATE applications SET status = 0 WHERE id = ?', [id]);

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'disable_application', { id, name: rows[0].name });
      } catch (e) { }

      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  return router;
}

module.exports = createApplicationRoutes;
