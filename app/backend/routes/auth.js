const express = require('express');
const bcrypt = require('bcrypt');

function createAuthRoutes({ jwt, JWT_SECRET, mysql, dbConfig }) {
  const router = express.Router();

  // POST /api/login - Issue JWT token after validating credentials
  router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    try {
      // Validate credentials against MySQL users table
      const connection = await mysql.createConnection(dbConfig);
      const [users] = await connection.execute(
        'SELECT id, username, password FROM users WHERE username = ?',
        [username]
      );
      await connection.end();

      if (users.length === 0) {
        console.log(`User ${username} not found in database`);
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const match = await bcrypt.compare(password, users[0].password);
      if (!match) {
        console.log(`Password mismatch for user ${username}`);
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Issue JWT
      const token = jwt.sign(
        { username, id: users[0].id },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      console.log(`Login successful for user ${username}`);
      return res.json({ success: true, token });

    } catch (error) {
      console.error('Database error during login:', error);
      return res.status(500).json({ success: false, error: 'Database connection failed' });
    }
  });

  return router;
}

module.exports = createAuthRoutes;
