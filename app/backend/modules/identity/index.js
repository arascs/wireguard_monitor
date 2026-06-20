const express = require('express');
const createAuthRoutes = require('./routes/auth');
const createUserRoutes = require('./routes/users');
const createDeviceRoutes = require('./routes/devices');
const createConnectVpnRoutes = require('./routes/connectVpn');

module.exports = function mountIdentity(deps) {
  const router = express.Router();
  router.use(createAuthRoutes(deps));
  router.use(createUserRoutes(deps));
  router.use(createDeviceRoutes(deps));
  router.use(createConnectVpnRoutes(deps));
  return router;
};
