const express = require('express');
const fs = require('fs');
const { logAction } = require('../../logging/auditLogger');
const { loadGlobalSettings } = require('../../../common/settings');
const { SETTINGS_FILE } = require('../../../common/paths');
const { saveNodeApiKey } = require('../../../common/auth');

module.exports = function createSettingsRoutes() {
  const router = express.Router();

  router.get('/settings', (req, res) => {
    try {
      const settings = loadGlobalSettings();
      settings.apiKey = process.env.NODE_API_KEY || '';
      return res.json({ success: true, settings });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/settings', (req, res) => {
    try {
      const currentSettings = loadGlobalSettings();
      const physicalInterface = req.body.physicalInterface !== undefined
        ? String(req.body.physicalInterface || '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
        : currentSettings.physicalInterface;
      const newSettings = {
        peerDisableHours: req.body.peerDisableHours ? parseInt(req.body.peerDisableHours, 10) : currentSettings.peerDisableHours,
        keyRotationTimeoutSeconds: req.body.keyRotationTimeoutSeconds !== undefined
          ? parseInt(req.body.keyRotationTimeoutSeconds, 10) : currentSettings.keyRotationTimeoutSeconds,
        physicalInterface,
        enforceKernelCheck: req.body.enforceKernelCheck !== undefined ? req.body.enforceKernelCheck : currentSettings.enforceKernelCheck,
        minKernelVersionLinux: req.body.minKernelVersionLinux !== undefined
          ? parseInt(req.body.minKernelVersionLinux, 10) : currentSettings.minKernelVersionLinux,
        minKernelVersionWindows: req.body.minKernelVersionWindows !== undefined
          ? parseInt(req.body.minKernelVersionWindows, 10) : currentSettings.minKernelVersionWindows,
        enforceFirewallLinux: req.body.enforceFirewallLinux !== undefined
          ? req.body.enforceFirewallLinux : currentSettings.enforceFirewallLinux,
        enforceFirewallWindows: req.body.enforceFirewallWindows !== undefined
          ? req.body.enforceFirewallWindows : currentSettings.enforceFirewallWindows,
        enforcePasswordRequiredLinux: req.body.enforcePasswordRequiredLinux !== undefined
          ? req.body.enforcePasswordRequiredLinux : currentSettings.enforcePasswordRequiredLinux,
        enforcePasswordRequiredWindows: req.body.enforcePasswordRequiredWindows !== undefined
          ? req.body.enforcePasswordRequiredWindows : currentSettings.enforcePasswordRequiredWindows,
        enforceWifiSecureLinux: req.body.enforceWifiSecureLinux !== undefined
          ? req.body.enforceWifiSecureLinux : currentSettings.enforceWifiSecureLinux,
        enforceWifiSecureWindows: req.body.enforceWifiSecureWindows !== undefined
          ? req.body.enforceWifiSecureWindows : currentSettings.enforceWifiSecureWindows,
        enforceNoUnallowedSharesLinux: req.body.enforceNoUnallowedSharesLinux !== undefined
          ? req.body.enforceNoUnallowedSharesLinux : currentSettings.enforceNoUnallowedSharesLinux,
        enforceNoUnallowedSharesWindows: req.body.enforceNoUnallowedSharesWindows !== undefined
          ? req.body.enforceNoUnallowedSharesWindows : currentSettings.enforceNoUnallowedSharesWindows,
        enforceNoMobileHotspotLinux: req.body.enforceNoMobileHotspotLinux !== undefined
          ? req.body.enforceNoMobileHotspotLinux : currentSettings.enforceNoMobileHotspotLinux,
        enforceNoMobileHotspotWindows: req.body.enforceNoMobileHotspotWindows !== undefined
          ? req.body.enforceNoMobileHotspotWindows : currentSettings.enforceNoMobileHotspotWindows,
        enforceNoUsbStorageLinux: req.body.enforceNoUsbStorageLinux !== undefined
          ? req.body.enforceNoUsbStorageLinux : currentSettings.enforceNoUsbStorageLinux,
        enforceNoUsbStorageWindows: req.body.enforceNoUsbStorageWindows !== undefined
          ? req.body.enforceNoUsbStorageWindows : currentSettings.enforceNoUsbStorageWindows,
        enforceAntivirusWindows: req.body.enforceAntivirusWindows !== undefined
          ? req.body.enforceAntivirusWindows : currentSettings.enforceAntivirusWindows,
        enforceUacWindows: req.body.enforceUacWindows !== undefined
          ? req.body.enforceUacWindows : currentSettings.enforceUacWindows,
        enforceBitlockerWindows: req.body.enforceBitlockerWindows !== undefined
          ? req.body.enforceBitlockerWindows : currentSettings.enforceBitlockerWindows
      };

      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');

      if (req.body && typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) {
        saveNodeApiKey(req.body.apiKey.trim());
      }

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_settings', { ...newSettings, apiKey: '***' });
      } catch (e) { /* ignore */ }

      res.json({
        success: true,
        settings: { ...newSettings, apiKey: process.env.NODE_API_KEY || '' }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
};
