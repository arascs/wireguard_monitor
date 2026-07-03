const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = ({ requireAuth, backupService }) => {
  const router = express.Router();
  const { createBackup, tarExtract, restoreDatabase, copyDir, CONFIG_DIR, BACKUP_DIR } = backupService;

  router.get('/backups', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.tar.gz'));
      const backups = files.map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        let type = 'unknown';
        let hasSnapshot = false;
        try {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
          tarExtract(full, tmp);
          const metaPath = path.join(tmp, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath));
            type = meta.type || 'unknown';
          }
          hasSnapshot = fs.existsSync(path.join(tmp, 'snapshot.json'));
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) { /* ignore */ }
        return { name: f, size: stat.size, mtime: stat.mtime, type, hasSnapshot };
      });
      res.json({ success: true, backups });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot list backups' });
    }
  });

  router.post('/backups/create', requireAuth, async (req, res) => {
    const { type } = req.body;
    if (!['db', 'wg_config', 'full'].includes(type)) {
      return res.status(400).json({ success: false, error: 'invalid type' });
    }
    try {
      const { filename } = await createBackup(type);
      res.json({ success: true, filename });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/backups/restore', requireAuth, async (req, res) => {
    const { name } = req.body;
    const fullPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      tarExtract(fullPath, tmp);
      const metaPath = path.join(tmp, 'metadata.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : {};
      const type = meta.type;

      try {
        await createBackup(type, { prefix: 'wg_monitor_pre_restore', snapshot: false });
      } catch (e) {
        console.error('pre-restore backup failed', e);
      }

      if (type === 'db' || type === 'full') {
        restoreDatabase(path.join(tmp, 'database.sql'));
      }
      if (type === 'wg_config' || type === 'full') {
        copyDir(path.join(tmp, 'wireguard_configs'), CONFIG_DIR);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/backups/snapshot/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-\.]+\.tar\.gz$/.test(name)) {
      return res.status(400).json({ success: false, error: 'invalid filename' });
    }
    const fullPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      tarExtract(fullPath, tmp);
      const snapPath = path.join(tmp, 'snapshot.json');
      if (!fs.existsSync(snapPath)) {
        return res.status(404).json({ success: false, error: 'No snapshot data in this backup.' });
      }
      const snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      res.json({ success: true, snapshot });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally {
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
    }
  });

  return router;
};
