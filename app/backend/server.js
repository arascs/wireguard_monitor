#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const morgan = require('morgan');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const { accessLogStream } = require('./common/logging');
const { corsMiddleware } = require('./common/security');
const { dbConfig } = require('./common/db');
const { HOSTNAME } = require('./common/config');
const {
  FRONTEND_DIR,
  BACKUP_DIR,
  HISTORY_DIR,
  TLS_KEY_PATH,
  TLS_CERT_PATH
} = require('./common/paths');
const {
  JWT_SECRET,
  ensureSecrets,
  apiKeyAuth,
  authenticateToken,
  requireAuth,
  loadNodeApiKeyFromDisk
} = require('./common/auth');
const { setupSession, adminApiGuard } = require('./common/middleware');

const mountSystemConfig = require('./modules/system-config');
const mountIdentity = require('./modules/identity');
const registerMonitoring = require('./modules/monitoring');
const { startCentralSync } = require('./modules/monitoring');
const mountLogging = require('./modules/logging');
const mountBackup = require('./modules/backup');
const { checkAndDisconnectIfExpired } = require('./modules/system-config/services/keyExpiry');

ensureSecrets();
loadNodeApiKeyFromDisk();

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const app = express();
app.set('trust proxy', true);
const PORT = parseInt(process.env.PORT || '3000', 10);

const moduleDeps = {
  mysql,
  dbConfig,
  bcrypt,
  jwt,
  JWT_SECRET,
  requireAuth,
  authenticateToken,
  apiKeyAuth,
  run: require('./common/runCmd').run,
  port: PORT,
  HISTORY_DIR
};

app.use(corsMiddleware());
app.use(morgan('combined', { stream: accessLogStream() }));
app.use(express.json());
setupSession(app);
app.use(adminApiGuard);

registerMonitoring(app, moduleDeps);

app.use('/api', mountSystemConfig(moduleDeps));
app.use('/api', mountIdentity(moduleDeps));
app.use('/api', mountLogging(moduleDeps));
app.use('/api', mountBackup(moduleDeps));

function renderHtmlWithHostname(filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/\{\{HOSTNAME\}\}/g, HOSTNAME);
  return html;
}

app.get('/audit-log', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'audit.html')));
});

app.get('/backup', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'backup.html')));
});

app.get('/login', (req, res) => {
  let html = fs.readFileSync(path.join(FRONTEND_DIR, 'login.html'), 'utf8');
  html = html.replace('{{HOSTNAME}}', HOSTNAME);
  res.send(html);
});

app.get('/', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'index.html')));
});

app.get('/interfaces', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'interfaces.html')));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'dashboard.html')));
});

app.get('/dashboard/:id', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'dashboard.html')));
});

app.get('/dashboard/peer/:id', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'peer_detail.html')));
});

app.get('/settings', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'settings.html')));
});

app.get('/dashboard/:id/peer/:peer_id', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'peer_detail.html')));
});

app.get('/users', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'users.html')));
});

app.get('/devices', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'devices.html')));
});

app.get('/applications', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'applications.html')));
});

app.get('/access-rules', requireAuth, (req, res) => {
  res.send(renderHtmlWithHostname(path.join(FRONTEND_DIR, 'access_rules.html')));
});

app.use(express.static(FRONTEND_DIR));

if (process.getuid && process.getuid() !== 0) {
  console.error('[ERROR] This program requires root privileges');
  process.exit(1);
}

setInterval(() => {
  checkAndDisconnectIfExpired();
}, 60 * 1000);

function tlsPair(keyPath, certPath) {
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

const internalTls = tlsPair(
  process.env.TLS_INTERNAL_KEY_PATH || TLS_KEY_PATH,
  process.env.TLS_INTERNAL_CERT_PATH || TLS_CERT_PATH
);
const publicTls = tlsPair(
  process.env.TLS_PUBLIC_KEY_PATH || TLS_KEY_PATH,
  process.env.TLS_PUBLIC_CERT_PATH || TLS_CERT_PATH
);

const hLan = process.env.TLS_INTERNAL_BIND || '192.168.178.128';
const hPub = process.env.TLS_PUBLIC_BIND || '172.16.0.128';
const hLo = process.env.TLS_LOOPBACK_BIND || '127.0.0.1';

const listeners = [
  [internalTls, hLan],
  [publicTls, hPub],
  [internalTls, hLo]
];

const onBoot = startCentralSync(PORT);

for (const [opts, host] of listeners) {
  https.createServer(opts, app).listen(PORT, host, () => {
    console.log(`HTTPS https://${host}:${PORT}`);
    onBoot();
  });
}
