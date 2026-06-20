const session = require('express-session');
const { SESSION_SECRET } = require('./auth');

const ADMIN_BYPASS_PATHS = new Set([
  '/api/admin-login',
  '/api/login',
  '/api/logout',
  '/api/connect-vpn',
  '/api/disconnect-vpn',
  '/api/device-heartbeat',
  '/api/check-device-enroll',
  '/api/enroll-device',
  '/api/update-key',
  '/api/notifications/ingest',
  '/api/sites/by-endpoint',
  '/api/hostname'
]);

function pathAllowsBypass(p) {
  if (ADMIN_BYPASS_PATHS.has(p)) return true;
  return false;
}

function setupSession(app) {
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 3600000
    }
  }));
}

module.exports = {
  ADMIN_BYPASS_PATHS,
  pathAllowsBypass,
  setupSession
};
