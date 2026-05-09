const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

module.exports = ({ requireAuth, BACKUP_DIR, CONFIG_DIR, dbConfig }) => {
  const router = express.Router();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Run a binary via execFile/spawnSync (no shell). Throws on non-zero exit. */
  function exec(file, args = [], opts = {}) {
    const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...opts });
    if (r.status !== 0) {
      throw new Error(r.stderr || `${file} exited with status ${r.status}`);
    }
    return r.stdout || '';
  }

  /** mysqldump <db> > out.sql, no shell redirection. */
  function dumpDatabase(dest) {
    const r = spawnSync(
      'mysqldump',
      ['-h', dbConfig.host, '-u', dbConfig.user, `-p${dbConfig.password}`, dbConfig.database],
      { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 }
    );
    if (r.status !== 0) {
      throw new Error(r.stderr || `mysqldump exited with status ${r.status}`);
    }
    fs.writeFileSync(dest, r.stdout || '');
  }

  /** mysql <db> < in.sql, using stdin. */
  function restoreDatabase(srcSqlFile) {
    const sql = fs.readFileSync(srcSqlFile, 'utf8');
    const r = spawnSync(
      'mysql',
      ['-h', dbConfig.host, '-u', dbConfig.user, `-p${dbConfig.password}`, dbConfig.database],
      { encoding: 'utf8', input: sql, maxBuffer: 200 * 1024 * 1024 }
    );
    if (r.status !== 0) {
      throw new Error(r.stderr || `mysql exited with status ${r.status}`);
    }
  }

  /** Recursively copy directory contents using node fs (no `cp -a`). */
  function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDir(s, d);
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
      else fs.copyFileSync(s, d);
    }
  }

  function tarCreate(archive, fromDir) {
    exec('tar', ['-czf', archive, '-C', fromDir, '.']);
  }

  function tarExtract(archive, intoDir) {
    exec('tar', ['-xzf', archive, '-C', intoDir]);
  }

  function parseConfFile(filePath, interfaceName) {
    const result = {
      name: interfaceName,
      address: '',
      listenPort: '',
      dns: '',
      mtu: '',
      type: '',
      status: 'unknown',
      peers: []
    };
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      let section = null;
      let currentPeer = null;
      let pendingPeerName = '';

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const isCommented = trimmed.startsWith('#');
        const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;
        if (!cleanLine) continue;

        if (isCommented) {
          const lower = cleanLine.toLowerCase();
          if (lower.startsWith('type =')) {
            result.type = cleanLine.split('=').slice(1).join('=').trim();
            continue;
          }
          if (lower.startsWith('name =')) {
            pendingPeerName = cleanLine.split('=').slice(1).join('=').trim();
            continue;
          }
        }

        if (cleanLine === '[Interface]') { section = 'interface'; continue; }
        if (cleanLine === '[Peer]') {
          section = 'peer';
          currentPeer = {
            name: pendingPeerName || '',
            publicKey: '',
            presharedKey: '',
            endpoint: '',
            allowedIPs: '',
            persistentKeepalive: '',
            enabled: !isCommented
          };
          pendingPeerName = '';
          result.peers.push(currentPeer);
          continue;
        }

        if (!cleanLine.includes('=')) continue;
        const eqIdx = cleanLine.indexOf('=');
        const key = cleanLine.substring(0, eqIdx).trim().toLowerCase();
        const value = cleanLine.substring(eqIdx + 1).trim();

        if (section === 'interface') {
          if (key === 'address') result.address = value;
          else if (key === 'listenport') result.listenPort = value;
          else if (key === 'dns') result.dns = value;
          else if (key === 'mtu') result.mtu = value;
        } else if (section === 'peer' && currentPeer) {
          if (key === 'publickey') currentPeer.publicKey = value;
          else if (key === 'presharedkey') currentPeer.presharedKey = '(hidden)';
          else if (key === 'endpoint') currentPeer.endpoint = value;
          else if (key === 'allowedips') currentPeer.allowedIPs = value;
          else if (key === 'persistentkeepalive') currentPeer.persistentKeepalive = value;
          if (isCommented) currentPeer.enabled = false;
        }
      }
    } catch (e) {
      // ignore parse errors
    }
    return result;
  }

  function collectInterfaces() {
    if (!fs.existsSync(CONFIG_DIR)) return [];
    const activeSet = new Set();
    try {
      const out = exec('wg', ['show', 'interfaces']).trim();
      if (out) out.split(/\s+/).filter(Boolean).forEach((i) => activeSet.add(i));
    } catch (_) { /* wg not running */ }

    return fs.readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith('.conf'))
      .sort()
      .map((f) => {
        const name = path.basename(f, '.conf');
        const info = parseConfFile(path.join(CONFIG_DIR, f), name);
        info.status = activeSet.has(name) ? 'connected' : 'disconnected';
        return info;
      });
  }

  const SENSITIVE_COLUMNS = new Set([
    'private_key', 'password', 'password_hash', 'preshared_key',
    'privateKey', 'presharedKey', 'passwordHash'
  ]);

  async function collectDatabase() {
    let connection;
    const tables = [];
    try {
      connection = await mysql.createConnection(dbConfig);
      const [tableRows] = await connection.execute('SHOW TABLES');
      const tableKey = Object.keys(tableRows[0] || {})[0];
      for (const row of tableRows) {
        const tableName = row[tableKey];
        try {
          const [rows] = await connection.execute(`SELECT * FROM \`${tableName}\` LIMIT 200`);
          const sanitized = rows.map((r) => {
            const clean = {};
            for (const [k, v] of Object.entries(r)) {
              if (!SENSITIVE_COLUMNS.has(k)) clean[k] = v;
            }
            return clean;
          });
          tables.push({ name: tableName, rows: sanitized });
        } catch (e) {
          tables.push({ name: tableName, rows: [], error: e.message });
        }
      }
    } catch (e) {
      // DB not accessible
    } finally {
      if (connection) { try { await connection.end(); } catch (_) { /* ignore */ } }
    }
    return tables;
  }

  async function writeSnapshot(dir, type) {
    const snapshot = { createdAt: new Date().toISOString() };
    if (type === 'wg_config' || type === 'full') {
      snapshot.interfaces = collectInterfaces();
    }
    if (type === 'db' || type === 'full') {
      snapshot.database = { tables: await collectDatabase() };
    }
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  }

  // ─── Routes ────────────────────────────────────────────────────────────────

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
        } catch (e) {
          // ignore
        }
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
      const ts = Date.now();
      const fname = `wg_monitor_backup_${ts}.tar.gz`;
      const filePath = path.join(BACKUP_DIR, fname);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      const metadata = { type, timestamp: ts };
      fs.writeFileSync(path.join(tmp, 'metadata.json'), JSON.stringify(metadata));

      if (type === 'db' || type === 'full') {
        dumpDatabase(path.join(tmp, 'database.sql'));
      }
      if (type === 'wg_config' || type === 'full') {
        copyDir(CONFIG_DIR, path.join(tmp, 'wireguard_configs'));
      }

      await writeSnapshot(tmp, type);
      tarCreate(filePath, tmp);
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
      tarExtract(fullPath, tmp);
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
          dumpDatabase(path.join(tmp2, 'database.sql'));
        }
        if (type === 'wg_config' || type === 'full') {
          copyDir(CONFIG_DIR, path.join(tmp2, 'wireguard_configs'));
        }
        tarCreate(prePath, tmp2);
        fs.rmSync(tmp2, { recursive: true, force: true });
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
