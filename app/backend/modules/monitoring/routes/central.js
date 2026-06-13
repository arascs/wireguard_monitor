const express = require('express');
const fetch = require('node-fetch');
const { isAdminIp } = require('../../../common/security');
const { run } = require('../../../common/runCmd');
const { EXPORTER_SCRIPT } = require('../../../common/paths');
const { HOSTNAME } = require('../../../common/config');
const {
  getApiKey,
  authHeaders,
  httpsAgent: centralAgent,
  getCentralBase,
  pushDevicesToCentral
} = require('../sync/centralSync');

function registerWithCentral(port) {
  const base = getCentralBase();
  const apiKey = getApiKey();
  if (!base || !apiKey) {
    return Promise.reject(new Error('CENTRAL_URL or NODE_API_KEY not set'));
  }
  const pollBase =
    process.env.CENTRAL_POLL_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `https://127.0.0.1:${port}`;
  const body = {
    name: process.env.CENTRAL_NODE_NAME || HOSTNAME,
    machineId: HOSTNAME,
    baseUrl: pollBase.replace(/\/+$/, ''),
    publicIp: process.env.CENTRAL_PUBLIC_IP || ''
  };
  return fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    agent: base.startsWith('https') ? centralAgent : undefined
  }).then(async (r) => {
    let payload = null;
    try { payload = await r.json(); } catch { /* ignore */ }
    if (!r.ok) {
      const msg = (payload && (payload.error || payload.message)) || `central returned ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return payload;
  });
}

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

module.exports = function createCentralRoutes({ port }) {
  const router = express.Router();

  router.post('/central-register', (req, res) => {
    registerWithCentral(port)
      .then((payload) => res.json({ success: true, central: payload }))
      .catch((e) => {
        const code = e.status >= 400 && e.status < 500 ? e.status : 502;
        res.status(code).json({ success: false, error: e.message });
      });
  });

  router.get('/hostname', (req, res) => res.json({ success: true, hostname: HOSTNAME }));

  return router;
};

module.exports.registerWithCentral = registerWithCentral;
module.exports.pushMetricsToCentral = pushMetricsToCentral;
module.exports.pushDevicesToCentral = pushDevicesToCentral;
