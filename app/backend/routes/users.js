const express = require('express');

function createUserRoutes({ mysql, dbConfig, bcrypt, run, requireAuth }) {
  const router = express.Router();

  // User identity management
  router.get('/users', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, username, allowed_ips, public_key FROM users ORDER BY id DESC'
      );
      res.json({ success: true, users: rows });
    } catch (error) {
      console.error('Error loading users:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/users', requireAuth, async (req, res) => {
    const { username, password, allowedIPs } = req.body || {};
    if (!username || !password || !allowedIPs) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      const privateKey = run('wg genkey').trim();
      const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();

      const passwordHash = await bcrypt.hash(password, 10);
      const privateKeyHash = await bcrypt.hash(privateKey, 10);

      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO users (username, password, public_key, private_key, allowed_ips) VALUES (?, ?, ?, ?, ?)',
        [username, passwordHash, publicKey, privateKeyHash, allowedIPs]
      );

      res.json({
        success: true,
        user: {
          username,
          allowed_ips: allowedIPs,
          public_key: publicKey
        },
        privateKey
      });
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  return router;
}

module.exports = createUserRoutes;

