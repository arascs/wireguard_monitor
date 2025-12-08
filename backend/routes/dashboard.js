const express = require('express');
const router = express.Router();
const { exec } = require('child_process');

// Parse output wg show all → JSON
function parseWGDump(output) {
    const peersData = {};
    const lines = output.trim().split('\n');
    lines.forEach(line => {
        const parts = line.split('\t');
        if (parts.length >= 8) {
            peersData[parts[0]] = { // Key là PublicKey
                publicKey: parts[0],
                presharedKey: parts[1],
                endpoint: parts[2],
                allowedIPs: parts[3],
                handshake: parseInt(parts[4]), // Timestamp (seconds)
                received: parseInt(parts[5]),  // Bytes
                sent: parseInt(parts[6]),      // Bytes
                persistentKeepalive: parts[7]
            };
        }
    });
    return peersData;
}

// Convert bytes string to number (e.g., "1.5 MiB" -> bytes)
function convertBytesToNumber(bytesStr) {
    if (!bytesStr) return 0;
    const num = parseFloat(bytesStr);
    if (bytesStr.includes("KiB")) return num * 1024;
    if (bytesStr.includes("MiB")) return num * 1024 * 1024;
    if (bytesStr.includes("GiB")) return num * 1024 * 1024 * 1024;
    if (bytesStr.includes("B") && !bytesStr.includes("KiB") && !bytesStr.includes("MiB") && !bytesStr.includes("GiB")) {
        return num;
    }
    return 0;
}

// API: /api/dashboard/wg
router.get('/wg', (req, res) => {
    exec("wg show all", (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: "Cannot run wg" });
        res.json(parseWG(stdout));
    });
});

// API: /api/dashboard/peers - Get peers with config and throughput
router.get('/peers', async (req, res) => {
    const app = req.app;
    
    // Get interface ID from query parameter
    const interfaceId = req.query.interface;
    
    // If interface ID is provided, set it first
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
                
                // Update shared config
                app.set('config', config);
            }
        } catch (error) {
            console.error('Error loading interface config:', error);
        }
    }
    
    // Get config from app.js (need to access it)
    const config = app.get('config');
    
    if (!config) {
        return res.status(500).json({ error: "Config not available" });
    }
    
    const ifaceName = interfaceId || 'wg0'; 

    // SỬA: Dùng 'dump' thay vì 'all'
    exec(`wg show ${ifaceName} dump`, (err, stdout, stderr) => {
        const wgPeersMap = err ? {} : parseWGDump(stdout);

        const combinedPeers = config.peers.map((peer, idx) => {
            const wgData = wgPeersMap[peer.publicKey];
            
            const receivedBytes = wgData ? wgData.received : 0;
            const sentBytes = wgData ? wgData.sent : 0;
            const handshakeTime = wgData ? wgData.handshake : 0;

            return {
                id: idx,
                name: peer.name || '',
                publicKey: peer.publicKey || '',
                // Chỉ gửi dữ liệu thô về client, client sẽ tự tính active/inactive
                isDisabled: peer.enabled === false, 
                receivedBytes: receivedBytes,
                sentBytes: sentBytes,
                totalBytes: receivedBytes + sentBytes,
                handshake: handshakeTime, // Quan trọng: Đây là số giây (Unix timestamp)
                endpoint: peer.endpoint || (wgData ? wgData.endpoint : ''),
                allowedIPs: peer.allowedIPs || '',
                persistentKeepalive: peer.persistentKeepalive || ''
            };
        });
        
        res.json(combinedPeers);
    });
});

// API: /api/dashboard/peer/:id - Get single peer details
router.get('/peer/:id', async (req, res) => {
    const app = req.app;
    
    // Get interface ID from query parameter
    const interfaceId = req.query.interface;
    
    // If interface ID is provided, set it first (same logic as /peers)
    if (interfaceId) {
        try {
            const { execSync } = require('child_process');
            const path = require('path');
            const fs = require('fs');
            const CONFIG_DIR = '/etc/wireguard/';
            const INTERFACE = decodeURIComponent(interfaceId);
            const CONFIG_FILE = path.join(CONFIG_DIR, `${INTERFACE}.conf`);
            
            // Load config from file for this interface (same parsing logic as /peers)
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
                
                // Update shared config
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
    
    // Get wg show data for this peer
    exec("wg show all", (err, stdout, stderr) => {
        if (err) {
            return res.json({
                id: peerId,
                name: peer.name || '',
                publicKey: peer.publicKey || '',
                status: peer.enabled === false ? 'disabled' : 'inactive',
                received: '0 B',
                sent: '0 B',
                receivedBytes: 0,
                sentBytes: 0,
                totalBytes: 0,
                handshake: null,
                endpoint: peer.endpoint || '',
                allowedIPs: peer.allowedIPs || '',
                persistentKeepalive: peer.persistentKeepalive || '',
                presharedKey: peer.presharedKey || ''
            });
        }
        
        const wgPeers = parseWG(stdout);
        const wgPeer = wgPeers.find(p => p.peer === peer.publicKey);
        const receivedBytes = wgPeer ? convertBytesToNumber(wgPeer.received) : 0;
        const sentBytes = wgPeer ? convertBytesToNumber(wgPeer.sent) : 0;
        
        res.json({
            id: peerId,
            name: peer.name || '',
            publicKey: peer.publicKey || '',
            status: peer.enabled === false ? 'disabled' : (wgPeer ? 'active' : 'inactive'),
            received: wgPeer ? wgPeer.received : '0 B',
            sent: wgPeer ? wgPeer.sent : '0 B',
            receivedBytes: receivedBytes,
            sentBytes: sentBytes,
            totalBytes: receivedBytes + sentBytes,
            handshake: wgPeer ? wgPeer.handshake : null,
            endpoint: peer.endpoint || '',
            allowedIPs: peer.allowedIPs || '',
            persistentKeepalive: peer.persistentKeepalive || '',
            presharedKey: peer.presharedKey || ''
        });
    });
});

const fs = require('fs');
const path = require('path');

function readInt(filePath) {
    try {
        return parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    } catch (err) {
        console.error("Error reading", filePath, err);
        return 0;
    }
}

// API: GET /api/dashboard/:iface/stats
// API to fetch interface data to draw graphs
router.get('/:id/stats', (req, res) => {
    const iface = req.params.id;
    const logDir = `/etc/wireguard/logs/${iface}`;
    
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
                        // Convert timestamp từ giây (Unix epoch) sang mili-giây (JS Date)
                        const tsMs = entry.timestamp * 1000; 

                        if (!dataMap.has(tsMs)) {
                            dataMap.set(tsMs, { timestamp: tsMs });
                        }
                        
                        // Gán giá trị metric vào object tại timestamp đó
                        dataMap.get(tsMs)[metric] = entry.value;
                    } catch (e) {
                        console.error(`Error parsing line in ${metric}:`, line);
                    }
                });
            }
        });

        // Chuyển Map thành Array và sắp xếp theo thời gian
        const result = Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp);

        // Đảm bảo các trường thiếu được điền số 0 (nếu cần thiết để vẽ biểu đồ mượt hơn)
        const finalResult = result.map(item => ({
            timestamp: item.timestamp,
            rx_bytes: item.rx_bytes,
            tx_bytes: item.tx_bytes,
            rx_dropped: item.rx_dropped,
            tx_dropped: item.tx_dropped,
            iface // Giữ lại field này nếu frontend cần
        }));

        res.json(finalResult);

    } catch (error) {
        console.error("Error reading logs:", error);
        res.status(500).json({ error: "Failed to read logs" });
    }
});


module.exports = router;
