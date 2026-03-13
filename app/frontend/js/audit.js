async function loadAuditLogs() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/audit-logs', { credentials: 'same-origin' });
    let data;
    try {
      data = await res.json();
    } catch (e) {
      alert('Failed to load logs: ' + e.message);
      return;
    }
    if (!data.success) {
      alert(data.error || 'Cannot load audit logs');
      return;
    }

    // set header row
    const headerRow = document.getElementById('log-header-row');
    headerRow.innerHTML = `
      <th>Timestamp</th>
      <th>Admin</th>
      <th>Action</th>
      <th>Details</th>
    `;

    (data.logs || []).forEach((entry, idx) => {
      const dateStr = new Date(entry.timestamp).toLocaleString();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${dateStr}</td>
        <td>${entry.admin}</td>
        <td>${entry.action}</td>
        <td><button data-idx="${idx}" class="btn-view-details">View</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-view-details').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-idx');
        const entry = data.logs[idx];
        if (entry) {
          alert(JSON.stringify(entry.details, null, 2));
        }
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading logs');
  }
}

async function loadSessionLogs() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/session-logs', { credentials: 'same-origin' });
    let data;
    try {
      data = await res.json();
    } catch (e) {
      alert('Failed to load session logs: ' + e.message);
      return;
    }
    if (!data.success) {
      alert(data.error || 'Cannot load session logs');
      return;
    }

    const headerRow = document.getElementById('log-header-row');
    headerRow.innerHTML = `
      <th>Start Time</th>
      <th>End Time</th>
      <th>Peer IP</th>
      <th>Peer Name</th>
      <th>App</th>
      <th>Details</th>
    `;

    (data.logs || []).forEach((entry, idx) => {
      const startStr = new Date(entry.start_time).toLocaleString();
      const endStr = new Date(entry.end_time).toLocaleString();
      const peerIp = entry.source ? entry.source.split(':')[0] : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${startStr}</td>
        <td>${endStr}</td>
        <td>${peerIp}</td>
        <td>${entry.peer_name || ''}</td>
        <td>${entry.service || ''}</td>
        <td><button data-idx="${idx}" class="btn-view-details">View</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-view-details').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-idx');
        const entry = data.logs[idx];
        if (entry) {
          alert(JSON.stringify({
            direction1: entry.direction1,
            direction2: entry.direction2,
            total_bytes: entry.total_bytes,
            duration_sec: entry.duration_sec
          }, null, 2));
        }
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading session logs');
  }
}

function switchTo(type) {
  const btnAudit = document.getElementById('tab-audit');
  const btnSess = document.getElementById('tab-sessions');
  const title = document.getElementById('section-title');
  const sidebarAudit = document.querySelector('.sidebar-item[data-section="audit"]');
  if (type === 'audit') {
    btnAudit.classList.add('active');
    btnSess.classList.remove('active');
    title.textContent = 'Audit log';
    loadAuditLogs();
  } else {
    btnAudit.classList.remove('active');
    btnSess.classList.add('active');
    title.textContent = 'Session log';
    loadSessionLogs();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btnAudit = document.getElementById('tab-audit');
  const btnSess = document.getElementById('tab-sessions');
  if (btnAudit) btnAudit.addEventListener('click', () => switchTo('audit'));
  if (btnSess) btnSess.addEventListener('click', () => switchTo('sessions'));
  switchTo('audit');
});