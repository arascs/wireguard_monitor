const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const { HOSTNAME } = require('./config');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function normalizeBaseUrl(u) {
  const trimmed = String(u || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
  return `https://${trimmed}`;
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

function getCentralBase() {
  const central = process.env.CENTRAL_URL;
  if (!central) return '';
  return normalizeBaseUrl(central);
}

function getApiKey() {
  return String(process.env.NODE_API_KEY || '').trim();
}

function authHeaders() {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    agent: url.startsWith('https') ? httpsAgent : undefined
  });
}

async function notifyDeviceApproved(row) {
  const base = getCentralBase();
  if (!base || !getApiKey()) return;
  const ctx = getNodeContext();
  try {
    await postJson(`${base}/api/devices/sync`, {
      machine_id: row.machine_id,
      device_name: row.device_name,
      public_key: row.public_key,
      interface: row.interface,
      node_id: ctx.nodeId,
      node_name: ctx.nodeName,
      base_url: ctx.baseUrl
    });
  } catch (e) {
    console.error('[centralSync] notifyDeviceApproved', e.message);
  }
}

async function notifyDeviceRemoved(machineId) {
  const base = getCentralBase();
  if (!base || !getApiKey() || !machineId) return;
  const ctx = getNodeContext();
  try {
    await postJson(`${base}/api/devices/unsync`, {
      machine_id: machineId,
      node_id: ctx.nodeId
    });
  } catch (e) {
    console.error('[centralSync] notifyDeviceRemoved', e.message);
  }
}

module.exports = {
  notifyDeviceApproved,
  notifyDeviceRemoved,
  getNodeContext,
  getCentralBase,
  getApiKey,
  authHeaders,
  nodeIdFor,
  normalizeBaseUrl,
  httpsAgent
};
