const express = require('express');
const createBackupRoutes = require('./routes/backups');
const createBackupService = require('./services/backupRunner');
const { loadGlobalSettings } = require('../../common/settings');
const { CONFIG_DIR } = require('../../common/wireguardConfig');
const { BACKUP_DIR } = require('../../common/paths');

let backupTimer = null;
let backupService = null;

function scheduleBackup() {
  if (backupTimer) clearInterval(backupTimer);
  if (!backupService) return;

  const days = Math.max(1, parseInt(loadGlobalSettings().backupIntervalDays, 10) || 7);
  backupTimer = setInterval(() => {
    backupService.createBackup('full').catch((e) => {
      console.error('[backup] scheduled backup failed:', e.message);
    });
  }, days * 24 * 60 * 60 * 1000);
}

module.exports = function mountBackup(deps) {
  backupService = createBackupService({
    BACKUP_DIR,
    CONFIG_DIR,
    dbConfig: deps.dbConfig
  });
  scheduleBackup();

  const router = express.Router();
  router.use(createBackupRoutes({
    requireAuth: deps.requireAuth,
    backupService
  }));
  return router;
};

module.exports.scheduleBackup = scheduleBackup;
