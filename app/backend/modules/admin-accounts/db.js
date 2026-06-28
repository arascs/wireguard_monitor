const { isUserExpired } = require('../../common/utils');

async function seedSuperAdmin(mysql, dbConfig, bcrypt) {
  const conn = await mysql.createConnection(dbConfig);
  try {
    const [rows] = await conn.execute('SELECT id FROM admins LIMIT 1');
    if (rows.length) return;
    const hash = await bcrypt.hash('admin', 10);
    const now = Math.floor(Date.now() / 1000);
    await conn.execute(
      `INSERT INTO admins (username, password, role, status, expire_day, create_day, created_by)
       VALUES (?, ?, 'superadmin', 1, NULL, ?, NULL)`,
      ['admin', hash, now]
    );
  } finally {
    await conn.end();
  }
}

function createValidateAdminSession({ mysql, dbConfig }) {
  return async function validateAdminSession(req) {
    const adminId = req.session && req.session.adminId;
    if (!adminId) return false;

    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
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
    } finally {
      if (conn) await conn.end();
    }
  };
}

async function initAdminAccounts({ mysql, dbConfig, bcrypt }) {
  await seedSuperAdmin(mysql, dbConfig, bcrypt);
}

module.exports = {
  initAdminAccounts,
  createValidateAdminSession
};
