let allAdmins = [];

const ICON_DISABLE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/></svg>';
const ICON_ENABLE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/></svg>';
const ICON_DELETE = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';

function formatEpoch(epoch) {
  if (!epoch) return '';
  const n = parseInt(epoch, 10);
  if (Number.isNaN(n)) return '';
  const d = new Date(n * 1000);
  return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN');
}

function renderAdminsTable() {
  const tbody = document.getElementById('admins-tbody');
  tbody.innerHTML = '';
  allAdmins.forEach((admin) => {
    const enabled = parseInt(admin.status, 10) !== 0;
    const tr = document.createElement('tr');
    let actions = '';
    if (enabled) {
      actions += `<button class="btn-icon" title="Disable" data-action="disable" data-id="${admin.id}">${ICON_DISABLE}</button>`;
    } else {
      actions += `<button class="btn-icon" title="Enable" data-action="enable" data-id="${admin.id}">${ICON_ENABLE}</button>`;
    }
    actions += `<button class="btn-icon" title="Delete" data-action="delete" data-id="${admin.id}">${ICON_DELETE}</button>`;
    tr.innerHTML = `
      <td>${admin.username}</td>
      <td>${formatEpoch(admin.create_day)}</td>
      <td>${formatEpoch(admin.expire_day) || 'Never'}</td>
      <td>${enabled ? 'Enabled' : 'Disabled'}</td>
      <td class="actions-cell">${actions}</td>
    `;
    tr.querySelectorAll('.btn-icon').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'enable') enableAdmin(id);
        else if (action === 'disable') disableAdmin(id);
        else if (action === 'delete') deleteAdmin(id);
      });
    });
    tbody.appendChild(tr);
  });
}

async function loadAdmins() {
  const res = await fetch('/api/admins', { credentials: 'same-origin' });
  const data = await res.json();
  if (!data.success) {
    alert(data.error || 'Cannot load admins');
    return;
  }
  allAdmins = data.admins || [];
  renderAdminsTable();
}

function openCreateAdminModal() {
  document.getElementById('create-admin-form')?.reset();
  document.getElementById('create-admin-modal')?.classList.add('open');
}

function closeCreateAdminModal() {
  document.getElementById('create-admin-modal')?.classList.remove('open');
}

async function enableAdmin(id) {
  const res = await fetch(`/api/admins/${id}/enable`, { method: 'POST', credentials: 'same-origin' });
  const data = await res.json();
  if (data.success) loadAdmins();
  else alert(data.error || 'Cannot enable admin');
}

async function disableAdmin(id) {
  const res = await fetch(`/api/admins/${id}/disable`, { method: 'POST', credentials: 'same-origin' });
  const data = await res.json();
  if (data.success) loadAdmins();
  else alert(data.error || 'Cannot disable admin');
}

async function deleteAdmin(id) {
  const admin = allAdmins.find((a) => String(a.id) === String(id));
  const name = admin ? admin.username : id;
  if (!confirm(`Delete admin "${name}"?`)) return;
  const res = await fetch(`/api/admins/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  const data = await res.json();
  if (data.success) loadAdmins();
  else alert(data.error || 'Cannot delete admin');
}

document.addEventListener('DOMContentLoaded', () => {
  loadAdmins();

  document.getElementById('btn-add-admin')?.addEventListener('click', openCreateAdminModal);

  document.getElementById('create-admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('admin-username').value.trim();
    const password = document.getElementById('admin-password').value;
    const expireDay = document.getElementById('admin-expire').value;
    if (!username || !password) return;

    const res = await fetch('/api/admins', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, expireDay })
    });
    const data = await res.json();
    if (data.success) {
      closeCreateAdminModal();
      loadAdmins();
    } else {
      alert(data.error || 'Cannot create admin');
    }
  });

  document.getElementById('create-admin-cancel')?.addEventListener('click', closeCreateAdminModal);
  document.getElementById('create-admin-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-admin-modal') closeCreateAdminModal();
  });
});
