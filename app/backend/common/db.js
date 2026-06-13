const dbConfig = {
  host: process.env.WG_DB_HOST || 'localhost',
  user: process.env.WG_DB_USER || 'root',
  password: process.env.WG_DB_PASSWORD || 'root',
  database: process.env.WG_DB_NAME || 'wg_monitor'
};

module.exports = { dbConfig };
