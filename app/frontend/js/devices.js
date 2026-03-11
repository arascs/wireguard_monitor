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
        actions += `<button class="btn-disable" onclick="disableDevice(${device.id})">Disable</button>`;
      } else {
        actions += `<button class="btn-enable" onclick="enableDevice(${device.id})">Enable</button>`;
      }
      actions += `<button class="btn-edit-expire" onclick="promptEditExpire(${device.id}, ${device.expire_date || 'null'})">Edit Expire</button>`;
      actions += `<button class="btn-delete" onclick="deleteDevice(${device.id})">Delete</button>`;

      tr.innerHTML = `
        <td>${device.username}</td>
        <td>${device.device_name}</td>
        <td>${device.allowed_ips || ''}</td>
        <td>${device.public_key || ''}</td>
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
            <p><strong>Status:</strong> ${request.status}</p>
          </div>
          <div class="device-status">Waiting for approval</div>
        </div>
        <div class="device-actions" id="actions-${request.id}">
          <button class="btn-approve" onclick="openApproveForm(${request.id}, '${request.username}', '${request.device_name}')">Accept</button>
          <button class="btn-decline" onclick="declineDevice(${request.id})">Decline</button>
        </div>
        <div class="approve-form" id="approve-form-${request.id}" style="display: none;">
          <input type="text" id="allowedips-${request.id}" placeholder="Allowed IPs (e.g., 10.0.0.2/32)" required>
          <input type="date" id="expiredate-${request.id}" placeholder="Expire Date (optional)">
          <div style="display: flex; gap: 10px;">
            <button onclick="approveDevice(${request.id})">Confirm Approve</button>
            <button style="background-color: #6c757d;" onclick="cancelApprove(${request.id})">Cancel</button>
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
    document.getElementById(`allowedips-${id}`).value = '';
    document.getElementById(`expiredate-${id}`).value = '';
  }
}

async function approveDevice(id) {
  const allowedIPs = document.getElementById(`allowedips-${id}`)?.value || '';
  const expireDate = document.getElementById(`expiredate-${id}`)?.value || '';
  if (!allowedIPs) {
    alert('Please enter Allowed IPs');
    return;
  }

  try {
    const res = await fetch('/api/devices/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, allowedIPs, expireDate })
    });
    const data = await res.json();
    if (data.success) {
      if (data.privateKey) {
        showPrivateKeyModal(data.privateKey);
      }
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

function showPrivateKeyModal(privateKey) {
  const modal = document.getElementById('private-key-modal');
  const textarea = document.getElementById('private-key-text');
  textarea.value = privateKey;
  modal.style.display = 'block';
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

  const copyBtn = document.getElementById('copy-key-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('private-key-text');
      const value = textarea.value || '';
      if (!value) {
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          alert('Private key copied to clipboard');
        } else {
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          alert('Please copy the key manually');
        }
      } catch (e) {
        alert('Error copying: ' + e.message);
      }
    });
  }

  const closeBtn = document.getElementById('close-key-modal');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('private-key-modal').style.display = 'none';
      document.getElementById('private-key-text').value = '';
    });
  }
});
