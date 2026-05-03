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
        return await response.json();
    } catch (error) {
        console.error('Error setting interface:', error);
        return { success: false };
    }
}

// Khởi tạo khung biểu đồ
function initChartFrames() {
    const rxEl = document.getElementById('peerRxSpeedChart');
    const txEl = document.getElementById('peerTxSpeedChart');
    if (!rxEl || !txEl || peerRxSpeedChart) return;

    const commonOption = {
        tooltip: { trigger: 'axis' },
        grid: { left: '65', right: '25', bottom: '30' },
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value', name: 'Bytes/s' }
    };

    peerRxSpeedChart = echarts.init(rxEl);
    peerRxSpeedChart.setOption({
        ...commonOption,
        title: { text: "Download Speed (RX)", left: 'center' },
        series: [{ name: "Download", type: 'line', smooth: true, areaStyle: { opacity: 0.2 }, lineStyle: { color: '#007bff' }, itemStyle: { color: '#007bff' }, data: [] }]
    });

    peerTxSpeedChart = echarts.init(txEl);
    peerTxSpeedChart.setOption({
        ...commonOption,
        title: { text: "Upload Speed (TX)", left: 'center' },
        series: [{ name: "Upload", type: 'line', smooth: true, areaStyle: { opacity: 0.2 }, lineStyle: { color: '#28a745' }, itemStyle: { color: '#28a745' }, data: [] }]
    });
}

async function loadPeerPage() {
    const { interfaceId, peerId } = getIdsFromUrl();
    if (peerId === null) return;

    if (interfaceId) {
        await setInterface(interfaceId);
    }

    try {
        const peerUrl = interfaceId 
            ? `/api/dashboard/peer/${peerId}?interface=${encodeURIComponent(interfaceId)}`
            : `/api/dashboard/peer/${peerId}`;

        const [peerRes, statsRes] = await Promise.all([
            fetch(peerUrl).then(r => r.json()),
            fetchPeerStatsData(interfaceId, peerId) // lấy data stats
        ]);

        // Dựng khung và điền dữ liệu 
        renderSkeleton(peerRes);
        currentPeerName = peerRes.name || null;
        
        // Khởi tạo chart và nạp dữ liệu stats đã lấy được
        initChartFrames();
        if (statsRes) {
            peerStatsHistory = statsRes;
            updatePeerCharts();
        }

        // Tải nốt phần connections
        loadPeerConnections(interfaceId, currentPeerName);

    } catch (error) {
        console.error("Error loading peer page:", error);
    }
}

// Hàm bổ trợ dựng khung HTML và điền data lần đầu
function renderSkeleton(peer) {
    if (document.getElementById('peer-skeleton')) return;

    const statusColors = { active: '#28a745', inactive: '#6c757d', disabled: '#dc3545' };
    const statusColor = statusColors[peer.status] || '#6c757d';

    const content = `
        <div id="peer-skeleton">
            <div class="peer-header">
                <div class="peer-name">${peer.name || `Peer ${peer.id}`}</div>
            </div>

            <!-- Connection Information + Throughput -->
            <div class="detail-section" style="background:#fff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.07);padding:14px;margin-bottom:10px;">
                <h3>Peer Information</h3>
                <table class="detail-table">
                    <tbody>
                        <tr><th>Status</th><td><span id="peer-status-badge" style="display:inline-block;padding:2px 10px;border-radius:4px;background:${statusColor};color:#fff;font-size:0.8rem;font-weight:600;">${peer.status.toUpperCase()}</span></td></tr>
                        <tr><th>Public Key</th><td>${peer.publicKey || 'Not set'}</td></tr>
                        <tr><th>Endpoint</th><td id="peer-endpoint-val">${peer.endpoint || 'Not set'}</td></tr>
                        <tr><th>Allowed IPs</th><td>${peer.allowedIPs || 'Not set'}</td></tr>
                        <tr><th>Latest Handshake</th><td id="peer-handshake-val">${calculateHandshake(peer.handshake)}</td></tr>
                        <tr><th>Received (RX)</th><td id="peer-rx-human">${formatBytes(peer.receivedBytes)}</td></tr>
                        <tr><th>Sent (TX)</th><td id="peer-tx-human">${formatBytes(peer.sentBytes)}</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- Active Sessions -->
            <div id="connections-section" class="detail-section" style="box-shadow:0 1px 4px rgba(0,0,0,.07);background:#fff;border-radius:6px;padding:14px;margin-bottom:10px;"></div>

            <!-- Peer Statistics Charts -->
            <div class="detail-section" style="box-shadow:0 1px 4px rgba(0,0,0,.07);background:#fff;border-radius:6px;padding:14px;margin-bottom:10px;">
                <h3>Peer Statistics</h3>
                <div class="filter-form">
                    <label>From: <input type="date" id="peerStartDate"></label>
                    <label>To: <input type="date" id="peerEndDate"></label>
                    <button id="applyPeerFilter">Apply Filter</button>
                    <button id="clearPeerFilter">Clear</button>
                </div>
                <div class="charts-pair">
                    <div id="peerRxSpeedChart" style="height:260px;"></div>
                    <div id="peerTxSpeedChart" style="height:260px;"></div>
                </div>
            </div>
        </div>
    `;
    document.getElementById('peer-detail-content').innerHTML = content;
    setupFilterEventListeners();
}




function calculateHandshake(timestamp) {
    if (!timestamp) return "Never";
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    return new Date(timestamp * 1000).toLocaleString();
}

async function fetchPeerStatsData(interfaceId, peerId, startTs = null, endTs = null) {
    let url = `/api/dashboard/${encodeURIComponent(interfaceId)}/peer/${peerId}/stats`;
    const params = [];
    if (startTs) params.push(`start=${startTs}`);
    if (endTs) params.push(`end=${endTs}`);
    if (params.length) url += '?' + params.join('&');
    const res = await fetch(url);
    return res.ok ? await res.json() : [];
}

async function refreshPeerDataOnly() {
    const { interfaceId, peerId } = getIdsFromUrl();
    try {
        const url = interfaceId ? `/api/dashboard/peer/${peerId}?interface=${encodeURIComponent(interfaceId)}` : `/api/dashboard/peer/${peerId}`;
        const response = await fetch(url);
        const peer = await response.json();

        const statusColors = { active: '#28a745', inactive: '#6c757d', disabled: '#dc3545' };
        const badge = document.getElementById('peer-status-badge');
        if (badge) {
            badge.style.background = statusColors[peer.status] || '#6c757d';
            badge.innerText = peer.status.toUpperCase();
        }
        document.getElementById('peer-handshake-val').innerText = calculateHandshake(peer.handshake);
        document.getElementById('peer-rx-human').innerText = formatBytes(peer.receivedBytes);
        document.getElementById('peer-tx-human').innerText = formatBytes(peer.sentBytes);
        document.getElementById('peer-endpoint-val').innerText = peer.endpoint || 'Not set';
    } catch (e) { console.error(e); }
}


// Cập nhật biểu đồ qua setOption
function updatePeerCharts() {
    if (!peerRxSpeedChart || !peerTxSpeedChart) return;
    
    const rxSpeedData = calculatePeerMetricRate(peerStatsHistory, 'rx_bytes');
    const txSpeedData = calculatePeerMetricRate(peerStatsHistory, 'tx_bytes');

    // Chỉ truyền data, không truyền lại title/grid
    peerRxSpeedChart.setOption({
        xAxis: { data: rxSpeedData.times },
        series: [{ data: rxSpeedData.rates }]
    });

    peerTxSpeedChart.setOption({
        xAxis: { data: txSpeedData.times },
        series: [{ data: txSpeedData.rates }]
    });
}

// Load peer connections from JSON file
async function loadPeerConnections(interfaceId, peerName) {
    try {
        if (!peerName) {
            console.warn('Peer name is not available for connections request');
            return;
        }
        const url = `/api/dashboard/${encodeURIComponent(interfaceId)}/peer/${encodeURIComponent(peerName)}/connections`;
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
            <h3>Active Sessions</h3>
            <div style="margin-bottom: 10px; font-size: 0.9em; color: #666;">
                Last updated: ${data.last_updated ? formatDateTime(data.last_updated) : 'N/A'} | 
                Active connections: ${data.active_connections_count || 0}
            </div>
        `;
        
        if (data.sessions && data.sessions.length > 0) {
            tableHTML += `
                <table style="width: 100%; border-collapse: collapse; border: 1px solid #861618;">
                    <thead>
                        <tr style="background-color: #861618; color: white;">
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Source</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Service</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Resource IP:Port</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Protocol</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Start Time</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Duration</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Bytes</th>
                            <th style="padding: 10px; border: 1px solid #861618; text-align: center;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            data.sessions.forEach((session, index) => {
                const sessionId = `session-${index}`;
                const dir1 = session.direction1 || { packets: 0, bytes: 0 };
                const dir2 = session.direction2 || { packets: 0, bytes: 0 };
                tableHTML += `
                    <tr>
                        <td style="padding: 10px; border: 1px solid #861618;">${session.source || 'N/A'}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${session.service || 'N/A'}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${session.resource_ip_port || 'N/A'}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${(session.protocol || 'N/A').toUpperCase()}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${formatDateTime(session.start_time)}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${formatDuration(session.duration_sec)}</td>
                        <td style="padding: 10px; border: 1px solid #861618;">${formatBytes(session.bytes || 0)}</td>
                        <td style="padding: 10px; border: 1px solid #861618; text-align: center;">
                            <button onclick="toggleConnectionDetails(${index})" style="padding: 5px 10px; cursor: pointer; border: 1px solid #861618; background: #fff; color: #861618;">View Details</button>
                        </td>
                    </tr>
                    <tr id="detail-${index}" style="display: none;">
                        <td colspan="8" style="padding: 15px; border: 1px solid #861618; background-color: #f9f9f9;">
                            <div style="margin-left: 20px;">
                                <div style="margin-bottom: 10px;">
                                    <strong>Direction 1: ${session.source || 'N/A'} → ${session.resource_ip_port || 'N/A'}</strong><br>
                                    Packets: ${dir1.packets || 0} | Bytes: ${formatBytes(dir1.bytes || 0)}
                                </div>
                                <div>
                                    <strong>Direction 2: ${session.resource_ip_port || 'N/A'} → ${session.source || 'N/A'}</strong><br>
                                    Packets: ${dir2.packets || 0} | Bytes: ${formatBytes(dir2.bytes || 0)}
                                </div>
                            </div>
                        </td>
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

function toggleConnectionDetails(index) {
    const detailRow = document.getElementById(`detail-${index}`);
    if (detailRow) {
        if (detailRow.style.display === 'none') {
            detailRow.style.display = '';
        } else {
            detailRow.style.display = 'none';
        }
    }
}

// Peer Charts Logic
let peerStatsHistory = [];
let peerRxSpeedChart, peerTxSpeedChart;
let currentPeerName = null;

async function fetchPeerStats(interfaceId, peerId, startTs = null, endTs = null) {
    try {
        let url = `/api/dashboard/${encodeURIComponent(interfaceId)}/peer/${peerId}/stats`;
        const params = [];
        if (startTs) params.push(`start=${startTs}`);
        if (endTs) params.push(`end=${endTs}`);
        if (params.length) url += '?' + params.join('&');
        
        const res = await fetch(url);
        if (!res.ok) throw new Error("API Error");
        
        const data = await res.json();
        
        if (Array.isArray(data)) {
            peerStatsHistory = data;
        } else {
            peerStatsHistory = [data];
        }
        
        updatePeerCharts();
    } catch (e) {
        console.error("Failed to fetch peer stats:", e);
    }
}

function calculatePeerMetricRate(data, metricKey) {
    const filteredData = data.filter(item => item[metricKey] !== undefined && item[metricKey] !== null);
    
    const times = [];
    const rates = [];

    for (let i = 1; i < filteredData.length; i++) {
        const curr = filteredData[i];
        const prev = filteredData[i-1];
        
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

function setupFilterEventListeners() {
    document.getElementById('applyPeerFilter').onclick = async () => {
        const { interfaceId, peerId } = getIdsFromUrl();
        const start = document.getElementById('peerStartDate').value;
        const end = document.getElementById('peerEndDate').value;
        const sTs = start ? Math.floor(new Date(start).getTime() / 1000) : null;
        const eTs = end ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : null;
        peerStatsHistory = await fetchPeerStatsData(interfaceId, peerId, sTs, eTs);
        updatePeerCharts();
    };
    document.getElementById('clearPeerFilter').onclick = async () => {
        document.getElementById('peerStartDate').value = '';
        document.getElementById('peerEndDate').value = '';
        const { interfaceId, peerId } = getIdsFromUrl();
        peerStatsHistory = await fetchPeerStatsData(interfaceId, peerId);
        updatePeerCharts();
    };
}

// sidebar helper
function initSidebar() {
    const sidebarItems = document.querySelectorAll('.sidebar-item');
    const currentSection = 'connections';
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

// edit peer modal logic
function setupEditPeerModal() {
    const btn = document.getElementById('edit-peer-btn');
    const modal = document.getElementById('edit-peer-modal');
    const cancelBtn = document.getElementById('cancel-edit-peer');
    const form = document.getElementById('edit-peer-form');
    let currentPeer = null;

    if (!btn) return;
    btn.addEventListener('click', async () => {
        const ids = getIdsFromUrl();
        // peerId may be 0 so guard against null/undefined rather than falsy
        if (ids.peerId === null || ids.peerId === undefined) return;
        const url = ids.interfaceId ?
            `/api/dashboard/peer/${ids.peerId}?interface=${encodeURIComponent(ids.interfaceId)}` :
            `/api/dashboard/peer/${ids.peerId}`;
        try {
            const res = await fetch(url);
            const peerData = await res.json();
            currentPeer = peerData;
            document.getElementById('edit-peer-name').value = peerData.name || '';
            document.getElementById('edit-peer-publicKey').value = peerData.publicKey || '';
            document.getElementById('edit-peer-endpoint').value = peerData.endpoint || '';
            document.getElementById('edit-peer-allowedIPs').value = peerData.allowedIPs || '';
            document.getElementById('edit-peer-keepalive').value = peerData.persistentKeepalive || '';
            modal.style.display = 'block';
        } catch (e) {
            console.error(e);
        }
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentPeer) return;
        const ids = getIdsFromUrl();
        const peerId = ids.peerId;
        const payload = {
            name: document.getElementById('edit-peer-name').value,
            publicKey: document.getElementById('edit-peer-publicKey').value,
            endpoint: document.getElementById('edit-peer-endpoint').value,
            allowedIPs: document.getElementById('edit-peer-allowedIPs').value,
            persistentKeepalive: document.getElementById('edit-peer-keepalive').value
        };
        try {
            const path = `/api/edit-peer/${peerId}`;
            const res = await fetch(path, {
                method: 'PUT', headers:{'Content-Type':'application/json'},
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                // persist the updated configuration to disk
                await fetch('/api/save-config', { method: 'POST' });
                modal.style.display = 'none';
                // reload entire peer page so name/allowedIPs etc update
                await loadPeerPage();
            } else {
                alert('Error: '+data.error);
            }
        } catch(err){ alert(err.message); }
    });
}

function initPeerDetail() {
    initSidebar();
    setupEditPeerModal();
    loadPeerPage();

    setInterval(() => {
        const { interfaceId, peerId } = getIdsFromUrl();
        if (interfaceId && peerId !== null) {
            refreshPeerDataOnly();
            if (currentPeerName) {
                loadPeerConnections(interfaceId, currentPeerName);
            }
            fetchPeerStatsData(interfaceId, peerId).then(data => {
                peerStatsHistory = data;
                updatePeerCharts();
            });
        }
    }, 30000);
}

initPeerDetail();

