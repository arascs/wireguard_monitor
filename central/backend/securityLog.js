const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.SECURITY_LOG_DIR || '/etc/wireguard/logs';
const LOG_FILE = path.join(LOG_DIR, 'endpoint_events.json');

function logSecurityEvent(fields) {
  const { event_name, timestamp, ...rest } = fields;
  const entry = {
    timestamp: timestamp || new Date().toISOString(),
    event_name: event_name || 'unknown',
    details: rest
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.error('[securityLog]', e.message);
  }
}

module.exports = { logSecurityEvent, LOG_FILE };
