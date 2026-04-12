function parseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const open = t.indexOf('{');
  let name;
  let labels = '';
  let valueStr;
  if (open === -1) {
    const sp = t.split(/\s+/);
    name = sp[0];
    valueStr = sp[1];
  } else {
    const close = t.indexOf('}', open);
    if (close === -1) return null;
    name = t.slice(0, open);
    labels = t.slice(open, close + 1);
    valueStr = t.slice(close + 1).trim().split(/\s+/)[0];
  }
  const value = parseFloat(valueStr);
  if (Number.isNaN(value)) return null;
  return { name, labels, value };
}

function labelMatch(labels, key, val) {
  const re = new RegExp(`${key}="([^"]*)"`);
  const m = labels.match(re);
  return m && m[1] === val;
}

function sumByName(lines, metricName) {
  let s = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (p && p.name === metricName) s += p.value;
  }
  return s;
}

function getLabeled(lines, metricName, filters) {
  for (const line of lines) {
    const p = parseLine(line);
    if (!p || p.name !== metricName) continue;
    let ok = true;
    for (const [k, v] of Object.entries(filters)) {
      if (!labelMatch(p.labels, k, v)) ok = false;
    }
    if (ok) return p.value;
  }
  return undefined;
}

function parseMetrics(text) {
  const lines = text.split('\n');
  const cpu = {};
  for (const mode of ['user', 'nice', 'system', 'idle']) {
    const v = getLabeled(lines, 'node_cpu_seconds_total', { mode });
    if (v !== undefined) cpu[mode] = v;
  }
  return {
    memTotal: getLabeled(lines, 'node_memory_MemTotal_bytes', {}) || sumByName(lines, 'node_memory_MemTotal_bytes'),
    memAvail: getLabeled(lines, 'node_memory_MemAvailable_bytes', {}) || sumByName(lines, 'node_memory_MemAvailable_bytes'),
    fsSizeRoot: getLabeled(lines, 'node_filesystem_size_bytes', { mountpoint: '/' }),
    fsAvailRoot: getLabeled(lines, 'node_filesystem_avail_bytes', { mountpoint: '/' }),
    alerts: getLabeled(lines, 'wireguard_alerts_total', {}),
    peersClient: getLabeled(lines, 'wireguard_peers_total', { type: 'client' }),
    peersSite: getLabeled(lines, 'wireguard_peers_total', { type: 'site' }),
    trafficRxClient: getLabeled(lines, 'wireguard_traffic_receive_bytes_total', { type: 'client' }),
    trafficTxClient: getLabeled(lines, 'wireguard_traffic_transmit_bytes_total', { type: 'client' }),
    trafficRxSite: getLabeled(lines, 'wireguard_traffic_receive_bytes_total', { type: 'site' }),
    trafficTxSite: getLabeled(lines, 'wireguard_traffic_transmit_bytes_total', { type: 'site' }),
    cpu
  };
}

module.exports = { parseMetrics, parseLine };
