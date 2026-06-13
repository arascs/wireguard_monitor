const express = require('express');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { loginLimiter } = require('../../../common/security');
const { loadCredentials } = require('../../../common/auth');
const { CREDENTIALS_FILE } = require('../../../common/paths');

module.exports = function createAdminAuthRoutes({ requireAuth }) {
  const router = express.Router();

  router.post('/admin-login', loginLimiter('local-admin'), async (req, res) => {
    const { username, password } = req.body || {};
    const creds = loadCredentials();
    if (username === creds.username && await bcrypt.compare(password, creds.passwordHash)) {
      req.session.user = username;
      return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const creds = loadCredentials();
    if (await bcrypt.compare(currentPassword, creds.passwordHash)) {
      const newHash = await bcrypt.hash(newPassword, 10);
      fs.writeFileSync(CREDENTIALS_FILE, `${creds.username}:${newHash}`, { mode: 0o600 });
      req.session.destroy(() => {});
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Current password incorrect' });
    }
  });

  router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
  });

  return router;
};
