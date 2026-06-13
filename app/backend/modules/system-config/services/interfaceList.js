const fs = require('fs');
const path = require('path');
const { run } = require('../../../common/runCmd');
const { CONFIG_DIR, wgPubkey } = require('../../../common/wireguardConfig');

function getActiveInterfaces() {
  try {
    const interfacesOutput = run('wg', ['show', 'interfaces']).trim();
    if (!interfacesOutput) {
      return [];
    }
    return interfacesOutput.split(/\s+/).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function parseInterfaceSummary(filePath) {
  const summary = { publicKey: '', address: '', type: '' };
  try {
    if (!fs.existsSync(filePath)) {
      return summary;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let section = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith('#')) {
        const commentContent = line.substring(1).trim();
        if (commentContent.toLowerCase().startsWith('type =')) {
          const eqIdx = commentContent.indexOf('=');
          summary.type = commentContent.substring(eqIdx + 1).trim();
        }
        continue;
      }
      if (line === '[Interface]') {
        section = 'interface';
        continue;
      }
      if (line === '[Peer]') {
        break;
      }
      if (section === 'interface' && line.includes('=')) {
        const equalIndex = line.indexOf('=');
        const key = line.substring(0, equalIndex).trim().toLowerCase();
        const value = line.substring(equalIndex + 1).trim();
        if (key === 'address') {
          summary.address = value;
        } else if (key === 'publickey') {
          summary.publicKey = value;
        } else if (key === 'privatekey' && !summary.publicKey) {
          try {
            summary.publicKey = wgPubkey(value);
          } catch (error) {
            // ignore pubkey calculation errors
          }
        }
      }
    }
  } catch (error) {
    console.error('Error parsing interface summary:', error.message);
  }
  return summary;
}

function listInterfaces() {
  if (!fs.existsSync(CONFIG_DIR)) {
    return [];
  }
  const files = fs.readdirSync(CONFIG_DIR)
    .filter((file) => file.endsWith('.conf'))
    .sort();
  const activeSet = new Set(getActiveInterfaces());
  return files.map((file) => {
    const interfaceName = path.basename(file, '.conf');
    const summary = parseInterfaceSummary(path.join(CONFIG_DIR, file));
    return {
      name: interfaceName,
      publicKey: summary.publicKey,
      address: summary.address,
      type: summary.type || '',
      status: activeSet.has(interfaceName) ? 'connected' : 'disconnected'
    };
  });
}

module.exports = {
  getActiveInterfaces,
  parseInterfaceSummary,
  listInterfaces
};
