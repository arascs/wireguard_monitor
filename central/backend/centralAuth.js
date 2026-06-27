const SESSION_SECRET = process.env.CENTRAL_SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('CENTRAL_SESSION_SECRET is required (set it in .env)');
}

const COOKIE_NAME = process.env.CENTRAL_COOKIE_NAME || 'central_session';
const COOKIE_MAX_AGE_MS = 60 * 60 * 1000;

module.exports = {
  SESSION_SECRET,
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME
};
