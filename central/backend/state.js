const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const NODES_FILE = path.join(DATA_DIR, 'nodes.json');
const NODE_KEYS_FILE = path.join(DATA_DIR, 'nodeKeys.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadNodes() {
  ensureDir();
  if (!fs.existsSync(NODES_FILE)) return [];
  try {
    const raw = fs.readFileSync(NODES_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveNodes(nodes) {
  ensureDir();
  fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2), 'utf8');
}

function nodeIdFor(baseUrl) {
  return crypto.createHash('sha256').update(baseUrl).digest('hex').slice(0, 16);
}

function loadNodeKeys() {
  ensureDir();
  if (!fs.existsSync(NODE_KEYS_FILE)) return [];
  try {
    const raw = fs.readFileSync(NODE_KEYS_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveNodeKeys(rows) {
  ensureDir();
  fs.writeFileSync(NODE_KEYS_FILE, JSON.stringify(rows, null, 2), 'utf8');
}

module.exports = {
  loadNodes,
  saveNodes,
  loadNodeKeys,
  saveNodeKeys,
  nodeIdFor,
  DATA_DIR
};
