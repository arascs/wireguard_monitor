// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get interface ID from URL
function getInterfaceIdFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/\/dashboard\/([^\/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

// Set interface before loading data
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

// Load interface information
async function loadInterfaceInfo() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        
        if (data.success && data.config) {
            const interface = data.config.interface;
            const interfaceInfo = document.getElementById('interface-info');
            
            interfaceInfo.innerHTML = `
                <div class="interface-info-grid">
                    <div class="info-item">
                        <strong>Public Key</strong>
                        <span>${interface.publicKey || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>Address</strong>
                        <span>${interface.address || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>Listen Port</strong>
                        <span>${interface.listenPort || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>DNS</strong>
                        <span>${interface.dns || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>MTU</strong>
                        <span>${interface.mtu || 'Not set'}</span>
                    </div>
                    ${interface.preUp ? `
                    <div class="info-item">
                        <strong>PreUp</strong>
                        <span>${interface.preUp}</span>
                    </div>
                    ` : ''}
                    ${interface.postUp ? `
                    <div class="info-item">
                        <strong>PostUp</strong>
                        <span>${interface.postUp}</span>
                    </div>
                    ` : ''}
                    ${interface.preDown ? `
                    <div class="info-item">
                        <strong>PreDown</strong>
                        <span>${interface.preDown}</span>
                    </div>
                    ` : ''}
                    ${interface.postDown ? `
                    <div class="info-item">
                        <strong>PostDown</strong>
                        <span>${interface.postDown}</span>
                    </div>
                    ` : ''}
                </div>
            `;
        } else {
            document.getElementById('interface-info').innerHTML = 
                '<div class="error">Error loading interface information</div>';
        }
    } catch (error) {
        console.error('Error loading interface info:', error);
        document.getElementById('interface-info').innerHTML = 
            '<div class="error">Error loading interface information: ' + error.message + '</div>';
    }
}

// Load peers list
async function loadPeers() {
    try {
        const interfaceId = getInterfaceIdFromUrl();
        const url = interfaceId ? `/api/dashboard/peers?interface=${encodeURIComponent(interfaceId)}` : '/api/dashboard/peers';
        const response = await fetch(url);
        const data = await response.json();
        
        const peersContainer = document.getElementById('peers-container');
        
        if (!Array.isArray(data)) {
            peersContainer.innerHTML = '<div class="error">Error loading peers: Invalid response</div>';
            return;
        }
        
        if (data.length === 0) {
            peersContainer.innerHTML = '<p>No peers configured.</p>';
            return;
        }
        
        peersContainer.innerHTML = '<div class="peers-grid"></div>';
        const peersGrid = peersContainer.querySelector('.peers-grid');
        
        data.forEach(peer => {
            const peerCard = document.createElement('div');
            peerCard.className = `peer-card ${peer.status}`;
            peerCard.onclick = () => {
                const interfaceId = getInterfaceIdFromUrl();
                if (interfaceId) {
                    window.location.href = `/dashboard/${encodeURIComponent(interfaceId)}/peer/${peer.id}`;
                } else {
                    window.location.href = `/dashboard/peer/${peer.id}`;
                }
            };
            
            const receivedFormatted = formatBytes(peer.receivedBytes);
            const sentFormatted = formatBytes(peer.sentBytes);
            const totalFormatted = formatBytes(peer.totalBytes);
            
            peerCard.innerHTML = `
                <div class="peer-name">${peer.name || `Peer ${peer.id}`}</div>
                <div class="peer-public-key">${peer.publicKey || 'No public key'}</div>
                <div class="peer-status ${peer.status}">${peer.status.toUpperCase()}</div>
                <div class="peer-throughput">
                    <div class="peer-throughput-item">
                        <strong>Received:</strong>
                        <span>${receivedFormatted}</span>
                    </div>
                    <div class="peer-throughput-item">
                        <strong>Sent:</strong>
                        <span>${sentFormatted}</span>
                    </div>
                    <div class="peer-throughput-item">
                        <strong>Total:</strong>
                        <span>${totalFormatted}</span>
                    </div>
                </div>
            `;
            
            peersGrid.appendChild(peerCard);
        });
    } catch (error) {
        console.error('Error loading peers:', error);
        document.getElementById('peers-container').innerHTML = 
            '<div class="error">Error loading peers: ' + error.message + '</div>';
    }
}

// Load all data on page load
window.onload = async function() {
    const interfaceId = getInterfaceIdFromUrl();
    if (interfaceId) {
        const success = await setInterface(interfaceId);
        if (!success) {
            document.getElementById('interface-info').innerHTML = 
                '<div class="error">Error setting interface: ' + interfaceId + '</div>';
            return;
        }
    }
    
    await loadInterfaceInfo();
    await loadPeers();
    
    // Refresh peers every 30 seconds
    setInterval(loadPeers, 30000);
};
