const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.CENTRAL_AUDIT_LOG_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(LOG_DIR, 'audit_log.json');

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function logAction(admin, action, details) {
  const entry = {
    timestamp: Date.now(),
    admin,
    action,
    details: details || {}
  };
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.error('[AUDIT] failed to write log file', e.message);
  }
}

function getLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const data = fs.readFileSync(LOG_FILE, 'utf8').trim();
    if (!data) return [];
    return data
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.error('[AUDIT] failed to read log file', e.message);
    return [];
  }
}

module.exports = { logAction, getLogs };
