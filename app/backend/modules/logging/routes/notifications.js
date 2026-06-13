const express = require('express');

const notificationState = {
  total: 0,
  readTotal: 0,
  latestAt: null
};

function countIncomingAlerts(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.events)) return payload.events.length;
  if (payload && payload.event) return 1;
  if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) return 1;
  return 0;
}

function getUnreadAlerts() {
  return Math.max(0, notificationState.total - notificationState.readTotal);
}

module.exports = function createNotificationRoutes({ apiKeyAuth, requireAuth }) {
  const router = express.Router();

  router.post('/notifications/ingest', apiKeyAuth, (req, res) => {
    const count = countIncomingAlerts(req.body);
    if (count <= 0) {
      return res.status(400).json({ success: false, error: 'Empty payload' });
    }

    notificationState.total += count;
    notificationState.latestAt = new Date().toISOString();
    res.json({ success: true, added: count, unread: getUnreadAlerts() });
  });

  router.get('/notifications/unread', requireAuth, (req, res) => {
    res.json({
      success: true,
      unread: getUnreadAlerts(),
      total: notificationState.total,
      latestAt: notificationState.latestAt
    });
  });

  router.post('/notifications/mark-read', requireAuth, (req, res) => {
    notificationState.readTotal = notificationState.total;
    res.json({ success: true, unread: 0 });
  });

  return router;
};
