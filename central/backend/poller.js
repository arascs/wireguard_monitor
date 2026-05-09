const fetch = require('node-fetch');

/**
 * Poller now only checks /health for each node. Metrics are pushed to central
 * by the local nodes via POST /api/metrics/push.
 */
function createPoller({ getNodes, onHealth }) {
  async function checkOne(node) {
    const base = node.baseUrl.replace(/\/+$/, '').replace(/^http:\/\//i, 'https://');
    let online = false;
    try {
      const r = await fetch(`${base}/health`, { timeout: 8000 });
      const t = await r.text();
      online = r.ok && t.trim() === 'ok';
    } catch {
      online = false;
    }
    return { nodeId: node.id, online };
  }

  async function tick() {
    const nodes = getNodes();
    const results = [];
    for (const node of nodes) {
      try {
        results.push(await checkOne(node));
      } catch {
        results.push({ nodeId: node.id, online: false, error: true });
      }
    }
    if (onHealth) onHealth(results);
  }

  return { tick, checkOne };
}

module.exports = { createPoller };
