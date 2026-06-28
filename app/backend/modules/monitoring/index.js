const dashboardRoutes = require('./routes/dashboard');
const createMainDashboardRoutes = require('./routes/mainDashboard');
const createCentralRoutes = require('./routes/central');
const { registerMetricsRoutes } = require('./routes/metrics');
const { loadGlobalSettings } = require('../../common/settings');
const {
  registerWithCentral,
  pushMetricsToCentral,
  pushDevicesToCentral
} = require('./routes/central');

let metricsTimer = null;
let registerTimer = null;
let deviceSyncTimer = null;
let listenPort = null;

function clearCentralTimers() {
  if (metricsTimer) clearInterval(metricsTimer);
  if (registerTimer) clearInterval(registerTimer);
  if (deviceSyncTimer) clearInterval(deviceSyncTimer);
  metricsTimer = registerTimer = deviceSyncTimer = null;
}

function scheduleCentralSync(port) {
  if (port != null) listenPort = port;
  if (listenPort == null) return;
  clearCentralTimers();

  const onRegisterFail = (e) => console.error('[central register]', e.message);
  registerWithCentral(listenPort)
    .then(() => pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message)))
    .catch(onRegisterFail);

  const regMs = parseInt(process.env.CENTRAL_REGISTER_INTERVAL_MS || '300000', 10);
  if (regMs > 0) {
    registerTimer = setInterval(() => {
      registerWithCentral(listenPort).catch(onRegisterFail);
    }, regMs);
  }

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
  }
}

module.exports = function registerMonitoring(app, deps) {
  registerMetricsRoutes(app);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/main-dashboard', createMainDashboardRoutes(deps));
  app.use('/api', createCentralRoutes(deps));
};

module.exports.startCentralSync = function startCentralSync(port) {
  let bootOnce = false;
  return function afterListen() {
    if (bootOnce) return;
    bootOnce = true;
    scheduleCentralSync(port);
  };
};

module.exports.scheduleCentralSync = scheduleCentralSync;
