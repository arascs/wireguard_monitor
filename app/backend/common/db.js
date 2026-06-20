const dbConfig = {
  host: process.env.WG_DB_HOST,
  user: process.env.WG_DB_USER,
  password: process.env.WG_DB_PASSWORD,
  database: process.env.WG_DB_NAME
};

module.exports = { dbConfig };
