const express = require('express');
const { logAction } = require('../../logging/auditLogger');
const { syncAppProxies, normalizePolicyInput } = require('../../app-proxy');

function policyFromBody(body) {
  if (!body || body.policy == null) return null;
  return normalizePolicyInput(body.policy);
}

async function afterAppChange(mysql, dbConfig) {
  try {
    await syncAppProxies(mysql, dbConfig);
  } catch (e) {
    console.error('[app-proxy] sync failed:', e.message);
  }
}

function createApplicationRoutes({ mysql, dbConfig, requireAuth }) {
  const router = express.Router();

  router.get('/applications', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT id, name, type, IP, port, status, policy_json, backend_host, backend_port
         FROM applications ORDER BY id DESC`
      );
      const applications = rows.map((row) => ({
        ...row,
        policy: row.policy_json
      }));
      res.json({ success: true, applications });
    } catch (error) {
      console.error('Error loading applications:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/applications', requireAuth, async (req, res) => {
    const { name, type, IP, port, backend_host, backend_port } = req.body || {};
    if (!name || !type || !IP || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const policy = policyFromBody(req.body);
    const bHost = String(backend_host || '127.0.0.1').trim();
    const bPort = backend_port != null && backend_port !== '' ? parseInt(backend_port, 10) : null;
    if (policy && (!bPort || bPort === parseInt(port, 10))) {
      return res.status(400).json({
        success: false,
        error: 'Backend port must be set and differ from client port when policy is enabled'
      });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        `INSERT INTO applications (name, type, IP, port, status, policy_json, backend_host, backend_port)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [name, type, IP, port, policy ? JSON.stringify(policy) : null, bHost, bPort]
      );

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'create_application', { name, type, IP, port });
      } catch (e) { /* ignore */ }

      res.json({ success: true, application: { name, type, IP, port } });
      await afterAppChange(mysql, dbConfig);
    } catch (error) {
      console.error('Error creating application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.put('/applications/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, type, IP, port, backend_host, backend_port } = req.body || {};
    if (!id || !name || !type || !IP || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const policy = policyFromBody(req.body);
    const bHost = String(backend_host || '127.0.0.1').trim();
    const bPort = backend_port != null && backend_port !== '' ? parseInt(backend_port, 10) : null;
    if (policy && (!bPort || bPort === parseInt(port, 10))) {
      return res.status(400).json({
        success: false,
        error: 'Backend port must be set and differ from client port when policy is enabled'
      });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        `UPDATE applications SET name = ?, type = ?, IP = ?, port = ?,
         policy_json = ?, backend_host = ?, backend_port = ? WHERE id = ?`,
        [name, type, IP, port, policy ? JSON.stringify(policy) : null, bHost, bPort, id]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Application not found' });
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_application', { id, name, type, IP, port });
      } catch (e) { /* ignore */ }

      res.json({ success: true });
      await afterAppChange(mysql, dbConfig);
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
      } catch (e) { /* ignore */ }

      res.json({ success: true });
      await afterAppChange(mysql, dbConfig);
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
      } catch (e) { /* ignore */ }

      res.json({ success: true });
      await afterAppChange(mysql, dbConfig);
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
      } catch (e) { /* ignore */ }

      res.json({ success: true });
      await afterAppChange(mysql, dbConfig);
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
