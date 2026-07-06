const express = require('express');
const fetch = require('node-fetch');
const { run, HOSTNAME } = require('../../../common/utils');
const { EXPORTER_SCRIPT } = require('../../../common/paths');
const {
  getApiKey,
  authHeaders,
  httpsAgent: centralAgent,
  getCentralBase,
  pushDevicesToCentral
} = require('../sync/centralSync');

async function pushMetricsToCentral() {
  const base = getCentralBase();
  if (!base || !getApiKey()) return;
  let body;
  try {
    body = run('bash', [EXPORTER_SCRIPT], { timeout: 60000 });
  } catch (e) {
    console.error('[metrics push] exporter failed:', e.message);
    return;
  }
  try {
    const r = await fetch(`${base}/api/metrics/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...authHeaders() },
      body,
      agent: base.startsWith('https') ? centralAgent : undefined
    });
    if (!r.ok) {
      console.error('[metrics push] central responded', r.status);
    }
  } catch (e) {
    console.error('[metrics push] network error:', e.message);
  }
}

module.exports = function createCentralRoutes({ requireAuth }) {
  const router = express.Router();
  router.get('/hostname', requireAuth, (req, res) => res.json({ success: true, hostname: HOSTNAME }));
  return router;
};

module.exports.pushMetricsToCentral = pushMetricsToCentral;
module.exports.pushDevicesToCentral = pushDevicesToCentral;
