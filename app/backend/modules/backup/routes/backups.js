const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BACKUP_NAME_RE = /^[\w\-.]+\.tar\.gz(\.enc)?$/;

module.exports = ({ requireAuth, backupService }) => {
  const router = express.Router();
  const { createBackup, tarExtract, restoreDatabase, copyDir, CONFIG_DIR, BACKUP_DIR } = backupService;

  function isEncryptedName(name) {
    return name.endsWith('.tar.gz.enc');
  }

  router.get('/backups', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.tar.gz') || f.endsWith('.tar.gz.enc'));
      const backups = files.map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        const encrypted = isEncryptedName(f);
        let type = encrypted ? 'encrypted' : 'unknown';
        let hasSnapshot = false;
        if (!encrypted) {
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
        }
        return { name: f, size: stat.size, mtime: stat.mtime, type, hasSnapshot, encrypted };
      });
      res.json({ success: true, backups });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot list backups' });
    }
  });

  router.post('/backups/create', requireAuth, async (req, res) => {
    const { type, password } = req.body;
    if (!['db', 'wg_config', 'full'].includes(type)) {
      return res.status(400).json({ success: false, error: 'invalid type' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'password required' });
    }
    try {
      const { filename } = await createBackup(type, { password });
      res.json({ success: true, filename });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/backups/restore', requireAuth, async (req, res) => {
    const { name, password } = req.body;
    if (!BACKUP_NAME_RE.test(name || '')) {
      return res.status(400).json({ success: false, error: 'invalid filename' });
    }
    const fullPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    if (isEncryptedName(name) && (!password || typeof password !== 'string')) {
      return res.status(400).json({ success: false, error: 'password required' });
    }
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      tarExtract(fullPath, tmp, password || null);
      const metaPath = path.join(tmp, 'metadata.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : {};
      const type = meta.type;

      try {
        await createBackup(type, { prefix: 'wg_monitor_pre_restore', snapshot: false, password: password || undefined });
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

  router.post('/backups/snapshot', requireAuth, (req, res) => {
    const { name, password } = req.body || {};
    if (!BACKUP_NAME_RE.test(name || '')) {
      return res.status(400).json({ success: false, error: 'invalid filename' });
    }
    const fullPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    if (isEncryptedName(name) && (!password || typeof password !== 'string')) {
      return res.status(400).json({ success: false, error: 'password required' });
    }
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      tarExtract(fullPath, tmp, password || null);
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
