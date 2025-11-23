#!/usr/bin/env node

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

const CONFIG_DIR = '/etc/wireguard/';
let INTERFACE = 'wgA';
let CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);

let config = {
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
    postDown: ''
  },
  peers: []
};

app.use(express.json());
app.use(express.static('../frontend'));

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

// Load configuration from file
function loadConfigFromFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      // Reset config if file doesn't exist
      config = {
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
          postDown: ''
        },
        peers: []
      };
      return false;
    }
    
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    const lines = content.split('\n');
    let section = null;
    let currentPeer = null;
    let peerEnabled = true;
    let peerName = '';
    
    // Reset config
    config = {
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
        postDown: ''
      },
      peers: []
    };
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const trimmed = line.trim();
      
      // Skip empty lines
      if (!trimmed) {
        continue;
      }
      
      // Check if line is commented
      const isCommented = trimmed.startsWith('#');
      const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;
      
      // Skip if cleanLine is empty after removing comment
      if (!cleanLine) {
        continue;
      }
      
      if (cleanLine === '[Interface]') {
        section = 'interface';
        peerEnabled = true;
        peerName = '';
      } else if (cleanLine === '[Peer]') {
        section = 'peer';
        currentPeer = {
          name: '',
          publicKey: '',
          presharedKey: '',
          endpoint: '',
          allowedIPs: '',
          persistentKeepalive: '',
          enabled: !isCommented
        };
        peerEnabled = !isCommented;
        peerName = '';
        config.peers.push(currentPeer);
      } else if (cleanLine.includes('=')) {
        const equalIndex = cleanLine.indexOf('=');
        const key = cleanLine.substring(0, equalIndex).trim();
        const value = cleanLine.substring(equalIndex + 1).trim();
        
        // Skip if key is empty
        if (!key) {
          continue;
        }
        
        const lowerKey = key.toLowerCase();
        
        // Check for Name metadata (always in comments)
        if (isCommented && lowerKey === 'name' && section === 'peer' && currentPeer) {
          currentPeer.name = value;
          continue;
        }
        
        if (section === 'interface') {
          // Map lowercase keys to camelCase property names
          let propertyName = lowerKey;
          if (lowerKey === 'listenport') {
            propertyName = 'listenPort';
          } else if (lowerKey === 'preup') {
            propertyName = 'preUp';
          } else if (lowerKey === 'postup') {
            propertyName = 'postUp';
          } else if (lowerKey === 'predown') {
            propertyName = 'preDown';
          } else if (lowerKey === 'postdown') {
            propertyName = 'postDown';
          } else if (lowerKey === 'privatekey') {
            propertyName = 'privateKey';
          } else if (lowerKey === 'publickey') {
            propertyName = 'publicKey';
          }
          
          config.interface[propertyName] = value;
          if (lowerKey === 'privatekey') {
            try {
              const pubKey = run(`echo "${value}" | wg pubkey`).trim();
              config.interface.publicKey = pubKey;
            } catch (e) {
              // Ignore if pubkey generation fails
              console.error('Error generating public key:', e.message);
            }
          }
        } else if (section === 'peer' && currentPeer) {
          // Map common variations of key names
          if (lowerKey === 'publickey') {
            currentPeer.publicKey = value;
          } else if (lowerKey === 'presharedkey') {
            currentPeer.presharedKey = value;
          } else if (lowerKey === 'endpoint') {
            currentPeer.endpoint = value;
          } else if (lowerKey === 'allowedips') {
            currentPeer.allowedIPs = value;
          } else if (lowerKey === 'persistentkeepalive') {
            currentPeer.persistentKeepalive = value;
          } else {
            // Generic assignment for other keys
            currentPeer[lowerKey] = value;
          }
          // Update enabled status based on whether peer section was commented
          if (peerEnabled === false) {
            currentPeer.enabled = false;
          }
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error loading config from file:', error.message);
    return false;
  }
}

// Choose interface
app.post('/api/interface', (req, res) => {
  try {
    INTERFACE = req.body.interface || 'wg0';
    CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
    // Load config when interface changes
    loadConfigFromFile();
    res.json({ success: true, interface: INTERFACE, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current interface
app.get('/api/interface', (req, res) => {
  res.json({ interface: INTERFACE });
});

// Generate keys
app.post('/api/generate-keys', (req, res) => {
  try {
    // Check if private key already exists and is valid
    const hasExistingKey = config.interface.privateKey && config.interface.privateKey.length > 0;
    const forceGenerate = req.body.force === true;
    
    if (hasExistingKey && !forceGenerate) {
      return res.json({ 
        success: false, 
        needConfirmation: true,
        message: 'Private key đã được cấu hình, bạn có chắc bạn muốn đổi key?'
      });
    }
  
    const privateKey = run('wg genkey').trim();
    //run(`echo ${privateKey} >> ${CONFIG_DIR}/${INTERFACE}.key`);
    
    const publicKey = run(`echo "${privateKey}" | wg pubkey`).trim();
    //run(`echo ${publicKey} >> ${CONFIG_DIR}/${INTERFACE}.pub`);
    
    config.interface.privateKey = privateKey;
    config.interface.publicKey = publicKey;
    
    res.json({ 
      success: true, 
      privateKey, 
      publicKey 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Configure interface
app.post('/api/configure-interface', (req, res) => {
  try {
    config.interface.address = req.body.address || '';
    config.interface.listenPort = req.body.listenPort || '51820';
    config.interface.dns = req.body.dns || '';
    config.interface.table = req.body.table || '';
    config.interface.preUp = req.body.preUp || '';
    config.interface.postUp = req.body.postUp || '';
    config.interface.preDown = req.body.preDown || '';
    config.interface.postDown = req.body.postDown || '';
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add peer
app.post('/api/add-peer', (req, res) => {
  try {
    // Check if interface is configured
    if (!config.interface.privateKey || !config.interface.address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Interface not configured. Please configure interface first.' 
      });
    }
    
    const peer = {
      name: req.body.name || '',
      publicKey: req.body.publicKey || '',
      presharedKey: req.body.presharedKey || '',
      endpoint: req.body.endpoint || '',
      allowedIPs: req.body.allowedIPs || '0.0.0.0/0',
      persistentKeepalive: req.body.persistentKeepalive || '25',
      enabled: true // Default enabled
    };
    
    if (req.body.generatePsk) {
      peer.presharedKey = run('wg genpsk').trim();
    }
    
    config.peers.push(peer);
    res.json({ success: true, peer, index: config.peers.length - 1 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Edit peer
app.put('/api/edit-peer/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      const peer = config.peers[idx];
      peer.name = req.body.name !== undefined ? req.body.name : peer.name;
      peer.publicKey = req.body.publicKey !== undefined ? req.body.publicKey : peer.publicKey;
      peer.endpoint = req.body.endpoint !== undefined ? req.body.endpoint : peer.endpoint;
      peer.allowedIPs = req.body.allowedIPs !== undefined ? req.body.allowedIPs : peer.allowedIPs;
      peer.persistentKeepalive = req.body.persistentKeepalive !== undefined ? req.body.persistentKeepalive : peer.persistentKeepalive;
      if (req.body.presharedKey !== undefined) {
        peer.presharedKey = req.body.presharedKey;
      }
      
      res.json({ success: true, peer });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete peer
app.delete('/api/delete-peer/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      config.peers.splice(idx, 1);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enable peer
app.post('/api/enable-peer/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      config.peers[idx].enabled = true;
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disable peer
app.post('/api/disable-peer/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < config.peers.length) {
      config.peers[idx].enabled = false;
      res.json({ success: true, peer: config.peers[idx] });
    } else {
      res.status(404).json({ success: false, error: 'Peer not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// View configuration
app.get('/api/config', (req, res) => {
  res.json({ success: true, config });
});

// Save configuration
app.post('/api/save-config', (req, res) => {
  try {
    if (!config.interface.privateKey || !config.interface.address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields (private key, address)' 
      });
    }
    
    if (config.peers.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No peers configured' 
      });
    }
    
    let content = '[Interface]\n';
    content += `PrivateKey = ${config.interface.privateKey}\n`;
    content += `Address = ${config.interface.address}\n`;
    if (config.interface.dns) content += `DNS = ${config.interface.dns}\n`;
    if (config.interface.listenPort) content += `ListenPort = ${config.interface.listenPort}\n`;
    if (config.interface.mtu) content += `MTU = ${config.interface.mtu}\n`;
    if (config.interface.preUp) content += `PreUp = ${config.interface.preUp}\n`;
    if (config.interface.postUp) content += `PostUp = ${config.interface.postUp}\n`;
    if (config.interface.preDown) content += `PreDown = ${config.interface.preDown}\n`;
    if (config.interface.postDown) content += `PostDown = ${config.interface.postDown}\n`;
    
    config.peers.forEach(peer => {
      const isDisabled = peer.enabled === false;
      content += '\n';
      
      // Add name as comment if exists
      if (peer.name) {
        content += `# Name = ${peer.name}\n`;
      }
      
      if (isDisabled) {
        content += '# [Peer]\n';
      } else {
        content += '[Peer]\n';
      }
      
      const prefix = isDisabled ? '# ' : '';
      content += `${prefix}PublicKey = ${peer.publicKey}\n`;
      if (peer.presharedKey) content += `${prefix}PresharedKey = ${peer.presharedKey}\n`;
      content += `${prefix}Endpoint = ${peer.endpoint}\n`;
      content += `${prefix}AllowedIPs = ${peer.allowedIPs}\n`;
      if (peer.persistentKeepalive) content += `${prefix}PersistentKeepalive = ${peer.persistentKeepalive}\n`;
    });
    
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    
    fs.writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
    
    res.json({ success: true, content });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Connect VPN
app.post('/api/connect', (req, res) => {
  try {
    try {
      const status = run('wg show interfaces');
      if (status.includes(INTERFACE)) {
        return res.status(400).json({ 
          success: false, 
          error: 'VPN already connected' 
        });
      }
    } catch (e) {}
    
    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(404).json({ 
        success: false, 
        error: 'Config file not found. Save configuration first.' 
      });
    }
    
    run(`wg-quick up ${INTERFACE}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect VPN
app.post('/api/disconnect', (req, res) => {
  try {
    run(`wg-quick down ${INTERFACE}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check root
if (process.getuid && process.getuid() !== 0) {
  console.error('[ERROR] This program requires root privileges');
  process.exit(1);
}

app.listen(PORT, () => {
  // Load config from file on startup
  loadConfigFromFile();
  console.log(`WireGuard VPN Manager running on http://localhost:${PORT}`);
});