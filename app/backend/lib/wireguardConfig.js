const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { run } = require('../runCmd');

const CONFIG_DIR = '/etc/wireguard/';
const LOG_BASE = '/etc/wireguard/logs';

function wgPubkey(privateKey) {
  const r = spawnSync('wg', ['pubkey'], { input: privateKey, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'wg pubkey failed');
  return r.stdout.trim();
}

function sanitizeInterfaceName(name) {
  if (!name || typeof name !== 'string') return null;
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || null;
}

function configPath(iface) {
  return path.join(CONFIG_DIR, `${iface}.conf`);
}

function publicKeyToLogId(pubkey) {
  return String(pubkey || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function peerLogDir(iface, pubkey) {
  return path.join(LOG_BASE, iface, publicKeyToLogId(pubkey));
}

function emptyConfig(defaultKeyExpiryDays = 90) {
  return {
    interface: {
      privateKey: '',
      publicKey: '',
      address: '',
      dns: '',
      listenPort: '',
      table: '',
      mtu: '1420',
      preUp: '',
      postUp: '',
      preDown: '',
      postDown: '',
      keyCreationDate: null,
      keyExpiryDays: defaultKeyExpiryDays,
      type: ''
    },
    peers: []
  };
}

function loadInterfaceConfig(ifaceName, options = {}) {
  const defaultKeyExpiryDays = options.defaultKeyExpiryDays ?? 90;
  const file = configPath(ifaceName);
  if (!fs.existsSync(file)) {
    return emptyConfig(defaultKeyExpiryDays);
  }

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let section = null;
  let currentPeer = null;
  let peerEnabled = true;
  let peerName = '';
  const config = emptyConfig(defaultKeyExpiryDays);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    const isCommented = trimmed.startsWith('#');
    const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;
    if (!cleanLine) continue;

    if (isCommented && cleanLine.toLowerCase().startsWith('name =')) {
      const parts = cleanLine.split('=');
      if (parts.length > 1) peerName = parts.slice(1).join('=').trim();
      continue;
    }

    if (cleanLine === '[Interface]') {
      section = 'interface';
      peerEnabled = true;
      peerName = '';
    } else if (cleanLine === '[Peer]') {
      section = 'peer';
      currentPeer = {
        name: peerName || '',
        publicKey: '',
        presharedKey: '',
        endpoint: '',
        allowedIPs: '',
        persistentKeepalive: '',
        rotationKey: '',
        enabled: !isCommented
      };
      peerEnabled = !isCommented;
      peerName = '';
      config.peers.push(currentPeer);
    } else if (cleanLine.includes('=')) {
      const equalIndex = cleanLine.indexOf('=');
      const key = cleanLine.substring(0, equalIndex).trim();
      const value = cleanLine.substring(equalIndex + 1).trim();
      if (!key) continue;

      const lowerKey = key.toLowerCase();

      if (isCommented) {
        if (lowerKey === 'key creation' && section === 'interface') {
          config.interface.keyCreationDate = value;
          continue;
        }
        if (lowerKey === 'key expiry days' && section === 'interface') {
          config.interface.keyExpiryDays = parseInt(value, 10) || defaultKeyExpiryDays;
          continue;
        }
        if (lowerKey === 'type' && (section === 'interface' || section === null)) {
          config.interface.type = value;
          continue;
        }
      }

      if (section === 'interface') {
        let propertyName = lowerKey;
        if (lowerKey === 'listenport') propertyName = 'listenPort';
        else if (lowerKey === 'preup') propertyName = 'preUp';
        else if (lowerKey === 'postup') propertyName = 'postUp';
        else if (lowerKey === 'predown') propertyName = 'preDown';
        else if (lowerKey === 'postdown') propertyName = 'postDown';
        else if (lowerKey === 'privatekey') propertyName = 'privateKey';
        else if (lowerKey === 'publickey') propertyName = 'publicKey';

        config.interface[propertyName] = value;
        if (lowerKey === 'privatekey') {
          try {
            config.interface.publicKey = wgPubkey(value);
          } catch (e) {
            console.error('wg pubkey:', e.message);
          }
        }
      } else if (section === 'peer' && currentPeer) {
        if (lowerKey === 'rotationkey') continue;
        if (lowerKey === 'publickey') currentPeer.publicKey = value;
        else if (lowerKey === 'presharedkey') currentPeer.presharedKey = value;
        else if (lowerKey === 'endpoint') currentPeer.endpoint = value;
        else if (lowerKey === 'allowedips') currentPeer.allowedIPs = value;
        else if (lowerKey === 'persistentkeepalive') currentPeer.persistentKeepalive = value;
        else currentPeer[lowerKey] = value;
        if (peerEnabled === false) currentPeer.enabled = false;
      }
    }
  }

  return config;
}

function isKeyExpired(config) {
  if (!config.interface.keyCreationDate) return false;
  const creationDate = new Date(config.interface.keyCreationDate);
  const expiryDate = new Date(creationDate);
  expiryDate.setDate(expiryDate.getDate() + (config.interface.keyExpiryDays || 90));
  return new Date() > expiryDate;
}

function buildConfigFileContent(ifaceName, config) {
  let content = '';
  const configFile = configPath(ifaceName);

  let typeToWrite = config.interface.type;
  if (!typeToWrite && fs.existsSync(configFile)) {
    try {
      const currentContent = fs.readFileSync(configFile, 'utf8');
      for (const line of currentContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('# type =')) {
          const parts = trimmed.split('=');
          if (parts.length > 1) typeToWrite = parts.slice(1).join('=').trim();
          break;
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (typeToWrite) content += `# Type = ${typeToWrite}\n`;
  content += '[Interface]\n';

  if (config.interface.keyCreationDate) {
    content += `# Key Creation = ${config.interface.keyCreationDate}\n`;
  }
  if (config.interface.keyExpiryDays) {
    content += `# Key Expiry Days = ${config.interface.keyExpiryDays}\n`;
  }

  content += `PrivateKey = ${config.interface.privateKey}\n`;
  content += `Address = ${config.interface.address}\n`;
  if (config.interface.dns) content += `DNS = ${config.interface.dns}\n`;
  if (config.interface.listenPort) content += `ListenPort = ${config.interface.listenPort}\n`;
  if (config.interface.mtu) content += `MTU = ${config.interface.mtu}\n`;
  if (config.interface.preUp) content += `PreUp = ${config.interface.preUp}\n`;
  if (config.interface.postUp) content += `PostUp = ${config.interface.postUp}\n`;
  if (config.interface.preDown) content += `PreDown = ${config.interface.preDown}\n`;
  if (config.interface.postDown) content += `PostDown = ${config.interface.postDown}\n`;

  config.peers.forEach((peer) => {
    const isDisabled = peer.enabled === false;
    content += '\n';
    if (peer.name) content += `# Name = ${peer.name}\n`;
    content += isDisabled ? '# [Peer]\n' : '[Peer]\n';
    const prefix = isDisabled ? '# ' : '';
    content += `${prefix}PublicKey = ${peer.publicKey}\n`;
    if (peer.presharedKey) content += `${prefix}PresharedKey = ${peer.presharedKey}\n`;
    if (peer.endpoint) content += `${prefix}Endpoint = ${peer.endpoint}\n`;
    content += `${prefix}AllowedIPs = ${peer.allowedIPs}\n`;
    if (peer.persistentKeepalive) content += `${prefix}PersistentKeepalive = ${peer.persistentKeepalive}\n`;
  });

  return content;
}

function saveInterfaceConfig(ifaceName, config, options = {}) {
  if (!options.skipExpiryCheck && isKeyExpired(config)) {
    const err = new Error('Key has expired. Cannot save configuration.');
    err.statusCode = 403;
    throw err;
  }
  if (!config.interface.privateKey || !config.interface.address) {
    const err = new Error('Missing required fields (private key, address)');
    err.statusCode = 400;
    throw err;
  }

  const content = buildConfigFileContent(ifaceName, config);
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(configPath(ifaceName), content, { mode: 0o600 });
  return content;
}

function findPeerIndex(config, publicKey) {
  return config.peers.findIndex((p) => p.publicKey === publicKey);
}

function findPeer(config, publicKey) {
  const idx = findPeerIndex(config, publicKey);
  return idx >= 0 ? config.peers[idx] : null;
}

function collectPeerStarts(lines) {
  const peerStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].trim().replace(/^#\s*/, '').trim();
    if (clean === '[Peer]') peerStarts.push(i);
  }
  return peerStarts;
}

function findPeerBlockRange(lines, publicKey) {
  const peerStarts = collectPeerStarts(lines);
  for (let s = 0; s < peerStarts.length; s++) {
    const start = peerStarts[s];
    const end = (s + 1 < peerStarts.length) ? peerStarts[s + 1] - 1 : lines.length - 1;
    for (let i = start; i <= end; i++) {
      const clean = lines[i].replace(/^\s*#\s*/, '').trim();
      const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
      if (m && m[1].trim() === publicKey) {
        return { start, end };
      }
    }
  }
  return null;
}

function wgSyncconfIfRunning(ifaceName) {
  try {
    const status = run('wg', ['show', 'interfaces']);
    if (!status.includes(ifaceName)) return;
    const strip = spawnSync('wg-quick', ['strip', ifaceName], { encoding: 'utf8' });
    
    if (strip.status === 0 && strip.stdout) {
      const tmpFile = path.join(CONFIG_DIR, `.tmp-sync-${ifaceName}.conf`);
      try {
        fs.writeFileSync(tmpFile, strip.stdout, { mode: 0o600 });
        const syncResult = spawnSync('wg', ['syncconf', ifaceName, tmpFile], { encoding: 'utf8' });
        if (syncResult.status !== 0) {
          console.error(`[wgSyncconf] wg syncconf error for ${ifaceName}:`, syncResult.stderr || 'Unknown error');
        }
      } finally {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      }
    } else {
      console.error(`[wgSyncconf] wg-quick strip failed for ${ifaceName}:`, strip.stderr || 'unknown error');
    }
  } catch (e) {
    console.error(`[wgSyncconf] error syncing ${ifaceName}:`, e.message);
  }
}

function disablePeerInConf(ifaceName, publicKey) {
  const file = configPath(ifaceName);
  if (!fs.existsSync(file)) {
    return { updated: false, reason: 'Interface config not found' };
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const range = findPeerBlockRange(lines, publicKey);
  if (!range) {
    return { updated: false, reason: 'Peer not found' };
  }

  for (let i = range.start; i <= range.end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    lines[i] = '# ' + lines[i];
  }

  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  wgSyncconfIfRunning(ifaceName);
  return { updated: true };
}

function deletePeerFromConf(ifaceName, publicKey) {
  if (!ifaceName || !publicKey) {
    return { updated: false, reason: 'Missing interface or public key' };
  }

  const file = configPath(ifaceName);
  if (!fs.existsSync(file)) {
    return { updated: false, reason: `${ifaceName}.conf not found` };
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const peerStarts = collectPeerStarts(lines);
  if (peerStarts.length === 0) {
    return { updated: false, reason: 'No peers in config' };
  }

  for (let s = peerStarts.length - 1; s >= 0; s--) {
    const start = peerStarts[s];
    const end = (s + 1 < peerStarts.length) ? peerStarts[s + 1] - 1 : lines.length - 1;

    let matches = false;
    for (let i = start; i <= end; i++) {
      const clean = lines[i].replace(/^\s*#\s*/, '').trim();
      const m = clean.match(/^PublicKey\s*=\s*(.+)\s*$/i);
      if (m && m[1].trim() === publicKey) {
        matches = true;
        break;
      }
    }
    if (!matches) continue;

    let deleteEnd = end;
    while (deleteEnd < lines.length - 1 && lines[deleteEnd + 1].trim() === '') {
      deleteEnd++;
    }
    lines.splice(start, deleteEnd - start + 1);
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
    wgSyncconfIfRunning(ifaceName);
    return { updated: true };
  }

  return { updated: false, reason: 'Peer not found in config' };
}

function interfaceAddressAsHost32(addressField) {
  const first = String(addressField || '').split(',')[0].trim();
  if (!first) return null;
  const host = first.includes('/') ? first.split('/')[0].trim() : first;
  return host ? `${host}/32` : null;
}

function buildClientVpnRouteAllowedIPs(addressField, extraCidr = '192.168.220.0/24') {
  const host32 = interfaceAddressAsHost32(addressField);
  return host32 ? `${host32}, ${extraCidr}` : null;
}

module.exports = {
  CONFIG_DIR,
  LOG_BASE,
  wgPubkey,
  sanitizeInterfaceName,
  configPath,
  publicKeyToLogId,
  peerLogDir,
  emptyConfig,
  loadInterfaceConfig,
  isKeyExpired,
  buildConfigFileContent,
  saveInterfaceConfig,
  findPeer,
  findPeerIndex,
  disablePeerInConf,
  deletePeerFromConf,
  wgSyncconfIfRunning,
  interfaceAddressAsHost32,
  buildClientVpnRouteAllowedIPs
};
