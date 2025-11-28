const express = require('express');
const router = express.Router();
const { exec } = require('child_process');

// Parse output wg show all → JSON
function parseWG(output) {
    const peers = [];
    let current = null;

    output.split("\n").forEach(line => {
        line = line.trim();

        if (line.startsWith("peer:")) {
            if (current) peers.push(current);
            current = { peer: line.split("peer:")[1].trim() };
        }

        if (line.startsWith("latest handshake:")) {
            current.handshake = line.replace("latest handshake:", "").trim();
        }

        if (line.startsWith("transfer:")) {
            const t = line.replace("transfer:", "").trim();
            const [recv, sent] = t.split(",").map(x => x.trim());

            current.received = recv;
            current.sent = sent;
        }
    });

    if (current) peers.push(current);
    return peers;
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
router.get('/peers', (req, res) => {
    // Get config from app.js (need to access it)
    const app = req.app;
    const config = app.get('config');
    
    if (!config) {
        return res.status(500).json({ error: "Config not available" });
    }
    
    // Get wg show data
    exec("wg show all", (err, stdout, stderr) => {
        if (err) {
            // If wg show fails, return peers from config only
            const peers = config.peers.map((peer, idx) => ({
                id: idx,
                name: peer.name || '',
                publicKey: peer.publicKey || '',
                status: peer.enabled === false ? 'disabled' : 'inactive',
                received: 0,
                sent: 0,
                receivedBytes: 0,
                sentBytes: 0,
                handshake: null,
                endpoint: peer.endpoint || '',
                allowedIPs: peer.allowedIPs || '',
                persistentKeepalive: peer.persistentKeepalive || '',
                presharedKey: peer.presharedKey || ''
            }));
            return res.json(peers);
        }
        
        const wgPeers = parseWG(stdout);
        
        // Combine config peers with wg show data
        const combinedPeers = config.peers.map((peer, idx) => {
            const wgPeer = wgPeers.find(p => p.peer === peer.publicKey);
            const receivedBytes = wgPeer ? convertBytesToNumber(wgPeer.received) : 0;
            const sentBytes = wgPeer ? convertBytesToNumber(wgPeer.sent) : 0;
            const totalBytes = receivedBytes + sentBytes;
            
            return {
                id: idx,
                name: peer.name || '',
                publicKey: peer.publicKey || '',
                status: peer.enabled === false ? 'disabled' : (wgPeer ? 'active' : 'inactive'),
                received: wgPeer ? wgPeer.received : '0 B',
                sent: wgPeer ? wgPeer.sent : '0 B',
                receivedBytes: receivedBytes,
                sentBytes: sentBytes,
                totalBytes: totalBytes,
                handshake: wgPeer ? wgPeer.handshake : null,
                endpoint: peer.endpoint || '',
                allowedIPs: peer.allowedIPs || '',
                persistentKeepalive: peer.persistentKeepalive || '',
                presharedKey: peer.presharedKey || ''
            };
        });
        
        res.json(combinedPeers);
    });
});

// API: /api/dashboard/peer/:id - Get single peer details
router.get('/peer/:id', (req, res) => {
    const app = req.app;
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

module.exports = router;
