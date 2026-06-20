const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { logSecurityEvent } = require('../modules/logging/auditLogger');

function parseList(env) {
  return String(env || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function clientIp(req) {
  const raw = req.ip || (req.connection && req.connection.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '');
}

function corsMiddleware() {
  const allowed = parseList(process.env.ALLOWED_ORIGINS);
  return cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Register-Key']
  });
}

function loginLimiter(component) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${clientIp(req)}:${(req.body && req.body.username) || ''}`,
    handler: (req, res) => {
      logSecurityEvent({
        event_name: 'fail_logins',
        ip: clientIp(req),
        username: (req.body && req.body.username) || '',
        reason: 'rate_limit_exceeded'
      });
      res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
    }
  });
}

module.exports = {
  corsMiddleware,
  loginLimiter,
  clientIp
};
