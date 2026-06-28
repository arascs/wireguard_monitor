const mysql = require('mysql2/promise');

const LOGS_TABLE = 'wireguard_logs';
const OPERATION_LOGS_TABLE = 'operation_logs';
const DEVICES_TABLE = 'devices';

let pool;

function toMysqlDateTime(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n, l = 2) => String(Math.trunc(n)).padStart(l, '0');
  const ms = dt.getUTCMilliseconds();
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}.${p(ms, 3)}`;
}

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

function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function insertOperationLog({ alertType, nodeId, nodeName, detail }) {
  const db = getPool();
  if (!db) return;
  try {
    await db.execute(
      `INSERT INTO ${OPERATION_LOGS_TABLE} (ts, alert_type, node_id, node_name, detail) VALUES (?, ?, ?, ?, ?)`,
      [toMysqlDateTime(), String(alertType), String(nodeId || ''), String(nodeName || ''), String(detail || '')]
    );
  } catch (e) {
    console.error('[mysql insertOperationLog]', e.message);
  }
}

function buildLogFilters(q, columns) {
  const params = [];
  const cond = ['1=1'];

  if (q.alert_type && String(q.alert_type).trim() && columns.alertType) {
    cond.push(`${columns.alertType} = ?`);
    params.push(String(q.alert_type).trim());
  }
  if (q.node_id && String(q.node_id).trim() && columns.nodeId) {
    cond.push(`${columns.nodeId} = ?`);
    params.push(String(q.node_id).trim());
  }
  if (q.origin_host && String(q.origin_host).trim() && columns.originHost) {
    cond.push(`${columns.originHost} = ?`);
    params.push(String(q.origin_host).trim());
  }
  if (q.event_type && String(q.event_type).trim() && columns.eventType) {
    cond.push(`${columns.eventType} = ?`);
    params.push(String(q.event_type).trim());
  }
  if (q.from && String(q.from).trim()) {
    cond.push(`${columns.time} >= ?`);
    params.push(String(q.from).trim());
  }
  if (q.to && String(q.to).trim()) {
    cond.push(`${columns.time} <= ?`);
    params.push(String(q.to).trim());
  }
  if (q.q && String(q.q).trim()) {
    const needle = `%${String(q.q).trim().toLowerCase()}%`;
    if (columns.searchDetail) {
      cond.push(`(LOWER(${columns.searchDetail}) LIKE ? OR LOWER(${columns.searchNode}) LIKE ?)`);
      params.push(needle, needle);
    } else {
      cond.push(`(LOWER(${columns.searchMessage}) LIKE ? OR LOWER(${columns.searchData}) LIKE ?)`);
      params.push(needle, needle);
    }
  }

  return { where: cond.join(' AND '), params };
}

async function fetchOperationLogs(q) {
  const db = getPool();
  if (!db) throw disabledError();

  const limit = Math.min(500, Math.max(1, parseInt(q.limit || '100', 10) || 100));
  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const { where, params } = buildLogFilters(q, {
    alertType: 'alert_type',
    nodeId: 'node_id',
    time: 'ts',
    searchDetail: 'detail',
    searchNode: 'node_name'
  });

  const [rows] = await db.execute(
    `SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS ts, alert_type, node_id, node_name, detail
     FROM ${OPERATION_LOGS_TABLE}
     WHERE ${where}
     ORDER BY ts DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const [[{ c: total }]] = await db.execute(
    `SELECT COUNT(*) AS c FROM ${OPERATION_LOGS_TABLE} WHERE ${where}`,
    params
  );

  return { rows, total: Number(total), limit, offset };
}

async function upsertDeviceRow(row) {
  const db = getPool();
  if (!db) throw new Error('Database unavailable');
  const {
    machine_id,
    device_name,
    public_key,
    interface: iface,
    node_id,
    node_name,
    base_url
  } = row;
  await db.execute(
    `INSERT INTO ${DEVICES_TABLE}
      (machine_id, device_name, username, public_key, \`interface\`, node_id, node_name, base_url, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      device_name = VALUES(device_name),
      public_key = VALUES(public_key),
      \`interface\` = VALUES(\`interface\`),
      node_name = VALUES(node_name),
      base_url = VALUES(base_url),
      updated_at = VALUES(updated_at)`,
    [
      String(machine_id),
      String(device_name || ''),
      String(public_key || ''),
      String(iface || ''),
      String(node_id || ''),
      String(node_name || ''),
      String(base_url || ''),
      toMysqlDateTime()
    ]
  );
}

async function deleteDeviceRowsForNodeExcept(nodeId, keepMachineIds) {
  const db = getPool();
  if (!db) throw new Error('Database unavailable');
  const nid = String(nodeId);
  if (!keepMachineIds.length) {
    await db.execute(`DELETE FROM ${DEVICES_TABLE} WHERE node_id = ?`, [nid]);
    return;
  }
  const placeholders = keepMachineIds.map(() => '?').join(', ');
  await db.execute(
    `DELETE FROM ${DEVICES_TABLE} WHERE node_id = ? AND machine_id NOT IN (${placeholders})`,
    [nid, ...keepMachineIds.map(String)]
  );
}

async function syncDevicesForNode(nodeMeta, devices) {
  const machineIds = [];
  for (const d of devices) {
    const machine_id = String(d.machine_id || '').trim();
    if (!machine_id) continue;
    machineIds.push(machine_id);
    await upsertDeviceRow({
      machine_id,
      device_name: String(d.device_name || '').trim(),
      public_key: String(d.public_key || '').trim(),
      interface: String(d.interface || '').trim(),
      node_id: String(nodeMeta.node_id),
      node_name: String(nodeMeta.node_name || ''),
      base_url: String(nodeMeta.base_url || '')
    });
  }
  await deleteDeviceRowsForNodeExcept(nodeMeta.node_id, machineIds);
  return machineIds.length;
}

function splitField(val) {
  if (!val) return [];
  return String(val).split('\x1e').filter(Boolean);
}

async function fetchDevicesAggregated() {
  const db = getPool();
  if (!db) throw disabledError();

  const [rows] = await db.execute(`
    SELECT
      d.machine_id,
      (SELECT d2.device_name
       FROM ${DEVICES_TABLE} d2
       WHERE d2.machine_id = d.machine_id
       ORDER BY d2.updated_at DESC
       LIMIT 1) AS device_name,
      GROUP_CONCAT(DISTINCT d.node_name ORDER BY d.node_name SEPARATOR '\x1e') AS node_names,
      GROUP_CONCAT(DISTINCT d.base_url ORDER BY d.base_url SEPARATOR '\x1e') AS base_urls
    FROM ${DEVICES_TABLE} d
    GROUP BY d.machine_id
    ORDER BY MAX(d.updated_at) DESC
  `);

  return rows.map((row) => ({
    machine_id: row.machine_id,
    device_name: row.device_name,
    node_names: splitField(row.node_names),
    base_urls: splitField(row.base_urls)
  }));
}

async function insertWireguardLogs(rows) {
  const db = getPool();
  if (!db) throw new Error('Database unavailable');
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      timestamp: String(row.timestamp || ''),
      origin_host: String(row.origin_host || 'unknown'),
      event_type: String(row.event_type || 'general'),
      message: String(row.message || ''),
      data: typeof row.data === 'string' ? row.data : JSON.stringify(row.data || {})
    }))
    .filter((row) => row.timestamp);
  if (normalized.length === 0) return 0;

  const values = normalized.map((row) => [
    row.timestamp,
    row.origin_host,
    row.event_type,
    row.message,
    row.data
  ]);
  await db.query(
    `INSERT INTO ${LOGS_TABLE} (timestamp, origin_host, event_type, message, data) VALUES ?`,
    [values]
  );
  return normalized.length;
}

async function countAlertsLast24h() {
  const db = getPool();
  if (!db) return 0;
  const since = toMysqlDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
  try {
    const [[row]] = await db.execute(
      `SELECT
        (SELECT COUNT(*) FROM ${LOGS_TABLE} WHERE timestamp >= ?) AS logs,
        (SELECT COUNT(*) FROM ${OPERATION_LOGS_TABLE} WHERE ts >= ?) AS ops`,
      [since, since]
    );
    return Number(row.logs || 0) + Number(row.ops || 0);
  } catch {
    return 0;
  }
}

async function fetchLogs(q) {
  const db = getPool();
  if (!db) throw disabledError();

  const limit = Math.min(500, Math.max(1, parseInt(q.limit || '100', 10) || 100));
  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const { where, params } = buildLogFilters(q, {
    originHost: 'origin_host',
    eventType: 'event_type',
    time: 'timestamp',
    searchMessage: 'message',
    searchData: 'data'
  });

  const [rawRows] = await db.execute(
    `SELECT timestamp, origin_host, event_type, message, data
     FROM ${LOGS_TABLE}
     WHERE ${where}
     ORDER BY timestamp DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const [[{ c: total }]] = await db.execute(
    `SELECT COUNT(*) AS c FROM ${LOGS_TABLE} WHERE ${where}`,
    params
  );

  const rows = rawRows.map((row) => {
    const et = row.event_type != null ? String(row.event_type).trim() : '';
    if (et) return row;
    try {
      const raw = row.data;
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const name = d && d.event_name != null ? String(d.event_name).trim() : '';
      if (name) return { ...row, event_type: name };
    } catch {
      /* ignore */
    }
    return row;
  });

  return { rows, total: Number(total), limit, offset };
}

module.exports = {
  fetchLogs,
  getPool,
  LOGS_TABLE,
  insertOperationLog,
  fetchOperationLogs,
  upsertDeviceRow,
  syncDevicesForNode,
  fetchDevicesAggregated,
  insertWireguardLogs,
  countAlertsLast24h,
  OPERATION_LOGS_TABLE,
  DEVICES_TABLE
};
