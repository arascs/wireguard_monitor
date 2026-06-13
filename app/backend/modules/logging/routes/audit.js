const express = require('express');
const { getLogs, getSecurityEvents } = require('../auditLogger');

module.exports = function createAuditRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/audit-logs', requireAuth, (req, res) => {
    try {
      const logs = getLogs();
      res.json({ success: true, logs });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot read audit logs' });
    }
  });

  router.get('/security-events', requireAuth, (req, res) => {
    try {
      const events = getSecurityEvents();
      res.json({ success: true, events });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot read security events' });
    }
  });

  return router;
};
