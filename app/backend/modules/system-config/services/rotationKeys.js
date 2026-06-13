const mysql = require('mysql2/promise');
const { dbConfig } = require('../../../common/db');

async function hydrateRotationKeysFromDb(iface, config) {
  for (const p of config.peers) {
    p.rotationKey = '';
  }
  try {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(
      'SELECT site_pubkey, site_rotation_key FROM sites WHERE `interface` = ?',
      [iface]
    );
    await conn.end();
    const map = new Map(rows.map((r) => [r.site_pubkey, r.site_rotation_key != null ? String(r.site_rotation_key) : '']));
    for (const p of config.peers) {
      if (p.publicKey && map.has(p.publicKey)) {
        p.rotationKey = map.get(p.publicKey);
      }
    }
  } catch (e) {
    console.error('hydrateRotationKeysFromDb:', e.message);
  }
}

function getRemainingDays(config) {
  if (!config.interface.keyCreationDate) return null;
  const creationDate = new Date(config.interface.keyCreationDate);
  const expiryDate = new Date(creationDate);
  expiryDate.setDate(expiryDate.getDate() + config.interface.keyExpiryDays);
  const diffTime = expiryDate - new Date();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

module.exports = {
  hydrateRotationKeysFromDb,
  getRemainingDays
};
