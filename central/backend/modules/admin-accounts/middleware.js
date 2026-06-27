function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

function createAuthMiddleware(validateAdminSession) {
  return async function authMiddleware(req, res, next) {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const ok = await validateAdminSession(req);
      if (!ok) {
        await destroySession(req);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return next();
    } catch (e) {
      console.error('[authMiddleware]', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.role === 'superadmin') return next();
  return res.status(403).json({ ok: false, error: 'Super admin required' });
}

module.exports = {
  createAuthMiddleware,
  requireSuperAdmin,
  destroySession
};
