const { run, tryRun } = require('../../../common/utils');
const { EXPORTER_SCRIPT } = require('../../../common/paths');

function registerMetricsRoutes(app) {
  app.get('/metrics', (req, res) => {
    try {
      const out = run('bash', [EXPORTER_SCRIPT], { timeout: 120000 });
      res.type('text/plain; version=0.0.4').send(out);
    } catch (e) {
      res.status(500).type('text/plain').send(`# exporter error: ${e.message || e}\n`);
    }
  });

  app.get('/health', (req, res) => {
    const r = tryRun('wg', ['show']);
    const ok = r.status === 0;
    res.status(ok ? 200 : 503).type('text/plain').send(ok ? 'ok' : 'fail');
  });
}

module.exports = { registerMetricsRoutes };
