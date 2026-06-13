const express = require('express');
const bcrypt = require('bcrypt');
const { loginLimiter, clientIp } = require('../../../common/security');
const { isUserExpired } = require('../../../common/securityChecks');


function createAuthRoutes({ jwt, JWT_SECRET, mysql, dbConfig }) {
  const router = express.Router();

  router.post('/login', loginLimiter('local-device'), async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [users] = await connection.execute(
        'SELECT id, username, password, expire_day FROM users WHERE username = ?',
        [username]
      );
      if (users.length === 0) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const match = await bcrypt.compare(password, users[0].password);
      if (!match) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      if (isUserExpired(users[0].expire_day)) {
        return res.status(403).json({ success: false, error: 'User account expired' });
      }

      const token = jwt.sign(
        { username, id: users[0].id },
        JWT_SECRET,
        { expiresIn: '12h' }
      );
      return res.json({ success: true, token });
    } catch (error) {
      console.error('Database error during login:', error);
      return res.status(500).json({ success: false, error: 'Database connection failed' });
    } finally {
      if (connection) {
        try { await connection.end(); } catch (_) { /* ignore */ }
      }
    }
  });

  return router;
}

module.exports = createAuthRoutes;
