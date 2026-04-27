const fs = require('fs');

const LOG_FILE = '/etc/wireguard/logs/audit_log.json';
const SECURITY_FILE = '/etc/wireguard/logs/endpoint_events.json';

function logAction(admin, action, details) {
  const entry = {
    timestamp: Date.now(),
    admin,
    action,
    details: details || {}
  };

  try {
    fs.mkdirSync('/etc/wireguard/logs', { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.error('[AUDIT] failed to write log file', e.message);
  }
}

function getLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      if (!data || !data.trim()) return [];

      const trimmed = data.trim();
      // NDJSON: each line is one JSON object
      const lines = trimmed.split('\n');
      return lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error('[AUDIT] failed to parse line:', e.message);
          return null;
        }
      }).filter(e => e !== null);
    }
  } catch (e) {
    console.error('[AUDIT] failed to read log file', e.message);
  }
  return [];
}

function getSecurityEvents() {
  try {
    if (fs.existsSync(SECURITY_FILE)) {
      const data = fs.readFileSync(SECURITY_FILE, 'utf8');
      if (!data) return [];
      // Parse JSONL format (each line is a JSON object)
      const lines = data.trim().split('\n');
      const events = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error('[SECURITY] failed to parse line:', e.message);
          return null;
        }
      }).filter(e => e !== null);
      return events;
    }
  } catch (e) {
    console.error('[SECURITY] failed to read security events file', e.message);
  }
  return [];
}

module.exports = { logAction, getLogs, getSecurityEvents };