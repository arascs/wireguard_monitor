let keyExpired = false;
let checkKeyStatusInterval = null;
let checkVPNStatusInterval = null;
let interfaceInitialized = false;

const pageContext = (() => {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const editIndex = segments.indexOf('editInterface');
    const addIndex = segments.indexOf('addInterface');

    if (editIndex !== -1 && segments[editIndex + 1]) {
        return { mode: 'edit', interfaceName: decodeURIComponent(segments[editIndex + 1]) };
    }
    if (addIndex !== -1 && segments[addIndex + 1]) {
        return { mode: 'add', interfaceName: decodeURIComponent(segments[addIndex + 1]) };
    }
    return { mode: 'legacy', interfaceName: null };
})();

if (pageContext.interfaceName) {
    const label = document.getElementById('interface-context-name');
    if (label) {
        label.textContent = pageContext.interfaceName;
    }
}

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
        statusText.textContent = 'Up';
        statusDiv.style.color = '#2e7d32';
    } else {
        statusText.textContent = 'Down';
        statusDiv.style.color = '#c62828';
    }
}

// Update key status banner
function updateKeyStatusBanner(statusData) {
    const banner = document.getElementById('key-status-banner');
    const keyExpiredText = document.getElementById('key-expired-text');
    
    if (!statusData.keyCreationDate) {
        banner.className = 'key-status-banner no-key';
        banner.innerHTML = 'Chưa có key. Vui lòng tạo key mới để sử dụng.';
        keyExpiredText.textContent = '';
        return;
    }
    
    if (statusData.expired) {
        banner.className = 'key-status-banner expired';
        banner.innerHTML = 'Key expired. Generate new keys to continue using VPN';
        keyExpiredText.textContent = 'Key expired. Generate new keys to continue using VPN';
    } else if (statusData.remainingDays !== null) {
        if (statusData.remainingDays <= 7) {
            banner.className = 'key-status-banner warning';
            banner.innerHTML = `Warning: Key expired after ${statusData.remainingDays} days. Generate new keys.`;
            keyExpiredText.textContent = `Warning: Key expired after ${statusData.remainingDays} days. Generate new keys.`;
        } else {
            banner.className = 'key-status-banner valid';
            banner.innerHTML = `Key expired after ${statusData.remainingDays} days.`;
            keyExpiredText.textContent = '';
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

function updateInterfaceContextName(name) {
    const label = document.getElementById('interface-context-name');
    if (label) {
        label.textContent = name || 'Not chosen';
    }
}

async function chooseInterface(forcedName, options = {}) {
    const inputEl = document.getElementById('interface-input');
    const interface_name = forcedName || (inputEl ? inputEl.value : '');
    if (!interface_name) {
        alert('Enter interface name');
        return;
    }
    const silent = options.silent === true;
    updateInterfaceContextName(interface_name);
    try {
        const response = await fetch('/api/interface', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interface: interface_name })
        });
        const data = await response.json();
        if (data.success) {
            const currentInterfaceEl = document.getElementById('current-interface');
            if (currentInterfaceEl) {
                currentInterfaceEl.textContent = data.interface;
            }
            updateInterfaceContextName(data.interface);
            // Update config with loaded data
            if (data.config) {
                updateInterfaceDisplay(data.config.interface);
                loadPeersFromConfig(data.config);
                // Check key status after loading interface
                await checkKeyStatus();
            }
            interfaceInitialized = true;
            if (!silent) {
                alert('Interface set to: ' + data.interface);
            }
            return data;
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

        if (data.needConfirmation) {
            if (confirm(data.message)) {
                await generateKeys(true);
                await checkKeyStatus();
            }
            return;
        }
        
        if (data.success) {
            const oldPublicKey = data.oldPublicKey;
            const newPublicKey = data.newPublicKey;
            const peers = data.peers || [];
            
            const keysOutput = document.getElementById('keys-output');
            keysOutput.innerHTML = '<p><strong>New key pair created.</strong></p>';
            
            if (peers.length > 0) {
                await distributeKeysToPeers(peers, oldPublicKey, newPublicKey);
            }
            
            keysOutput.innerHTML += '<p style="color: green;"><strong>Distribute key succeeded.</strong></p>';
            await checkKeyStatus();
            await reloadCurrentConfig();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function distributeKeysToPeers(peers, senderPub, newSenderPub) {
    const results = [];
    const KEY_SERVER_URL = 'http://192.168.178.129:52000/update';
    
    for (const peer of peers) {
        if (!peer.publicKey) {
            continue;
        }
        
        try {
            const requestBody = {
                receiver_pub: peer.publicKey,
                sender_pub: senderPub,
                new_sender_pub: newSenderPub
            };
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(KEY_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
                results.push({ status: 'success' });
            } else {
                results.push({ status: 'error' });
            }
        } catch (error) {
            results.push({ status: 'error' });
        }
    }
    
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const keysOutput = document.getElementById('keys-output');
    keysOutput.innerHTML += `<p>Distribute key to ${successCount} peers successfully, ${errorCount} fails.</p>`;
    
    return results;
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
            <div class="interface-info" style="background-color: white; border: 2px solid #861618;">
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
        mtu: document.getElementById('mtu').value,
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

async function initializeInterfaceContext() {
    const interfaceSection = document.getElementById('interface-section');
    if (pageContext.mode === 'edit') {
        if (interfaceSection) {
            interfaceSection.style.display = 'none';
        }
        if (pageContext.interfaceName) {
            const interfaceInput = document.getElementById('interface-input');
            if (interfaceInput) {
                interfaceInput.value = pageContext.interfaceName;
            }
            updateInterfaceContextName(pageContext.interfaceName);
            await chooseInterface(pageContext.interfaceName, { silent: true });
        }
        return;
    }
    if (pageContext.mode === 'add') {
        // Ở trang addInterface, đã biết sẵn tên interface từ URL và không cần cho người dùng tự Set Interface nữa
        if (interfaceSection) {
            interfaceSection.style.display = 'none';
        }
        if (pageContext.interfaceName) {
            const interfaceInput = document.getElementById('interface-input');
            if (interfaceInput) {
                interfaceInput.value = pageContext.interfaceName;
            }
            updateInterfaceContextName(pageContext.interfaceName);
            await chooseInterface(pageContext.interfaceName, { silent: true });
        }
        return;
    }
    if (interfaceSection) {
        interfaceSection.style.display = 'block';
    }
    try {
        const interfaceResponse = await fetch('/api/interface');
        const interfaceData = await interfaceResponse.json();
        if (interfaceData.interface) {
            const currentInterfaceEl = document.getElementById('current-interface');
            if (currentInterfaceEl) {
                currentInterfaceEl.textContent = interfaceData.interface;
            }
            document.getElementById('interface-input').value = interfaceData.interface;
            updateInterfaceContextName(interfaceData.interface);
        }
    } catch (error) {
        console.error('Error getting current interface:', error);
    }
}

async function reloadCurrentConfig() {
    try {
        const reloadResponse = await fetch('/api/reload-config');
        const reloadData = await reloadResponse.json();
        if (reloadData.success && reloadData.config) {
            const interfaceConfig = reloadData.config.interface || {};
            updateInterfaceDisplay(interfaceConfig);
            document.getElementById('address').value = interfaceConfig.address || '';
            document.getElementById('listenPort').value = interfaceConfig.listenPort || '51820';
            document.getElementById('dns').value = interfaceConfig.dns || '';
            document.getElementById('table').value = interfaceConfig.table || '';
            document.getElementById('mtu').value = interfaceConfig.mtu || '1420';
            document.getElementById('preUp').value = interfaceConfig.preUp || '';
            document.getElementById('postUp').value = interfaceConfig.postUp || '';
            document.getElementById('preDown').value = interfaceConfig.preDown || '';
            document.getElementById('postDown').value = interfaceConfig.postDown || '';
            loadPeersFromConfig(reloadData.config);
        }
    } catch (error) {
        console.error('Error loading initial config:', error);
    }
}

// Load peers and config on page load
window.onload = async function() {
    await initializeInterfaceContext();
    await reloadCurrentConfig();
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

function showConfigInterface() {
    document.getElementById('configure-section').style.display = 'block';
    document.getElementById('peer-section').style.display = 'none';
}

function showConfigPeers() {
    document.getElementById('configure-section').style.display = 'none';
    document.getElementById('peer-section').style.display = 'block';
}

async function restartVPN() {
    try {
        const response = await fetch('/api/restart-vpn', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('VPN restarted successfully');
            await checkVPNStatus();
        } else {
            alert('Error restarting VPN: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}