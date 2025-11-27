let keyExpired = false;
let checkKeyStatusInterval = null;
let checkVPNStatusInterval = null;

// Check key status from server
async function checkKeyStatus() {
    try {
        const response = await fetch('/api/key-status');
        const data = await response.json();
        
        if (data.success) {
            keyExpired = data.expired;
            updateKeyStatusBanner(data);
            
            if (keyExpired) {
                disableAllFunctions();
                // If key expired, VPN should be disconnected, update status
                updateVPNStatus(false);
            } else {
                enableAllFunctions();
            }
        }
    } catch (error) {
        console.error('Error checking key status:', error);
    }
}

// Check VPN status from server
async function checkVPNStatus() {
    try {
        const response = await fetch('/api/vpn-status');
        const data = await response.json();
        
        if (data.success) {
            updateVPNStatus(data.connected);
        }
    } catch (error) {
        console.error('Error checking VPN status:', error);
        updateVPNStatus(false);
    }
}

// Update VPN status display
function updateVPNStatus(isConnected) {
    const statusText = document.getElementById('vpn-status-text');
    const statusDiv = document.getElementById('vpn-status');
    
    if (isConnected) {
        statusText.textContent = 'Connected';
        statusDiv.style.backgroundColor = '#e8f5e9';
        statusDiv.style.border = '2px solid #4caf50';
        statusDiv.style.color = '#2e7d32';
    } else {
        statusText.textContent = 'Disconnected';
        statusDiv.style.backgroundColor = '#ffebee';
        statusDiv.style.border = '2px solid #f44336';
        statusDiv.style.color = '#c62828';
    }
}

// Update key status banner
function updateKeyStatusBanner(statusData) {
    const banner = document.getElementById('key-status-banner');
    
    if (!statusData.keyCreationDate) {
        banner.className = 'key-status-banner no-key';
        banner.innerHTML = 'Chưa có key. Vui lòng tạo key mới để sử dụng.';
        return;
    }
    
    if (statusData.expired) {
        banner.className = 'key-status-banner expired';
        banner.innerHTML = 'KEY ĐÃ HẾT HẠN! VPN đã bị ngắt kết nối. Vui lòng tạo key mới.';
    } else if (statusData.remainingDays !== null) {
        if (statusData.remainingDays <= 7) {
            banner.className = 'key-status-banner warning';
            banner.innerHTML = `Cảnh báo: Key sẽ hết hạn sau ${statusData.remainingDays} ngày. Vui lòng chuẩn bị tạo key mới.`;
        } else {
            banner.className = 'key-status-banner valid';
            banner.innerHTML = `Key hợp lệ. Còn ${statusData.remainingDays} ngày (Hết hạn: ${statusData.keyExpiryDays} ngày kể từ ngày tạo)`;
        }
    }
}

// Disable all functions except interface selection and key generation
function disableAllFunctions() {
    // Disable VPN control buttons
    document.querySelectorAll('#vpn-section button').forEach(btn => {
        btn.disabled = true;
    });
    
    // Leave configure interface button/form enabled so users can update settings
    const configBtn = document.getElementById('config-interface-btn');
    if (configBtn) {
        configBtn.disabled = false;
    }
    const configForm = document.getElementById('configure-form');
    if (configForm) {
        configForm.querySelectorAll('input, button').forEach(el => {
            el.disabled = false;
        });
    }
    
    // Disable peer section
    document.querySelectorAll('#peer-section button').forEach(btn => {
        btn.disabled = true;
    });
    document.querySelectorAll('.peer-buttons button').forEach(btn => {
        btn.disabled = true;
    });
}

// Enable all functions
function enableAllFunctions() {
    // Enable VPN control buttons
    document.querySelectorAll('#vpn-section button').forEach(btn => {
        btn.disabled = false;
    });
    
    // Enable configure interface button
    const configBtn = document.getElementById('config-interface-btn');
    if (configBtn) {
        configBtn.disabled = false;
    }
    
    // Enable all inputs
    document.querySelectorAll('input, button').forEach(el => {
        el.disabled = false;
    });
    
    // Reload peers to restore proper enable/disable state
    loadPeers();
}

async function chooseInterface() {
    const interface_name = document.getElementById('interface-input').value;
    try {
        const response = await fetch('/api/interface', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interface: interface_name })
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('current-interface').textContent = data.interface;
            // Update config with loaded data
            if (data.config) {
                updateInterfaceDisplay(data.config.interface);
                loadPeersFromConfig(data.config);
                // Check key status after loading interface
                await checkKeyStatus();
            }
            alert('Interface set to: ' + data.interface);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function generateKeys(force=false) {
    try {
        const response = await fetch('/api/generate-keys', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: force })
        });
        const data = await response.json();

        // Check if need confirmation
        if (data.needConfirmation) {
            if (confirm(data.message)) {
                // User confirmed, regenerate with force flag
                generateKeys(true);
                // Refresh key status after generating new keys
                await checkKeyStatus();
            }
            return;
        }
        
        if (data.success) {
            document.getElementById('keys-output').innerHTML = 
                '<p><strong>Success!</strong></p>' +
                '<p>Private Key: ' + data.privateKey + '</p>' +
                '<p>Public Key: ' + data.publicKey + '</p>';
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function toggleConfigInterfaceForm() {
    const form = document.getElementById('configure-form');
    const btn = document.getElementById('config-interface-btn');
    if (form.classList.contains('active')) {
        form.classList.remove('active');
        btn.textContent = 'Configure Interface';
    } else {
        form.classList.add('active');
        btn.textContent = 'Hide Form';
    }
}

function updateInterfaceDisplay(interfaceConfig) {
    const infoDiv = document.getElementById('interface-info-display');
    if (interfaceConfig && (interfaceConfig.address || interfaceConfig.privateKey)) {
        infoDiv.innerHTML = `
            <div class="interface-info">
                <h4>Current Interface Configuration</h4>
                ${interfaceConfig.publicKey ? '<p><strong>Public Key:</strong> ' + interfaceConfig.publicKey + '</p>' : ''}
                <p><strong>Address:</strong> ${interfaceConfig.address || 'Not set'}</p>
                ${interfaceConfig.listenPort ? '<p><strong>Listen Port:</strong> ' + interfaceConfig.listenPort + '</p>' : ''}
                ${interfaceConfig.dns ? '<p><strong>DNS:</strong> ' + interfaceConfig.dns + '</p>' : ''}
                ${interfaceConfig.mtu ? '<p><strong>MTU:</strong> ' + interfaceConfig.mtu + '</p>' : ''}
                ${interfaceConfig.preUp ? '<p><strong>PreUp:</strong> ' + interfaceConfig.preUp + '</p>' : ''}
                ${interfaceConfig.postUp ? '<p><strong>PostUp:</strong> ' + interfaceConfig.postUp + '</p>' : ''}
                ${interfaceConfig.preDown ? '<p><strong>PreDown:</strong> ' + interfaceConfig.preDown + '</p>' : ''}
                ${interfaceConfig.postDown ? '<p><strong>PostDown:</strong> ' + interfaceConfig.postDown + '</p>' : ''}
            </div>
        `;
    } else {
        infoDiv.innerHTML = '<p>No interface configuration found.</p>';
    }
}

async function configureInterface() {
    const interfaceConfig = {
        address: document.getElementById('address').value,
        listenPort: document.getElementById('listenPort').value,
        dns: document.getElementById('dns').value,
        table: document.getElementById('table').value,
        preUp: document.getElementById('preUp').value,
        postUp: document.getElementById('postUp').value,
        preDown: document.getElementById('preDown').value,
        postDown: document.getElementById('postDown').value,
        saveToFile: true
    };
    
    try {
        const response = await fetch('/api/configure-interface', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(interfaceConfig)
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('configure-output').innerHTML = '<p><strong>Interface configured!</strong></p>';
            updateInterfaceDisplay(data.config.interface);
            // Hide form after successful config
            setTimeout(() => {
                toggleConfigInterfaceForm();
            }, 1000);
            // Refresh key status
            await checkKeyStatus();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function toggleAddPeerForm() {
    const form = document.getElementById('add-peer-form');
    const btn = document.getElementById('add-peer-btn');
    if (form.classList.contains('active')) {
        form.classList.remove('active');
        btn.textContent = 'Add New Peer';
    } else {
        form.classList.add('active');
        btn.textContent = 'Hide Form';
    }
}

async function addPeer() {
    const peer = {
        name: document.getElementById('peer-name').value,
        publicKey: document.getElementById('peer-publicKey').value,
        endpoint: document.getElementById('peer-endpoint').value,
        allowedIPs: document.getElementById('peer-allowedIPs').value,
        persistentKeepalive: document.getElementById('peer-keepalive').value,
        generatePsk: document.getElementById('peer-generatePsk').checked
    };
    
    try {
        const response = await fetch('/api/add-peer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(peer)
        });
        
        const data = await response.json();
        if (data.success) {
            document.getElementById('peer-output').innerHTML = '<p><strong>Peer added!</strong></p>';
            // Clear form
            document.getElementById('peer-name').value = '';
            document.getElementById('peer-publicKey').value = '';
            document.getElementById('peer-endpoint').value = '';
            document.getElementById('peer-allowedIPs').value = '0.0.0.0/0';
            document.getElementById('peer-keepalive').value = '25';
            document.getElementById('peer-generatePsk').checked = false;
            // Hide form after successful add
            setTimeout(() => {
                toggleAddPeerForm();
                loadPeers();
            }, 1000);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function loadPeersFromConfig(configData) {
    const peersList = document.getElementById('peers-list');
    peersList.innerHTML = '';
    
    if (!configData.peers || configData.peers.length === 0) {
        peersList.innerHTML = '<p>No peers added yet.</p>';
        return;
    }
    
    configData.peers.forEach((peer, idx) => {
        const peerDiv = document.createElement('div');
        peerDiv.className = 'peer-item' + (peer.enabled === false ? ' disabled' : '');
        peerDiv.id = `peer-${idx}`;
        peerDiv.setAttribute('data-name', (peer.name || '').toLowerCase());
        
        const statusText = peer.enabled === false ? ' (Disabled)' : ' (Enabled)';
        const peerNameDisplay = peer.name ? `<div class="peer-name">${peer.name}</div>` : '';
        
        peerDiv.innerHTML = `
            <div class="peer-header">Peer ${idx}${statusText}</div>
            ${peerNameDisplay}
            <div class="peer-buttons">
                <button onclick="viewPeerInfo(${idx})">View Info</button>
                <button onclick="editPeer(${idx})">Edit</button>
                <button onclick="deletePeer(${idx})">Delete</button>
                <button onclick="enablePeer(${idx})" ${peer.enabled !== false ? 'disabled' : ''}>Enable</button>
                <button onclick="disablePeer(${idx})" ${peer.enabled === false ? 'disabled' : ''}>Disable</button>
            </div>
            <div class="peer-info" id="peer-info-${idx}">
                ${peer.name ? '<strong>Name:</strong> ' + peer.name + '<br>' : ''}
                <strong>Public Key:</strong> ${peer.publicKey || 'NOT SET'}<br>
                <strong>Endpoint:</strong> ${peer.endpoint || 'NOT SET'}<br>
                <strong>Allowed IPs:</strong> ${peer.allowedIPs || 'NOT SET'}<br>
                <strong>Persistent Keepalive:</strong> ${peer.persistentKeepalive || 'NOT SET'}<br>
                ${peer.presharedKey ? '<strong>Preshared Key:</strong> ***' + peer.presharedKey.slice(-8) + '<br>' : ''}
            </div>
            <div class="peer-edit-form" id="peer-edit-${idx}">
                <label>Name:</label>
                <input type="text" id="edit-name-${idx}" value="${peer.name || ''}">
                <label>Public Key:</label>
                <input type="text" id="edit-publicKey-${idx}" value="${peer.publicKey || ''}">
                <label>Endpoint:</label>
                <input type="text" id="edit-endpoint-${idx}" value="${peer.endpoint || ''}">
                <label>Allowed IPs:</label>
                <input type="text" id="edit-allowedIPs-${idx}" value="${peer.allowedIPs || ''}">
                <label>Persistent Keepalive:</label>
                <input type="text" id="edit-keepalive-${idx}" value="${peer.persistentKeepalive || ''}">
                <button onclick="savePeerEdit(${idx})">Save</button>
                <button onclick="cancelPeerEdit(${idx})">Cancel</button>
            </div>
        `;
        peersList.appendChild(peerDiv);
    });
}

async function loadPeers() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        if (data.success) {
            loadPeersFromConfig(data.config);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function searchPeers() {
    const searchTerm = document.getElementById('peer-search').value.toLowerCase();
    const peerItems = document.querySelectorAll('.peer-item');
    
    peerItems.forEach(item => {
        const peerName = item.getAttribute('data-name') || '';
        if (searchTerm === '' || peerName.includes(searchTerm)) {
            item.classList.remove('hidden');
        } else {
            item.classList.add('hidden');
        }
    });
}

function clearSearch() {
    document.getElementById('peer-search').value = '';
    searchPeers();
}

function viewPeerInfo(index) {
    const infoDiv = document.getElementById(`peer-info-${index}`);
    const editDiv = document.getElementById(`peer-edit-${index}`);
    if (infoDiv.style.display === 'block') {
        infoDiv.style.display = 'none';
    } else {
        infoDiv.style.display = 'block';
        editDiv.style.display = 'none';
    }
}

function editPeer(index) {
    const infoDiv = document.getElementById(`peer-info-${index}`);
    const editDiv = document.getElementById(`peer-edit-${index}`);
    if (editDiv.style.display === 'block') {
        editDiv.style.display = 'none';
    } else {
        editDiv.style.display = 'block';
        infoDiv.style.display = 'none';
    }
}

function cancelPeerEdit(index) {
    document.getElementById(`peer-edit-${index}`).style.display = 'none';
    loadPeers();
}

async function savePeerEdit(index) {
    const peer = {
        name: document.getElementById(`edit-name-${index}`).value,
        publicKey: document.getElementById(`edit-publicKey-${index}`).value,
        endpoint: document.getElementById(`edit-endpoint-${index}`).value,
        allowedIPs: document.getElementById(`edit-allowedIPs-${index}`).value,
        persistentKeepalive: document.getElementById(`edit-keepalive-${index}`).value
    };
    
    try {
        const response = await fetch(`/api/edit-peer/${index}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(peer)
        });
        
        const data = await response.json();
        if (data.success) {
            loadPeers();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function deletePeer(index) {
    if (!confirm('Are you sure you want to delete this peer?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/delete-peer/${index}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        if (data.success) {
            loadPeers();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function enablePeer(index) {
    try {
        const response = await fetch(`/api/enable-peer/${index}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        if (data.success) {
            loadPeers();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function disablePeer(index) {
    try {
        const response = await fetch(`/api/disable-peer/${index}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        if (data.success) {
            loadPeers();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function saveConfig() {
    try {
        const response = await fetch('/api/save-config', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('Configuration saved successfully!');
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function connectVPN() {
    try {
        const response = await fetch('/api/connect', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            document.getElementById('vpn-output').innerHTML = '<p><strong>VPN connected!</strong></p>';
            // Update status to connected
            updateVPNStatus(true);
        } else {
            alert('Error: ' + data.error);
            // Update status to disconnected on error
            updateVPNStatus(false);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        updateVPNStatus(false);
    }
}

async function disconnectVPN() {
    try {
        const response = await fetch('/api/disconnect', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            document.getElementById('vpn-output').innerHTML = '<p><strong>VPN disconnected!</strong></p>';
            // Update status to disconnected
            updateVPNStatus(false);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        // Still update status to disconnected on error
        updateVPNStatus(false);
    }
}

// Load peers and config on page load
window.onload = async function() {
    try {
        // Get current interface first
        const interfaceResponse = await fetch('/api/interface');
        const interfaceData = await interfaceResponse.json();
        if (interfaceData.interface) {
            document.getElementById('current-interface').textContent = interfaceData.interface;
            document.getElementById('interface-input').value = interfaceData.interface;
        }
        
        // Reload config from file once on page load
        const reloadResponse = await fetch('/api/reload-config');
        const reloadData = await reloadResponse.json();
        if (reloadData.success && reloadData.config) {
            const interfaceConfig = reloadData.config.interface || {};
            updateInterfaceDisplay(interfaceConfig);
            if (interfaceConfig.address) {
                document.getElementById('address').value = interfaceConfig.address || '';
                document.getElementById('listenPort').value = interfaceConfig.listenPort || '51820';
                document.getElementById('dns').value = interfaceConfig.dns || '';
                document.getElementById('table').value = interfaceConfig.table || '';
                document.getElementById('preUp').value = interfaceConfig.preUp || '';
                document.getElementById('postUp').value = interfaceConfig.postUp || '';
                document.getElementById('preDown').value = interfaceConfig.preDown || '';
                document.getElementById('postDown').value = interfaceConfig.postDown || '';
            }
            loadPeersFromConfig(reloadData.config);
        }
    } catch (error) {
        console.error('Error loading initial config:', error);
    }
    // Start checking key status
    await checkKeyStatus();

    // Check key status every 5 minutes
    checkKeyStatusInterval = setInterval(checkKeyStatus, 5 * 60 * 1000);
    
    // Check VPN status on page load
    await checkVPNStatus();
    
    // Check VPN status every 30 seconds
    checkVPNStatusInterval = setInterval(checkVPNStatus, 30 * 1000);
};

// Cleanup interval on page unload
window.onbeforeunload = function() {
    if (checkKeyStatusInterval) {
        clearInterval(checkKeyStatusInterval);
    }
    if (checkVPNStatusInterval) {
        clearInterval(checkVPNStatusInterval);
    }
};