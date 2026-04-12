const { createClient } = require('@clickhouse/client');

const TABLE =
  process.env.CLICKHOUSE_LOGS_TABLE || 'vpn_monitoring.wireguard_logs';

let client;

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
  const rows = await run(sql, dataParams);
  const countRows = await run(sqlCount, filterParams);
  const total =
    countRows[0] && typeof countRows[0].c !== 'undefined'
      ? Number(countRows[0].c)
      : rows.length;

  return { rows, total, limit, offset };
}

module.exports = { fetchLogs, getClient, TABLE };
