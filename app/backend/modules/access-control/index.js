const express = require('express');
const createApplicationRoutes = require('./routes/applications');
const createAccessRuleRoutes = require('./routes/accessRules');
const { ensureAppProxySchema, syncAppProxies } = require('./app-proxy');

function mountAccessControl(deps) {
  const router = express.Router();
  router.use(createApplicationRoutes(deps));
  router.use(createAccessRuleRoutes(deps));
  return router;
}

module.exports = mountAccessControl;
module.exports.ensureAppProxySchema = ensureAppProxySchema;
module.exports.syncAppProxies = syncAppProxies;
