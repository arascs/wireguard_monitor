const dashboardRoutes = require('./routes/dashboard');
const createMainDashboardRoutes = require('./routes/mainDashboard');
const createCentralRoutes = require('./routes/central');
const { registerMetricsRoutes } = require('./routes/metrics');

module.exports = function registerMonitoring(app, deps) {
  registerMetricsRoutes(app);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/main-dashboard', createMainDashboardRoutes(deps));
  app.use('/api', createCentralRoutes(deps));
};

const {
  registerWithCentral,
  pushMetricsToCentral,
  pushDevicesToCentral
} = require('./routes/central');

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
    const onRegisterFail = (e) => console.error('[central register]', e.message);
    registerWithCentral(port)
      .then(() => pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message)))
      .catch(onRegisterFail);
    const regMs = parseInt(process.env.CENTRAL_REGISTER_INTERVAL_MS || '300000', 10);
    if (regMs > 0) {
      setInterval(() => {
        registerWithCentral(port).catch(onRegisterFail);
      }, regMs);
    }
    const pushMs = parseInt(process.env.METRICS_PUSH_INTERVAL_MS || '30000', 10);
    if (pushMs > 0) {
      setInterval(() => { pushMetricsToCentral(); }, pushMs);
      pushMetricsToCentral();
    }
    const deviceSyncMs = parseInt(process.env.DEVICE_SYNC_INTERVAL_MS || '3600000', 10);
    if (deviceSyncMs > 0) {
      setInterval(() => {
        pushDevicesToCentral().catch((e) => console.error('[centralSync] pushDevices', e.message));
      }, deviceSyncMs);
    }
  };
};
