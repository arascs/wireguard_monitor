const session = require('express-session');
const { SESSION_SECRET } = require('./auth');

const PUBLIC_API_PATHS = new Set([
  '/api/login',
  '/api/connect-vpn',
  '/api/disconnect-vpn',
  '/api/device-heartbeat',
  '/api/check-device-enroll',
  '/api/enroll-device',
  '/api/update-key',
  '/api/notifications/ingest',
  '/api/hostname'
]);

const ADMIN_BYPASS_PATHS = new Set([
  '/api/admin-login',
  '/api/logout',
  ...PUBLIC_API_PATHS
]);

function pathAllowsBypass(p) {
  return ADMIN_BYPASS_PATHS.has(p);
}

function pathIsPublicApi(p) {
  return PUBLIC_API_PATHS.has(p);
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
  PUBLIC_API_PATHS,
  pathAllowsBypass,
  pathIsPublicApi,
  setupSession
};
