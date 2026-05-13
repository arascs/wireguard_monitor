const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'central_credentials.txt');

const SESSION_SECRET = process.env.CENTRAL_SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('CENTRAL_SESSION_SECRET is required (set it in .env)');
}

const COOKIE_NAME = process.env.CENTRAL_COOKIE_NAME || 'central_session';
const COOKIE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function ensureCredentials() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CRED_FILE)) {
    const hash = bcrypt.hashSync('admin', 10);
    fs.writeFileSync(CRED_FILE, `admin:${hash}`, { mode: 0o600 });
  }
}

function loadCreds() {
  ensureCredentials();
  const line = fs.readFileSync(CRED_FILE, 'utf8').trim();
  const i = line.indexOf(':');
  if (i <= 0) throw new Error('Invalid credentials file');
  return { username: line.slice(0, i), passwordHash: line.slice(i + 1) };
}

async function verifyLogin(username, password) {
  const c = loadCreds();
  if (!username || !password) return false;
  if (username !== c.username) return false;
  return bcrypt.compare(password, c.passwordHash);
}

function authMiddleware(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = {
  ensureCredentials,
  loadCreds,
  SESSION_SECRET,
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME,
  verifyLogin,
  authMiddleware,
  CRED_FILE
};
