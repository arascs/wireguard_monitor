const fs = require('fs');
const { SETTINGS_FILE } = require('./paths');

const defaultSettings = {
  peerDisableHours: 12,
  keyRotationTimeoutSeconds: 60,
  physicalInterface: '',
  centralUrl: '',
  metricsPushIntervalMs: 30000,
  allowedLanRanges: '192.168.220.0/24'
};

function loadGlobalSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Error loading settings:', e.message);
  }
  return { ...defaultSettings };
}

function getAllowedLanCidrs(settings) {
  const raw = (settings && settings.allowedLanRanges) != null
    ? settings.allowedLanRanges
    : defaultSettings.allowedLanRanges;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCidrList(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isValidCidr(s) {
  const m = String(s).match(/^([\d.:a-fA-F]+)\/(\d{1,3})$/);
  if (!m) return false;
  const p = parseInt(m[2], 10);
  return p >= 0 && p <= 128;
}

module.exports = {
  loadGlobalSettings,
  defaultSettings,
  getAllowedLanCidrs,
  parseCidrList,
  isValidCidr
};
