const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

module.exports = ({ requireAuth, BACKUP_DIR, CONFIG_DIR, dbConfig }) => {
  const router = express.Router();

  router.get('/backups', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return res.json({ success: true, backups: [] });
      }
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.tar.gz'));
      const backups = files.map(f => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        let type = 'unknown';
        try {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
          execSync(`tar -xzf ${full} -C ${tmp}`);
          const metaPath = path.join(tmp, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath));
            type = meta.type || 'unknown';
          }
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch (e) {
          // ignore
        }
        return { name: f, size: stat.size, mtime: stat.mtime, type };
      });
      res.json({ success: true, backups });
    } catch (e) {
      res.status(500).json({ success: false, error: 'cannot list backups' });
    }
  });

  router.post('/backups/create', requireAuth, (req, res) => {
    const { type } = req.body;
    if (!['db', 'wg_config', 'full'].includes(type)) {
      return res.status(400).json({ success: false, error: 'invalid type' });
    }
    try {
      const ts = Date.now();
      const fname = `wg_monitor_backup_${ts}.tar.gz`;
      const filePath = path.join(BACKUP_DIR, fname);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      const metadata = { type, timestamp: ts };
      fs.writeFileSync(path.join(tmp, 'metadata.json'), JSON.stringify(metadata));
      if (type === 'db' || type === 'full') {
        execSync(`mysqldump -u ${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > ${path.join(tmp, 'database.sql')}`);
      }
      if (type === 'wg_config' || type === 'full') {
        const wgdir = path.join(tmp, 'wireguard_configs');
        fs.mkdirSync(wgdir);
        execSync(`cp -a ${CONFIG_DIR}/* ${wgdir}/`);
      }
      execSync(`tar -czf ${filePath} -C ${tmp} .`);
      fs.rmSync(tmp, { recursive: true, force: true });
      res.json({ success: true, filename: fname });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/backups/restore', requireAuth, (req, res) => {
    const { name } = req.body;
    const fullPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      execSync(`tar -xzf ${fullPath} -C ${tmp}`);
      const metaPath = path.join(tmp, 'metadata.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : {};
      const type = meta.type;

      try {
        const ts2 = Date.now();
        const preName = `wg_monitor_pre_restore_${ts2}.tar.gz`;
        const prePath = path.join(BACKUP_DIR, preName);
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
        const metadata2 = { type, timestamp: ts2 };
        fs.writeFileSync(path.join(tmp2, 'metadata.json'), JSON.stringify(metadata2));
        if (type === 'db' || type === 'full') {
          execSync(`mysqldump -u ${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > ${path.join(tmp2, 'database.sql')}`);
        }
        if (type === 'wg_config' || type === 'full') {
          const wgdir = path.join(tmp2, 'wireguard_configs');
          fs.mkdirSync(wgdir);
          execSync(`cp -a ${CONFIG_DIR}/* ${wgdir}/`);
        }
        execSync(`tar -czf ${prePath} -C ${tmp2} .`);
        fs.rmSync(tmp2, { recursive: true, force: true });
      } catch (e) {
        console.error('pre-restore backup failed', e);
      }

      if (type === 'db' || type === 'full') {
        execSync(`mysql -u ${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} < ${path.join(tmp, 'database.sql')}`);
      }
      if (type === 'wg_config' || type === 'full') {
        execSync(`cp -a ${path.join(tmp, 'wireguard_configs')}/* ${CONFIG_DIR}`);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};
