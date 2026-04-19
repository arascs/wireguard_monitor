const { createClient } = require('@clickhouse/client');

const TABLE = process.env.CLICKHOUSE_LOGS_TABLE || 'vpn_monitoring.wireguard_logs';
const OPERATION_LOGS_TABLE =
  process.env.CLICKHOUSE_OPERATION_LOGS_TABLE || 'vpn_monitoring.operation_logs';
const DEVICES_TABLE = process.env.CLICKHOUSE_DEVICES_TABLE || 'vpn_monitoring.devices';

let client;

/** JSONEachRow + DateTime64(3): dùng chuỗi 'YYYY-MM-DD HH:mm:ss.sss' (UTC), không dùng new Date() trực tiếp. */
function toClickHouseDateTime64UTC(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n, l = 2) => String(Math.trunc(n)).padStart(l, '0');
  const ms = dt.getUTCMilliseconds();
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}.${p(ms, 3)}`;
}

function getClient() {
  if (process.env.CLICKHOUSE_DISABLED === '1') return null;
  if (!client) {
    client = createClient({
      url: process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || ''
    });
  }
  return client;
}

async function insertOperationLog({ alertType, nodeId, nodeName, detail }) {
  const ch = getClient();
  if (!ch) return;
  try {
    await ch.insert({
      table: OPERATION_LOGS_TABLE,
      values: [
        {
          ts: toClickHouseDateTime64UTC(),
          alert_type: String(alertType),
          node_id: String(nodeId || ''),
          node_name: String(nodeName || ''),
          detail: String(detail || '')
        }
      ],
      format: 'JSONEachRow'
    });
  } catch (e) {
    console.error('[clickhouse insertOperationLog]', e.message);
  }
}

async function fetchOperationLogs(q) {
  const ch = getClient();
  if (!ch) {
    const err = new Error('ClickHouse disabled (CLICKHOUSE_DISABLED=1)');
    err.code = 'CH_DISABLED';
    throw err;
  }

  const limit = Math.min(500, Math.max(1, parseInt(q.limit || '100', 10) || 100));
  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const filterParams = {};
  const cond = ['1=1'];

  if (q.alert_type && String(q.alert_type).trim()) {
    cond.push('alert_type = {alert_type:String}');
    filterParams.alert_type = String(q.alert_type).trim();
  }
  if (q.node_id && String(q.node_id).trim()) {
    cond.push('node_id = {node_id:String}');
    filterParams.node_id = String(q.node_id).trim();
  }
  if (q.from && String(q.from).trim()) {
    cond.push('ts >= parseDateTimeBestEffort({dfrom:String})');
    filterParams.dfrom = String(q.from).trim();
  }
  if (q.to && String(q.to).trim()) {
    cond.push('ts <= parseDateTimeBestEffort({dto:String})');
    filterParams.dto = String(q.to).trim();
  }
  if (q.q && String(q.q).trim()) {
    cond.push(
      '(positionCaseInsensitive(detail, {needle:String}) > 0 OR positionCaseInsensitive(node_name, {needle:String}) > 0)'
    );
    filterParams.needle = String(q.q).trim();
  }

  const where = cond.join(' AND ');
  const sql = `
    SELECT formatDateTime(ts, '%Y-%m-%d %H:%i:%S') AS ts, alert_type, node_id, node_name, detail
    FROM ${OPERATION_LOGS_TABLE}
    WHERE ${where}
    ORDER BY ts DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;
  const sqlCount = `
    SELECT count() AS c
    FROM ${OPERATION_LOGS_TABLE}
    WHERE ${where}
  `;

  const run = async (query, params) => {
    const rs = await ch.query({
      query,
      query_params: params,
      format: 'JSONEachRow'
    });
    const text = await rs.text();
    if (!text.trim()) return [];
    return text
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  const dataParams = { ...filterParams, limit: Math.floor(limit), offset: Math.floor(offset) };
  const rows = await run(sql, dataParams);
  const countRows = await run(sqlCount, filterParams);
  const total =
    countRows[0] && typeof countRows[0].c !== 'undefined'
      ? Number(countRows[0].c)
      : rows.length;

  return { rows, total, limit, offset };
}

async function upsertDeviceRow(row) {
  const ch = getClient();
  if (!ch) throw new Error('ClickHouse unavailable');
  const {
    machine_id,
    device_name,
    public_key,
    interface: iface,
    node_id,
    node_name,
    base_url
  } = row;
  await ch.query({
    query: `ALTER TABLE ${DEVICES_TABLE} DELETE WHERE machine_id = {m:String} AND node_id = {n:String}`,
    query_params: { m: String(machine_id), n: String(node_id) }
  });
  await ch.insert({
    table: DEVICES_TABLE,
    values: [
      {
        machine_id: String(machine_id),
        device_name: String(device_name || ''),
        username: '',
        public_key: String(public_key || ''),
        interface: String(iface || ''),
        node_id: String(node_id || ''),
        node_name: String(node_name || ''),
        base_url: String(base_url || ''),
        updated_at: toClickHouseDateTime64UTC()
      }
    ],
    format: 'JSONEachRow'
  });
}

async function deleteDeviceRow(machineId, nodeId) {
  const ch = getClient();
  if (!ch) throw new Error('ClickHouse unavailable');
  await ch.query({
    query: `ALTER TABLE ${DEVICES_TABLE} DELETE WHERE machine_id = {m:String} AND node_id = {n:String}`,
    query_params: { m: String(machineId), n: String(nodeId) }
  });
}

async function deleteAllDeviceRowsForMachine(machineId) {
  const ch = getClient();
  if (!ch) throw new Error('ClickHouse unavailable');
  await ch.query({
    query: `ALTER TABLE ${DEVICES_TABLE} DELETE WHERE machine_id = {m:String}`,
    query_params: { m: String(machineId) }
  });
}

async function fetchDistinctBaseUrlsForMachine(machineId) {
  const ch = getClient();
  if (!ch) return [];
  const rs = await ch.query({
    query: `SELECT DISTINCT base_url FROM ${DEVICES_TABLE} WHERE machine_id = {m:String} AND base_url != ''`,
    query_params: { m: String(machineId) },
    format: 'JSONEachRow'
  });
  const text = await rs.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l).base_url;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchDevicesAggregated() {
  const ch = getClient();
  if (!ch) {
    const err = new Error('ClickHouse disabled (CLICKHOUSE_DISABLED=1)');
    err.code = 'CH_DISABLED';
    throw err;
  }
  const rs = await ch.query({
    query: `
      SELECT
        machine_id,
        anyLast(device_name) AS device_name,
        groupArray(node_name) AS node_names,
        groupArray(base_url) AS base_urls
      FROM ${DEVICES_TABLE}
      GROUP BY machine_id
      ORDER BY max(updated_at) DESC
    `,
    format: 'JSONEachRow'
  });
  const text = await rs.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchLogs(q) {
  const ch = getClient();
  if (!ch) {
    const err = new Error('ClickHouse disabled (CLICKHOUSE_DISABLED=1)');
    err.code = 'CH_DISABLED';
    throw err;
  }

  const limit = Math.min(500, Math.max(1, parseInt(q.limit || '100', 10) || 100));
  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);

  const filterParams = {};

  const cond = ['1=1'];

  if (q.origin_host && String(q.origin_host).trim()) {
    cond.push('origin_host = {origin_host:String}');
    filterParams.origin_host = String(q.origin_host).trim();
  }
  if (q.event_type && String(q.event_type).trim()) {
    cond.push('event_type = {event_type:String}');
    filterParams.event_type = String(q.event_type).trim();
  }
  if (q.from && String(q.from).trim()) {
    cond.push('timestamp >= parseDateTimeBestEffort({dfrom:String})');
    filterParams.dfrom = String(q.from).trim();
  }
  if (q.to && String(q.to).trim()) {
    cond.push('timestamp <= parseDateTimeBestEffort({dto:String})');
    filterParams.dto = String(q.to).trim();
  }
  if (q.q && String(q.q).trim()) {
    cond.push(
      '(positionCaseInsensitive(coalesce(message, \'\'), {needle:String}) > 0 OR positionCaseInsensitive(toString(data), {needle:String}) > 0)'
    );
    filterParams.needle = String(q.q).trim();
  }

  const where = cond.join(' AND ');
  const sql = `
    SELECT timestamp, origin_host, event_type, message, data
    FROM ${TABLE}
    WHERE ${where}
    ORDER BY timestamp DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;

  const sqlCount = `
    SELECT count() AS c
    FROM ${TABLE}
    WHERE ${where}
  `;

  const run = async (query, params) => {
    const rs = await ch.query({
      query,
      query_params: params,
      format: 'JSONEachRow'
    });
    const text = await rs.text();
    if (!text.trim()) return [];
    return text
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  const dataParams = { ...filterParams, limit: Math.floor(limit), offset: Math.floor(offset) };
  let rows = await run(sql, dataParams);
  rows = rows.map((row) => {
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
  const countRows = await run(sqlCount, filterParams);
  const total =
    countRows[0] && typeof countRows[0].c !== 'undefined'
      ? Number(countRows[0].c)
      : rows.length;

  return { rows, total, limit, offset };
}

module.exports = {
  fetchLogs,
  getClient,
  TABLE,
  insertOperationLog,
  fetchOperationLogs,
  upsertDeviceRow,
  deleteDeviceRow,
  deleteAllDeviceRowsForMachine,
  fetchDistinctBaseUrlsForMachine,
  fetchDevicesAggregated,
  OPERATION_LOGS_TABLE,
  DEVICES_TABLE
};
