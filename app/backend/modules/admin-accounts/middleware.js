const { ADMIN_BYPASS_PATHS } = require('../../common/middleware');

function pathAllowsBypass(p) {
  if (ADMIN_BYPASS_PATHS.has(p)) return true;
  return false;
}

function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

function createRequireAuth(validateAdminSession) {
  return async function requireAuth(req, res, next) {
    if (!req.session || !req.session.adminId) {
      if (req.path && req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      return res.redirect('/login');
    }

    try {
      const ok = await validateAdminSession(req);
      if (!ok) {
        await destroySession(req);
        if (req.path && req.path.startsWith('/api/')) {
          return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        return res.redirect('/login');
      }
      return next();
    } catch (error) {
      console.error('Admin session validation failed:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

function createAdminApiGuard(validateAdminSession) {
  return async function adminApiGuard(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    if (pathAllowsBypass(req.path)) return next();
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    try {
      const ok = await validateAdminSession(req);
      if (!ok) {
        await destroySession(req);
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      return next();
    } catch (error) {
      console.error('Admin API guard failed:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Super admin required' });
}

function requireSuperAdminPage(req, res, next) {
  if (req.session && req.session.role === 'superadmin') return next();
  return res.redirect('/');
}

module.exports = {
  createRequireAuth,
  createAdminApiGuard,
  requireSuperAdmin,
  requireSuperAdminPage
};
