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
  requireSuperAdmin,
  requireSuperAdminPage
};
