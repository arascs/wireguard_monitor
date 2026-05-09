const ipRangeCheck = require('ip-range-check');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { logSecurityEvent } = require('./securityLog');

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

/** Reject requests not coming from the configured admin CIDR ranges. */
function adminIpGuard(req, res, next) {
  const cidrs = parseList(process.env.ADMIN_IP_CIDR);
  const ip = clientIp(req);
  if (ip === '127.0.0.1' || ip === '::1') return next();
  if (cidrs.length === 0) return next();
  if (ipRangeCheck(ip, cidrs)) return next();
  return res.status(403).json({ error: 'forbidden network' });
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key']
  });
}

/** 5 login attempts per IP+username per 15 minutes; logs fail_logins on lockout. */
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
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
  });
}

module.exports = {
  adminIpGuard,
  corsMiddleware,
  loginLimiter,
  clientIp
};
