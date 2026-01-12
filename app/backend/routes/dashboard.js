const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get peers with config and throughput
router.get('/peers', async (req, res) => {
    const app = req.app;
    
    const interfaceId = req.query.interface;
    
    if (interfaceId) {
        try {
            const { execSync } = require('child_process');
            const path = require('path');
            const fs = require('fs');
            const CONFIG_DIR = '/etc/wireguard/';
            const INTERFACE = decodeURIComponent(interfaceId);
            const CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
            
            // Load config from file for this interface
            if (fs.existsSync(CONFIG_FILE)) {
                const content = fs.readFileSync(CONFIG_FILE, 'utf8');
                const lines = content.split('\n');
                let section = null;
                let currentPeer = null;
                let peerEnabled = true;
                let peerName = '';
                
                const config = {
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
                        keyExpiryDays: 90
                    },
                    peers: []
                };
                
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    
                    const isCommented = trimmed.startsWith('#');
                    const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;
                    if (!cleanLine) continue;
                    
                    if (isCommented && cleanLine.toLowerCase().startsWith('name =')) {
                        const parts = cleanLine.split('=');
                        if (parts.length > 1) {
                            peerName = parts.slice(1).join('=').trim();
                        }
                        continue;
                    }
                    
                    if (cleanLine === '[Interface]') {
                        section = 'interface';
                        peerEnabled = true;
                        peerName = '';
                    } else if (cleanLine === '[Peer]') {
                        section = 'peer';
                        const pendingPeerName = peerName;
                        currentPeer = {
                            name: pendingPeerName || '',
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
                        if (!key) continue;
                        
                        const lowerKey = key.toLowerCase();
                        
                        if (isCommented) {
                            if (lowerKey === 'key creation' && section === 'interface') {
                                config.interface.keyCreationDate = value;
                                continue;
                            }
                            if (lowerKey === 'key expiry days' && section === 'interface') {
                                config.interface.keyExpiryDays = parseInt(value) || 90;
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
                                    const pubKey = execSync(`echo "${value}" | wg pubkey`, { encoding: 'utf8' }).trim();
                                    config.interface.publicKey = pubKey;
                                } catch (e) {
                                    console.error('Error generating public key:', e.message);
                                }
                            }
                        } else if (section === 'peer' && currentPeer) {
                            if (lowerKey === 'publickey') currentPeer.publicKey = value;
                            else if (lowerKey === 'presharedkey') currentPeer.presharedKey = value;
                            else if (lowerKey === 'endpoint') currentPeer.endpoint = value;
                            else if (lowerKey === 'allowedips') currentPeer.allowedIPs = value;
                            else if (lowerKey === 'persistentkeepalive') currentPeer.persistentKeepalive = value;
                            else currentPeer[lowerKey] = value;
                            if (peerEnabled === false) {
                                currentPeer.enabled = false;
                            }
                        }
                    }
                }
                
                app.set('config', config);
            }
        } catch (error) {
            console.error('Error loading interface config:', error);
        }
    }
    
    const config = app.get('config');
    
    if (!config) {
        return res.status(500).json({ error: "Config not available" });
    }
    
    const ifaceName = interfaceId || 'wg0'; 

    // Lấy dữ liệu peers từ log files
    const combinedPeers = config.peers.map((peer, idx) => {
        const peerLogDir = `/etc/wireguard/logs/${ifaceName}/${idx}`;
        const rxBytesFile = path.join(peerLogDir, 'rx_bytes.json');
        const txBytesFile = path.join(peerLogDir, 'tx_bytes.json');
        const handshakeFile = path.join(peerLogDir, 'latest_handshake');
        
        const receivedBytes = getLatestValueFromLog(rxBytesFile);
        const sentBytes = getLatestValueFromLog(txBytesFile);
        const handshakeTime = getLatestHandshake(handshakeFile);
        
        return {
            id: idx,
            name: peer.name || '',
            publicKey: peer.publicKey || '',
            isDisabled: peer.enabled === false, 
            receivedBytes: receivedBytes,
            sentBytes: sentBytes,
            totalBytes: receivedBytes + sentBytes,
            handshake: handshakeTime, // Unix timestamp
            endpoint: peer.endpoint || '',
            allowedIPs: peer.allowedIPs || '',
            persistentKeepalive: peer.persistentKeepalive || ''
        };
    });
    
    res.json(combinedPeers);
});

// Get single peer details
router.get('/peer/:id', async (req, res) => {
    try {
        const app = req.app;
        
        let interfaceId = req.query.interface;
    if (interfaceId) {
        try {
            const { execSync } = require('child_process');
            const path = require('path');
            const fs = require('fs');
            const CONFIG_DIR = '/etc/wireguard/';
            const INTERFACE = decodeURIComponent(interfaceId);
            const CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
            
            if (fs.existsSync(CONFIG_FILE)) {
                const content = fs.readFileSync(CONFIG_FILE, 'utf8');
                const lines = content.split('\n');
                let section = null;
                let currentPeer = null;
                let peerEnabled = true;
                let peerName = '';
                
                const config = {
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
                        keyExpiryDays: 90
                    },
                    peers: []
                };
                
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    
                    const isCommented = trimmed.startsWith('#');
                    const cleanLine = isCommented ? trimmed.substring(1).trim() : trimmed;
                    if (!cleanLine) continue;
                    
                    if (isCommented && cleanLine.toLowerCase().startsWith('name =')) {
                        const parts = cleanLine.split('=');
                        if (parts.length > 1) {
                            peerName = parts.slice(1).join('=').trim();
                        }
                        continue;
                    }
                    
                    if (cleanLine === '[Interface]') {
                        section = 'interface';
                        peerEnabled = true;
                        peerName = '';
                    } else if (cleanLine === '[Peer]') {
                        section = 'peer';
                        const pendingPeerName = peerName;
                        currentPeer = {
                            name: pendingPeerName || '',
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
                        if (!key) continue;
                        
                        const lowerKey = key.toLowerCase();
                        
                        if (isCommented) {
                            if (lowerKey === 'key creation' && section === 'interface') {
                                config.interface.keyCreationDate = value;
                                continue;
                            }
                            if (lowerKey === 'key expiry days' && section === 'interface') {
                                config.interface.keyExpiryDays = parseInt(value) || 90;
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
                                    const pubKey = execSync(`echo "${value}" | wg pubkey`, { encoding: 'utf8' }).trim();
                                    config.interface.publicKey = pubKey;
                                } catch (e) {
                                    console.error('Error generating public key:', e.message);
                                }
                            }
                        } else if (section === 'peer' && currentPeer) {
                            if (lowerKey === 'publickey') currentPeer.publicKey = value;
                            else if (lowerKey === 'presharedkey') currentPeer.presharedKey = value;
                            else if (lowerKey === 'endpoint') currentPeer.endpoint = value;
                            else if (lowerKey === 'allowedips') currentPeer.allowedIPs = value;
                            else if (lowerKey === 'persistentkeepalive') currentPeer.persistentKeepalive = value;
                            else currentPeer[lowerKey] = value;
                            if (peerEnabled === false) {
                                currentPeer.enabled = false;
                            }
                        }
                    }
                }
                
                app.set('config', config);
            }
        } catch (error) {
            console.error('Error loading interface config:', error);
        }
    }
    
    const config = app.get('config');
    
    if (!config) {
        return res.status(500).json({ error: "Config not available" });
    }
    
    const peerId = parseInt(req.params.id);
    if (peerId < 0 || peerId >= config.peers.length) {
        return res.status(404).json({ error: "Peer not found" });
    }
    
    const peer = config.peers[peerId];
    
    const interfaceIdFinal = req.query.interface || 'wg0';
        
    // Read from log files
    const peerLogDir = `/etc/wireguard/logs/${interfaceIdFinal}/${peerId}`;
    const rxBytesFile = path.join(peerLogDir, 'rx_bytes.json');
    const txBytesFile = path.join(peerLogDir, 'tx_bytes.json');
    const handshakeFile = path.join(peerLogDir, 'latest_handshake');
    
    const receivedBytes = getLatestValueFromLog(rxBytesFile);
    const sentBytes = getLatestValueFromLog(txBytesFile);
    const handshakeTimestamp = getLatestHandshake(handshakeFile);
    
    // Determine status based on handshake
    const nowSec = Math.floor(Date.now() / 1000);
    let status = 'inactive';
    if (peer.enabled === false) {
        status = 'disabled';
    } else if (handshakeTimestamp && (nowSec - handshakeTimestamp) < 180) {
        status = 'active';
    }
    
        res.json({
            id: peerId,
            name: peer.name || '',
            publicKey: peer.publicKey || '',
            status: status,
            received: formatBytes(receivedBytes),
            sent: formatBytes(sentBytes),
            receivedBytes: receivedBytes,
            sentBytes: sentBytes,
            totalBytes: receivedBytes + sentBytes,
            handshake: handshakeTimestamp,
            endpoint: peer.endpoint || '',
            allowedIPs: peer.allowedIPs || '',
            persistentKeepalive: peer.persistentKeepalive || '',
            presharedKey: peer.presharedKey || ''
        });
    } catch (error) {
        console.error('Error in peer details API:', error);
        res.status(500).json({ error: 'Failed to load peer details' });
    }
});

// Helper function to get latest value from JSON log file
function getLatestValueFromLog(filePath) {
    try {
        if (!fs.existsSync(filePath)) return 0;
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.trim().split('\n').filter(line => line.trim());
        if (lines.length === 0) return 0;
        const lastLine = lines[lines.length - 1];
        const entry = JSON.parse(lastLine);
        return entry.value || 0;
    } catch (e) {
        console.error(`Error reading ${filePath}:`, e);
        return 0;
    }
}

// Helper function to get latest handshake timestamp
function getLatestHandshake(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        const timestamp = parseInt(content.split('root')[0]);
        return isNaN(timestamp) ? null : timestamp;
    } catch (e) {
        console.error(`Error reading handshake ${filePath}:`, e);
        return null;
    }
}

// Fetch interface data to draw graphs
router.get('/:id/stats', (req, res) => {
    const iface = req.params.id;
    const logDir = `/etc/wireguard/logs/${iface}`;
    
    // Get start and end timestamps from query params (Unix seconds)
    const startTs = req.query.start ? parseInt(req.query.start) * 1000 : null;
    const endTs = req.query.end ? parseInt(req.query.end) * 1000 : null;
    
    // Các loại metric cần đọc
    const metrics = ['rx_bytes', 'tx_bytes', 'rx_dropped', 'tx_dropped'];
    
    // Map để gộp dữ liệu: key là timestamp, value là object chứa các metric
    const dataMap = new Map();

    try {
        metrics.forEach(metric => {
            const filePath = path.join(logDir, `${metric}.json`);
            
            if (fs.existsSync(filePath)) {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const lines = fileContent.trim().split('\n');

                lines.forEach(line => {
                    if (!line.trim()) return;
                    try {
                        const entry = JSON.parse(line);
                        const tsMs = entry.timestamp * 1000; 

                        if (!dataMap.has(tsMs)) {
                            dataMap.set(tsMs, { timestamp: tsMs });
                        }
                        
                        dataMap.get(tsMs)[metric] = entry.value;
                    } catch (e) {
                        console.error(`Error parsing line in ${metric}:`, line);
                    }
                });
            }
        });

        let result = Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp);

        if (startTs !== null) {
            result = result.filter(item => item.timestamp >= startTs);
        }
        if (endTs !== null) {
            result = result.filter(item => item.timestamp <= endTs);
        }

        // Đảm bảo các trường thiếu được điền số 0
        const finalResult = result.map(item => ({
            timestamp: item.timestamp,
            rx_bytes: item.rx_bytes || 0,
            tx_bytes: item.tx_bytes || 0,
            rx_dropped: item.rx_dropped || 0,
            tx_dropped: item.tx_dropped || 0,
            iface
        }));

        res.json(finalResult);

    } catch (error) {
        console.error("Error reading logs:", error);
        res.status(500).json({ error: "Failed to read logs" });
    }
});

// Fetch peer data to draw graphs
router.get('/:interface/peer/:peerId/stats', (req, res) => {
    const interfaceName = req.params.interface;
    const peerId = req.params.peerId;
    const peerLogDir = `/etc/wireguard/logs/${interfaceName}/${peerId}`;
    
    const startTs = req.query.start ? parseInt(req.query.start) * 1000 : null;
    const endTs = req.query.end ? parseInt(req.query.end) * 1000 : null;
    
    // Metrics for peer: rx_bytes and tx_bytes
    const metrics = ['rx_bytes', 'tx_bytes'];
    
    const dataMap = new Map();

    try {
        metrics.forEach(metric => {
            const filePath = path.join(peerLogDir, `${metric}.json`);
            
            if (fs.existsSync(filePath)) {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const lines = fileContent.trim().split('\n');

                lines.forEach(line => {
                    if (!line.trim()) return;
                    try {
                        const entry = JSON.parse(line);
                        const tsMs = entry.timestamp * 1000; 

                        if (!dataMap.has(tsMs)) {
                            dataMap.set(tsMs, { timestamp: tsMs });
                        }
                        
                        dataMap.get(tsMs)[metric] = entry.value;
                    } catch (e) {
                        console.error(`Error parsing line in ${metric}:`, line);
                    }
                });
            }
        });

        let result = Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp);

        if (startTs !== null) {
            result = result.filter(item => item.timestamp >= startTs);
        }
        if (endTs !== null) {
            result = result.filter(item => item.timestamp <= endTs);
        }

        // Đảm bảo các trường thiếu được điền số 0
        const finalResult = result.map(item => ({
            timestamp: item.timestamp,
            rx_bytes: item.rx_bytes || 0,
            tx_bytes: item.tx_bytes || 0
        }));

        res.json(finalResult);

    } catch (error) {
        console.error("Error reading peer logs:", error);
        res.status(500).json({ error: "Failed to read peer logs" });
    }
});

// Fetch peer connections from JSON file
router.get('/:interface/peer/:peerId/connections', (req, res) => {
    const interfaceName = req.params.interface;
    const peerId = req.params.peerId;
    const STATUS_FILE = '/dev/shm/vpn_live_status.json';
    
    try {
        if (!fs.existsSync(STATUS_FILE)) {
            return res.json({
                last_updated: null,
                active_connections_count: 0,
                sessions: []
            });
        }
        
        const fileContent = fs.readFileSync(STATUS_FILE, 'utf-8');
        const data = JSON.parse(fileContent);
        
        // Filter sessions by interface and peer_id
        const filteredSessions = data.sessions.filter(session => {
            return session.interface === interfaceName && session.peer_id === peerId;
        });
        
        res.json({
            last_updated: data.last_updated,
            active_connections_count: filteredSessions.length,
            sessions: filteredSessions
        });
        
    } catch (error) {
        console.error("Error reading connections file:", error);
        res.status(500).json({ error: "Failed to read connections" });
    }
});


module.exports = router;
