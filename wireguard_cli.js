#!/usr/bin/env node

const readline = require('readline-sync');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = '/etc/wireguard/test/';
INTERFACE = 'wg0';
CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);

// Config object
let config = {
  interface: {
    privateKey: '',
    publicKey: '',
    address: '',
    dns: '',
    listenPort: '',
    mtu: '1420'
  },
  peers: []
};

// Helper functions
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

function print(msg) {
  console.log(msg);
}

function input(prompt, defaultValue = '') {
  const value = readline.question(prompt + (defaultValue ? ` [${defaultValue}]` : '') + ': ');
  return value.trim() || defaultValue;
}

function confirm(prompt) {
  const answer = readline.question(prompt + ' (y/n): ');
  return answer.toLowerCase() === 'y';
}

function clearScreen() {
  console.clear();
}

function pause() {
  readline.question('\nPress Enter to continue...');
}

// Menu functions
function showMenu() {
  clearScreen();
  print('=== WireGuard VPN Manager ===\n');
  print('a. Choose interface');
  print('1. Generate Keys');
  print('2. Configure Interface');
  print('3. Add/Edit Peer');
  print('4. View Configuration');
  print('5. Save Configuration');
  print('6. Load Configuration');
  print('7. Connect VPN');
  print('8. Disconnect VPN');
  print('9. Check Status');
  print('0. Exit\n');
}

function generateKeys() {
  clearScreen();
  print('=== Generate Keys ===\n');
  
  try {
    print('Generating private key...');
    const privateKey = run('wg genkey').trim();
    run(`echo ${privateKey} >> ${CONFIG_DIR}/${INTERFACE}.key`)
    
    print('Generating public key...');
    const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
    run(`echo ${publicKey} >> ${CONFIG_DIR}/${INTERFACE}.pub`)
    
    config.interface.privateKey = privateKey;
    config.interface.publicKey = publicKey;
    
    print('\n[SUCCESS] Keys generated!');
    print(`Private Key: ${privateKey}`);
    print(`Public Key: ${publicKey}`);
  } catch (error) {
    print(`\n[ERROR] ${error.message}`);
  }
  
  pause();
}

function configureInterface() {
  clearScreen();
  print(`=== Configure Interface ${INTERFACE}===\n`);
  
  if (!config.interface.privateKey) {
    print('[WARNING] No private key found. Generate keys first!\n');
  }
  
  config.interface.address = input('Address (e.g. 10.0.0.2/24)', config.interface.address);
  config.interface.listenPort = input('Listen Port (leave empty for auto port 51000)', config.interface.listenPort);
  
  print('\n[SUCCESS] Interface configured!');
  pause();
}

function addPeer() {
  clearScreen();
  print('=== Add/Edit Peer ===\n');
  
  if (config.peers.length > 0) {
    print('Current peers:');
    config.peers.forEach((peer, idx) => {
      print(`${idx + 1}. ${peer.endpoint || 'No endpoint'}`);
    });
    print();
    
    const action = input('(n)ew peer or (e)dit existing', 'n');
    
    if (action === 'e') {
      const idx = parseInt(input('Peer number')) - 1;
      if (idx >= 0 && idx < config.peers.length) {
        editPeer(idx);
        return;
      }
    }
  }
  
  // Add new peer
  const peer = {
    publicKey: '',
    presharedKey: '',
    endpoint: '',
    allowedIPs: '',
    persistentKeepalive: ''
  };
  
  peer.publicKey = input('Peer Public Key');
  peer.endpoint = input('Endpoint (IP)', '');
  peer.allowedIPs = input('Allowed IPs', '0.0.0.0/0');
  peer.persistentKeepalive = input('Persistent Keepalive (seconds)', '25');
  
  if (confirm('Add preshared key?')) {
    try {
      peer.presharedKey = run('wg genpsk').trim();
      print(`PSK generated: ${peer.presharedKey.substring(0, 20)}...`);
    } catch (error) {
      print(`[ERROR] ${error.message}`);
    }
  }
  
  config.peers.push(peer);
  print('\n[SUCCESS] Peer added!');
  pause();
}

function editPeer(idx) {
  const peer = config.peers[idx];
  
  print(`\nEditing peer ${idx + 1}:`);
  peer.publicKey = input('Peer Public Key', peer.publicKey);
  peer.endpoint = input('Endpoint (IP)', peer.endpoint);
  peer.allowedIPs = input('Allowed IPs', peer.allowedIPs);
  peer.persistentKeepalive = input('Persistent Keepalive', peer.persistentKeepalive);
  
  print('\n[SUCCESS] Peer updated!');
}

function viewConfig() {
  clearScreen();
  print('=== Current Configuration ===\n');
  
  print('[Interface]');
  print('PostUp = wg set %i private-key /etc/wireguard/%i.key')
  print(`PublicKey = ${config.interface.publicKey || 'NOT SET'}`);
  print(`Address = ${config.interface.address || 'NOT SET'}`);
  
  config.peers.forEach((peer, idx) => {
    print(`\n[Peer ${idx + 1}]`);
    print(`PublicKey = ${peer.publicKey || 'NOT SET'}`);
    if (peer.presharedKey) print(`PresharedKey = ***${peer.presharedKey.slice(-8)}`);
    print(`Endpoint = ${peer.endpoint || 'NOT SET'}`);
    print(`AllowedIPs = ${peer.allowedIPs || 'NOT SET'}`);
    if (peer.persistentKeepalive) print(`PersistentKeepalive = ${peer.persistentKeepalive}`);
  });
  
  pause();
}

function generateConfigContent() {
  let content = '[Interface]\n';
  content += `PrivateKey = ${config.interface.privateKey}\n`;
  content += `Address = ${config.interface.address}\n`;
  if (config.interface.dns) content += `DNS = ${config.interface.dns}\n`;
  if (config.interface.listenPort) content += `ListenPort = ${config.interface.listenPort}\n`;
  if (config.interface.mtu) content += `MTU = ${config.interface.mtu}\n`;
  
  config.peers.forEach(peer => {
    content += '\n[Peer]\n';
    content += `PublicKey = ${peer.publicKey}\n`;
    if (peer.presharedKey) content += `PresharedKey = ${peer.presharedKey}\n`;
    content += `Endpoint = ${peer.endpoint}\n`;
    content += `AllowedIPs = ${peer.allowedIPs}\n`;
    if (peer.persistentKeepalive) content += `PersistentKeepalive = ${peer.persistentKeepalive}\n`;
  });
  
  return content;
}

function saveConfig() {
  clearScreen();
  print('=== Save Configuration ===\n');
  
  if (!config.interface.privateKey || !config.interface.address) {
    print('[ERROR] Missing required fields (private key, address)');
    pause();
    return;
  }
  
  if (config.peers.length === 0) {
    print('[ERROR] No peers configured');
    pause();
    return;
  }
  
  try {
    const content = generateConfigContent();
    
    print('Configuration to save:');
    print('---');
    print(content);
    print('---\n');
    
    if (!confirm(`Save to ${CONFIG_FILE}?`)) {
      print('Cancelled.');
      pause();
      return;
    }
    
    // Create directory if not exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    
    fs.writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
    
    print(`\n[SUCCESS] Configuration saved to ${CONFIG_FILE}`);
  } catch (error) {
    print(`\n[ERROR] ${error.message}`);
  }
  
  pause();
}

function loadConfig() {
  clearScreen();
  print('=== Load Configuration ===\n');
  
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      print(`[ERROR] Config file not found: ${CONFIG_FILE}`);
      pause();
      return;
    }
    
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    print('Current config file:');
    print('---');
    print(content);
    print('---\n');
    
    if (!confirm('Load this configuration?')) {
      print('Cancelled.');
      pause();
      return;
    }
    
    // Parse config
    const lines = content.split('\n');
    let section = null;
    let currentPeer = null;
    
    config.peers = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed === '[Interface]') {
        section = 'interface';
      } else if (trimmed === '[Peer]') {
        section = 'peer';
        currentPeer = {
          publicKey: '',
          presharedKey: '',
          endpoint: '',
          allowedIPs: '',
          persistentKeepalive: ''
        };
        config.peers.push(currentPeer);
      } else if (trimmed.includes('=')) {
        const [key, value] = trimmed.split('=').map(s => s.trim());
        const lowerKey = key.charAt(0).toLowerCase() + key.slice(1);
        
        if (section === 'interface') {
          config.interface[lowerKey] = value;
          if (lowerKey === 'privateKey') {
            // Generate public key from private key
            try {
              const pubKey = run(`echo "${value}" | wg pubkey`).trim();
              config.interface.publicKey = pubKey;
            } catch (e) {}
          }
        } else if (section === 'peer' && currentPeer) {
          currentPeer[lowerKey] = value;
        }
      }
    }
    
    print('\n[SUCCESS] Configuration loaded!');
  } catch (error) {
    print(`\n[ERROR] ${error.message}`);
  }
  
  pause();
}

function connectVPN() {
  clearScreen();
  print('=== Connect VPN ===\n');
  
  try {
    // Check if already connected
    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        print('[WARNING] VPN already connected');
        pause();
        return;
      }
    } catch (e) {}
    
    if (!fs.existsSync(CONFIG_FILE)) {
      print('[ERROR] Config file not found. Save configuration first.');
      pause();
      return;
    }
    
    print('Connecting...');
    run(`wg-quick up ${INTERFACE}`);
    
    print('\n[SUCCESS] VPN connected!');
  } catch (error) {
    print(`\n[ERROR] ${error.message}`);
  }
  
  pause();
}

function disconnectVPN() {
  clearScreen();
  print('=== Disconnect VPN ===\n');
  
  try {
    print('Disconnecting...');
    run(`wg-quick down ${INTERFACE}`);
    
    print('\n[SUCCESS] VPN disconnected!');
  } catch (error) {
    print(`\n[ERROR] ${error.message}`);
  }
  
  pause();
}

function checkStatus() {
  clearScreen();
  print('=== VPN Status ===\n');
  
  try {
    const interfaces = run('wg show interfaces').trim();
    
    if (!interfaces || !interfaces.includes(INTERFACE)) {
      print('[STATUS] VPN is DISCONNECTED\n');
    } else {
      print('[STATUS] VPN is CONNECTED\n');
      print('Details:');
      print('---');
      const status = run(`wg show ${INTERFACE}`);
      print(status);
      print('---');
    }
  } catch (error) {
    print(`[ERROR] ${error.message}`);
  }
  
  pause();
}

function chooseInterface() {
    INTERFACE = input('Choose interface to config: ', INTERFACE)
}

// Main loop
function main() {
  // Check root
  if (process.getuid && process.getuid() !== 0) {
    console.error('[ERROR] This program requires root privileges');
    process.exit(1);
  }
  
  while (true) {
    showMenu();
    print(`Current interface: ${INTERFACE}`)
    const choice = readline.question('Choose option: ');
    
    switch (choice) {
      case 'a': chooseInterface(); break;
      case '1': generateKeys(); break;
      case '2': configureInterface(); break;
      case '3': addPeer(); break;
      case '4': viewConfig(); break;
      case '5': saveConfig(); break;
      case '6': loadConfig(); break;
      case '7': connectVPN(); break;
      case '8': disconnectVPN(); break;
      case '9': checkStatus(); break;
      case '0':
        print('\Wireguard CLI exit.');
        process.exit(0);
      default:
        print('\n[ERROR] Invalid option');
        pause();
    }
  }
}

main();
