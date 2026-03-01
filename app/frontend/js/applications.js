async function loadApplications() {
  try {
    const res = await fetch('/api/applications');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load applications');
      return;
    }
    const tbody = document.getElementById('applications-tbody');
    tbody.innerHTML = '';
    (data.applications || []).forEach((app) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${app.name}</td>
        <td>${app.type}</td>
        <td>${app.IP}</td>
        <td>${app.port}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    alert(e.message || 'Error loading applications');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadApplications();

  const form = document.getElementById('create-application-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('app-name').value.trim();
    const type = document.getElementById('app-type').value.trim();
    const IP = document.getElementById('app-ip').value.trim();
    const port = parseInt(document.getElementById('app-port').value, 10);
    if (!name || !type || !IP || !port) {
      return;
    }

    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, IP, port })
    });
    const data = await res.json();
    if (data.success) {
      form.reset();
      loadApplications();
    } else {
      alert(data.error || 'Cannot create application');
    }
  });
});

