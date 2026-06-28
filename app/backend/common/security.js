const rateLimit = require('express-rate-limit');
const cors = require('cors');
const ipRangeCheck = require('ip-range-check');
const { logSecurityEvent } = require('../modules/logging/auditLogger');
const { pathIsPublicApi } = require('./middleware');

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

function adminIpGuard(req, res, next) {
  const cidrs = parseList(process.env.ADMIN_IP_CIDR);
  if (cidrs.length === 0) return next();
  const p = req.path;
  if (pathIsPublicApi(p) || p === '/health' || p === '/metrics') return next();
  if (/\.[a-z0-9]+$/i.test(p)) return next();
  const ip = clientIp(req);
  if (ip === '127.0.0.1' || ip === '::1') return next();
  if (ipRangeCheck(ip, cidrs)) return next();
  if (p.startsWith('/api/')) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  return res.status(403).type('text').send('forbidden');
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
  adminIpGuard,
  corsMiddleware,
  loginLimiter,
  clientIp
};
