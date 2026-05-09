const { execFileSync, spawnSync } = require('child_process');

/**
 * Run a binary with explicit args via execFile (no shell interpretation).
 *
 * Usage:
 *   run('wg', ['show', 'interfaces'])
 *   run('wg-quick', ['up', INTERFACE])
 *   run('wg', ['pubkey'], { input: privateKey })
 */
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

/**
 * Like run() but returns { stdout, status } instead of throwing on non-zero
 * exit. Useful for commands that may fail benignly (e.g. `systemctl stop`
 * a unit that does not exist).
 */
function tryRun(file, args = [], opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

module.exports = { run, tryRun };
