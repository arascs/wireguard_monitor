const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { HOSTNAME } = require('../../../common/config');
const { dbConfig } = require('../../../common/db');
const { getNodeProductUuid } = require('../../../common/nodeUuid');

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
  const headers = {};
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const uuid = getNodeProductUuid();
  if (uuid) headers['X-Node-UUID'] = uuid;
  return headers;
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    agent: url.startsWith('https') ? httpsAgent : undefined
  });
}

async function pushDevicesToCentral() {
  const base = getCentralBase();
  if (!base || !getApiKey()) return;

  const ctx = getNodeContext();
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(
      `SELECT device_name, public_key, \`interface\`, machine_id
       FROM devices
       WHERE machine_id IS NOT NULL AND TRIM(machine_id) != ''`
    );
    const devices = rows
      .map((r) => ({
        machine_id: String(r.machine_id || '').trim(),
        device_name: String(r.device_name || '').trim(),
        public_key: String(r.public_key || '').trim(),
        interface: String(r.interface || '').trim()
      }))
      .filter((d) => d.machine_id);

    const r = await postJson(`${base}/api/devices/sync-batch`, {
      node_id: ctx.nodeId,
      node_name: ctx.nodeName,
      base_url: ctx.baseUrl,
      devices
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[centralSync] pushDevices', r.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.error('[centralSync] pushDevices', e.message);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  pushDevicesToCentral,
  getNodeContext,
  getCentralBase,
  getApiKey,
  authHeaders,
  getNodeProductUuid,
  nodeIdFor,
  normalizeBaseUrl,
  httpsAgent
};
