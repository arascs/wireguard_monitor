const { getPool } = require('../../mysqlLogs');
const { isUserExpired } = require('../../utils');

async function seedSuperAdmin(bcrypt) {
  const pool = getPool();
  if (!pool) return;
  const [rows] = await pool.execute('SELECT id FROM admins LIMIT 1');
  if (rows.length) return;
  const hash = await bcrypt.hash('admin', 10);
  const now = Math.floor(Date.now() / 1000);
  await pool.execute(
    `INSERT INTO admins (username, password, role, status, expire_day, create_day, created_by)
     VALUES (?, ?, 'superadmin', 1, NULL, ?, NULL)`,
    ['admin', hash, now]
  );
}

function createValidateAdminSession() {
  return async function validateAdminSession(req) {
    const adminId = req.session && req.session.adminId;
    if (!adminId) return false;

    const pool = getPool();
    if (!pool) return false;

    const [rows] = await pool.execute(
      'SELECT id, username, role, status, expire_day FROM admins WHERE id = ?',
      [adminId]
    );
    if (!rows.length) return false;

    const admin = rows[0];
    if (parseInt(admin.status, 10) === 0) return false;
    if (admin.role !== 'superadmin' && isUserExpired(admin.expire_day)) return false;

    req.session.user = admin.username;
    req.session.role = admin.role;
    return true;
  };
}

async function authenticateAdmin(username, password, bcrypt) {
  const pool = getPool();
  if (!pool) throw new Error('Database unavailable');

  const [rows] = await pool.execute(
    'SELECT id, username, password, role, status, expire_day FROM admins WHERE username = ?',
    [username]
  );
  if (!rows.length) return { status: 401, error: 'Invalid credentials' };

  const admin = rows[0];
  if (parseInt(admin.status, 10) === 0) {
    return { status: 403, error: 'Admin account disabled' };
  }
  if (admin.role !== 'superadmin' && isUserExpired(admin.expire_day)) {
    return { status: 403, error: 'Admin account expired' };
  }
  if (!(await bcrypt.compare(password, admin.password))) {
    return { status: 401, error: 'Invalid credentials' };
  }

  return { admin };
}

async function initAdminAccounts(bcrypt) {
  await seedSuperAdmin(bcrypt);
}

module.exports = {
  initAdminAccounts,
  createValidateAdminSession,
  authenticateAdmin
};
