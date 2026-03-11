async function loadAuditLogs() {
  const tbody = document.getElementById('audit-body');
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

document.addEventListener('DOMContentLoaded', loadAuditLogs);