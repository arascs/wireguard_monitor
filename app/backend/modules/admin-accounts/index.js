const express = require('express');
const { initAdminAccounts, createValidateAdminSession } = require('./db');
const {
  createRequireAuth,
  createAdminApiGuard,
  requireSuperAdmin,
  requireSuperAdminPage
} = require('./middleware');
const createAdminAuthRoutes = require('./routes/auth');
const createAdminsRoutes = require('./routes/admins');

function mountAdminAccounts(deps) {
  const router = express.Router();
  router.use(createAdminAuthRoutes(deps));
  router.use(createAdminsRoutes(deps));
  return router;
}

module.exports = {
  initAdminAccounts,
  createValidateAdminSession,
  createRequireAuth,
  createAdminApiGuard,
  requireSuperAdmin,
  requireSuperAdminPage,
  mountAdminAccounts
};
