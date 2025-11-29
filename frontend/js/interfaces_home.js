const interfacesContainer = document.getElementById('interfaces-container');
const emptyState = document.getElementById('interfaces-empty');
const addInterfaceBtn = document.getElementById('add-interface-btn');

function renderInterfaces(items) {
    interfacesContainer.innerHTML = '';
    if (!items.length) {
        emptyState.style.display = 'block';
        return;
    }
    emptyState.style.display = 'none';
    items.forEach((iface) => {
        const card = document.createElement('div');
        card.className = 'interface-card';
        const statusClass = iface.status === 'connected' ? 'connected' : 'disconnected';
        const publicKey = iface.publicKey || 'Chưa có';
        const address = iface.address || 'Chưa cấu hình';
        card.innerHTML = `
            <h3>${iface.name}</h3>
            <p><strong>Public Key:</strong> ${publicKey}</p>
            <p><strong>Address:</strong> ${address}</p>
            <p class="interface-status ${statusClass}">Status: ${iface.status === 'connected' ? 'Connected' : 'Disconnected'}</p>
            <button data-name="${iface.name}" class="edit-btn">Edit Interface</button>
            <button data-name="${iface.name}" class="monitor-btn">Monitor</button>
        `;
        card.querySelector('.edit-btn').addEventListener('click', () => {
            window.location.href = `/editInterface/${encodeURIComponent(iface.name)}`;
        });
        card.querySelector('.monitor-btn').addEventListener('click', () => {
            window.location.href = `/dashboard/${encodeURIComponent(iface.name)}`;
        });
        interfacesContainer.appendChild(card);
    });
}

async function loadInterfaces() {
    try {
        const response = await fetch('/api/interfaces');
        const data = await response.json();
        if (data.success) {
            renderInterfaces(data.interfaces || []);
        } else {
            renderInterfaces([]);
            alert(data.error || 'Không thể tải danh sách interface');
        }
    } catch (error) {
        renderInterfaces([]);
        alert(error.message || 'Có lỗi xảy ra khi tải danh sách interface');
    }
}

function handleAddInterface() {
    const name = prompt('Nhập tên interface mới (ví dụ wgA):');
    if (!name) {
        return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
        return;
    }
    window.location.href = `/addInterface/${encodeURIComponent(trimmed)}`;
}

document.addEventListener('DOMContentLoaded', () => {
    loadInterfaces();
    addInterfaceBtn.addEventListener('click', handleAddInterface);
});

