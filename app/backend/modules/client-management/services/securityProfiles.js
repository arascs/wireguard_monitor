const { validateProfileChecks, normalizeProfileChecks } = require('./securityChecks');

const BASIC_NAMES = { linux: 'Basic Linux', windows: 'Basic Windows' };

function parseProfileRow(row) {
  if (!row) return null;
  let checks = row.checks;
  if (typeof checks === 'string') {
    try { checks = JSON.parse(checks); } catch (_) { checks = {}; }
  }
  return {
    id: row.id,
    name: row.name,
    os_type: row.os_type,
    checks: normalizeProfileChecks(checks)
  };
}

async function listProfiles(connection) {
  const [rows] = await connection.execute(
    'SELECT id, name, os_type, checks FROM security_profiles ORDER BY id ASC'
  );
  return rows.map(parseProfileRow);
}

async function getProfileById(connection, id) {
  const [rows] = await connection.execute(
    'SELECT id, name, os_type, checks FROM security_profiles WHERE id = ? LIMIT 1',
    [id]
  );
  return parseProfileRow(rows[0]);
}

async function getDefaultProfile(connection, osType) {
  const os = String(osType || '').trim().toLowerCase();
  const name = BASIC_NAMES[os];
  if (!name) return { os_type: os, checks: {} };
  const [rows] = await connection.execute(
    'SELECT id, name, os_type, checks FROM security_profiles WHERE os_type = ? AND name = ? LIMIT 1',
    [os, name]
  );
  return parseProfileRow(rows[0]) || { os_type: os, checks: {} };
}

async function resolveDeviceProfile(connection, deviceRow, securityInfoOs) {
  if (deviceRow && deviceRow.security_profile_id) {
    const profile = await getProfileById(connection, deviceRow.security_profile_id);
    if (profile) return profile;
  }
  const os = String(deviceRow && deviceRow.os || securityInfoOs || '').trim().toLowerCase();
  return getDefaultProfile(connection, os);
}

function validateProfilePayload({ name, os_type, checks }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return 'Name is required';
  const os = String(os_type || '').trim().toLowerCase();
  if (os !== 'linux' && os !== 'windows') return 'os_type must be linux or windows';
  const checkErr = validateProfileChecks(os, checks || {});
  if (checkErr) return checkErr;
  return null;
}

module.exports = {
  parseProfileRow,
  listProfiles,
  getProfileById,
  getDefaultProfile,
  resolveDeviceProfile,
  validateProfilePayload
};
