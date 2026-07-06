const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

const NODES_TABLE = 'nodes';
const NODES_FILE = path.join(__dirname, 'data', 'nodes.json');

let pool;

function disabledError() {
  const err = new Error('Database disabled (CENTRAL_DB_DISABLED=1)');
  err.code = 'DB_DISABLED';
  return err;
}

function getPool() {
  if (process.env.CENTRAL_DB_DISABLED === '1') return null;
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.CENTRAL_DB_HOST || '127.0.0.1',
      user: process.env.CENTRAL_DB_USER || 'root',
      password: process.env.CENTRAL_DB_PASSWORD || '',
      database: process.env.CENTRAL_DB_NAME || 'vpn_monitoring',
      waitForConnections: true,
      connectionLimit: 10
    });
  }
  return pool;
}

function rowToNode(row) {
  if (!row) return null;
  return {
    machineId: String(row.machine_id || '').toLowerCase(),
    name: row.name || '',
    apiKeyHash: row.api_key_hash || '',
    baseUrl: row.base_url || '',
    publicIp: row.public_ip || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null
  };
}

async function fetchAllNodes() {
  const db = getPool();
  if (!db) throw disabledError();
  const [rows] = await db.execute(
    `SELECT machine_id, name, api_key_hash, base_url, public_ip, created_at, registered_at
     FROM ${NODES_TABLE} ORDER BY created_at DESC`
  );
  return rows.map(rowToNode);
}

async function findNodeByMachineId(machineId) {
  const mid = String(machineId || '').trim().toLowerCase();
  if (!mid) return null;
  const db = getPool();
  if (!db) throw disabledError();
  const [rows] = await db.execute(
    `SELECT machine_id, name, api_key_hash, base_url, public_ip, created_at, registered_at
     FROM ${NODES_TABLE} WHERE machine_id = ? LIMIT 1`,
    [mid]
  );
  return rowToNode(rows[0]);
}

async function insertNode({ name, machineId, apiKeyHash }) {
  const db = getPool();
  if (!db) throw disabledError();
  const mid = String(machineId).trim().toLowerCase();
  await db.execute(
    `INSERT INTO ${NODES_TABLE} (machine_id, name, api_key_hash) VALUES (?, ?, ?)`,
    [mid, String(name).trim(), apiKeyHash]
  );
  return findNodeByMachineId(mid);
}

async function deleteNodeByMachineId(machineId) {
  const db = getPool();
  if (!db) throw disabledError();
  const mid = String(machineId).trim().toLowerCase();
  const [r] = await db.execute(`DELETE FROM ${NODES_TABLE} WHERE machine_id = ?`, [mid]);
  return r.affectedRows > 0;
}

async function hashApiKey(plain) {
  return bcrypt.hash(String(plain), 10);
}

async function verifyApiKey(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(String(plain), String(hash));
}

async function migrateFromJsonIfNeeded() {
  const db = getPool();
  if (!db) return;
  const [countRows] = await db.execute(`SELECT COUNT(*) AS c FROM ${NODES_TABLE}`);
  if (Number(countRows[0].c) > 0) return;
  if (!fs.existsSync(NODES_FILE)) return;

  let legacy = [];
  try {
    const j = JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
    legacy = Array.isArray(j) ? j : [];
  } catch {
    return;
  }
  if (!legacy.length) return;

  for (const n of legacy) {
    const machineId = String(n.machineId || '').trim().toLowerCase();
    if (!machineId) continue;
    const name = String(n.name || machineId).trim();
    const plainKey = String(n.apiKey || '').trim();
    if (!plainKey) continue;
    const apiKeyHash = await hashApiKey(plainKey);
    const baseUrl = String(n.baseUrl || '').trim();
    const publicIp = n.publicIp != null ? String(n.publicIp).trim() : null;
    const registeredAt = baseUrl || n.id ? new Date() : null;
    await db.execute(
      `INSERT INTO ${NODES_TABLE} (machine_id, name, api_key_hash, base_url, public_ip, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [machineId, name, apiKeyHash, baseUrl, publicIp, registeredAt]
    );
  }
  const bak = `${NODES_FILE}.migrated`;
  try {
    fs.renameSync(NODES_FILE, bak);
  } catch {
    /* ignore */
  }
}

module.exports = {
  fetchAllNodes,
  findNodeByMachineId,
  insertNode,
  deleteNodeByMachineId,
  hashApiKey,
  verifyApiKey,
  migrateFromJsonIfNeeded
};
