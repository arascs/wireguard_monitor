const fs = require('fs');

const PRODUCT_UUID_PATH = '/sys/class/dmi/id/product_uuid';

function getNodeProductUuid() {
  const fromEnv = String(process.env.NODE_PRODUCT_UUID || '').trim();
  if (fromEnv) return fromEnv.toLowerCase();
  try {
    if (fs.existsSync(PRODUCT_UUID_PATH)) {
      const id = fs.readFileSync(PRODUCT_UUID_PATH, 'utf8').trim();
      if (id) return id.toLowerCase();
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

module.exports = { getNodeProductUuid };
