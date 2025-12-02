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
    
// Refresh peers every 30 seconds (Giữ nguyên logic cũ của bạn)
setInterval(loadPeers, 30000);

// Graphs for interface 
const iface = window.location.pathname.split("/").pop();
document.getElementById("title").innerText = `Dashboard: ${iface}`;

const speedChart = echarts.init(document.getElementById('speedChart')); // Mới
const bytesChart = echarts.init(document.getElementById('bytesChart'));
const dropRateChart = echarts.init(document.getElementById('dropRateChart')); // Mới
const dropChart = echarts.init(document.getElementById('dropChart'));

let statsHistory = []; 

// Hàm fetchStats mới: Lấy toàn bộ log và vẽ lại
async function fetchStats() {
    try {
        const res = await fetch(`/api/dashboard/${iface}/stats`);
        if (!res.ok) throw new Error("API Error");
        
        const data = await res.json();
        
        // API trả về mảng, ta gán trực tiếp thay vì push từng cái
        if (Array.isArray(data)) {
            statsHistory = data; 
        } else {
            // Fallback nếu API lỗi trả về object đơn lẻ (trường hợp cũ)
            statsHistory = [data];
        }
        
        updateCharts();
    } catch (e) {
        console.error("Failed to fetch stats:", e);
    }
}

function updateCharts() {
    // Format thời gian hiển thị
    const times = statsHistory.map(p => new Date(p.timestamp).toLocaleTimeString());
    const rxBytes = statsHistory.map(p => p.rx_bytes);
    const txBytes = statsHistory.map(p => p.tx_bytes);
    const rxDrop = statsHistory.map(p => p.rx_dropped);
    const txDrop = statsHistory.map(p => p.tx_dropped);

    // 2. Tính toán dữ liệu cho biểu đồ TỐC ĐỘ (Rate) - Mới
    const speedTimes = [];
    const rxSpeed = []; // Bytes/s
    const txSpeed = []; // Bytes/s
    const rxDropRate = []; // Packets/s
    const txDropRate = []; // Packets/s

    for (let i = 1; i < statsHistory.length; i++) {
        const curr = statsHistory[i];
        const prev = statsHistory[i-1];

        // Tính khoảng thời gian giữa 2 lần log (đổi ra giây)
        // Backend gửi timestamp dạng ms, nên chia 1000
        const timeDiff = (curr.timestamp - prev.timestamp) / 1000;

        if (timeDiff > 0) {
            speedTimes.push(new Date(curr.timestamp).toLocaleTimeString());

            // Tính chênh lệch bytes, chia cho thời gian để ra tốc độ (Bytes/s)
            // Math.max(0, ...) để tránh số âm nếu counter bị reset (khi reboot server)
            rxSpeed.push(Math.max(0, curr.rx_bytes - prev.rx_bytes) / timeDiff);
            txSpeed.push(Math.max(0, curr.tx_bytes - prev.tx_bytes) / timeDiff);

            // Tương tự cho dropped packets
            rxDropRate.push(Math.max(0, curr.rx_dropped - prev.rx_dropped) / timeDiff);
            txDropRate.push(Math.max(0, curr.tx_dropped - prev.tx_dropped) / timeDiff);
        }
    }

    // --- Cấu hình biểu đồ ---

    // 1. Biểu đồ Tốc độ (Mới)
    speedChart.setOption({
        title: { text: "Network Speed (Bytes/sec)" },
        tooltip: { trigger: 'axis' },
        legend: { data: ['Download Speed', 'Upload Speed'] },
        xAxis: { type: 'category', data: speedTimes },
        yAxis: { type: 'value' },
        series: [
            { name: "Download Speed", type: 'line', smooth: true, areaStyle: {}, data: rxSpeed },
            { name: "Upload Speed", type: 'line', smooth: true, areaStyle: {}, data: txSpeed }
        ]
    });

    bytesChart.setOption({
        title: { text: "Bandwidth (bytes)" },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: times },
        yAxis: { type: 'value' },
        series: [
            { name: "rx_bytes", type: 'line', data: rxBytes, showSymbol: false }, // showSymbol: false giúp biểu đồ mượt hơn khi nhiều điểm
            { name: "tx_bytes", type: 'line', data: txBytes, showSymbol: false }
        ]
    });

    // 3. Biểu đồ Tốc độ rớt gói (Mới)
    dropRateChart.setOption({
        title: { text: "Packet Drop Rate (Packets/sec)" },
        tooltip: { trigger: 'axis' },
        legend: { data: ['RX Drop Rate', 'TX Drop Rate'] },
        xAxis: { type: 'category', data: speedTimes },
        yAxis: { type: 'value' },
        series: [
            { name: "RX Drop Rate", type: 'line', data: rxDropRate },
            { name: "TX Drop Rate", type: 'line', data: txDropRate }
        ]
    });

    dropChart.setOption({
        title: { text: "Dropped Packets" },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: times },
        yAxis: { type: 'value' },
        series: [
            { name: "rx_dropped", type: 'line', data: rxDrop, showSymbol: false },
            { name: "tx_dropped", type: 'line', data: txDrop, showSymbol: false }
        ]
    });
}

// Gọi lần đầu
fetchStats();

// Refresh mỗi 1 phút (Để cập nhật log mới ghi thêm)
setInterval(fetchStats, 60 * 1000);
};
