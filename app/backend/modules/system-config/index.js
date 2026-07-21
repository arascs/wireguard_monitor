const express = require('express');
const createInterfaceRoutes = require('./routes/interfaces');
const createPeerRoutes = require('./routes/peers');
const createSettingsRoutes = require('./routes/settings');

module.exports = function mountSystemConfig(deps) {
  const router = express.Router();
  router.use(createInterfaceRoutes(deps));
  router.use(createPeerRoutes(deps));
  router.use(createSettingsRoutes(deps));
  return router;
};
