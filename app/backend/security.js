const ipRangeCheck = require('ip-range-check');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { logSecurityEvent } = require('./auditLogger');

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

function isAdminIp(req) {
  const cidrs = parseList(process.env.ADMIN_IP_CIDR);
  const ip = clientIp(req);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (cidrs.length === 0) return false;
  return ipRangeCheck(ip, cidrs);
}

function adminIpGuard(req, res, next) {
  if (isAdminIp(req)) return next();
  return res.status(403).json({ success: false, error: 'forbidden network' });
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
  isAdminIp,
  clientIp
};
