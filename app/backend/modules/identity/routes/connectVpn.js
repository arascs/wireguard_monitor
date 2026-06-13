const express = require('express');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadGlobalSettings } = require('../../../common/settings');
const { DEFAULT_KEY_EXPIRY_DAYS } = require('../../../common/paths');
const { dbConfig } = require('../../../common/db');
const { run, tryRun } = require('../../../common/runCmd');
const {
  collectSecurityPolicyIssues,
  formatIssues,
  isUserExpired
} = require('../../../common/securityChecks');
const {
  CONFIG_DIR,
  loadInterfaceConfig,
  saveInterfaceConfig,
  wgSyncconfIfRunning,
  buildClientVpnRouteAllowedIPs
} = require('../../../common/wireguardConfig');
const { touch: redisHeartbeatTouch } = require('../services/deviceHeartbeat');
const { hydrateRotationKeysFromDb } = require('../../system-config/services/rotationKeys');

module.exports = function createConnectVpnRoutes({ authenticateToken }) {
  const router = express.Router();

  router.post('/connect-vpn', authenticateToken, async (req, res) => {
    let connection;

    try {
      const { deviceName, securityInfo } = req.body;
      const username = req.user.username;

      if (!deviceName) {
        return res.status(400).json({ success: false, error: 'Missing deviceName' });
      }

      const settings = loadGlobalSettings();
      if (securityInfo) {
        const issues = collectSecurityPolicyIssues(securityInfo, settings);
        if (issues.length > 0) {
          return res.status(403).json({
            success: false,
            error: `Security policy violation: ${formatIssues(issues)}`,
            issues
          });
        }
      }

      connection = await mysql.createConnection(dbConfig);
      const now = Math.floor(Date.now() / 1000);

      const [userRows] = await connection.execute(
        'SELECT expire_day FROM users WHERE username = ?',
        [username]
      );
      if (userRows.length === 0) {
        await connection.end();
        return res.status(403).json({ success: false, error: 'User not found' });
      }
      if (isUserExpired(userRows[0].expire_day)) {
        await connection.end();
        return res.status(403).json({ success: false, error: 'User account expired' });
      }

      const [devices] = await connection.execute(
        'SELECT allowed_ips, public_key, status, expire_date, `interface` FROM devices WHERE username = ? AND device_name = ?',
        [username, deviceName]
      );

      await connection.execute(
        'UPDATE devices SET last_seen = ? WHERE username = ? AND device_name = ?',
        [now, username, deviceName]
      );
      await connection.end();

      if (devices.length === 0) {
        return res.status(403).json({ success: false, error: 'Device not enrolled' });
      }

      const deviceRow = devices[0];
      const deviceStatus = parseInt(deviceRow.status, 10);
      if (deviceStatus === 0) {
        return res.status(403).json({ success: false, error: 'Device disabled' });
      }

      const expireDate = deviceRow.expire_date ? parseInt(deviceRow.expire_date, 10) : null;
      if (expireDate !== null && expireDate < now) {
        const c2 = await mysql.createConnection(dbConfig);
        await c2.execute(
          'UPDATE devices SET status = 0 WHERE username = ? AND device_name = ?',
          [username, deviceName]
        );
        await c2.end();
        return res.status(403).json({ success: false, error: 'Device expired' });
      }

      const device = devices[0];
      const allowedIPs = device.allowed_ips;
      const publicKey = device.public_key;
      const targetIface = device.interface || 'wg2';
      const confFile = path.join(CONFIG_DIR, `${targetIface}.conf`);

      if (!fs.existsSync(confFile)) {
        throw new Error(`Interface ${targetIface} config not found on server`);
      }

      const config = loadInterfaceConfig(targetIface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
      await hydrateRotationKeysFromDb(targetIface, config);

      let peer = config.peers.find((p) => p.publicKey === publicKey);
      let needSave = false;

      if (peer) {
        if (peer.enabled === false) {
          peer.enabled = true;
          peer.name = `${username}_${deviceName}`;
          needSave = true;
          console.log(`[INFO] Enabled device ${deviceName} for user ${username} on ${targetIface}`);
        }
      } else {
        config.peers.push({
          name: `${username}_${deviceName}`,
          publicKey,
          presharedKey: '',
          endpoint: '',
          allowedIPs,
          persistentKeepalive: '25',
          rotationKey: '',
          enabled: true
        });
        needSave = true;
        console.log(`[INFO] Created and enabled device ${deviceName} for user ${username} on ${targetIface}`);
      }

      if (needSave) {
        saveInterfaceConfig(targetIface, config);
        wgSyncconfIfRunning(targetIface);

        try {
          const currentSettings = loadGlobalSettings();
          const disableHours = currentSettings.peerDisableHours || 12;
          const unitName = `wg-peer-expire-${username}-${deviceName}`;

          tryRun('systemctl', ['stop', `${unitName}.timer`]);
          tryRun('systemctl', ['stop', `${unitName}.service`]);
          tryRun('systemctl', ['reset-failed', `${unitName}.service`]);
          run('systemd-run', [
            `--on-active=${disableHours}h`,
            `--unit=${unitName}`,
            '/usr/local/bin/wg_disable_peer.sh',
            targetIface,
            publicKey
          ]);
          console.log(`[INFO] Scheduled peer disable in ${disableHours}h for ${username}/${deviceName} on ${targetIface}`);
        } catch (e) {
          console.error('systemd-run schedule error:', e.message);
        }
      }

      try {
        await redisHeartbeatTouch(username, deviceName);
      } catch (e) {
        console.error('[heartbeat] connect-vpn touch:', e.message);
      }

      const listenPort = String(config.interface.listenPort || '').trim();
      const serverAllowedIPs = buildClientVpnRouteAllowedIPs(config.interface.address);
      if (!listenPort) {
        return res.status(500).json({ success: false, error: `Interface ${targetIface} missing ListenPort` });
      }
      if (!serverAllowedIPs) {
        return res.status(500).json({ success: false, error: `Interface ${targetIface} missing Address` });
      }

      const vpnPublicHost = process.env.VPN_PUBLIC_ENDPOINT_HOST || process.env.TLS_PUBLIC_BIND || '172.16.0.128';
      res.json({
        success: true,
        allowedIPs,
        serverPublicKey: config.interface.publicKey,
        serverEndpoint: `${vpnPublicHost}:${listenPort}`,
        serverAllowedIPs
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) await connection.end();
    }
  });

  return router;
};
