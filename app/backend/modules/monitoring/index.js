const createDashboardRoutes = require('./routes/dashboard');
const createMainDashboardRoutes = require('./routes/mainDashboard');
const createCentralRoutes = require('./routes/central');
const { registerMetricsRoutes } = require('./routes/metrics');
const { loadGlobalSettings } = require('../../common/settings');
const {
  pushMetricsToCentral,
  pushDevicesToCentral
} = require('./routes/central');

let metricsTimer = null;
let deviceSyncTimer = null;

function clearCentralTimers() {
  if (metricsTimer) clearInterval(metricsTimer);
  if (deviceSyncTimer) clearInterval(deviceSyncTimer);
  metricsTimer = deviceSyncTimer = null;
}

function scheduleCentralSync() {
  clearCentralTimers();

  const pushMs = Math.max(5000, parseInt(loadGlobalSettings().metricsPushIntervalMs, 10) || 30000);
  if (pushMs > 0) {
    metricsTimer = setInterval(() => { pushMetricsToCentral(); }, pushMs);
    pushMetricsToCentral();
  }

  const deviceSyncMs = parseInt(process.env.DEVICE_SYNC_INTERVAL_MS || '3600000', 10);
  if (deviceSyncMs > 0) {
    deviceSyncTimer = setInterval(() => {
      pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message));
    }, deviceSyncMs);
    pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message));
  }
}

module.exports = function registerMonitoring(app, deps) {
  registerMetricsRoutes(app);
  app.use('/api/dashboard', createDashboardRoutes(deps));
  app.use('/api/main-dashboard', createMainDashboardRoutes(deps));
  app.use('/api', createCentralRoutes(deps));
};

module.exports.startCentralSync = function startCentralSync() {
  let bootOnce = false;
  return function afterListen() {
    if (bootOnce) return;
    bootOnce = true;
    scheduleCentralSync();
  };
};

module.exports.scheduleCentralSync = scheduleCentralSync;
