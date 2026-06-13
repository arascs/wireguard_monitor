const express = require('express');
const createBackupRoutes = require('./routes/backups');
const { CONFIG_DIR } = require('../../common/wireguardConfig');
const { BACKUP_DIR } = require('../../common/paths');

module.exports = function mountBackup(deps) {
  const router = express.Router();
  router.use(createBackupRoutes({
    requireAuth: deps.requireAuth,
    BACKUP_DIR,
    CONFIG_DIR,
    dbConfig: deps.dbConfig
  }));
  return router;
};
