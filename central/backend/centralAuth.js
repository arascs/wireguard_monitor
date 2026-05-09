const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'central_credentials.txt');

const JWT_SECRET = process.env.CENTRAL_JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('CENTRAL_JWT_SECRET is required (set it in .env)');
}

const COOKIE_NAME = process.env.CENTRAL_COOKIE_NAME || 'central_session';
const COOKIE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/'
};

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

function generateToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '1h' });
}

async function verifyLogin(username, password) {
  const c = loadCreds();
  if (!username || !password) return false;
  if (username !== c.username) return false;
  return bcrypt.compare(password, c.passwordHash);
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = {
  ensureCredentials,
  loadCreds,
  generateToken,
  verifyLogin,
  authMiddleware,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME,
  CRED_FILE
};
