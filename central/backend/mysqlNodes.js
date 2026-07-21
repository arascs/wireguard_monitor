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

async function updateNodeMetadata(machineId, { baseUrl, publicIp }) {
  const db = getPool();
  if (!db) throw disabledError();
  const mid = String(machineId).trim().toLowerCase();
  const sets = [];
  const vals = [];
  if (baseUrl != null && String(baseUrl).trim()) {
    sets.push('base_url = ?');
    vals.push(String(baseUrl).trim());
  }
  if (publicIp != null && String(publicIp).trim()) {
    sets.push('public_ip = ?');
    vals.push(String(publicIp).trim());
  }
  if (!sets.length) return findNodeByMachineId(mid);
  vals.push(mid);
  await db.execute(`UPDATE ${NODES_TABLE} SET ${sets.join(', ')} WHERE machine_id = ?`, vals);
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

module.exports = {
  fetchAllNodes,
  findNodeByMachineId,
  insertNode,
  updateNodeMetadata,
  deleteNodeByMachineId,
  hashApiKey,
  verifyApiKey
};
