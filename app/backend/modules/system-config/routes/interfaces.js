const express = require('express');
const fs = require('fs');
const path = require('path');
const { run } = require('../../../common/runCmd');
const { logAction } = require('../../logging/auditLogger');
const { DEFAULT_KEY_EXPIRY_DAYS } = require('../../../common/paths');
const {
  CONFIG_DIR,
  loadInterfaceConfig,
  saveInterfaceConfig,
  isKeyExpired: isInterfaceKeyExpired,
  sanitizeInterfaceName,
  wgPubkey
} = require('../../../common/wireguardConfig');
const { listInterfaces, parseInterfaceSummary } = require('../services/interfaceList');
const { hydrateRotationKeysFromDb, getRemainingDays } = require('../services/rotationKeys');

module.exports = function createInterfaceRoutes() {
  const router = express.Router();

  router.get('/interface-log/:interfaceName', (req, res) => {
    try {
      const interfaceName = req.params.interfaceName.replace(/[^a-zA-Z0-9_\-]/g, '');
      if (!interfaceName) {
        return res.status(400).json({ success: false, error: 'Invalid interface name' });
      }
      const LOG_FILE = '/etc/wireguard/logs/wg_systemd.log';
      let lines = '';
      try {
        const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
        const matched = content.split('\n').filter((l) => l.includes(interfaceName));
        lines = matched.slice(-50).join('\n');
      } catch (e) {
        lines = '';
      }
      res.json({ success: true, log: lines });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/interfaces/:interface/key-status', (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
    res.json({
      success: true,
      expired: isInterfaceKeyExpired(config),
      remainingDays: getRemainingDays(config),
      keyCreationDate: config.interface.keyCreationDate,
      keyExpiryDays: config.interface.keyExpiryDays
    });
  });

  router.get('/interfaces', (req, res) => {
    try {
      const interfaces = listInterfaces();
      res.json({ success: true, interfaces });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/interfaces/client', (req, res) => {
    try {
      const interfaces = listInterfaces().filter((i) => i.type === 'Client');
      res.json({ success: true, interfaces });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/add-interface', async (req, res) => {
    try {
      const { name, type, address, listenPort, dns, mtu, preUp, postUp, preDown, postDown, keyExpiryDays } = req.body;
      if (!String(name || '').trim()) {
        return res.status(400).json({ success: false, error: 'Interface name is required' });
      }
      if (!String(address || '').trim()) {
        return res.status(400).json({ success: false, error: 'Address is required' });
      }
      if (!String(listenPort || '').trim()) {
        return res.status(400).json({ success: false, error: 'Listen port is required' });
      }
      const interfaceType = (type === 'Site' || type === 'Client') ? type : 'Client';
      const confFile = path.join(CONFIG_DIR, `${name}.conf`);
      if (fs.existsSync(confFile)) {
        return res.status(409).json({ success: false, error: 'Interface already exists' });
      }

      const privateKey = run('wg', ['genkey']).trim();
      const publicKey = wgPubkey(privateKey);

      let content = `# Type = ${interfaceType}\n`;
      content += '[Interface]\n';
      content += `# Key Creation = ${new Date().toISOString()}\n`;
      const expiryDays = parseInt(keyExpiryDays, 10) || DEFAULT_KEY_EXPIRY_DAYS;
      content += `# Key Expiry Days = ${expiryDays}\n`;
      content += `PrivateKey = ${privateKey}\n`;
      content += `Address = ${String(address).trim()}\n`;
      content += `ListenPort = ${String(listenPort).trim()}\n`;
      if (dns) content += `DNS = ${dns}\n`;
      if (mtu) content += `MTU = ${mtu}\n`;
      if (preUp) content += `PreUp = ${preUp}\n`;
      if (postUp) content += `PostUp = ${postUp}\n`;
      if (preDown) content += `PreDown = ${preDown}\n`;
      if (postDown) content += `PostDown = ${postDown}\n`;

      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(confFile, content, { mode: 0o600 });

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'add_interface', { interface: name, type: interfaceType, publicKey, address, keyExpiryDays: expiryDays });
      } catch (e) { /* ignore */ }

      res.json({ success: true, name, type: interfaceType, publicKey });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.delete('/delete-interface/:name', (req, res) => {
    try {
      const interfaceName = decodeURIComponent(req.params.name);
      const configFile = path.join(CONFIG_DIR, `${interfaceName}.conf`);

      if (!fs.existsSync(configFile)) {
        return res.status(404).json({ success: false, error: 'Interface config file not found' });
      }

      const ifaceSummary = parseInterfaceSummary(configFile);

      try {
        const status = run('wg', ['show', 'interfaces']);
        if (status.includes(interfaceName)) {
          run('wg-quick', ['down', interfaceName]);
        }
      } catch (e) {
        // Interface not running, continue
      }

      fs.unlinkSync(configFile);

      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'delete_interface', {
          interface: interfaceName,
          publicKey: ifaceSummary.publicKey,
          address: ifaceSummary.address
        });
      } catch (e) { /* ignore */ }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/interfaces/:interface/config', async (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
      await hydrateRotationKeysFromDb(iface, config);
      res.json({ success: true, config });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/interfaces/:interface/reload', async (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
      await hydrateRotationKeysFromDb(iface, config);
      const loaded = fs.existsSync(path.join(CONFIG_DIR, `${iface}.conf`));
      res.json({ success: true, config, loaded });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/interfaces/:interface/save', (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
      const content = saveInterfaceConfig(iface, config);
      try {
        const status = run('wg', ['show', 'interfaces']);
        if (status.includes(iface)) {
          run('wg-quick', ['down', iface]);
          run('wg-quick', ['up', iface]);
        }
      } catch (e) { /* not running */ }
      res.json({ success: true, content });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  router.post('/interfaces/:interface/connect', (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'start_interface', { interface: iface });
      } catch (e) { /* ignore */ }

      const config = loadInterfaceConfig(iface, { defaultKeyExpiryDays: DEFAULT_KEY_EXPIRY_DAYS });
      if (isInterfaceKeyExpired(config)) {
        return res.status(403).json({ success: false, error: 'Key has expired. Cannot connect VPN. Please generate new keys first.' });
      }

      const status = run('wg', ['show', 'interfaces']);
      if (status.includes(iface)) {
        return res.status(400).json({ success: false, error: 'VPN already connected' });
      }

      const confFile = path.join(CONFIG_DIR, `${iface}.conf`);
      if (!fs.existsSync(confFile)) {
        return res.status(404).json({ success: false, error: 'Config file not found. Save configuration first.' });
      }

      run('wg-quick', ['up', iface]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/interfaces/:interface/disconnect', (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      try {
        const admin = req.session && req.session.user ? req.session.user : 'unknown';
        logAction(admin, 'stop_interface', { interface: iface });
      } catch (e) { /* ignore */ }
      run('wg-quick', ['down', iface]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/interfaces/:interface/vpn-status', (req, res) => {
    const iface = sanitizeInterfaceName(req.params.interface);
    if (!iface) {
      return res.status(400).json({ success: false, error: 'Invalid interface name' });
    }
    try {
      const status = run('wg', ['show', 'interfaces']);
      res.json({ success: true, connected: status.includes(iface) });
    } catch (error) {
      res.json({ success: true, connected: false });
    }
  });

  return router;
};
