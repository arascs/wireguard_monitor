const express = require('express');
const createAuditRoutes = require('./routes/audit');
const createNotificationRoutes = require('./routes/notifications');
const createSessionLogRoutes = require('./routes/sessionLogs');

module.exports = function mountLogging(deps) {
  const router = express.Router();
  router.use(createAuditRoutes(deps));
  router.use(createNotificationRoutes(deps));
  router.use(createSessionLogRoutes({ requireAuth: deps.requireAuth, HISTORY_DIR: deps.HISTORY_DIR }));
  return router;
};
