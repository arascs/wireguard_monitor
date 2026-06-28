const fs = require('fs');
const { SETTINGS_FILE } = require('./paths');

function normalizeSettings(settings) {
  const s = { ...settings };
  if (s.minKernelVersion != null && s.minKernelVersionLinux == null) {
    s.minKernelVersionLinux = s.minKernelVersion;
  }
  if (s.minKernelVersion != null && s.minKernelVersionWindows == null) {
    s.minKernelVersionWindows = s.minKernelVersion;
  }
  if (s.enforceFirewall != null && s.enforceFirewallLinux == null) {
    s.enforceFirewallLinux = s.enforceFirewall;
  }
  if (s.enforceFirewall != null && s.enforceFirewallWindows == null) {
    s.enforceFirewallWindows = s.enforceFirewall;
  }
  if (s.enforceNoPasswordlessUser != null && s.enforcePasswordRequiredLinux == null) {
    s.enforcePasswordRequiredLinux = s.enforceNoPasswordlessUser;
  }
  if (s.enforceNoPasswordlessUser != null && s.enforcePasswordRequiredWindows == null) {
    s.enforcePasswordRequiredWindows = s.enforceNoPasswordlessUser;
  }
  return s;
}

const defaultSettings = {
  peerDisableHours: 12,
  keyRotationTimeoutSeconds: 60,
  physicalInterface: '',
  centralUrl: '',
  metricsPushIntervalMs: 30000,
  allowedLanRanges: '192.168.220.0/24',
  enforceKernelCheck: true,
  minKernelVersionLinux: 4,
  minKernelVersionWindows: 10,
  enforceFirewallLinux: true,
  enforceFirewallWindows: true,
  enforcePasswordRequiredLinux: true,
  enforcePasswordRequiredWindows: true,
  enforceWifiSecureLinux: false,
  enforceWifiSecureWindows: false,
  enforceNoUnallowedSharesLinux: false,
  enforceNoUnallowedSharesWindows: false,
  enforceNoMobileHotspotLinux: false,
  enforceNoMobileHotspotWindows: false,
  enforceNoUsbStorageLinux: false,
  enforceNoUsbStorageWindows: false,
  enforceAntivirusWindows: false,
  enforceUacWindows: false,
  enforceBitlockerWindows: false
};

function loadGlobalSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return normalizeSettings({ ...defaultSettings, ...JSON.parse(data) });
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
  normalizeSettings,
  getAllowedLanCidrs,
  parseCidrList,
  isValidCidr
};
