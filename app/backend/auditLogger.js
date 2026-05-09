const fs = require('fs');
const path = require('path');

const LOG_DIR = '/etc/wireguard/logs';
const LOG_FILE = path.join(LOG_DIR, 'audit_log.json');
const SECURITY_FILE = path.join(LOG_DIR, 'endpoint_events.json');

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
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

/**
 * Append a security event (NDJSON) to endpoint_events.json. Used by the
 * login rate-limiter to record fail_logins, plus other security signals.
 */
function logSecurityEvent(fields) {
  const { event_name, timestamp, ...rest } = fields;
  const entry = {
    timestamp: timestamp || new Date().toISOString(),
    event_name: event_name || 'unknown',
    details: rest
  };
  try {
    ensureLogDir();
    fs.appendFileSync(SECURITY_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.error('[SECURITY] failed to write event', e.message);
  }
}

function readNdjson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, 'utf8').trim();
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
    console.error('[AUDIT] failed to read', file, e.message);
    return [];
  }
}

function getLogs() {
  return readNdjson(LOG_FILE);
}

function getSecurityEvents() {
  return readNdjson(SECURITY_FILE);
}

module.exports = { logAction, logSecurityEvent, getLogs, getSecurityEvents };
