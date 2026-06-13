const express = require('express');

function createApplicationRoutes({ mysql, dbConfig, requireAuth }) {
  const router = express.Router();

  // Applications management
  router.get('/applications', requireAuth, async (req, res) => {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(
        'SELECT id, name, type, IP, port FROM applications ORDER BY id DESC'
      );
      res.json({ success: true, applications: rows });
    } catch (error) {
      console.error('Error loading applications:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  router.post('/applications', requireAuth, async (req, res) => {
    const { name, type, IP, port } = req.body || {};
    if (!name || !type || !IP || !port) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      await connection.execute(
        'INSERT INTO applications (name, type, IP, port) VALUES (?, ?, ?, ?)',
        [name, type, IP, port]
      );

      res.json({
        success: true,
        application: { name, type, IP, port }
      });
    } catch (error) {
      console.error('Error creating application:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  });

  return router;
}

module.exports = createApplicationRoutes;

