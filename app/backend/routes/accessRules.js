const express = require('express');
const { execSync } = require('child_process');

function createAccessRuleRoutes({ mysql, dbConfig, run, requireAuth }) {
  const router = express.Router();

  router.get('/access-rules', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT r.id, r.name, r.source_type, r.user_id, r.source_ip, r.application_id, r.status,
                u.username, a.name AS application_name
         FROM access_rules r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN applications a ON r.application_id = a.id
         ORDER BY r.id DESC`
      );
      const rules = rows.map((row) => {
        const isBlock = row.status >= 2;
        const isOn = (row.status % 2) === 1;
        const action = isBlock ? 'block' : 'allow';
        const sourceLabel =
          row.source_type === 'user'
            ? (row.username || `user#${row.user_id}`)
            : (row.source_ip || '');
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
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/access-rules', requireAuth, async (req, res) => {
    const { name, sourceType, sourceUserId, sourceIp, applicationId, action } = req.body || {};
    if (!name || !sourceType || !applicationId || !action) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (sourceType !== 'user' && sourceType !== 'ip') {
      return res.status(400).json({ success: false, error: 'Invalid source type' });
    }
    if (sourceType === 'user' && !sourceUserId) {
      return res.status(400).json({ success: false, error: 'Missing user source' });
    }
    if (sourceType === 'ip' && !sourceIp) {
      return res.status(400).json({ success: false, error: 'Missing source IP' });
    }

    let connection;
    try {
      const isBlock = action === 'block';
      const baseStatus = isBlock ? 2 : 0;
      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO access_rules (name, source_type, user_id, source_ip, application_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [
          name,
          sourceType,
          sourceType === 'user' ? sourceUserId : null,
          sourceType === 'ip' ? sourceIp : null,
          applicationId,
          baseStatus
        ]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Error creating access rule:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/access-rules/:id/enable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, error: 'Invalid rule id' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT r.id, r.name, r.source_type, r.user_id, r.source_ip, r.application_id, r.status,
                u.allowed_ips, a.IP AS app_ip, a.port as app_port
         FROM access_rules r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN applications a ON r.application_id = a.id
         WHERE r.id = ?`,
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Rule not found' });
      }
      const rule = rows[0];
      const isBlock = rule.status >= 2;
      const target = isBlock ? 'DROP' : 'ACCEPT';

      const destIp = rule.app_ip;
      const destPort = rule.app_port;
      if (!destIp || !destPort) {
        return res.status(400).json({ success: false, error: 'Application IP or port not found' });
      }

      let sources = [];
      if (rule.source_type === 'user') {
        if (rule.allowed_ips) {
          sources = rule.allowed_ips
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else if (rule.source_type === 'ip' && rule.source_ip) {
        sources = [rule.source_ip.trim()];
      }

      if (!sources.length) {
        return res.status(400).json({ success: false, error: 'No source IPs resolved for rule' });
      }

      let chain = "FORWARD";

      try {
        const routeOutput = execSync(`ip route get ${destIp}`).toString();

        if (routeOutput.includes("local")) {
          chain = "INPUT";
        }
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: "Failed to determine route for destination IP",
        });
      }

      // Add rule theo chain phù hợp
      sources.forEach((src) => {
        const cmd = `iptables -A ${chain} -s ${src} -d ${destIp} -p tcp --dport ${destPort} -j ${target}`;
        run(cmd);
      });

      const newStatus = isBlock ? 3 : 1;
      await connection.execute('UPDATE access_rules SET status = ? WHERE id = ?', [newStatus, id]);
      res.json({ success: true });
    } catch (error) {
      console.error('Error enabling access rule:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/access-rules/:id/disable', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, error: 'Invalid rule id' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        `SELECT r.id, r.name, r.source_type, r.user_id, r.source_ip, r.application_id, r.status,
                u.allowed_ips, a.IP AS app_ip, a.port as app_port
         FROM access_rules r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN applications a ON r.application_id = a.id
         WHERE r.id = ?`,
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Rule not found' });
      }
      const rule = rows[0];
      const isBlock = rule.status >= 2;
      const target = isBlock ? 'DROP' : 'ACCEPT';

      const destIp = rule.app_ip;
      const destPort = rule.app_port;
      if (!destIp || !destPort) {
        return res.status(400).json({ success: false, error: 'Application IP or port not found' });
      }

      let sources = [];
      if (rule.source_type === 'user') {
        if (rule.allowed_ips) {
          sources = rule.allowed_ips
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else if (rule.source_type === 'ip' && rule.source_ip) {
        sources = [rule.source_ip.trim()];
      }

      let chain = "FORWARD";

      try {
        const routeOutput = execSync(`ip route get ${destIp}`).toString();

        if (routeOutput.includes("local")) {
          chain = "INPUT";
        }
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: "Failed to determine route for destination IP",
        });
      }

      // Add rule theo chain phù hợp
      sources.forEach((src) => {
        const cmd = `iptables -D ${chain} -s ${src} -d ${destIp} -p tcp --dport ${destPort} -j ${target}`;
        run(cmd);
      });

      const newStatus = isBlock ? 2 : 0;
      await connection.execute('UPDATE access_rules SET status = ? WHERE id = ?', [newStatus, id]);
      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling access rule:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  return router;
}

module.exports = createAccessRuleRoutes;

