const express = require('express');
const createInterfaceRoutes = require('./routes/interfaces');
const createPeerRoutes = require('./routes/peers');
const createSettingsRoutes = require('./routes/settings');
const createApplicationRoutes = require('./routes/applications');
const createAccessRuleRoutes = require('./routes/accessRules');

module.exports = function mountSystemConfig(deps) {
  const router = express.Router();
  router.use(createInterfaceRoutes());
  router.use(createPeerRoutes());
  router.use(createSettingsRoutes());
  router.use(createApplicationRoutes(deps));
  router.use(createAccessRuleRoutes(deps));
  return router;
};
