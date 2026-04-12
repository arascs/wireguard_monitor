const fetch = require('node-fetch');
const { parseMetrics } = require('./parseMetrics');

function createPoller({ getNodes, onSnapshot }) {
  let prev = new Map();
  let alertLog = [];

  function pruneAlertLog(nowSec) {
    const cutoff = nowSec - 86400;
    alertLog = alertLog.filter((e) => e.t >= cutoff);
  }

  function alertsDelta24h(nodeId, nowSec, currentTotal) {
    if (currentTotal === undefined || currentTotal === null) return 0;
    const nodeSamples = alertLog.filter((e) => e.nodeId === nodeId).sort((a, b) => a.t - b.t);
    if (nodeSamples.length === 0) return 0;
    const cutoff = nowSec - 86400;
    const beforeCutoff = nodeSamples.filter((e) => e.t <= cutoff);
    const baseline = beforeCutoff.length
      ? beforeCutoff[beforeCutoff.length - 1].value
      : nodeSamples[0].value;
    return Math.max(0, currentTotal - baseline);
  }

  async function pollNode(node) {
    const base = node.baseUrl.replace(/\/+$/, '');
    let online = false;
    let metricsText = '';
    try {
      const hr = await fetch(`${base}/health`, { timeout: 8000 });
      const ht = await hr.text();
      online = hr.ok && ht.trim() === 'ok';
    } catch {
      online = false;
    }
    try {
      const mr = await fetch(`${base}/metrics`, { timeout: 60000 });
      metricsText = await mr.text();
    } catch {
      metricsText = '';
    }
    const m = metricsText ? parseMetrics(metricsText) : {};
    const nowSec = Math.floor(Date.now() / 1000);
    pruneAlertLog(nowSec);

    if (m.alerts !== undefined) {
      alertLog.push({ t: nowSec, nodeId: node.id, value: m.alerts });
    }

    const p = prev.get(node.id) || {};
    const d = (a, b) => (a !== undefined && b !== undefined ? Math.max(0, a - b) : 0);

    const traffic = {
      clientRx: d(m.trafficRxClient, p.trafficRxClient),
      clientTx: d(m.trafficTxClient, p.trafficTxClient),
      siteRx: d(m.trafficRxSite, p.trafficRxSite),
      siteTx: d(m.trafficTxSite, p.trafficTxSite)
    };

    let cpuPct;
    const modes = ['user', 'nice', 'system', 'idle'];
    let sumD = 0;
    let busyD = 0;
    for (const mode of modes) {
      const cur = m.cpu && m.cpu[mode];
      const pr = p.cpu && p.cpu[mode];
      if (cur !== undefined && pr !== undefined) {
        const delta = cur - pr;
        sumD += delta;
        if (mode !== 'idle') busyD += delta;
      }
    }
    if (sumD > 0) cpuPct = (busyD / sumD) * 100;

    const peers = (m.peersClient || 0) + (m.peersSite || 0);
    const bandwidthDelta =
      traffic.clientRx + traffic.clientTx + traffic.siteRx + traffic.siteTx;

    prev.set(node.id, {
      trafficRxClient: m.trafficRxClient,
      trafficTxClient: m.trafficTxClient,
      trafficRxSite: m.trafficRxSite,
      trafficTxSite: m.trafficTxSite,
      cpu: m.cpu ? { ...m.cpu } : {},
      alerts: m.alerts
    });

    return {
      nodeId: node.id,
      online,
      metrics: m,
      cpuPct,
      peers,
      bandwidthDelta,
      traffic,
      alerts24h: alertsDelta24h(node.id, nowSec, m.alerts)
    };
  }

  async function tick() {
    const nodes = getNodes();
    const results = [];
    for (const node of nodes) {
      try {
        results.push(await pollNode(node));
      } catch {
        results.push({ nodeId: node.id, online: false, error: true });
      }
    }
    if (onSnapshot) onSnapshot(results);
  }

  return { tick, pollNode };
}

module.exports = { createPoller };
