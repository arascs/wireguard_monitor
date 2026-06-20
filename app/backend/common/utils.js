const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const HOSTNAME = os.hostname();
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

function run(file, args = [], opts = {}) {
  if (typeof file !== 'string' || !file) {
    throw new Error('run(): file must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new Error('run(): args must be an array');
  }
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...opts
    });
  } catch (e) {
    throw new Error((e.stderr && e.stderr.toString()) || e.message);
  }
}

function tryRun(file, args = [], opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function isUserExpired(expireDay) {
  if (expireDay == null || expireDay === '') return false;
  const exp = parseInt(expireDay, 10);
  if (Number.isNaN(exp)) return false;
  return exp < Math.floor(Date.now() / 1000);
}

module.exports = {
  HOSTNAME,
  getNodeProductUuid,
  run,
  tryRun,
  isUserExpired
};
