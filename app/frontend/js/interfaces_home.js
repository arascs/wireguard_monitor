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
        const typeLabel = iface.type ? iface.type : '';
        const typeBadgeColor = iface.type === 'Client' ? '#1a73e8' : (iface.type === 'Site' ? '#388e3c' : '#888');
        const typeBadge = typeLabel
            ? `<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${typeBadgeColor};color:#fff;font-size:0.78rem;font-weight:600;margin-bottom:6px;">${typeLabel}</span>`
            : '';
        card.innerHTML = `
            <h3>${iface.name}</h3>
            ${typeBadge}
            <p><strong>Public Key:</strong> ${publicKey}</p>
            <p><strong>Address:</strong> ${address}</p>
            <p class="interface-status ${statusClass}">Status: ${iface.status === 'connected' ? 'Up' : 'Down'}</p>
            <div class="interface-buttons">
                <button data-name="${iface.name}" class="details-btn">Details</button>
                <button data-name="${iface.name}" class="delete-btn">Delete</button>
            </div>
        `;
        card.querySelector('.details-btn').addEventListener('click', () => {
            // go to dashboard/details page for this interface
            window.location.href = `/dashboard/${encodeURIComponent(iface.name)}`;
        });
        card.querySelector('.delete-btn').addEventListener('click', async () => {
            if (confirm(`Bạn có chắc muốn xóa interface ${iface.name}?`)) {
                try {
                    const response = await fetch(`/api/delete-interface/${encodeURIComponent(iface.name)}`, {
                        method: 'DELETE'
                    });
                    const data = await response.json();
                    if (data.success) {
                        loadInterfaces();
                    } else {
                        alert('Lỗi: ' + (data.error || 'Không thể xóa interface'));
                    }
                } catch (error) {
                    alert('Lỗi: ' + error.message);
                }
            }
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
            alert(data.error || 'Cannot load interface list');
        }
    } catch (error) {
        renderInterfaces([]);
        alert(error.message || 'Error loading interface list');
    }
}

// open modal to collect interface details
function showAddInterfaceModal() {
    const modal = document.getElementById('add-interface-modal');
    if (modal) {
        modal.style.display = 'block';
    }
}

function hideAddInterfaceModal() {
    const modal = document.getElementById('add-interface-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}


async function submitAddInterfaceForm(e) {
    e.preventDefault();
    const name = document.getElementById('new-interface-name').value.trim();
    if (!name) {
        alert('Interface name is required');
        return;
    }
    const type = document.getElementById('new-interface-type').value;
    // optional fields
    const address = document.getElementById('new-interface-address').value.trim();
    const listenPort = document.getElementById('new-interface-listenPort').value.trim();
    const dns = document.getElementById('new-interface-dns').value.trim();
    const mtu = document.getElementById('new-interface-mtu').value.trim();
    const preUp = document.getElementById('new-interface-preUp').value.trim();
    const postUp = document.getElementById('new-interface-postUp').value.trim();
    const preDown = document.getElementById('new-interface-preDown').value.trim();
    const postDown = document.getElementById('new-interface-postDown').value.trim();

    try {
        const payload = { name, type };
        if (address) payload.address = address;
        if (listenPort) payload.listenPort = listenPort;
        if (dns) payload.dns = dns;
        if (mtu) payload.mtu = mtu;
        if (preUp) payload.preUp = preUp;
        if (postUp) payload.postUp = postUp;
        if (preDown) payload.preDown = preDown;
        if (postDown) payload.postDown = postDown;

        const response = await fetch('/api/add-interface', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            alert('Error: ' + (data.error || 'Cannot create interface'));
            return;
        }

        hideAddInterfaceModal();
        // after creation redirect to dashboard for new interface
        window.location.href = `/dashboard/${encodeURIComponent(name)}`;
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function handleSyncKeys() {
    try {
        const response = await fetch('/api/sync-keys', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('Keys synchronized successfully.');
            loadInterfaces();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadInterfaces();
    addInterfaceBtn.addEventListener('click', showAddInterfaceModal);
    document.getElementById('sync-keys-btn').addEventListener('click', handleSyncKeys);
    // modal cancel button
    const cancelBtn = document.getElementById('cancel-add-interface');
    if (cancelBtn) cancelBtn.addEventListener('click', hideAddInterfaceModal);
    const form = document.getElementById('add-interface-form');
    if (form) form.addEventListener('submit', submitAddInterfaceForm);
});

