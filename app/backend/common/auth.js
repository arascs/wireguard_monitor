const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;

function ensureSecrets() {
  if (!JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET is required (set it in .env)');
    process.exit(1);
  }
  if (!SESSION_SECRET) {
    console.error('[FATAL] SESSION_SECRET is required (set it in .env)');
    process.exit(1);
  }
}

function apiKeyAuth(req, res, next) {
  const expected = (process.env.NODE_API_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ success: false, error: 'node not provisioned' });
  }
  const auth = req.header('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || '';
  if (!provided) {
    return res.status(401).json({ success: false, error: 'missing api key' });
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'invalid api key' });
  }
  next();
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ success: false, error: 'Malformed Authorization header' });
  }
  const token = parts[1];
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    req.user = payload;
    next();
  });
}

function secretStringsMatch(stored, presented) {
  const a = String(stored || '');
  const b = String(presented || '');
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  JWT_SECRET,
  SESSION_SECRET,
  ensureSecrets,
  apiKeyAuth,
  authenticateToken,
  secretStringsMatch
};
