const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = ({ requireAuth, HISTORY_DIR }) => {
  const router = express.Router();

  router.get('/session-logs', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(HISTORY_DIR)) {
        return res.json({ success: true, logs: [] });
      }
      const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
      let allLogs = [];
      files.forEach(fname => {
        const full = path.join(HISTORY_DIR, fname);
        const content = fs.readFileSync(full, 'utf8');
        content.split('\n').forEach(line => {
          if (!line.trim()) return;
          try {
            const obj = JSON.parse(line);
            allLogs.push(obj);
          } catch (e) {
            // skip bad line
          }
        });
      });
      allLogs.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
      res.json({ success: true, logs: allLogs });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot read session logs' });
    }
  });

  return router;
};
