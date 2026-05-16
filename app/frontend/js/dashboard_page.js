function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getInterfaceIdFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/^\/dashboard\/([^\/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

const iface = getInterfaceIdFromUrl() || '';

let currentInterfaceConfig = {};

function apiIface(path) {
    const interfaceId = getInterfaceIdFromUrl();
    if (!interfaceId) return null;
    return `/api/interfaces/${encodeURIComponent(interfaceId)}${path}`;
}

async function loadInterfaceInfo() {
    const configUrl = apiIface('/config');
    if (!configUrl) {
        document.getElementById('interface-info').innerHTML = '<div class="error">Missing interface in URL</div>';
        return;
    }
    try {
        const response = await fetch(configUrl);
        const data = await response.json();

        if (data.success && data.config) {
            const ifaceObj = data.config.interface;
            currentInterfaceConfig = ifaceObj || {};
            const interfaceInfo = document.getElementById('interface-info');

            const rows = [
                ['Public Key',  ifaceObj.publicKey  || 'Not set'],
                ['Address',     ifaceObj.address    || 'Not set'],
                ['Listen Port', ifaceObj.listenPort || 'Not set'],
                ['DNS',         ifaceObj.dns        || 'Not set'],
                ['MTU',         ifaceObj.mtu        || 'Not set'],
            ];
            if (ifaceObj.preUp)   rows.push(['PreUp',   ifaceObj.preUp]);
            if (ifaceObj.postUp)  rows.push(['PostUp',  ifaceObj.postUp]);
            if (ifaceObj.preDown) rows.push(['PreDown', ifaceObj.preDown]);
            if (ifaceObj.postDown)rows.push(['PostDown',ifaceObj.postDown]);

            interfaceInfo.innerHTML = `
                <table class="if-table">
                    <tbody>
                        ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}
                        <tr>
                            <th>Active Peers</th>
                            <td><span id="active-peers-stat" style="font-weight:600;color:#0056b3;">0/0</span></td>
                        </tr>
                    </tbody>
                </table>
            `;
        } else {
            document.getElementById('interface-info').innerHTML = '<div class="error">Error loading interface information</div>';
        }
    } catch (error) {
        console.error('Error loading interface info:', error);
        document.getElementById('interface-info').innerHTML = `<div class="error">${error.message}</div>`;
    }
}


// All peers data cached for client-side search
let _allPeersData = [];

async function loadPeers() {
    try {
        const interfaceId = getInterfaceIdFromUrl();
        if (!interfaceId) return;
        const url = `/api/dashboard/peers?interface=${encodeURIComponent(interfaceId)}`;
        const response = await fetch(url);
        const data = await response.json();

        const tbody = document.getElementById('peers-tbody');

        if (!Array.isArray(data)) {
            tbody.innerHTML = '<tr><td colspan="7" class="error">Error loading peers: Invalid response</td></tr>';
            return;
        }

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No peers configured.</td></tr>';
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        let activeCount = 0;

        _allPeersData = data.map(peer => {
            const lastHandshake = parseInt(peer.handshake || 0);
            const diff = nowSec - lastHandshake;
            let calculatedStatus = 'inactive';
            if (peer.isDisabled) {
                calculatedStatus = 'disabled';
            } else if (lastHandshake > 0 && diff < 180) {
                calculatedStatus = 'active';
                activeCount++;
            }
            let timeAgo = 'Never';
            if (lastHandshake > 0) {
                if (diff < 60) timeAgo = `${diff}s ago`;
                else if (diff < 3600) timeAgo = `${Math.floor(diff / 60)}m ${diff % 60}s ago`;
                else if (diff < 86400) timeAgo = `${Math.floor(diff / 3600)}h ago`;
                else timeAgo = new Date(lastHandshake * 1000).toLocaleString();
            }
            return { ...peer, calculatedStatus, timeAgo };
        });

        const activeStatEl = document.getElementById('active-peers-stat');
        if (activeStatEl) {
            activeStatEl.innerHTML = `${activeCount} <span style="color:#666;font-weight:normal;font-size:0.8em;">/ ${data.length}</span>`;
        }

        renderPeersTable(_allPeersData, interfaceId);
    } catch (error) {
        console.error('Error loading peers:', error);
        const tbody = document.getElementById('peers-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="error">Error: ${error.message}</td></tr>`;
    }
}

function renderPeersTable(peers, interfaceId) {
    const tbody = document.getElementById('peers-tbody');
    if (!tbody) return;
    if (peers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:16px;">No matching peers.</td></tr>';
        return;
    }
    tbody.innerHTML = peers.map(peer => {
        const disabled = peer.isDisabled === true;
        const keySeg = encodeURIComponent(peer.publicKey || '');
        const detailLink = `/dashboard/${encodeURIComponent(interfaceId)}/peer/${keySeg}`;
        const label = peer.name || (peer.publicKey ? peer.publicKey.substring(0, 12) + '…' : 'Peer');
        return `<tr data-public-key="${keySeg}">
            <td><a href="${detailLink}" style="color:rgba(134,22,24,1);text-decoration:none;font-weight:500;">${label}</a></td>
            <td style="font-family:monospace;font-size:0.82em;">${peer.allowedIPs || '—'}</td>
            <td style="font-family:monospace;font-size:0.82em;">${peer.endpoint || '—'}</td>
            <td>${peer.timeAgo}</td>
            <td>${formatBytes(peer.receivedBytes)} / ${formatBytes(peer.sentBytes)}</td>
            <td><span class="peer-badge badge-${peer.calculatedStatus}">${peer.calculatedStatus.toUpperCase()}</span></td>
            <td>
                <div style="display:flex;gap:6px;">
                    <button class="peer-action-btn" data-action="${disabled ? 'enable' : 'disable'}" data-public-key="${keySeg}" style="padding:4px 10px;font-size:0.8rem;">${disabled ? 'Enable' : 'Disable'}</button>
                    <button class="peer-action-btn" data-action="delete" data-public-key="${keySeg}" style="padding:4px 10px;font-size:0.8rem;background:rgba(220,53,69,.85);">Delete</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function filterPeersTable() {
    const q = (document.getElementById('peer-search')?.value || '').toLowerCase();
    const interfaceId = getInterfaceIdFromUrl();
    const filtered = _allPeersData.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.publicKey || '').toLowerCase().includes(q) ||
        (p.allowedIPs || '').toLowerCase().includes(q) ||
        (p.endpoint || '').toLowerCase().includes(q)
    );
    renderPeersTable(filtered, interfaceId);
}


// Vẽ biểu đồ
document.getElementById("title").innerText = `${iface}`;

const rxSpeedChart = echarts.init(document.getElementById('rxSpeedChart'));
const txSpeedChart = echarts.init(document.getElementById('txSpeedChart'));
const rxDropRateChart = echarts.init(document.getElementById('rxDropRateChart'));
const txDropRateChart = echarts.init(document.getElementById('txDropRateChart'));

let statsHistory = [];

async function fetchStats(startTs = null, endTs = null) {
    try {
        let url = `/api/dashboard/${iface}/stats`;
        const params = [];
        if (startTs) params.push(`start=${startTs}`);
        if (endTs) params.push(`end=${endTs}`);
        if (params.length) url += '?' + params.join('&');

        const res = await fetch(url);
        if (!res.ok) throw new Error("API Error");

        const data = await res.json();

        if (Array.isArray(data)) {
            statsHistory = data;
        } else {
            statsHistory = [data];
        }

        updateCharts();
    } catch (e) {
        console.error("Failed to fetch stats:", e);
    }
}

// Hàm tính tốc độ cho một metric cụ thể (lọc bỏ các mốc thời gian không có dữ liệu của metric đó)
function calculateMetricRate(data, metricKey) {
    // 1. Lọc ra các bản ghi có chứa metricKey (để tránh việc so sánh với timestamp của file khác)
    const filteredData = data.filter(item => item[metricKey] !== undefined && item[metricKey] !== null);

    const times = [];
    const rates = [];

    for (let i = 1; i < filteredData.length; i++) {
        const curr = filteredData[i];
        const prev = filteredData[i - 1];

        // Tính khoảng cách thời gian giữa 2 lần ghi CÙNG LOẠI metric
        const timeDiff = (curr.timestamp - prev.timestamp) / 1000;

        if (timeDiff > 0) {
            const valDiff = Math.max(0, curr[metricKey] - prev[metricKey]);
            const rate = valDiff / timeDiff;

            times.push(new Date(curr.timestamp).toLocaleTimeString());
            rates.push(rate);
        }
    }
    return { times, rates };
}

function updateCharts() {
    // Tính toán dữ liệu riêng biệt cho từng biểu đồ
    const rxSpeedData = calculateMetricRate(statsHistory, 'rx_bytes');
    const txSpeedData = calculateMetricRate(statsHistory, 'tx_bytes');
    const rxDropData = calculateMetricRate(statsHistory, 'rx_dropped');
    const txDropData = calculateMetricRate(statsHistory, 'tx_dropped');

    // 1. RX Speed Chart
    rxSpeedChart.setOption({
        title: { text: "Download Speed (RX)", left: 'center' },
        tooltip: { trigger: 'axis' },
        grid: { left: '50', right: '20' },
        xAxis: { type: 'category', data: rxSpeedData.times },
        yAxis: { type: 'value', name: 'Bytes/s' },
        series: [{
            name: "Download",
            type: 'line',
            smooth: true,
            areaStyle: { opacity: 0.3 },
            lineStyle: { color: '#007bff' },
            itemStyle: { color: '#007bff' },
            data: rxSpeedData.rates
        }]
    });

    // 2. TX Speed Chart
    txSpeedChart.setOption({
        title: { text: "Upload Speed (TX)", left: 'center' },
        tooltip: { trigger: 'axis' },
        grid: { left: '50', right: '20' },
        xAxis: { type: 'category', data: txSpeedData.times },
        yAxis: { type: 'value', name: 'Bytes/s' },
        series: [{
            name: "Upload",
            type: 'line',
            smooth: true,
            areaStyle: { opacity: 0.3 },
            lineStyle: { color: '#28a745' },
            itemStyle: { color: '#28a745' },
            data: txSpeedData.rates
        }]
    });

    // 3. RX Drop Rate Chart
    rxDropRateChart.setOption({
        title: { text: "RX Packet Drop Rate", left: 'center' },
        tooltip: { trigger: 'axis' },
        grid: { left: '50', right: '20' },
        xAxis: { type: 'category', data: rxDropData.times },
        yAxis: { type: 'value', name: 'Pkts/s' },
        series: [{
            name: "RX Drop",
            type: 'line',
            lineStyle: { color: '#dc3545' },
            itemStyle: { color: '#dc3545' },
            data: rxDropData.rates
        }]
    });

    // 4. TX Drop Rate Chart
    txDropRateChart.setOption({
        title: { text: "TX Packet Drop Rate", left: 'center' },
        tooltip: { trigger: 'axis' },
        grid: { left: '50', right: '20' },
        xAxis: { type: 'category', data: txDropData.times },
        yAxis: { type: 'value', name: 'Pkts/s' },
        series: [{
            name: "TX Drop",
            type: 'line',
            lineStyle: { color: '#fd7e14' },
            itemStyle: { color: '#fd7e14' },
            data: txDropData.rates
        }]
    });
}

window.onload = async function () {
    await loadInterfaceInfo();
    checkVPNStatus();
    await loadPeers();
    fetchStats();

    setInterval(loadPeers, 30000);
    setInterval(fetchStats, 60000);

    setupInterfaceControls();
    setupPeerModals();

    // sidebar activation (reuse layout code)
    initSidebar();

    // Filter logic
    document.getElementById('applyFilter').addEventListener('click', () => {
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
            alert('Start date must be before end date');
            return;
        }
        const startTs = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : null;
        const endTs = endDate ? Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000) : null;
        fetchStats(startTs, endTs);
    });

    document.getElementById('clearFilter').addEventListener('click', () => {
        document.getElementById('startDate').value = '';
        document.getElementById('endDate').value = '';
        fetchStats();
    });
};

// helper to initialize sidebar behavior (same as layout.js)
function initSidebar() {
    const sidebarItems = document.querySelectorAll('.sidebar-item');
    const currentSection = 'connections'; // always connections for dashboard
    sidebarItems.forEach((btn) => {
        const section = btn.dataset.section;
        const path = btn.dataset.path;
        if (section === currentSection) btn.classList.add('active');
        btn.addEventListener('click', () => {
            if (window.location.pathname !== path) {
                window.location.href = path;
            }
        });
    });
}

// VPN status control functions
async function checkVPNStatus() {
    const statusUrl = apiIface('/vpn-status');
    if (!statusUrl) return;
    try {
        const r = await fetch(statusUrl);
        const d = await r.json();
        updateVpnButton(d.connected);
    } catch (e) {
        console.error(e);
        updateVpnButton(false);
    }
}

function updateVpnButton(isConnected) {
    const statusSpan = document.getElementById('iface-status');
    const btn = document.getElementById('start-stop-btn');
    if (isConnected) {
        statusSpan.textContent = 'Status: Up';
        statusSpan.style.color = '#28a745';
        btn.textContent = 'Stop';
    } else {
        statusSpan.textContent = 'Status: Down';
        statusSpan.style.color = '#dc3545';
        btn.textContent = 'Start';
    }
}

async function toggleVpn() {
    const btn = document.getElementById('start-stop-btn');
    const connectUrl = apiIface('/connect');
    const disconnectUrl = apiIface('/disconnect');
    if (!connectUrl || !disconnectUrl) return;
    if (btn.textContent === 'Start') {
        const r = await fetch(connectUrl, { method: 'POST' });
        const d = await r.json();
        if (d.success) checkVPNStatus();
    } else {
        const r = await fetch(disconnectUrl, { method: 'POST' });
        const d = await r.json();
        if (d.success) checkVPNStatus();
    }
}

// interface editing modal
function setupInterfaceControls() {
    document.getElementById('start-stop-btn').addEventListener('click', toggleVpn);
    document.getElementById('edit-interface-btn').addEventListener('click', openEditInterfaceModal);
    document.getElementById('cancel-edit-if').addEventListener('click', closeEditInterfaceModal);

    // log viewer button
    document.getElementById('view-log-btn').addEventListener('click', openLogModal);
    document.getElementById('log-close-btn').addEventListener('click', closeLogModal);
    document.getElementById('log-backdrop').addEventListener('click', closeLogModal);
    document.getElementById('edit-interface-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const updated = {
            address: document.getElementById('edit-if-address').value,
            listenPort: document.getElementById('edit-if-port').value,
            dns: document.getElementById('edit-if-dns').value,
            mtu: document.getElementById('edit-if-mtu').value,
            preUp: document.getElementById('edit-if-preup').value,
            postUp: document.getElementById('edit-if-postup').value,
            preDown: document.getElementById('edit-if-predown').value,
            postDown: document.getElementById('edit-if-postdown').value,
            saveToFile: true
        };
        try {
            const configureUrl = apiIface('/configure');
            if (!configureUrl) return;
            const res = await fetch(configureUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            });
            const data = await res.json();
            if (data.success) {
                closeEditInterfaceModal();
                await loadInterfaceInfo();
                // also refresh peer list so active count is recalculated
                loadPeers();
            } else {
                alert('Error: ' + data.error);
            }
        } catch (err) { alert(err.message); }
    });

    // generate new key pair from edit modal
    const genBtn = document.getElementById('edit-if-generate-keys');
    if (genBtn) {
        genBtn.addEventListener('click', async () => {
            const output = document.getElementById('edit-if-keys-output');
            if (output) output.innerHTML = 'Generating new key pair...';
            try {
                const genUrl = apiIface('/generate-keys');
                if (!genUrl) return;
                const res = await fetch(genUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: true })
                });
                const data = await res.json();
                if (data.needConfirmation) {
                    // shouldn't happen since we force, but handle just in case
                    if (confirm(data.message)) {
                        genBtn.click();
                    }
                    return;
                }
                if (data.success) {
                    if (output) {
                        output.innerHTML = '<p><strong>New key pair created.</strong></p>';
                        if (data.peers && data.peers.length) {
                            output.innerHTML += `<p>Distributed keys to ${data.peers.length} peers.</p>`;
                        }
                    }
                    await loadInterfaceInfo();
                    loadPeers();
                } else if (output) {
                    output.innerHTML = '<p style="color:red;">Error: ' + data.error + '</p>';
                }
            } catch (err) {
                if (output) output.innerHTML = '<p style="color:red;">Error: ' + err.message + '</p>';
            }
        });
    }
}

function openEditInterfaceModal() {
    const cfg = currentInterfaceConfig;
    document.getElementById('edit-if-address').value = cfg.address || '';
    document.getElementById('edit-if-port').value = cfg.listenPort || '';
    document.getElementById('edit-if-dns').value = cfg.dns || '';
    document.getElementById('edit-if-mtu').value = cfg.mtu || '';
    document.getElementById('edit-if-preup').value = cfg.preUp || '';
    document.getElementById('edit-if-postup').value = cfg.postUp || '';
    document.getElementById('edit-if-predown').value = cfg.preDown || '';
    document.getElementById('edit-if-postdown').value = cfg.postDown || '';
    // clear any previous key-generation messages
    const output = document.getElementById('edit-if-keys-output');
    if (output) output.innerHTML = '';
    document.getElementById('edit-interface-modal').style.display = 'block';
}

function closeEditInterfaceModal() {
    document.getElementById('edit-interface-modal').style.display = 'none';
}

// peer add/delete/enable/disable/edit actions
function setupPeerModals() {
    document.getElementById('add-peer-btn').addEventListener('click', () => {
        document.getElementById('add-peer-modal').style.display = 'block';
    });
    document.getElementById('cancel-add-peer').addEventListener('click', () => {
        document.getElementById('add-peer-modal').style.display = 'none';
    });
    document.getElementById('add-peer-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const peer = {
            name: document.getElementById('new-peer-name').value,
            publicKey: document.getElementById('new-peer-publicKey').value,
            endpoint: document.getElementById('new-peer-endpoint').value,
            allowedIPs: document.getElementById('new-peer-allowedIPs').value,
            persistentKeepalive: document.getElementById('new-peer-keepalive').value,
            rotationKey: document.getElementById('new-peer-rotationKey').value,
            generatePsk: document.getElementById('new-peer-generatePsk').checked
        };
        try {
            const addUrl = apiIface('/peers');
            if (!addUrl) return;
            const res = await fetch(addUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(peer)
            });
            const data = await res.json();
            if (data.success) {
                document.getElementById('add-peer-modal').style.display = 'none';
                loadPeers();
            } else {
                alert('Error: ' + data.error);
            }
        } catch (err) { alert(err.message); }
    });

    // delegate action buttons (table rows)
    document.getElementById('peers-tbody').addEventListener('click', async (ev) => {
        const btn = ev.target.closest('.peer-action-btn');
        if (!btn) return;
        ev.stopPropagation();
        const action = btn.dataset.action;
        const publicKey = btn.dataset.publicKey;
        const iface = getInterfaceIdFromUrl();
        if (!iface || !publicKey) return;
        let url = '';
        let method = 'POST';
        if (action === 'delete') {
            if (!confirm('Delete peer?')) return;
            url = `/api/interfaces/${encodeURIComponent(iface)}/peers/${publicKey}`;
            method = 'DELETE';
        } else if (action === 'enable') {
            url = `/api/interfaces/${encodeURIComponent(iface)}/peers/${publicKey}/enable`;
        } else if (action === 'disable') {
            url = `/api/interfaces/${encodeURIComponent(iface)}/peers/${publicKey}/disable`;
        }
        try {
            const r = await fetch(url, { method });
            const d = await r.json();
            if (d.success) {
                await loadPeers();
            } else {
                alert('Error: ' + d.error);
            }
        } catch (e) {
            alert(e.message);
        }
    })
};

// ─── Log viewer modal ────────────────────────────────────────────
async function openLogModal() {
    const modal = document.getElementById('log-modal');
    const backdrop = document.getElementById('log-backdrop');
    const content = document.getElementById('log-content');
    const title = document.getElementById('log-modal-title');

    // Determine the current interface name from the URL
    const interfaceName = getInterfaceIdFromUrl() || iface;

    title.textContent = `Log: ${interfaceName}`;
    content.innerHTML = '<span class="log-empty">Loading log entries...</span>';

    // Show modal and backdrop
    modal.style.display = 'flex';
    backdrop.style.display = 'block';

    try {
        const res = await fetch(`/api/interface-log/${encodeURIComponent(interfaceName)}`);
        const data = await res.json();

        if (!data.success) {
            content.innerHTML = `<span style="color:#ff6b6b;">Error: ${data.error || 'Unknown error'}</span>`;
            return;
        }

        const logText = (data.log || '').trim();
        if (!logText) {
            content.innerHTML = '<span class="log-empty">No log entries found for this interface.</span>';
        } else {
            // Render each line with subtle coloring
            const lines = logText.split('\n');
            content.innerHTML = lines.map(line => {
                let color = '#c8d0e0';
                if (/Invalid|fail|warn|unallowed|giving up/i.test(line)) color = '#ff8080';
                else if (/success|start/i.test(line)) color = '#7ec8a0';
                const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div style="color:${color};">${escaped}</div>`;
            }).join('');
            // Scroll to bottom so most recent entries are visible
            content.scrollTop = content.scrollHeight;
        }
    } catch (err) {
        content.innerHTML = `<span style="color:#ff6b6b;">Failed to fetch log: ${err.message}</span>`;
    }
}

function closeLogModal() {
    document.getElementById('log-modal').style.display = 'none';
    document.getElementById('log-backdrop').style.display = 'none';
}