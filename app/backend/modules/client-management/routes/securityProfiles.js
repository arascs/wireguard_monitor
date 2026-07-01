const express = require('express');
const { logAction } = require('../../logging/auditLogger');
const { CHECK_LABELS, getChecksForOs } = require('../services/securityChecks');
const {
  listProfiles,
  getProfileById,
  validateProfilePayload
} = require('../services/securityProfiles');

function createSecurityProfileRoutes({ mysql, dbConfig, requireAuth }) {
  const router = express.Router();

  router.get('/security-profiles/meta', requireAuth, (req, res) => {
    res.json({
      success: true,
      labels: CHECK_LABELS,
      checksByOs: {
        linux: getChecksForOs('linux'),
        windows: getChecksForOs('windows')
      }
    });
  });

  router.get('/security-profiles', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const profiles = await listProfiles(connection);
      res.json({ success: true, profiles });
    } catch (error) {
      console.error('Error loading security profiles:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/security-profiles', requireAuth, async (req, res) => {
    const { name, os_type, checks } = req.body || {};
    const err = validateProfilePayload({ name, os_type, checks });
    if (err) return res.status(400).json({ success: false, error: err });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'INSERT INTO security_profiles (name, os_type, checks) VALUES (?, ?, ?)',
        [name.trim(), os_type, JSON.stringify(checks || {})]
      );
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'create_security_profile', { name, os_type, checks });
      } catch (_) {}
      res.json({ success: true, id: result.insertId });
    } catch (error) {
      console.error('Error creating security profile:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.put('/security-profiles/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, os_type, checks } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const err = validateProfilePayload({ name, os_type, checks });
    if (err) return res.status(400).json({ success: false, error: err });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'UPDATE security_profiles SET name = ?, os_type = ?, checks = ? WHERE id = ?',
        [name.trim(), os_type, JSON.stringify(checks || {}), id]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Profile not found' });
      }
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_security_profile', { id, name, os_type, checks });
      } catch (_) {}
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating security profile:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.delete('/security-profiles/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const existing = await getProfileById(connection, id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Profile not found' });
      }
      await connection.execute(
        'UPDATE devices SET security_profile_id = NULL WHERE security_profile_id = ?',
        [id]
      );
      await connection.execute('DELETE FROM security_profiles WHERE id = ?', [id]);
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'delete_security_profile', { id, name: existing.name });
      } catch (_) {}
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting security profile:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  return router;
}

module.exports = createSecurityProfileRoutes;
