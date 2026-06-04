const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = '/etc/wireguard/logs';
const VPN_LOG = path.join(LOG_DIR, 'vpn.log');
const ACCESS_LOG = path.join(LOG_DIR, 'access.log');

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

function vpnWrite(level, args) {
  ensureLogDir();
  const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
  try {
    fs.appendFileSync(VPN_LOG, line);
  } catch (_) {
    /* ignore */
  }
}

console.log = (...args) => vpnWrite('INFO', args);
console.error = (...args) => vpnWrite('ERROR', args);
console.warn = (...args) => vpnWrite('WARN', args);

function accessLogStream() {
  ensureLogDir();
  return fs.createWriteStream(ACCESS_LOG, { flags: 'a' });
}

module.exports = { accessLogStream };
