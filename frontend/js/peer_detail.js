// Format bytes to human readable
function formatBytes(bytes) {
    if (!bytes || bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get peer ID from URL
function getPeerIdFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/\/dashboard\/peer\/(\d+)/);
    return match ? parseInt(match[1]) : null;
}

// Load peer details
async function loadPeerDetails() {
    const peerId = getPeerIdFromUrl();
    console.log('Loading peer details for ID:', peerId);
    
    if (peerId === null) {
        document.getElementById('peer-detail-content').innerHTML = 
            '<div class="error">Invalid peer ID</div>';
        return;
    }
    
    try {
        console.log('Fetching from:', `/api/dashboard/peer/${peerId}`);
        const response = await fetch(`/api/dashboard/peer/${peerId}`);
        
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
    } catch (error) {
        console.error('Error loading peer details:', error);
        document.getElementById('peer-detail-content').innerHTML = 
            '<div class="error">Error loading peer details: ' + error.message + '</div>';
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
    setInterval(loadPeerDetails, 30000);
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

