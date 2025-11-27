async function loadWG() {
    const res = await fetch("/api/dashboard/wg");
    const data = await res.json();

    // Chuẩn bị dữ liệu cho ECharts
    const peers = data.map(p => p.peer);
    const receivedBytes = data.map(p => convertBytes(p.received));
    const sentBytes = data.map(p => convertBytes(p.sent));

    const chartDom = document.getElementById('chart');
    const chart = echarts.init(chartDom);

    const option = {
        title: { text: "WireGuard Traffic per Peer" },
        tooltip: {},
        legend: { data: ['Received', 'Sent']},
        xAxis: { type: 'category', data: peers },
        yAxis: { type: 'value' },
        series: [
            { name: 'Received', type: 'bar', data: receivedBytes },
            { name: 'Sent', type: 'bar', data: sentBytes }
        ]
    };

    chart.setOption(option);
}

function convertBytes(s) {
    if (s.includes("KiB")) return parseFloat(s) * 1024;
    if (s.includes("MiB")) return parseFloat(s) * 1024 * 1024;
    if (s.includes("B")) return parseFloat(s);
    return 0;
}

loadWG();
