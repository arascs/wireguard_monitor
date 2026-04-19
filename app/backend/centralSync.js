const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const { HOSTNAME } = require('./config');

const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.CENTRAL_NODE_TLS_INSECURE !== '1'
});

function normalizeBaseUrl(u) {
  const trimmed = String(u || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
  return `https://${trimmed}`;
}

function normalizeCentralUrl(u) {
  if (!u) return '';
  const t = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function nodeIdFor(baseUrl) {
  const u = normalizeBaseUrl(baseUrl);
  if (!u) return '';
  return crypto.createHash('sha256').update(u).digest('hex').slice(0, 16);
}

function getNodeContext() {
  const port = process.env.PORT || 3000;
  const baseUrl = normalizeBaseUrl(
    process.env.CENTRAL_POLL_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      `https://127.0.0.1:${port}`
  );
  return {
    baseUrl,
    nodeId: nodeIdFor(baseUrl),
    nodeName: process.env.CENTRAL_NODE_NAME || HOSTNAME
  };
}

async function notifyDeviceApproved(row) {
  const central = process.env.CENTRAL_URL;
  const secret = process.env.CENTRAL_REGISTER_SECRET;
  if (!central || !secret) return;
  const base = normalizeCentralUrl(central);
  const ctx = getNodeContext();
  const url = `${base}/api/devices/sync`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Register-Key': secret },
      body: JSON.stringify({
        machine_id: row.machine_id,
        device_name: row.device_name,
        public_key: row.public_key,
        interface: row.interface,
        node_id: ctx.nodeId,
        node_name: ctx.nodeName,
        base_url: ctx.baseUrl
      }),
      agent: url.startsWith('https') ? httpsAgent : undefined
    });
  } catch (e) {
    console.error('[centralSync] notifyDeviceApproved', e.message);
  }
}

async function notifyDeviceRemoved(machineId) {
  const central = process.env.CENTRAL_URL;
  const secret = process.env.CENTRAL_REGISTER_SECRET;
  if (!central || !secret || !machineId) return;
  const base = normalizeCentralUrl(central);
  const ctx = getNodeContext();
  const url = `${base}/api/devices/unsync`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Register-Key': secret },
      body: JSON.stringify({
        machine_id: machineId,
        node_id: ctx.nodeId
      }),
      agent: url.startsWith('https') ? httpsAgent : undefined
    });
  } catch (e) {
    console.error('[centralSync] notifyDeviceRemoved', e.message);
  }
}

module.exports = {
  notifyDeviceApproved,
  notifyDeviceRemoved,
  getNodeContext,
  nodeIdFor,
  normalizeBaseUrl
};
