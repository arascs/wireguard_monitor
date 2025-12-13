// Format bytes to human readable
function formatBytes(bytes) {
    if (!bytes || bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format duration from seconds to human readable
function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0s';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// Format datetime string to readable format
function formatDateTime(dateTimeStr) {
    if (!dateTimeStr) return 'N/A';
    try {
        const date = new Date(dateTimeStr);
        return date.toLocaleString();
    } catch (e) {
        return dateTimeStr;
    }
}

// Get interface ID and peer ID from URL
function getIdsFromUrl() {
    const path = window.location.pathname;
    // Try pattern /dashboard/:id/peer/:peer_id first
    const matchWithInterface = path.match(/\/dashboard\/([^\/]+)\/peer\/(\d+)/);
    if (matchWithInterface) {
        return {
            interfaceId: decodeURIComponent(matchWithInterface[1]),
            peerId: parseInt(matchWithInterface[2])
        };
    }
    // Fallback to pattern /dashboard/peer/:id
    const match = path.match(/\/dashboard\/peer\/(\d+)/);
    return match ? { interfaceId: null, peerId: parseInt(match[1]) } : { interfaceId: null, peerId: null };
}

// Set interface before loading peer details
async function setInterface(interfaceName) {
    try {
        const response = await fetch('/api/interface', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interface: interfaceName })
        });
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('Error setting interface:', error);
        return false;
    }
}

// Load peer details
async function loadPeerDetails() {
    const { interfaceId, peerId } = getIdsFromUrl();
    console.log('Loading peer details for interface:', interfaceId, 'peer ID:', peerId);
    
    if (peerId === null) {
        document.getElementById('peer-detail-content').innerHTML = 
            '<div class="error">Invalid peer ID</div>';
        return;
    }
    
    // Set interface if interfaceId is provided
    if (interfaceId) {
        const success = await setInterface(interfaceId);
        if (!success) {
            document.getElementById('peer-detail-content').innerHTML = 
                '<div class="error">Error setting interface: ' + interfaceId + '</div>';
            return;
        }
    }
    
    try {
        const url = interfaceId 
            ? `/api/dashboard/peer/${peerId}?interface=${encodeURIComponent(interfaceId)}`
            : `/api/dashboard/peer/${peerId}`;
        console.log('Fetching from:', url);
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to load peer details' }));
            document.getElementById('peer-detail-content').innerHTML = 
                `<div class="error">Error: ${errorData.error || 'Failed to load peer details'}</div>`;
            return;
        }
        
        const peer = await response.json();
        console.log('Peer data received:', peer);
        
        if (peer.error) {
            document.getElementById('peer-detail-content').innerHTML = 
                `<div class="error">Error: ${peer.error}</div>`;
            return;
        }
        
        // Ensure all values are defined
        const receivedBytes = peer.receivedBytes || 0;
        const sentBytes = peer.sentBytes || 0;
        const totalBytes = peer.totalBytes || (receivedBytes + sentBytes);
        console.log('Processed bytes:', { receivedBytes, sentBytes, totalBytes });
        
        const receivedFormatted = formatBytes(receivedBytes);
        const sentFormatted = formatBytes(sentBytes);
        const totalFormatted = formatBytes(totalBytes);
        
        const content = `
            <div class="peer-header">
                <div class="peer-name">${peer.name || `Peer ${peer.id}`}</div>
                <div class="peer-status ${peer.status}">${peer.status.toUpperCase()}</div>
            </div>
            
            <div class="detail-section">
                <h3>Connection Information</h3>
                <div class="detail-grid">
                    <div class="detail-item">
                        <strong>Public Key</strong>
                        <span class="value">${peer.publicKey || 'Not set'}</span>
                    </div>
                    <div class="detail-item">
                        <strong>Endpoint</strong>
                        <span>${peer.endpoint || 'Not set'}</span>
                    </div>
                    <div class="detail-item">
                        <strong>Allowed IPs</strong>
                        <span>${peer.allowedIPs || 'Not set'}</span>
                    </div>
                    <div class="detail-item">
                        <strong>Persistent Keepalive</strong>
                        <span>${peer.persistentKeepalive || 'Not set'}</span>
                    </div>
                    ${peer.handshake ? `
                    <div class="detail-item">
                        <strong>Latest Handshake</strong>
                        <span>${peer.handshake}</span>
                    </div>
                    ` : ''}
                </div>
            </div>
            
            <div class="detail-section">
                <h3>Throughput Statistics</h3>
                <div class="throughput-section">
                    <div class="throughput-grid">
                        <div class="throughput-item">
                            <strong>Received</strong>
                            <div class="value">${receivedFormatted}</div>
                            <div style="font-size: 0.85em; color: #666; margin-top: 5px;">${peer.received}</div>
                        </div>
                        <div class="throughput-item">
                            <strong>Sent</strong>
                            <div class="value">${sentFormatted}</div>
                            <div style="font-size: 0.85em; color: #666; margin-top: 5px;">${peer.sent}</div>
                        </div>
                        <div class="throughput-item">
                            <strong>Total</strong>
                            <div class="value">${totalFormatted}</div>
                            <div style="font-size: 0.85em; color: #666; margin-top: 5px;">Total Transfer</div>
                        </div>
                    </div>
                </div>
            </div>
            
            ${peer.presharedKey ? `
            <div class="detail-section">
                <h3>Security</h3>
                <div class="detail-grid">
                    <div class="detail-item">
                        <strong>Preshared Key</strong>
                        <span>***${peer.presharedKey.slice(-8)}</span>
                    </div>
                </div>
            </div>
            ` : ''}
        `;
        
        console.log('Rendering content...');
        document.getElementById('peer-detail-content').innerHTML = content;
        console.log('Content rendered successfully');
        
        // Load connections after peer details are loaded
        if (interfaceId) {
            loadPeerConnections(interfaceId, peerId);
        }
    } catch (error) {
        console.error('Error loading peer details:', error);
        document.getElementById('peer-detail-content').innerHTML = 
            '<div class="error">Error loading peer details: ' + error.message + '</div>';
    }
}

// Load peer connections from JSON file
async function loadPeerConnections(interfaceId, peerId) {
    try {
        const url = `/api/dashboard/${encodeURIComponent(interfaceId)}/peer/${peerId}/connections`;
        console.log('Fetching connections from:', url);
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error('Failed to load connections');
            return;
        }
        
        const data = await response.json();
        console.log('Connections data received:', data);
        
        // Find the connections section or create it
        let connectionsSection = document.getElementById('connections-section');
        if (!connectionsSection) {
            // Create connections section after throughput section
            const peerDetailContent = document.getElementById('peer-detail-content');
            connectionsSection = document.createElement('div');
            connectionsSection.id = 'connections-section';
            connectionsSection.className = 'detail-section';
            peerDetailContent.appendChild(connectionsSection);
        }
        
        // Build connections table
        let tableHTML = `
            <h3>Active Connections</h3>
            <div style="margin-bottom: 10px; font-size: 0.9em; color: #666;">
                Last updated: ${data.last_updated ? formatDateTime(data.last_updated) : 'N/A'} | 
                Active connections: ${data.active_connections_count || 0}
            </div>
        `;
        
        if (data.sessions && data.sessions.length > 0) {
            tableHTML += `
                <table style="width: 100%; border-collapse: collapse; border: 1px solid #000;">
                    <thead>
                        <tr style="background-color: #f0f0f0;">
                            <th style="padding: 10px; border: 1px solid #000; text-align: center;">Source</th>
                            <th style="padding: 10px; border: 1px solid #000; text-align: center;">Service</th>
                            <th style="padding: 10px; border: 1px solid #000; text-align: center;">Start Time</th>
                            <th style="padding: 10px; border: 1px solid #000; text-align: center;">Duration</th>
                            <th style="padding: 10px; border: 1px solid #000; text-align: center;">Bytes</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            data.sessions.forEach(session => {
                tableHTML += `
                    <tr>
                        <td style="padding: 10px; border: 1px solid #000;">${session.source || 'N/A'}</td>
                        <td style="padding: 10px; border: 1px solid #000;">${session.service || 'N/A'}</td>
                        <td style="padding: 10px; border: 1px solid #000;">${formatDateTime(session.start_time)}</td>
                        <td style="padding: 10px; border: 1px solid #000;">${formatDuration(session.duration_sec)}</td>
                        <td style="padding: 10px; border: 1px solid #000;">${formatBytes(session.bytes || 0)}</td>
                    </tr>
                `;
            });
            
            tableHTML += `
                    </tbody>
                </table>
            `;
        } else {
            tableHTML += '<div style="padding: 20px; text-align: center; color: #666;">No active connections</div>';
        }
        
        connectionsSection.innerHTML = tableHTML;
        
    } catch (error) {
        console.error('Error loading peer connections:', error);
    }
}

// Function to initialize
function initPeerDetail() {
    console.log('Initializing peer detail page...');
    
    // Check if DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            console.log('DOMContentLoaded fired');
            loadPeerDetails();
        });
    } else {
        // DOM is already ready
        console.log('DOM already ready');
        loadPeerDetails();
    }
    
    // Also set up window.onload as backup
    window.onload = function() {
        console.log('window.onload fired');
        loadPeerDetails();
    };
    
    // Set up auto-refresh
    setInterval(() => {
        const { interfaceId, peerId } = getIdsFromUrl();
        loadPeerDetails();
        if (interfaceId && peerId !== null) {
            loadPeerConnections(interfaceId, peerId);
        }
    }, 30000);
}

// Start initialization immediately
try {
    initPeerDetail();
} catch (error) {
    console.error('Error initializing peer detail:', error);
    const contentDiv = document.getElementById('peer-detail-content');
    if (contentDiv) {
        contentDiv.innerHTML = '<div class="error">Error initializing page: ' + error.message + '</div>';
    }
}

