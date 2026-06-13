const { run } = require('../../../common/runCmd');
const {
  loadInterfaceConfig,
  isKeyExpired: isInterfaceKeyExpired
} = require('../../../common/wireguardConfig');
const { DEFAULT_KEY_EXPIRY_DAYS } = require('../../../common/paths');
const { logSecurityEvent } = require('../../logging/auditLogger');
const { listInterfaces } = require('./interfaceList');
const { getRemainingDays } = require('./rotationKeys');

async function checkAndDisconnectIfExpired() {
  for (const iface of listInterfaces()) {
    const config = loadInterfaceConfig(iface.name, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    const remaining = getRemainingDays(config);
    if (remaining !== null && remaining <= 3) {
      logSecurityEvent({
        event_name: 'interface_expire',
        interface: iface.name,
        remaining_days: remaining
      });
    }
    if (!isInterfaceKeyExpired(config)) continue;
    try {
      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(iface.name)) {
        run('wg-quick', ['down', iface.name]);
        console.log(`[INFO] VPN ${iface.name} disconnected due to expired key`);
      }
    } catch (e) {
      console.error('Error disconnecting VPN:', e.message);
    }
  }
}

module.exports = { checkAndDisconnectIfExpired };
