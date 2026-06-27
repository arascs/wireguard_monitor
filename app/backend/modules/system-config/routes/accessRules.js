const express = require('express');
const { spawnSync } = require('child_process');
const { logAction } = require('../../logging/auditLogger');

function createAccessRuleRoutes({ mysql, dbConfig, run, requireAuth }) {
  const router = express.Router();

  const RULE_SELECT = `SELECT r.id, r.name, r.source_type, r.source_value, r.status, r.application_id,
                s.site_name, d.device_name, a.name AS application_name,
                a.IP AS app_ip, a.port AS app_port
         FROM access_rules r
         LEFT JOIN sites s ON r.source_type = 'site' AND r.source_value = s.id
         LEFT JOIN devices d ON r.source_type = 'device' AND r.source_value = d.id
         LEFT JOIN applications a ON r.application_id = a.id`;

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
      application: row.application_id == null ? 'All applications' : (row.application_name || ''),
      status: row.status
    };
  }

  function audit(admin, action, details) {
    try {
      logAction(admin || 'unknown', action, details);
    } catch (_) { /* ignore */ }
  }

  // Helper: resolve source IPs from rule
  async function resolveSourceIps(connection, rule) {
    if (rule.source_type === 'site') {
      const [rows] = await connection.execute(
        'SELECT site_allowedIPs FROM sites WHERE id = ?',
        [rule.source_value]
      );
      const ips = [];
      if (rows.length && rows[0].site_allowedIPs) {
        // site_allowedIPs may contain multiple CIDRs separated by commas/spaces
        rows[0].site_allowedIPs.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((ip) => ips.push(ip));
      }
      return { type: 'ip', sources: ips };
    } else if (rule.source_type === 'device') {
      const [devices] = await connection.execute(
        'SELECT allowed_ips FROM devices WHERE id = ?',
        [rule.source_value]
      );
      const ips = [];
      if (devices.length && devices[0].allowed_ips) {
        devices[0].allowed_ips.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((ip) => ips.push(ip));
      }
      return { type: 'ip', sources: ips };
    } else if (rule.source_type === 'interface') {
      return { type: 'interface', iface: rule.source_value };
    } else if (rule.source_type === 'ip' && rule.source_value) {
      return { type: 'ip', sources: [rule.source_value.trim()] };
    } else if (rule.source_type === 'all') {
      return { type: 'all' };
    }
    return { type: 'ip', sources: [] };
  }

  async function resolveDestinations(connection, rule) {
    if (rule.application_id == null) {
      const [rows] = await connection.execute(
        'SELECT IP, port FROM applications WHERE IP IS NOT NULL AND IP != "" AND port IS NOT NULL'
      );
      return rows
        .filter((row) => row.IP && row.port)
        .map((row) => ({ destIp: String(row.IP).trim(), destPort: row.port }));
    }
    if (rule.app_ip && rule.app_port) {
      return [{ destIp: rule.app_ip, destPort: rule.app_port }];
    }
    return [];
  }

  function resolveChain(destIp) {
    const r = spawnSync('ip', ['route', 'get', destIp], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').includes('local') ? 'INPUT' : 'FORWARD';
  }

  function applyIptables(action, chain, source, destIp, destPort, target) {
    const baseTail = ['-d', destIp, '-p', 'tcp', '--dport', String(destPort), '-j', target];
    if (source.type === 'all') {
      run('iptables', [action, chain, ...baseTail]);
    } else if (source.type === 'ip') {
      source.sources.forEach((src) => {
        run('iptables', [action, chain, '-s', src, ...baseTail]);
      });
    } else if (source.type === 'interface') {
      run('iptables', [action, chain, '-i', source.iface, ...baseTail]);
    }
  }

  async function applyRuleIptables(action, connection, rule) {
    const isBlock = rule.status >= 2;
    const target = isBlock ? 'DROP' : 'ACCEPT';
    const source = await resolveSourceIps(connection, rule);

    if (source.type === 'ip' && !source.sources.length) {
      throw new Error('No source IPs resolved for rule');
    }
    if (source.type === 'interface' && !source.iface) {
      throw new Error('No interface specified for rule');
    }

    const destinations = await resolveDestinations(connection, rule);
    if (!destinations.length) {
      throw new Error('No destination applications resolved for rule');
    }

    for (const dest of destinations) {
      const chain = resolveChain(dest.destIp);
      if (!chain) {
        throw new Error(`Failed to determine route for destination IP ${dest.destIp}`);
      }
      applyIptables(action, chain, source, dest.destIp, dest.destPort, target);
    }
  }

  router.get('/access-rules', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT r.id, r.name, r.source_type, r.source_value, r.application_id, r.status,
                s.site_name, d.device_name, a.name AS application_name
         FROM access_rules r
         LEFT JOIN sites s ON r.source_type = 'site' AND r.source_value = s.id
         LEFT JOIN devices d ON r.source_type = 'device' AND r.source_value = d.id
         LEFT JOIN applications a ON r.application_id = a.id
         ORDER BY (r.status % 2) DESC, r.enabled_at DESC, r.id DESC`
      );
      const rules = rows.map((row) => {
        const isBlock = row.status >= 2;
        const isOn = (row.status % 2) === 1;
        const action = isBlock ? 'block' : 'allow';
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
        return {
          id: row.id,
          name: row.name,
          source_type: row.source_type,
          source_label: sourceLabel,
          application_name: row.application_id == null ? 'All applications' : (row.application_name || ''),
          status: isOn ? 1 : 0,
          action
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

  // List sites for rules UI
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
    const { name, sourceType, sourceSiteId, sourceDeviceId, sourceInterface, sourceIp, applicationId, action } = req.body || {};
    const validTypes = ['site', 'device', 'interface', 'ip', 'all'];
    if (!name || !sourceType || applicationId === undefined || applicationId === null || applicationId === '' || !action) {
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
    if (sourceType === 'ip' && !sourceIp) {
      return res.status(400).json({ success: false, error: 'Missing source IP' });
    }

    let connection;
    try {
      const isBlock = action === 'block';
      const baseStatus = isBlock ? 2 : 0;
      let sourceValue = null;
      if (sourceType === 'site') {
        sourceValue = parseInt(sourceSiteId, 10);
      } else if (sourceType === 'device') {
        sourceValue = parseInt(sourceDeviceId, 10);
      } else if (sourceType === 'interface') {
        sourceValue = sourceInterface;
      } else if (sourceType === 'ip') {
        sourceValue = sourceIp;
      }

      const appId = applicationId === 'all' ? null : parseInt(applicationId, 10);
      if (appId !== null && !appId) {
        return res.status(400).json({ success: false, error: 'Invalid application' });
      }

      connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(
        'INSERT INTO access_rules (name, source_type, source_value, application_id, status) VALUES (?, ?, ?, ?, ?)',
        [name, sourceType, sourceValue, appId, baseStatus]
      );
      const [created] = await connection.execute(`${RULE_SELECT} WHERE r.id = ?`, [result.insertId]);
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
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule id' });

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(`${RULE_SELECT} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      await applyRuleIptables('-I', connection, rule);

      const newStatus = rule.status >= 2 ? 3 : 1;
      await connection.execute('UPDATE access_rules SET status = ?, enabled_at = NOW() WHERE id = ?', [newStatus, id]);
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
      const [rows] = await connection.execute(`${RULE_SELECT} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      await applyRuleIptables('-D', connection, rule);

      const newStatus = rule.status >= 2 ? 2 : 0;
      await connection.execute('UPDATE access_rules SET status = ? WHERE id = ?', [newStatus, id]);
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
      const [rows] = await connection.execute(`${RULE_SELECT} WHERE r.id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      if ((rule.status % 2) === 1) {
        try {
          await applyRuleIptables('-D', connection, rule);
        } catch (e) {
          console.error('Error removing iptables rules before delete:', e.message);
        }
      }

      await connection.execute('DELETE FROM access_rules WHERE id = ?', [id]);
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
