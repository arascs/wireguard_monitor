const express = require('express');
const fs = require('fs');
const { logAction } = require('../../logging/auditLogger');
const {
  loadGlobalSettings,
  parseCidrList,
  isValidCidr
} = require('../../../common/settings');
const { SETTINGS_FILE } = require('../../../common/paths');
const { scheduleCentralSync } = require('../../monitoring');
const { scheduleBackup } = require('../../backup');
const { normalizeBaseUrl } = require('../../monitoring/sync/centralSync');

module.exports = function createSettingsRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/settings', requireAuth, (req, res) => {
    try {
      const settings = loadGlobalSettings();
      settings.apiKey = process.env.NODE_API_KEY || '';
      return res.json({ success: true, settings });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/settings', requireAuth, (req, res) => {
    try {
      const currentSettings = loadGlobalSettings();
      const physicalInterface = req.body.physicalInterface !== undefined
        ? String(req.body.physicalInterface || '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
        : currentSettings.physicalInterface;

      const centralUrlRaw = req.body.centralUrl !== undefined
        ? String(req.body.centralUrl || '').trim()
        : currentSettings.centralUrl;
      const centralUrl = centralUrlRaw ? normalizeBaseUrl(centralUrlRaw) : '';

      const metricsPushIntervalMs = req.body.metricsPushIntervalMs !== undefined
        ? parseInt(req.body.metricsPushIntervalMs, 10)
        : currentSettings.metricsPushIntervalMs;
      if (!Number.isFinite(metricsPushIntervalMs) || metricsPushIntervalMs < 5000) {
        return res.status(400).json({ success: false, error: 'metricsPushIntervalMs must be >= 5000' });
      }

      const allowedLanRanges = req.body.allowedLanRanges !== undefined
        ? String(req.body.allowedLanRanges || '').trim()
        : currentSettings.allowedLanRanges;
      const cidrs = parseCidrList(allowedLanRanges);
      if (!cidrs.length || cidrs.some((c) => !isValidCidr(c))) {
        return res.status(400).json({ success: false, error: 'Invalid Allowed LAN range' });
      }

      const backupIntervalDays = req.body.backupIntervalDays !== undefined
        ? parseInt(req.body.backupIntervalDays, 10)
        : currentSettings.backupIntervalDays;
      if (!Number.isFinite(backupIntervalDays) || backupIntervalDays < 1) {
        return res.status(400).json({ success: false, error: 'backupIntervalDays must be >= 1' });
      }

      const newSettings = {
        peerDisableHours: req.body.peerDisableHours ? parseInt(req.body.peerDisableHours, 10) : currentSettings.peerDisableHours,
        keyRotationTimeoutSeconds: req.body.keyRotationTimeoutSeconds !== undefined
          ? parseInt(req.body.keyRotationTimeoutSeconds, 10) : currentSettings.keyRotationTimeoutSeconds,
        physicalInterface,
        centralUrl,
        metricsPushIntervalMs,
        allowedLanRanges: cidrs.join(', '),
        backupIntervalDays
      };

      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');
      scheduleCentralSync();
      scheduleBackup();

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'update_settings', newSettings);
      } catch (e) { /* ignore */ }

      res.json({ success: true, settings: newSettings });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
};
