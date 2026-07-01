const express = require('express');
const createAuthRoutes = require('./routes/auth');
const createUserRoutes = require('./routes/users');
const createDeviceRoutes = require('./routes/devices');
const createConnectVpnRoutes = require('./routes/connectVpn');
const createSecurityProfileRoutes = require('./routes/securityProfiles');

module.exports = function mountClientManagement(deps) {
  const router = express.Router();
  router.use(createAuthRoutes(deps));
  router.use(createUserRoutes(deps));
  router.use(createDeviceRoutes(deps));
  router.use(createSecurityProfileRoutes(deps));
  router.use(createConnectVpnRoutes(deps));
  return router;
};
