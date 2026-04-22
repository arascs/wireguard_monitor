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

/** Metric line without `{labels}` (legacy exporters). */
function getUnlabeledMetric(lines, metricName) {
  for (const line of lines) {
    const p = parseLine(line);
    if (!p || p.name !== metricName) continue;
    if (p.labels) continue;
    return p.value;
  }
  return undefined;
}

function parseLabelsMap(labels) {
  const out = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(labels || '')) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function getSiteEndpoints(lines) {
  const all = new Set();
  const online = new Set();
  for (const line of lines) {
    const p = parseLine(line);
    if (!p || p.name !== 'wireguard_site_endpoint_info' || p.value < 1) continue;
    const labels = parseLabelsMap(p.labels);
    const endpoint = labels.endpoint || '';
    if (!endpoint || endpoint === '(none)') continue;
    all.add(endpoint);
    if (labels.online === '1') {
      online.add(endpoint);
    }
  }
  return { all: Array.from(all), online: Array.from(online) };
}

function parseMetrics(text) {
  const lines = text.split('\n');
  const cpu = {};
  for (const mode of ['user', 'nice', 'system', 'idle']) {
    const v = getLabeled(lines, 'node_cpu_seconds_total', { mode });
    if (v !== undefined) cpu[mode] = v;
  }
  const services = {};
  for (const svc of ['endpoint_monitor', 'wg_handshake_monitor', 'services_monitor', 'mysql']) {
    const v = getLabeled(lines, 'wireguard_monitor_service_active', { service: svc });
    if (v !== undefined) services[svc] = v >= 1 ? 1 : 0;
  }
  const peersOnlineClient = getLabeled(lines, 'wireguard_peers_online_total', { type: 'client' });
  const peersOnlineSite = getLabeled(lines, 'wireguard_peers_online_total', { type: 'site' });
  const peersOnlineLegacy = getUnlabeledMetric(lines, 'wireguard_peers_online_total');
  let peersOnlineTotal;
  if (peersOnlineClient != null && peersOnlineSite != null) {
    peersOnlineTotal = peersOnlineClient + peersOnlineSite;
  } else if (peersOnlineLegacy != null) {
    peersOnlineTotal = peersOnlineLegacy;
  }
  const siteEndpoints = getSiteEndpoints(lines);

  return {
    memTotal: getLabeled(lines, 'node_memory_MemTotal_bytes', {}) || sumByName(lines, 'node_memory_MemTotal_bytes'),
    memAvail: getLabeled(lines, 'node_memory_MemAvailable_bytes', {}) || sumByName(lines, 'node_memory_MemAvailable_bytes'),
    fsSizeRoot: getLabeled(lines, 'node_filesystem_size_bytes', { mountpoint: '/' }),
    fsAvailRoot: getLabeled(lines, 'node_filesystem_avail_bytes', { mountpoint: '/' }),
    alerts: getLabeled(lines, 'wireguard_alerts_total', {}),
    peersClient: getLabeled(lines, 'wireguard_peers_total', { type: 'client' }),
    peersSite: getLabeled(lines, 'wireguard_peers_total', { type: 'site' }),
    peersOnlineClient,
    peersOnlineSite,
    peersOnlineTotal,
    services,
    trafficRxClient: getLabeled(lines, 'wireguard_traffic_receive_bytes_total', { type: 'client' }),
    trafficTxClient: getLabeled(lines, 'wireguard_traffic_transmit_bytes_total', { type: 'client' }),
    trafficRxSite: getLabeled(lines, 'wireguard_traffic_receive_bytes_total', { type: 'site' }),
    trafficTxSite: getLabeled(lines, 'wireguard_traffic_transmit_bytes_total', { type: 'site' }),
    sites: siteEndpoints.all,
    onlineSites: siteEndpoints.online,
    cpu
  };
}

module.exports = { parseMetrics, parseLine };
