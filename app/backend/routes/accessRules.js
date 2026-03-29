const express = require('express');
const { execSync } = require('child_process');

function createAccessRuleRoutes({ mysql, dbConfig, run, requireAuth }) {
  const router = express.Router();

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
    }
    return { type: 'ip', sources: [] };
  }

  // Helper: determine iptables chain from destination IP
  function resolveChain(destIp) {
    try {
      const routeOutput = execSync(`ip route get ${destIp}`).toString();
      return routeOutput.includes('local') ? 'INPUT' : 'FORWARD';
    } catch (err) {
      return null;
    }
  }

  // Helper: apply or remove iptables rules
  function applyIptables(action, chain, source, destIp, destPort, target) {
    // action: '-A' to add, '-D' to delete
    if (source.type === 'ip') {
      source.sources.forEach((src) => {
        run(`iptables ${action} ${chain} -s ${src} -d ${destIp} -p tcp --dport ${destPort} -j ${target}`);
      });
    } else if (source.type === 'interface') {
      run(`iptables ${action} ${chain} -i ${source.iface} -d ${destIp} -p tcp --dport ${destPort} -j ${target}`);
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
        } else {
          sourceLabel = row.source_value || '';
        }
        return {
          id: row.id,
          name: row.name,
          source_type: row.source_type,
          source_label: sourceLabel,
          application_name: row.application_name,
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
    const validTypes = ['site', 'device', 'interface', 'ip'];
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
    if (sourceType === 'ip' && !sourceIp) {
      return res.status(400).json({ success: false, error: 'Missing source IP' });
    }

    let connection;
    try {
      const isBlock = action === 'block';
      const baseStatus = isBlock ? 2 : 0;
      // source_value stores: site id for 'site', device id for 'device', interface name for 'interface', IP for 'ip'
      let sourceValue;
      if (sourceType === 'site') {
        sourceValue = parseInt(sourceSiteId, 10);
      } else if (sourceType === 'device') {
        sourceValue = parseInt(sourceDeviceId, 10);
      } else if (sourceType === 'interface') {
        sourceValue = sourceInterface;
      } else if (sourceType === 'ip') {
        sourceValue = sourceIp;
      }

      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO access_rules (name, source_type, source_value, application_id, status) VALUES (?, ?, ?, ?, ?)',
        [name, sourceType, sourceValue, parseInt(applicationId, 10), baseStatus]
      );
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
      const [rows] = await connection.execute(
        `SELECT r.id, r.source_type, r.source_value, r.status,
                a.IP AS app_ip, a.port AS app_port
         FROM access_rules r
         LEFT JOIN applications a ON r.application_id = a.id
         WHERE r.id = ?`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      const isBlock = rule.status >= 2;
      const target = isBlock ? 'DROP' : 'ACCEPT';
      const destIp = rule.app_ip;
      const destPort = rule.app_port;
      if (!destIp || !destPort) {
        return res.status(400).json({ success: false, error: 'Application IP or port not found' });
      }

      const source = await resolveSourceIps(connection, rule);
      if (source.type === 'ip' && !source.sources.length) {
        return res.status(400).json({ success: false, error: 'No source IPs resolved for rule' });
      }
      if (source.type === 'interface' && !source.iface) {
        return res.status(400).json({ success: false, error: 'No interface specified for rule' });
      }

      const chain = resolveChain(destIp);
      if (!chain) return res.status(500).json({ success: false, error: 'Failed to determine route for destination IP' });

      applyIptables('-I', chain, source, destIp, destPort, target);

      const newStatus = isBlock ? 3 : 1;
      await connection.execute('UPDATE access_rules SET status = ?, enabled_at = NOW() WHERE id = ?', [newStatus, id]);
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
      const [rows] = await connection.execute(
        `SELECT r.id, r.source_type, r.source_value, r.status,
                a.IP AS app_ip, a.port AS app_port
         FROM access_rules r
         LEFT JOIN applications a ON r.application_id = a.id
         WHERE r.id = ?`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      const isBlock = rule.status >= 2;
      const target = isBlock ? 'DROP' : 'ACCEPT';
      const destIp = rule.app_ip;
      const destPort = rule.app_port;
      if (!destIp || !destPort) {
        return res.status(400).json({ success: false, error: 'Application IP or port not found' });
      }

      const source = await resolveSourceIps(connection, rule);

      const chain = resolveChain(destIp);
      if (!chain) return res.status(500).json({ success: false, error: 'Failed to determine route for destination IP' });

      applyIptables('-D', chain, source, destIp, destPort, target);

      const newStatus = isBlock ? 2 : 0;
      await connection.execute('UPDATE access_rules SET status = ? WHERE id = ?', [newStatus, id]);
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
      const [rows] = await connection.execute(
        `SELECT r.id, r.source_type, r.source_value, r.status,
                a.IP AS app_ip, a.port AS app_port
         FROM access_rules r
         LEFT JOIN applications a ON r.application_id = a.id
         WHERE r.id = ?`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ success: false, error: 'Rule not found' });

      const rule = rows[0];
      // If rule is enabled, disable it first
      if ((rule.status % 2) === 1) {
        const isBlock = rule.status >= 2;
        const target = isBlock ? 'DROP' : 'ACCEPT';
        const destIp = rule.app_ip;
        const destPort = rule.app_port;
        if (destIp && destPort) {
          const source = await resolveSourceIps(connection, rule);
          const chain = resolveChain(destIp);
          if (chain) {
            applyIptables('-D', chain, source, destIp, destPort, target);
          }
        }
      }

      // Delete the rule
      await connection.execute('DELETE FROM access_rules WHERE id = ?', [id]);
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
