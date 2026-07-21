const { syncAppProxies } = require('./proxyManager');
const { parsePolicy } = require('./policyScript');

async function ensureAppProxySchema(mysql, dbConfig) {
  const conn = await mysql.createConnection(dbConfig);
  try {
    const alters = [
      'ALTER TABLE applications ADD COLUMN policy_json JSON NULL',
      "ALTER TABLE applications ADD COLUMN backend_host VARCHAR(255) NOT NULL DEFAULT '127.0.0.1'",
      'ALTER TABLE applications ADD COLUMN backend_port INT NULL'
    ];
    for (const sql of alters) {
      try {
        await conn.execute(sql);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
      }
    }
  } finally {
    await conn.end();
  }
}

function normalizePolicyInput(raw) {
  if (raw == null) return null;
  const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsePolicy({
    print: p.print,
    clipboard: p.clipboard,
    download: p.download,
    allowed_methods: p.allowed_methods,
    deny_extensions: p.deny_extensions
  });
}

module.exports = {
  ensureAppProxySchema,
  syncAppProxies,
  normalizePolicyInput,
  parsePolicy
};
