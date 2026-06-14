const fs = require('fs');
const { normalizeSettings } = require('./securityChecks');
const { SETTINGS_FILE } = require('./paths');

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

module.exports = { loadGlobalSettings, defaultSettings };
