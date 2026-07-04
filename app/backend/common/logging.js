const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = '/etc/wireguard/logs';
const VPN_LOG = path.join(LOG_DIR, 'vpn.log');
const ACCESS_LOG = path.join(LOG_DIR, 'access.log');

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(LOG_DIR, 0o700);
  } catch (_) {
    /* ignore */
  }
}

function vpnWrite(level, args) {
  ensureLogDir();
  const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
  try {
    fs.appendFileSync(VPN_LOG, line, { mode: 0o600 });
  } catch (_) {
    /* ignore */
  }
}

console.log = (...args) => vpnWrite('INFO', args);
console.error = (...args) => vpnWrite('ERROR', args);
console.warn = (...args) => vpnWrite('WARN', args);

function accessLogStream() {
  ensureLogDir();
  return fs.createWriteStream(ACCESS_LOG, { flags: 'a', mode: 0o600 });
}

module.exports = { accessLogStream };
