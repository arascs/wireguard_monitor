// --- Helper Functions ---
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getInterfaceIdFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/\/dashboard\/([^\/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

const iface = window.location.pathname.split("/").pop(); // Lấy tên interface hiện tại

// --- 1. Interface Information Logic ---
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

async function loadInterfaceInfo() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        
        if (data.success && data.config) {
            const interface = data.config.interface;
            const interfaceInfo = document.getElementById('interface-info');
            
            // Render HTML, thêm ô "Active Peers" vào cuối danh sách
            interfaceInfo.innerHTML = `
                <div class="interface-info-grid">
                    <div class="info-item">
                        <strong>Public Key</strong>
                        <span>${interface.publicKey ? interface.publicKey.substring(0, 15) + '...' : 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>Address</strong>
                        <span>${interface.address || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>Listen Port</strong>
                        <span>${interface.listenPort || 'Not set'}</span>
                    </div>
                    
                    <!-- MỚI: Ô hiển thị số lượng Active Peers -->
                    <div class="info-item" style="border-color: #007bff; background-color: #e3f2fd;">
                        <strong>Active Peers (< 180s)</strong>
                        <span id="active-peers-stat" style="font-size: 1.1em; font-weight: bold; color: #0056b3;">Loading...</span>
                    </div>

                    <div class="info-item">
                        <strong>DNS</strong>
                        <span>${interface.dns || 'Not set'}</span>
                    </div>
                    <div class="info-item">
                        <strong>MTU</strong>
                        <span>${interface.mtu || 'Not set'}</span>
                    </div>
                    ${interface.preUp ? `<div class="info-item"><strong>PreUp</strong><span>${interface.preUp}</span></div>` : ''}
                    ${interface.postUp ? `<div class="info-item"><strong>PostUp</strong><span>${interface.postUp}</span></div>` : ''}
                    ${interface.preDown ? `<div class="info-item"><strong>PreDown</strong><span>${interface.preDown}</span></div>` : ''}
                    ${interface.postDown ? `<div class="info-item"><strong>PostDown</strong><span>${interface.postDown}</span></div>` : ''}
                </div>
            `;
        } else {
            document.getElementById('interface-info').innerHTML = '<div class="error">Error loading interface information</div>';
        }
    } catch (error) {
        console.error('Error loading interface info:', error);
        document.getElementById('interface-info').innerHTML = `<div class="error">${error.message}</div>`;
    }
}

// --- 2. Peers Logic (With 180s Check) ---
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

        // --- Logic Tính toán Active/Inactive ---
        const nowSec = Math.floor(Date.now() / 1000); // Thời gian hiện tại (giây)
        let activeCount = 0;
        
        // Xử lý dữ liệu từng peer
        const processedPeers = data.map(peer => {
            // Backend phải trả về 'handshake' là Unix timestamp (int)
            const lastHandshake = parseInt(peer.handshake || 0);
            const diff = nowSec - lastHandshake;
            
            // Rule: Active nếu handshake > 0 VÀ cách đây < 180 giây
            // (Giả sử thuộc tính 'status' gốc từ config chỉ cho biết enabled/disabled)
            let calculatedStatus = 'inactive';
            
            if (peer.status === 'disabled') {
                calculatedStatus = 'disabled';
            } else if (lastHandshake > 0 && diff < 180) {
                calculatedStatus = 'active';
                activeCount++;
            }

            // Tạo chuỗi hiển thị thời gian
            let timeAgo = "Never";
            if (lastHandshake > 0) {
                if (diff < 60) timeAgo = `${diff}s ago`;
                else if (diff < 3600) timeAgo = `${Math.floor(diff/60)}m ${diff%60}s ago`;
                else if (diff < 86400) timeAgo = `${Math.floor(diff/3600)}h ago`;
                else timeAgo = new Date(lastHandshake * 1000).toLocaleString();
            }

            return {
                ...peer,
                calculatedStatus,
                timeAgo
            };
        });

        // --- Cập nhật ô thông tin Active/Total ở Interface Grid ---
        const activeStatEl = document.getElementById('active-peers-stat');
        if (activeStatEl) {
            activeStatEl.innerHTML = `${activeCount} <span style="color: #666; font-weight: normal; font-size: 0.8em;">/ ${data.length}</span>`;
        }

        // --- Render Peers ---
        peersContainer.innerHTML = '<div class="peers-grid"></div>';
        const peersGrid = peersContainer.querySelector('.peers-grid');
        
        processedPeers.forEach(peer => {
            const peerCard = document.createElement('div');
            // Gán class để CSS tô màu viền (active/inactive/disabled)
            peerCard.className = `peer-card ${peer.calculatedStatus}`;
            
            peerCard.onclick = () => {
                const link = interfaceId ? `/dashboard/${encodeURIComponent(interfaceId)}/peer/${peer.id}` : `/dashboard/peer/${peer.id}`;
                window.location.href = link;
            };
            
            const badgeClass = `badge-${peer.calculatedStatus}`;
            
            peerCard.innerHTML = `
                <div class="peer-name">
                    ${peer.name || `Peer ${peer.id}`}
                    <span class="peer-badge ${badgeClass}">${peer.calculatedStatus.toUpperCase()}</span>
                </div>
                <div class="peer-public-key">${peer.publicKey || 'No public key'}</div>
                
                <div style="font-size: 0.85em; color: #555; margin-bottom: 8px;">
                    Last Handshake: <strong>${peer.timeAgo}</strong>
                </div>

                <div class="peer-throughput">
                    <div class="peer-throughput-item">
                        <span>RX:</span> <strong>${formatBytes(peer.receivedBytes)}</strong>
                    </div>
                    <div class="peer-throughput-item">
                        <span>TX:</span> <strong>${formatBytes(peer.sentBytes)}</strong>
                    </div>
                </div>
            `;
            
            peersGrid.appendChild(peerCard);
        });
    } catch (error) {
        console.error('Error loading peers:', error);
        document.getElementById('peers-container').innerHTML = '<div class="error">Error: ' + error.message + '</div>';
    }
}

// --- 3. Charts Logic (Stats from Logs) ---
document.getElementById("title").innerText = `Dashboard: ${iface}`;

const rxSpeedChart = echarts.init(document.getElementById('rxSpeedChart'));
const txSpeedChart = echarts.init(document.getElementById('txSpeedChart'));
const rxDropRateChart = echarts.init(document.getElementById('rxDropRateChart'));
const txDropRateChart = echarts.init(document.getElementById('txDropRateChart'));

let statsHistory = []; 

async function fetchStats() {
    try {
        const res = await fetch(`/api/dashboard/${iface}/stats`);
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
        const prev = filteredData[i-1];
        
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
            lineStyle: { color: '#007bff' }, // Màu xanh cho RX
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
            lineStyle: { color: '#28a745' }, // Màu xanh lá cho TX
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
            lineStyle: { color: '#dc3545' }, // Màu đỏ
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
            lineStyle: { color: '#fd7e14' }, // Màu cam
            itemStyle: { color: '#fd7e14' },
            data: txDropData.rates
        }]
    });
}

// --- 4. Initialization ---
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
    fetchStats();
    
    setInterval(loadPeers, 30000); 
    setInterval(fetchStats, 60000); 
};

// Handle resize for all charts
window.addEventListener('resize', function() {
    rxSpeedChart.resize();
    txSpeedChart.resize();
    rxDropRateChart.resize();
    txDropRateChart.resize();
});