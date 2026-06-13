const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

module.exports = {
  BACKEND_DIR,
  FRONTEND_DIR: path.join(BACKEND_DIR, '../frontend'),
  SETTINGS_FILE: path.join(BACKEND_DIR, 'settings.json'),
  NODE_KEY_FILE: path.join(BACKEND_DIR, 'node_api_key.txt'),
  CREDENTIALS_FILE: '/etc/wireguard/credentials.txt',
  BACKUP_DIR: '/var/backups/wg_monitor',
  HISTORY_DIR: '/etc/wireguard/logs/vpn_history',
  EXPORTER_SCRIPT: '/usr/local/bin/exporter.sh',
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || '/usr/local/share/ca-certificates/key.pem',
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || '/usr/local/share/ca-certificates/cert.pem',
  DEFAULT_KEY_EXPIRY_DAYS: 90
};
