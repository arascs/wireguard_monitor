async function loadBackups() {
  const tbody = document.getElementById('backups-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/backups', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load backups');
      return;
    }
    (data.backups || []).forEach((b, idx) => {
      const dateStr = new Date(b.mtime).toLocaleString();
      const sizeKb = (b.size / 1024).toFixed(1) + ' KB';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${b.name}</td>
        <td>${sizeKb}</td>
        <td>${dateStr}</td>
        <td>${b.type || ''}</td>
        <td><button data-idx="${idx}" class="btn-restore">Restore</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-restore').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-idx');
        const entry = data.backups[idx];
        if (entry) {
          if (confirm('Restore from ' + entry.name + '? This will overwrite existing data.')) {
            restoreBackup(entry.name);
          }
        }
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading backups');
  }
}

async function createBackup(type) {
  try {
    const res = await fetch('/api/backups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type })
    });
    const data = await res.json();
    if (data.success) {
      alert('Backup created: ' + data.filename);
      loadBackups();
    } else {
      alert(data.error || 'Failed to create backup');
    }
  } catch (e) {
    alert(e.message || 'Error creating backup');
  }
}

async function restoreBackup(name) {
  try {
    const res = await fetch('/api/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      alert('Restore completed');
    } else {
      alert(data.error || 'Failed to restore');
    }
  } catch (e) {
    alert(e.message || 'Error restoring backup');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadBackups();
  const btnDb = document.getElementById('btn-create-db');
  const btnWg = document.getElementById('btn-create-wg');
  const btnFull = document.getElementById('btn-create-full');
  if (btnDb) btnDb.addEventListener('click', () => createBackup('db'));
  if (btnWg) btnWg.addEventListener('click', () => createBackup('wg_config'));
  if (btnFull) btnFull.addEventListener('click', () => createBackup('full'));
});