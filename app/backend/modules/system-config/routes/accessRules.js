const express = require('express');
const { logAction } = require('../../logging/auditLogger');
const {
  applyRuleIptables,
  buildDeleteArgLists,
  runDeleteCommands,
  cancelScheduledExpiry,
  scheduleExpiry,
  deleteAccessRule
} = require('../services/accessRuleService');

function createAccessRuleRoutes({ mysql, dbConfig, requireAuth }) {
  const router = express.Router();

  const RULE_SELECT_FULL = `SELECT r.id, r.name, r.source_type, r.source_value, r.status, r.application_id,
                r.expire_hours, r.enabled_at,
                s.site_name, d.device_name, a.name AS application_name,
                a.IP AS app_ip, a.port AS app_port
         FROM access_rules r
         LEFT JOIN sites s ON r.source_type = 'site' AND r.source_value = s.id
         LEFT JOIN devices d ON r.source_type = 'device' AND r.source_value = d.id
         LEFT JOIN applications a ON r.application_id = a.id`;

  const RULES_ORDER_BY = `
         ORDER BY (r.status % 2) DESC,
                  CASE WHEN (r.status % 2) = 1 AND r.enable_position = 'last' THEN 1 ELSE 0 END ASC,
                  CASE WHEN (r.status % 2) = 1 AND r.enable_position = 'last' THEN r.enabled_at END ASC,
                  CASE WHEN (r.status % 2) = 1 THEN r.enabled_at END DESC,
                  r.id DESC`;

  function ruleAuditDetails(row) {
    const isBlock = row.status >= 2;
    let source = row.source_value;
    if (row.source_type === 'site') source = row.site_name || source;
    else if (row.source_type === 'device') source = row.device_name || source;
    return {
      id: row.id,
      name: row.name,
      action: isBlock ? 'block' : 'allow',
      source_type: row.source_type,
      source,
      application_id: row.application_id,
      application: row.application_name || '',
      status: row.status,
      expire_hours: row.expire_hours
    };
  }

  function audit(admin, action, details) {
    try {
      logAction(admin || 'unknown', action, details);
    } catch (_) { /* ignore */ }
  }

  async function disableRule(connection, rule, ruleId) {
    if ((rule.status % 2) === 1) {
      const deleteArgLists = await buildDeleteArgLists(connection, rule);
      runDeleteCommands(deleteArgLists);
    }
    cancelScheduledExpiry(ruleId);
    const newStatus = rule.status >= 2 ? 2 : 0;
    await connection.execute('UPDATE access_rules SET status = ? WHERE id = ?', [newStatus, ruleId]);
    return newStatus;
  }

  router.get('/access-rules', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT r.id, r.name, r.source_type, r.source_value, r.application_id, r.status,
                r.expire_hours, r.enabled_at,
                s.site_name, d.device_name, a.name AS application_name
         FROM access_rules r
         LEFT JOIN sites s ON r.source_type = 'site' AND r.source_value = s.id
         LEFT JOIN devices d ON r.source_type = 'device' AND r.source_value = d.id
         LEFT JOIN applications a ON r.application_id = a.id
         ${RULES_ORDER_BY}`
      );
      const now = Date.now();
      const rules = rows.map((row) => {
        const isBlock = row.status >= 2;
        const isOn = (row.status % 2) === 1;
        let sourceLabel = '';
        if (row.source_type === 'site') {
          sourceLabel = `Site: ${row.site_name || `#${row.source_value}`}`;
        } else if (row.source_type === 'device') {
          sourceLabel = `Device: ${row.device_name || `#${row.source_value}`}`;
        } else if (row.source_type === 'interface') {
          sourceLabel = `Interface: ${row.source_value || ''}`;
        } else if (row.source_type === 'all') {
          sourceLabel = 'All';
        } else {
          sourceLabel = row.source_value || '';
        }

        let expire_label = 'Never';
        if (row.expire_hours != null && row.expire_hours > 0) {
          expire_label = `${row.expire_hours}h`;
          if (isOn && row.enabled_at) {
            const expiresAt = new Date(row.enabled_at).getTime() + row.expire_hours * 3600000;
            if (expiresAt <= now) expire_label = 'Expired';
            else expire_label = `${row.expire_hours}h (until ${new Date(expiresAt).toLocaleString()})`;
          }
        }

        return {
          id: row.id,
          name: row.name,
          source_type: row.source_type,
          source_label: sourceLabel,
          application_name: row.application_name || '',
          status: isOn ? 1 : 0,
          action: isBlock ? 'block' : 'allow',
          expire_hours: row.expire_hours,
          expire_label
        };
      });
      res.json({ success: true, rules });
    } catch (error) {
      console.error('Error loading access rules:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.get('/sites', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, site_name, site_allowedIPs FROM sites ORDER BY id DESC'
      );
      res.json({ success: true, sites: rows });
    } catch (error) {
      console.error('Error loading sites:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/access-rules', requireAuth, async (req, res) => {
    const {
      name, sourceType, sourceSiteId, sourceDeviceId, sourceInterface,
      applicationId, action, expireHours
    } = req.body || {};
    const validTypes = ['site', 'device', 'interface', 'all'];
    if (!name || !sourceType || !applicationId || !action) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!validTypes.includes(sourceType)) {
      return res.status(400).json({ success: false, error: 'Invalid source type' });
    }
    if (sourceType === 'site' && !sourceSiteId) {
      return res.status(400).json({ success: false, error: 'Missing site' });
    }
    if (sourceType === 'device' && !sourceDeviceId) {
      return res.status(400).json({ success: false, error: 'Missing device' });
    }
    if (sourceType === 'interface' && !sourceInterface) {
      return res.status(400).json({ success: false, error: 'Missing interface name' });
    }

    let parsedExpireHours = null;
    if (expireHours != null && expireHours !== '') {
      parsedExpireHours = parseInt(expireHours, 10);
      if (!Number.isFinite(parsedExpireHours) || parsedExpireHours < 1) {
        return res.status(400).json({ success: false, error: 'expireHours must be >= 1' });
      }
    }

    let connection;
    try {
      const isBlock = action === 'block';
      const baseStatus = isBlock ? 2 : 0;
      let sourceValue = null;
      if (sourceType === 'site') sourceValue = String(parseInt(sourceSiteId, 10));
      else if (sourceType === 'device') sourceValue = String(parseInt(sourceDeviceId, 10));
      else if (sourceType === 'interface') sourceValue = sourceInterface;
      else if (sourceType === 'all') sourceValue = '';

      const appId = parseInt(applicationId, 10);
      if (!appId) {
        return res.status(400).json({ success: false, error: 'Invalid application' });
      }

      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'INSERT INTO access_rules (name, source_type, source_value, application_id, status, expire_hours) VALUES (?, ?, ?, ?, ?, ?)',
        [name, sourceType, sourceValue, appId, baseStatus, parsedExpireHours]
      );
      const [created] = await connection.execute(`${RULE_SELECT_FULL} WHERE r.id = ?`, [result.insertId]);
      if (created.length) {
        audit(req.session && req.session.user, 'create_access_rule', ruleAuditDetails(created[0]));
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error creating access rule:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/access-rules/:id/enable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const position = String(req.body && req.body.position || 'first').toLowerCase();
    const insertAction = position === 'last' ? '-A' : '-I';
    const enablePosition = position === 'last' ? 'last' : 'first';
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule id' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(`${RULE_SELECT_FULL} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      const deleteArgLists = await applyRuleIptables(insertAction, connection, rule);

      const newStatus = rule.status >= 2 ? 3 : 1;
      await connection.execute(
        'UPDATE access_rules SET status = ?, enabled_at = NOW(), enable_position = ? WHERE id = ?',
        [newStatus, enablePosition, id]
      );

      if (rule.expire_hours != null && rule.expire_hours > 0) {
        scheduleExpiry(id, rule.expire_hours, deleteArgLists);
      }

      audit(req.session && req.session.user, 'enable_access_rule', ruleAuditDetails({ ...rule, status: newStatus }));
      res.json({ success: true });
    } catch (error) {
      console.error('Error enabling access rule:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.post('/access-rules/:id/disable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule id' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(`${RULE_SELECT_FULL} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      const newStatus = await disableRule(connection, rule, id);
      audit(req.session && req.session.user, 'disable_access_rule', ruleAuditDetails({ ...rule, status: newStatus }));
      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling access rule:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) await connection.end();
    }
  });

  router.delete('/access-rules/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule id' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(`${RULE_SELECT_FULL} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      await deleteAccessRule(connection, rule);
      audit(req.session && req.session.user, 'delete_access_rule', ruleAuditDetails(rule));
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting access rule:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) await connection.end();
    }
  });

  return router;
}

module.exports = createAccessRuleRoutes;
