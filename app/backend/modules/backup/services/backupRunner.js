const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

function createBackupService({ BACKUP_DIR, CONFIG_DIR, dbConfig }) {
  function exec(file, args = [], opts = {}) {
    const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...opts });
    if (r.status !== 0) {
      throw new Error(r.stderr || `${file} exited with status ${r.status}`);
    }
    return r.stdout || '';
  }

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

  function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  function withBackupPass(password, opts = {}) {
    return { ...opts, env: { ...process.env, ...(opts.env || {}), BACKUP_PASS: password } };
  }

  function tarCreate(archive, fromDir, password) {
    if (password) {
      exec('bash', ['-c',
        `tar -czf - -C ${shQuote(fromDir)} . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASS -out ${shQuote(archive)}`
      ], withBackupPass(password));
    } else {
      exec('tar', ['-czf', archive, '-C', fromDir, '.']);
    }
    fs.chmodSync(archive, 0o600);
  }

  function tarExtract(archive, intoDir, password) {
    if (password || archive.endsWith('.enc')) {
      if (!password) throw new Error('password required for encrypted backup');
      exec('bash', ['-c',
        `openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASS -in ${shQuote(archive)} | tar -xzf - -C ${shQuote(intoDir)}`
      ], withBackupPass(password));
    } else {
      exec('tar', ['-xzf', archive, '-C', intoDir]);
    }
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
    } catch (_) { /* ignore */ }
    return result;
  }

  function collectInterfaces() {
    if (!fs.existsSync(CONFIG_DIR)) return [];
    const activeSet = new Set();
    try {
      const out = exec('wg', ['show', 'interfaces']).trim();
      if (out) out.split(/\s+/).filter(Boolean).forEach((i) => activeSet.add(i));
    } catch (_) { /* ignore */ }

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
    } catch (_) { /* ignore */ } finally {
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

  async function createBackup(type, options = {}) {
    const prefix = options.prefix || 'wg_monitor_backup';
    const snapshot = options.snapshot !== false;
    const password = options.password || process.env.BACKUP_PASSWORD || '';
    const ts = Date.now();
    const fname = password ? `${prefix}_${ts}.tar.gz.enc` : `${prefix}_${ts}.tar.gz`;
    const filePath = path.join(BACKUP_DIR, fname);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    try {
      fs.writeFileSync(path.join(tmp, 'metadata.json'), JSON.stringify({ type, timestamp: ts }));
      if (type === 'db' || type === 'full') {
        dumpDatabase(path.join(tmp, 'database.sql'));
      }
      if (type === 'wg_config' || type === 'full') {
        copyDir(CONFIG_DIR, path.join(tmp, 'wireguard_configs'));
      }
      if (snapshot) {
        await writeSnapshot(tmp, type);
      }
      tarCreate(filePath, tmp, password || null);
      return { filename: fname, filePath };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return {
    createBackup,
    tarExtract,
    restoreDatabase,
    copyDir,
    CONFIG_DIR,
    BACKUP_DIR
  };
}

module.exports = createBackupService;
