const bcrypt = require('bcrypt');
const { initAdminAccounts, createValidateAdminSession, authenticateAdmin } = require('./db');
const { createAuthMiddleware } = require('./middleware');
const createAdminsRoutes = require('./routes/admins');

let authMiddleware = null;

async function setup() {
  await initAdminAccounts(bcrypt);
  authMiddleware = createAuthMiddleware(createValidateAdminSession());
}

function getAuthMiddleware() {
  if (!authMiddleware) {
    return (req, res) => res.status(503).json({ error: 'Server starting' });
  }
  return authMiddleware;
}

function authWrapper(req, res, next) {
  return getAuthMiddleware()(req, res, next);
}

function mountAdminsRoutes(app) {
  app.use('/api', createAdminsRoutes({ getAuthMiddleware, bcrypt }));
}

module.exports = {
  setup,
  authWrapper,
  mountAdminsRoutes,
  authenticateAdmin
};
