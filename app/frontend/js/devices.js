async function loadApprovedDevices() {
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load devices');
      return;
    }
    const tbody = document.getElementById('approved-devices-body');
    tbody.innerHTML = '';
    (data.devices || []).forEach(device => {
      const expireDateStr = device.expire_date ? new Date(device.expire_date * 1000).toLocaleDateString() : 'Never';
      const statusText = device.status === 1 ? 'Enabled' : 'Disabled';
      const tr = document.createElement('tr');
      let actions = '';
      if (device.status === 1) {
        actions += `<button class="btn-disable" title="Disable" onclick="disableDevice(${device.id})"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/></svg></button>`;
      } else {
        actions += `<button class="btn-enable" title="Enable" onclick="enableDevice(${device.id})"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/></svg></button>`;
      }
      actions += `<button class="btn-edit-expire" title="Edit Expire" onclick="promptEditExpire(${device.id}, ${device.expire_date || 'null'})"><svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg></button>`;
      actions += `<button class="btn-delete" title="Delete" onclick="deleteDevice(${device.id})"><svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>`;

      tr.innerHTML = `
        <td>${device.username}</td>
        <td>${device.device_name}</td>
        <td>${device.interface || ''}</td>
        <td>${device.allowed_ips || ''}</td>
        <td>${device.public_key || ''}</td>
        <td>${device.machine_id || ''}</td>
        <td>${expireDateStr}</td>
        <td>${statusText}</td>
        <td>${actions}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    alert(e.message || 'Error loading devices');
  }
}

async function loadRequests() {
  try {
    // Fetch Client interfaces for the dropdown
    let clientInterfaces = [];
    try {
      const ifaceRes = await fetch('/api/interfaces/client');
      const ifaceData = await ifaceRes.json();
      if (ifaceData.success) {
        clientInterfaces = ifaceData.interfaces || [];
      }
    } catch (e) {
      console.warn('Could not fetch client interfaces:', e.message);
    }

    // Build select options HTML
    const optionsHtml = clientInterfaces.length > 0
      ? clientInterfaces.map(i => `<option value="${i.name}">${i.name}</option>`).join('')
      : '<option value="">-- No Client interfaces --</option>';

    const res = await fetch('/api/enrollment-requests');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load requests');
      return;
    }

    const container = document.getElementById('devices-container');
    const requests = data.requests || [];

    if (requests.length === 0) {
      container.innerHTML = '<div class="empty-message">No enrollment requests</div>';
      return;
    }

    container.innerHTML = '';
    requests.forEach(request => {
      const div = document.createElement('div');
      div.className = 'device-request';
      div.innerHTML = `
        <div class="device-request-header">
          <div class="device-info">
            <h3>${request.device_name || 'Unknown Device'}</h3>
            <p><strong>Username:</strong> ${request.username}</p>
            <p><strong>Machine ID:</strong> ${request.machine_id || '<em>N/A</em>'}</p>
            <p><strong>Public Key:</strong> ${request.public_key || '<em>N/A</em>'}</p>
            <p><strong>Status:</strong> ${request.status}</p>
          </div>
          <div class="device-status">Waiting for approval</div>
        </div>
        <div class="device-actions" id="actions-${request.id}">
          <button class="btn-approve" onclick="openApproveForm(${request.id}, '${request.username}', '${request.device_name}')">Accept</button>
          <button class="btn-decline" onclick="declineDevice(${request.id})">Decline</button>
        </div>
        <div class="approve-form" id="approve-form-${request.id}" style="display: none;">
          <label style="display:block;margin-bottom:4px;font-size:0.9rem;">Interface (Client type):</label>
          <select id="interface-${request.id}" style="width:100%;padding:8px;margin-bottom:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:0.9rem;">
            ${optionsHtml}
          </select>
          <input type="text" id="allowedips-${request.id}" placeholder="Allowed IPs (e.g., 10.0.0.2/32)" required>
          <input type="date" id="expiredate-${request.id}" placeholder="Expire Date (optional)">
          <div style="display: flex; gap: 10px;">
            <button onclick="approveDevice(${request.id})">Confirm Approve</button>
            <button onclick="cancelApprove(${request.id})">Cancel</button>
          </div>
        </div>
      `;
      container.appendChild(div);
    });
  } catch (e) {
    alert(e.message || 'Error loading requests');
  }
}

function openApproveForm(id, username, deviceName) {
  const form = document.getElementById(`approve-form-${id}`);
  if (form) {
    form.style.display = 'block';
  }
}

function cancelApprove(id) {
  const form = document.getElementById(`approve-form-${id}`);
  if (form) {
    form.style.display = 'none';
    const ifaceSelect = document.getElementById(`interface-${id}`);
    if (ifaceSelect) ifaceSelect.selectedIndex = 0;
    document.getElementById(`allowedips-${id}`).value = '';
    document.getElementById(`expiredate-${id}`).value = '';
  }
}

async function approveDevice(id) {
  const selectedInterface = document.getElementById(`interface-${id}`)?.value || '';
  const allowedIPs = document.getElementById(`allowedips-${id}`)?.value || '';
  const expireDate = document.getElementById(`expiredate-${id}`)?.value || '';
  if (!selectedInterface) {
    alert('Please select an Interface');
    return;
  }
  if (!allowedIPs) {
    alert('Please enter Allowed IPs');
    return;
  }

  try {
    const res = await fetch('/api/devices/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, interface: selectedInterface, allowedIPs, expireDate })
    });
    const data = await res.json();
    if (data.success) {
      loadRequests();
    } else {
      alert(data.error || 'Failed to approve device');
    }
  } catch (e) {
    alert(e.message || 'Error approving device');
  }
}

async function declineDevice(id) {
  if (!confirm('Are you sure you want to decline this enrollment request?')) {
    return;
  }

  try {
    const res = await fetch('/api/devices/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      loadRequests();
    } else {
      alert(data.error || 'Failed to decline request');
    }
  } catch (e) {
    alert(e.message || 'Error declining request');
  }
}

async function deleteDevice(id) {
  if (!confirm('Are you sure you want to delete this device? This action cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch(`/api/devices/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      loadApprovedDevices(); // Reload the approved devices list
    } else {
      alert(data.error || 'Failed to delete device');
    }
  } catch (e) {
    alert(e.message || 'Error deleting device');
  }
}

// helper functions for enable/disable/expire editing
async function enableDevice(id) {
  try {
    const res = await fetch(`/api/enable-device/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('Device enabled');
      loadApprovedDevices();
    } else {
      alert(data.error || 'Failed to enable device');
    }
  } catch (e) {
    alert(e.message || 'Error enabling device');
  }
}

async function disableDevice(id) {
  try {
    const res = await fetch(`/api/disable-device/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('Device disabled');
      loadApprovedDevices();
    } else {
      alert(data.error || 'Failed to disable device');
    }
  } catch (e) {
    alert(e.message || 'Error disabling device');
  }
}

function promptEditExpire(id, currentEpoch) {
  const currentDate = currentEpoch ? new Date(currentEpoch * 1000).toISOString().split('T')[0] : '';
  const newDate = prompt('Enter new expiration date (YYYY-MM-DD):', currentDate);
  if (!newDate) return;
  const epoch = Math.floor(new Date(newDate).getTime() / 1000);
  if (isNaN(epoch)) {
    alert('Invalid date');
    return;
  }
  editExpire(id, epoch);
}

async function editExpire(id, epoch) {
  try {
    const res = await fetch(`/api/devices/${id}/expire-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expireDate: epoch })
    });
    const data = await res.json();
    if (data.success) {
      alert('Expiration updated');
      loadApprovedDevices();
    } else {
      alert(data.error || 'Failed to update expiration');
    }
  } catch (e) {
    alert(e.message || 'Error updating expiration');
  }
}

function switchTab(tabName) {
  const approvedView = document.getElementById('approved-view');
  const requestsView = document.getElementById('requests-view');
  const tabApproved = document.getElementById('tab-approved');
  const tabRequests = document.getElementById('tab-requests');
  const sidebarDevices = document.querySelector('.sidebar-item[data-section="devices"]');

  if (tabName === 'approved') {
    approvedView.style.display = 'block';
    requestsView.style.display = 'none';
    tabApproved.classList.add('active');
    tabRequests.classList.remove('active');
    loadApprovedDevices();
  } else if (tabName === 'requests') {
    approvedView.style.display = 'none';
    requestsView.style.display = 'block';
    tabApproved.classList.remove('active');
    tabRequests.classList.add('active');
    loadRequests();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadApprovedDevices();

  const tabApproved = document.getElementById('tab-approved');
  const tabRequests = document.getElementById('tab-requests');

  if (tabApproved) {
    tabApproved.addEventListener('click', () => switchTab('approved'));
  }

  if (tabRequests) {
    tabRequests.addEventListener('click', () => switchTab('requests'));
  }
});
