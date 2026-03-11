const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../audit_log.json');

function logAction(admin, action, details) {
  const entry = {
    timestamp: Date.now(),
    admin,
    action,
    details: details || {}
  };

  let arr = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      arr = data ? JSON.parse(data) : [];
      if (!Array.isArray(arr)) arr = [];
    }
  } catch (e) {
    console.error('[AUDIT] failed to read log file', e.message);
  }

  arr.push(entry);
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('[AUDIT] failed to write log file', e.message);
  }
}

function getLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      return data ? JSON.parse(data) : [];
    }
  } catch (e) {
    console.error('[AUDIT] failed to read log file', e.message);
  }
  return [];
}

module.exports = { logAction, getLogs };