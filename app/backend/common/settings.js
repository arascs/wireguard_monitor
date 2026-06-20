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

module.exports = { loadGlobalSettings, defaultSettings, normalizeSettings };
